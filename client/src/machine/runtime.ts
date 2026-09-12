import type { SimulatedOutcome } from '../../../shared/wire.ts';
import { NETWORK_WAIT_MS, POLL_INTERVAL_MS } from '../../../shared/constants.ts';
import { createApi, type Api } from '../api/client.ts';
import { emit } from '../api/telemetry.ts';
import { admit as admissionOf, restatesKnownState } from './admission.ts';
import { pollDueAt, waitEndedAt } from './deadlines.ts';
import { initialState, reduce } from './reducer.ts';
import { clear, isCurrent, load, readRaw, save } from './storage.ts';
import { retainedSubmission, toWire } from './submission.ts';
import type { Event, Interaction, Rejection, State, Submission } from './types.ts';
import { newUuid } from './uuid.ts';

export interface RuntimeOptions {
  api?: Api;
  now?: () => number;
  tickMs?: number;
  uuid?: () => string;
  emit?: typeof emit;
}

/** A server response on its way to the reducer: where it came from, for which intent, and what it said. */
type ClassifiedResponse = Omit<Extract<Event, { type: 'RESPONSE' }>, 'type' | 'now'>;

/**
 * The module-level store: owns the four timers and every fetch (research R3, R4, R10). React reads
 * it through useSyncExternalStore. Timers are wall-clock deadlines checked by one ticker; nothing
 * is armed as a long setTimeout. revalidate() runs synchronously on pageshow/visibility before any
 * buffered response can be admitted.
 */
export function createRuntime(options: RuntimeOptions = {}) {
  const api = options.api ?? createApi();
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? 250;
  const uuid = options.uuid ?? newUuid;
  const telemetry = options.emit ?? emit;

  let state: State = { ...initialState, now: now() };
  const listeners = new Set<() => void>();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let pollController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** The interaction/key pair the current polling loop belongs to; polling follows the key, not the phase. */
  let pollingFor: { interactionId: string; key: string } | null = null;
  let lastCheckId = 0;
  const onPageShow = () => revalidate();
  const onVisibility = () => { if (document.visibilityState === 'visible') revalidate(); };

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function persist(prev: State, next: State): void {
    if (prev.interaction !== next.interaction) {
      if (next.interaction && next.interaction.phase !== 'idle') save(next.interaction);
      else clear();
    }
  }

  /** Reduce, persist, run the effects of the transition, notify React. A refused event does none of it. */
  function dispatch(event: Event): State {
    const prev = state;
    const next = reduce(prev, event);
    if (next === prev) return prev;
    state = next;
    persist(prev, next);
    afterTransition(prev, next, event);
    notify();
    return next;
  }

  function stopPolling(): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pollController?.abort();
    pollController = null;
    pollingFor = null;
  }

  /** Polling exists exactly when the current submission is `submitted` with polling started, for THAT key. */
  function reconcilePolling(): void {
    const interaction = state.interaction;
    const wanted =
      interaction && interaction.phase === 'submitted' && interaction.submission && interaction.submission.pollStartedAt !== null
        ? { interactionId: interaction.id, key: interaction.submission.idempotencyKey }
        : null;
    const alreadyPolling = wanted && pollingFor && wanted.interactionId === pollingFor.interactionId && wanted.key === pollingFor.key;
    if (alreadyPolling) return;
    stopPolling();
    if (wanted) startPolling(wanted.interactionId, wanted.key);
  }

  /**
   * Side effects that follow a transition, kept out of the pure reducer. Each one is keyed on a single
   * transition: the interaction ending, the menu being asked for, the PAY that sends the POST, and the
   * screen changes telemetry reports on.
   */
  function afterTransition(prev: State, next: State, event: Event): void {
    const before = prev.interaction;
    const after = next.interaction;

    const interactionEnded = before !== null && (after === null || after.id !== before.id);
    if (interactionEnded) {
      stopPolling();
      const expiredByClock = event.type === 'TICK' && before.phase !== 'confirmed';
      if (expiredByClock) telemetry(before.id, 'interaction_expired', { phase: before.phase }, before.submission?.idempotencyKey);
    }
    if (!after) return;

    const menuRequested = next.menuLoading && !prev.menuLoading;
    if (menuRequested) void loadMenu(after.id);

    // The POST is sent exactly once, on PAY. A reload into `submitted` (RESUME) never re-sends: it polls by key.
    if (event.type === 'PAY' && after.phase === 'submitted' && after.submission) void sendPost(after.id, after.submission);

    reconcilePolling();
    emitTransitionTelemetry(before, after, next.rejection);
  }

  /** The screen transitions the telemetry contract reports (contracts/openapi.yaml, client events). */
  function emitTransitionTelemetry(before: Interaction | null, after: Interaction, rejection: Rejection | null): void {
    const enteredUnresolved = after.phase === 'unresolved' && before?.phase !== 'unresolved';
    const lateResultApplied = before?.phase === 'unresolved' && (after.phase === 'confirmed' || after.phase === 'declined');
    const enteredRejected = after.screen === 'rejected' && before?.screen !== 'rejected';
    const key = after.submission?.idempotencyKey;

    if (enteredUnresolved) telemetry(after.id, 'unresolved_shown', { knownState: after.submission?.knownState ?? 'none' }, key);
    if (lateResultApplied) telemetry(after.id, 'late_result_applied', { phase: after.phase }, key);
    if (enteredRejected) telemetry(after.id, 'rejection_shown', { reasons: rejection?.reasons.join(',') ?? '' });
  }

  /**
   * The menu fetch is bounded by the same wait as a submission (FR-025): a proxy that cannot reach a
   * stopped API may hold the connection open far longer, and the customer would be building on the
   * previous menu the whole time. A fetch that outlives the wait is treated as a failure.
   */
  async function loadMenu(interactionId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('menu: no answer within the network wait')), NETWORK_WAIT_MS); });
    try {
      const menu = await Promise.race([api.fetchMenu(), timeout]);
      if (state.interaction?.id !== interactionId) return;
      dispatch({ type: 'MENU_LOADED', now: now(), items: menu.items });
    } catch {
      if (state.interaction?.id !== interactionId) return;
      dispatch({ type: 'MENU_FAILED', now: now() });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The POST is never aborted; its late result goes through the same admission rule as any other. */
  async function sendPost(interactionId: string, submission: Submission): Promise<void> {
    const result = await api.postOrder(toWire(submission), interactionId);
    admit({ source: 'post', interactionId, idempotencyKey: submission.idempotencyKey, result });
  }

  /**
   * Every response goes through the reducer's admission rule. One that changes nothing is reported as
   * stale or foreign, except a response the rule admitted that merely restates the known state (an
   * ordinary poll of a pending order): that is the normal case, not a discard.
   */
  function admit(response: ClassifiedResponse): void {
    // A conflict means an order exists under this key and may be paid: look it up (research R10).
    if (response.result.category === 'conflict') {
      void api.lookupByKey(response.idempotencyKey, response.interactionId).then((lookup) => admit({ ...response, source: 'lookup', result: lookup }));
      return;
    }
    const event = { type: 'RESPONSE' as const, now: now(), ...response };
    const admission = admissionOf(state.interaction, event);
    const before = state;
    const after = dispatch(event);
    if (after !== before) return;
    if (response.result.category === 'unknown') return;
    if (admission.admitted && response.result.category === 'outcome' && restatesKnownState(admission.submission, response.result.status)) return;

    const interaction = state.interaction;
    const foreign = !interaction || interaction.id !== response.interactionId || interaction.submission?.idempotencyKey !== response.idempotencyKey;
    telemetry(interaction?.id ?? response.interactionId, foreign ? 'foreign_response_discarded' : 'stale_response_discarded', { category: response.result.category, source: response.source }, response.idempotencyKey);
  }

  function startPolling(interactionId: string, key: string): void {
    stopPolling();
    const controller = new AbortController();
    pollController = controller;
    pollingFor = { interactionId, key };
    // Cadence is measured from the START of each poll (every 2 s), with at most one in flight.
    const pollOnce = async () => {
      const interaction = state.interaction;
      if (controller.signal.aborted || !interaction || interaction.id !== interactionId || interaction.phase !== 'submitted' || interaction.submission?.idempotencyKey !== key) return;
      const waitEnd = interaction.submission ? waitEndedAt(interaction.submission) : null;
      if (waitEnd !== null && now() >= waitEnd) return;
      const startedAt = now();
      const perPoll = AbortSignal.any ? AbortSignal.any([controller.signal, AbortSignal.timeout(POLL_INTERVAL_MS)]) : controller.signal;
      const result = await api.lookupByKey(key, interactionId, perPoll);
      if (controller.signal.aborted) return;
      admit({ source: 'poll', interactionId, idempotencyKey: key, result });
      if (!controller.signal.aborted && state.interaction?.phase === 'submitted') {
        pollTimer = setTimeout(pollOnce, Math.max(0, POLL_INTERVAL_MS - (now() - startedAt)));
      }
    };
    void pollOnce();
  }

  /** POLL_START is dispatched once the 8 s network wait is over; the reducer clamps a start that could only happen late. */
  function startPollingIfDue(time: number): void {
    const interaction = state.interaction;
    if (interaction?.phase !== 'submitted' || !interaction.submission || interaction.submission.pollStartedAt !== null) return;
    const due = pollDueAt(interaction.submission);
    if (due !== null && time >= due) dispatch({ type: 'POLL_START', now: time });
  }

  function tickOnce(): void {
    const time = now();
    startPollingIfDue(time);
    dispatch({ type: 'TICK', now: time });
  }

  /**
   * A live page (pageshow after a bfcache restore, a tab becoming visible) keeps its in-memory
   * state and only has the clock applied: TICK. Only a fresh load with nothing in memory hydrates
   * from storage: RESUME. Both run synchronously before any buffered response can be admitted.
   */
  function revalidate(): void {
    const time = now();
    const live = state.interaction;
    if (live) {
      // A document restored from the back/forward cache keeps its heap. If another document in this
      // tab has since moved on (reset, new interaction, new attempt), this one's memory is stale: it
      // abandons its state and hydrates the tab's current record (FR-028). It never writes over it.
      const raw = readRaw();
      if (raw === undefined || isCurrent(live, raw)) dispatch({ type: 'TICK', now: time });
      else dispatch({ type: 'RESUME', now: time, interaction: load() });
    } else {
      dispatch({ type: 'RESUME', now: time, interaction: load() });
    }
    startPollingIfDue(time);
    reconcilePolling();
    const current = state.interaction;
    if (current && !state.menu && current.phase !== 'idle' && !state.menuLoading) void loadMenu(current.id);
  }

  function boot(): void {
    revalidate();
    if (!ticker) ticker = setInterval(tickOnce, tickMs);
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', onPageShow);
      document.addEventListener('visibilitychange', onVisibility);
    }
  }

  /**
   * Continue to payment. Ordinarily one dispatch. When a retained key exists (sent, rejected, outcome
   * unknown) it is checked once more before a new intent replaces it (ADR-002 "The validation
   * window"): one check at a time, identified, and admitted only while the review it started from is
   * still current. Categories are handled explicitly:
   *   outcome → the recorded state is applied;
   *   404 with the API's own not_found body → the one case where "not found" permits a new intent;
   *   anything else (network, 5xx, unrecognised body) → nothing is known, nothing new starts.
   */
  function continueToPayment(): void {
    const interaction = state.interaction;
    const retained = interaction && interaction.phase === 'building' ? retainedSubmission(interaction) : null;
    if (!interaction || !retained) {
      dispatch({ type: 'GO_PAYMENT', now: now(), idempotencyKey: uuid() });
      return;
    }
    const checkId = ++lastCheckId;
    const before = state;
    const after = dispatch({ type: 'CHECK_START', now: now(), checkId });
    if (after === before) return; // a check is already in flight, or the screen is not the review
    const interactionId = interaction.id;
    const key = retained.idempotencyKey;
    void api.lookupByKey(key, interactionId).then((result) => {
      // Identity first: a check abandoned by any navigation, or belonging to an ended interaction,
      // is dropped entirely and touches nothing (not even another check's flag).
      if (state.activeCheck !== checkId) return;
      if (result.category === 'outcome') {
        dispatch({ type: 'CHECK_END', now: now(), checkId });
        admit({ source: 'lookup', interactionId, idempotencyKey: key, result });
        return;
      }
      if (result.category === 'unknown' && result.notFound) {
        dispatch({ type: 'CHECK_END', now: now(), checkId });
        dispatch({ type: 'GO_PAYMENT', now: now(), idempotencyKey: uuid() });
        return;
      }
      dispatch({ type: 'CHECK_FAILED', now: now(), checkId });
    });
  }

  function stop(): void {
    if (ticker) clearInterval(ticker);
    ticker = null;
    stopPolling();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    boot,
    stop,
    revalidate,
    tickOnce,
    now,
    actions: {
      start: () => dispatch({ type: 'START', now: now(), interactionId: uuid() }),
      addItem: (itemId: string) => dispatch({ type: 'ADD_ITEM', now: now(), itemId }),
      setQty: (itemId: string, quantity: number) => dispatch({ type: 'SET_QTY', now: now(), itemId, quantity }),
      removeItem: (itemId: string) => dispatch({ type: 'REMOVE_ITEM', now: now(), itemId }),
      goReview: () => dispatch({ type: 'GO_REVIEW', now: now() }),
      goMenu: () => dispatch({ type: 'GO_MENU', now: now() }),
      goPayment: continueToPayment,
      backToCart: () => dispatch({ type: 'BACK_TO_CART', now: now() }),
      setSimulation: (outcome: SimulatedOutcome) => dispatch({ type: 'SET_SIMULATION', now: now(), outcome }),
      pay: () => dispatch({ type: 'PAY', now: now() }),
      continueSession: () => dispatch({ type: 'CONTINUE', now: now() }),
      retryAfterError: () => {
        const interaction = state.interaction;
        if (interaction && state.error?.kind === 'menu_unreachable') telemetry(interaction.id, 'service_unreachable', { screen: 'menu' });
        dispatch({ type: 'RETRY_AFTER_ERROR', now: now() });
      },
      tryAgain: () => dispatch({ type: 'TRY_AGAIN', now: now() }),
      retryPayment: () => dispatch({ type: 'RETRY_PAYMENT', now: now(), idempotencyKey: uuid() }),
      startNewOrder: () => dispatch({ type: 'START_NEW_ORDER', now: now() }),
      done: () => dispatch({ type: 'DONE', now: now() }),
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
