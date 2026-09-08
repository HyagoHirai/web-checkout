import type { OrderSubmission } from '../../../shared/wire.ts';
import { POLL_INTERVAL_MS } from '../../../shared/constants.ts';
import { createApi, type Api } from '../api/client.ts';
import { emit } from '../api/telemetry.ts';
import { pollDueAt, waitEndedAt } from './deadlines.ts';
import { initialState, reduce } from './reducer.ts';
import { clear, load, save } from './storage.ts';
import type { Event, State } from './types.ts';
import { newUuid } from './uuid.ts';

export interface RuntimeOptions {
  api?: Api;
  now?: () => number;
  tickMs?: number;
  uuid?: () => string;
  emit?: typeof emit;
}

/**
 * The module-level store: owns the four timers and every fetch (research R3, R4, R10). React reads
 * it through useSyncExternalStore. Timers are wall-clock deadlines checked by one ticker; nothing
 * is armed as a long setTimeout. revalidate() runs synchronously on pageshow/visibility before any
 * buffered response can be admitted.
 */
export function createRuntime(opts: RuntimeOptions = {}) {
  const api = opts.api ?? createApi();
  const now = opts.now ?? (() => Date.now());
  const tickMs = opts.tickMs ?? 250;
  const uuid = opts.uuid ?? newUuid;
  const telemetry = opts.emit ?? emit;

  let state: State = { ...initialState, now: now() };
  const listeners = new Set<() => void>();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let pollController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const onPageShow = () => revalidate();
  const onVisibility = () => { if (document.visibilityState === 'visible') revalidate(); };

  function notify(): void {
    for (const l of listeners) l();
  }

  function persist(prev: State, next: State): void {
    if (prev.interaction !== next.interaction) {
      if (next.interaction && next.interaction.phase !== 'idle') save(next.interaction);
      else clear();
    }
  }

  function dispatch(ev: Event): State {
    const prev = state;
    const next = reduce(prev, ev);
    if (next === prev) return prev;
    state = next;
    persist(prev, next);
    afterTransition(prev, next, ev);
    notify();
    return next;
  }

  function stopPolling(): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pollController?.abort();
    pollController = null;
  }

  /** Side effects that follow a transition; kept out of the pure reducer. */
  function afterTransition(prev: State, next: State, ev: Event): void {
    const pi = prev.interaction;
    const ni = next.interaction;
    const interactionEnded = pi && (!ni || ni.id !== pi.id);
    if (interactionEnded) {
      stopPolling();
      if (ev.type === 'TICK' && pi && pi.phase !== 'confirmed') telemetry(pi.id, 'interaction_expired', { phase: pi.phase }, pi.submission?.idempotencyKey);
    }
    if (!ni) return;

    if (next.menuLoading && !prev.menuLoading) void loadMenu(ni.id);

    // The POST is sent exactly once, on PAY. A reload into `submitted` (RESUME) never re-sends: it polls by key.
    if (ev.type === 'PAY' && ni.phase === 'submitted' && ni.submission) void sendPost(ni.id, ni.submission);

    const pollingNow = ni.phase === 'submitted' && ni.submission?.pollStartedAt !== null;
    const pollingBefore = pi?.phase === 'submitted' && pi.submission?.pollStartedAt !== null;
    if (pollingNow && !pollingBefore) startPolling(ni.id, ni.submission!.idempotencyKey);

    if (ni.phase !== 'submitted' && pi?.phase === 'submitted') stopPolling();
    if (ni.phase === 'unresolved' && pi?.phase !== 'unresolved') {
      telemetry(ni.id, 'unresolved_shown', { knownState: ni.submission?.knownState ?? 'none' }, ni.submission?.idempotencyKey);
    }
    if (pi?.phase === 'unresolved' && (ni.phase === 'confirmed' || ni.phase === 'declined')) {
      telemetry(ni.id, 'late_result_applied', { phase: ni.phase }, ni.submission?.idempotencyKey);
    }
    if (ni.screen === 'rejected' && pi?.screen !== 'rejected') telemetry(ni.id, 'rejection_shown', { reasons: next.rejection?.reasons.join(',') ?? '' });
  }

  async function loadMenu(interactionId: string): Promise<void> {
    try {
      const menu = await api.fetchMenu();
      if (state.interaction?.id !== interactionId) return;
      dispatch({ type: 'MENU_LOADED', now: now(), items: menu.items });
    } catch {
      if (state.interaction?.id !== interactionId) return;
      dispatch({ type: 'MENU_FAILED', now: now() });
    }
  }

  function toWire(sub: NonNullable<State['interaction']>['submission'] & object): OrderSubmission {
    return {
      idempotencyKey: sub.idempotencyKey,
      currency: 'USD',
      expectedTotalMinor: sub.expectedTotalMinor,
      lines: sub.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      simulation: { outcome: sub.simulation },
    };
  }

  /** The POST is never aborted; its late result goes through the same admission rule as any other. */
  async function sendPost(interactionId: string, sub: NonNullable<State['interaction']>['submission'] & object): Promise<void> {
    const result = await api.postOrder(toWire(sub), interactionId);
    admit({ source: 'post', interactionId, idempotencyKey: sub.idempotencyKey, result });
  }

  function admit(ev: Omit<Extract<Event, { type: 'RESPONSE' }>, 'type' | 'now'>): void {
    // A conflict means an order exists under this key and may be paid: look it up (research R10).
    if (ev.result.category === 'conflict') {
      void api.lookupByKey(ev.idempotencyKey, ev.interactionId).then((r) => admit({ ...ev, source: 'lookup', result: r }));
      return;
    }
    const before = state;
    const after = dispatch({ type: 'RESPONSE', now: now(), ...ev });
    if (after === before) {
      const i = state.interaction;
      const foreign = !i || i.id !== ev.interactionId || i.submission?.idempotencyKey !== ev.idempotencyKey;
      if (ev.result.category !== 'unknown') {
        telemetry(i?.id ?? ev.interactionId, foreign ? 'foreign_response_discarded' : 'stale_response_discarded', { category: ev.result.category, source: ev.source }, ev.idempotencyKey);
      }
    }
  }

  function startPolling(interactionId: string, key: string): void {
    stopPolling();
    const controller = new AbortController();
    pollController = controller;
    // Cadence is measured from the START of each poll (every 2 s), with at most one in flight.
    const tick = async () => {
      const i = state.interaction;
      if (controller.signal.aborted || !i || i.id !== interactionId || i.phase !== 'submitted' || i.submission?.idempotencyKey !== key) return;
      const end = i.submission ? waitEndedAt(i.submission) : null;
      if (end !== null && now() >= end) return;
      const startedAt = now();
      const perPoll = AbortSignal.any ? AbortSignal.any([controller.signal, AbortSignal.timeout(POLL_INTERVAL_MS)]) : controller.signal;
      const result = await api.lookupByKey(key, interactionId, perPoll);
      if (controller.signal.aborted) return;
      admit({ source: 'poll', interactionId, idempotencyKey: key, result });
      if (!controller.signal.aborted && state.interaction?.phase === 'submitted') {
        pollTimer = setTimeout(tick, Math.max(0, POLL_INTERVAL_MS - (now() - startedAt)));
      }
    };
    void tick();
  }

  function tickOnce(): void {
    const t = now();
    const i = state.interaction;
    if (i?.phase === 'submitted' && i.submission && i.submission.pollStartedAt === null) {
      const due = pollDueAt(i.submission);
      if (due !== null && t >= due) dispatch({ type: 'POLL_START', now: t });
    }
    dispatch({ type: 'TICK', now: t });
  }

  /**
   * A live page (pageshow after a bfcache restore, a tab becoming visible) keeps its in-memory
   * state and only has the clock applied: TICK. Only a fresh load with nothing in memory hydrates
   * from storage: RESUME. Both run synchronously before any buffered response can be admitted.
   */
  function revalidate(): void {
    const t = now();
    if (state.interaction) dispatch({ type: 'TICK', now: t });
    else dispatch({ type: 'RESUME', now: t, interaction: load() });
    const ni = state.interaction;
    if (ni && ni.phase === 'submitted' && ni.submission) {
      if (ni.submission.pollStartedAt === null) {
        const due = pollDueAt(ni.submission);
        if (due !== null && t >= due) dispatch({ type: 'POLL_START', now: t });
      }
      if (state.interaction?.submission?.pollStartedAt !== null && !pollController) startPolling(ni.id, ni.submission.idempotencyKey);
    }
    if (ni && !state.menu && ni.phase !== 'idle' && !state.menuLoading) void loadMenu(ni.id);
  }

  function boot(): void {
    revalidate();
    if (!ticker) ticker = setInterval(tickOnce, tickMs);
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', onPageShow);
      document.addEventListener('visibilitychange', onVisibility);
    }
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
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
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
      goPayment: () => dispatch({ type: 'GO_PAYMENT', now: now(), idempotencyKey: uuid() }),
      backToCart: () => dispatch({ type: 'BACK_TO_CART', now: now() }),
      setSimulation: (outcome: 'success' | 'declined' | 'inconclusive') => dispatch({ type: 'SET_SIMULATION', now: now(), outcome }),
      pay: () => dispatch({ type: 'PAY', now: now() }),
      continueSession: () => dispatch({ type: 'CONTINUE', now: now() }),
      retryAfterError: () => {
        const i = state.interaction;
        if (i && state.error?.kind === 'menu_unreachable') telemetry(i.id, 'service_unreachable', { screen: 'menu' });
        dispatch({ type: 'RETRY_AFTER_ERROR', now: now() });
      },
      tryAgain: () => dispatch({ type: 'TRY_AGAIN', now: now() }),
      startNewOrder: () => dispatch({ type: 'START_NEW_ORDER', now: now() }),
      done: () => dispatch({ type: 'DONE', now: now() }),
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
