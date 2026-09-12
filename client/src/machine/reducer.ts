import { NETWORK_WAIT_MS } from '../../../shared/constants.ts';
import type { MenuItem, OrderStatus, ValidationRejection } from '../../../shared/wire.ts';
import { admit, DEFINITENESS, knownStateOf, restatesKnownState, type Admission } from './admission.ts';
import { canReview, cartBlocker, cartChangeBlocker, flagRejectedItems, menuWithCurrentItems, reflag, setLine } from './cart.ts';
import { inactivityDeadline, isExpired, normalize } from './deadlines.ts';
import { cartFromFrozen, isRepriced, newSubmission, retainedSubmission, unsentSubmission } from './submission.ts';
import { INTERACTION_FORMAT_VERSION, type Event, type Interaction, type State, type Submission } from './types.ts';

export const initialState: State = {
  interaction: null,
  menu: null,
  menuLoading: false,
  cart: { lines: [], flagged: [] },
  rejection: null,
  error: null,
  activeCheck: null,
  now: 0,
};

/** Events that count as customer activity (ADR-005, FR-027). Everything else never re-stamps. */
const ACTIVITY = new Set<Event['type']>([
  'ADD_ITEM', 'SET_QTY', 'REMOVE_ITEM', 'GO_REVIEW', 'GO_MENU', 'GO_PAYMENT', 'BACK_TO_CART',
  'SET_SIMULATION', 'PAY', 'CONTINUE', 'RETRY_AFTER_ERROR', 'TRY_AGAIN', 'RETRY_PAYMENT', 'DONE',
]);

type ResponseEvent = Extract<Event, { type: 'RESPONSE' }>;
type AdmittedResponse = Extract<Admission, { admitted: true }>;

function stamp(interaction: Interaction, now: number): Interaction {
  return { ...interaction, lastActivityAt: now, deadlineAt: null };
}

function toIdle(state: State, now: number): State {
  return { ...initialState, now, menu: state.menu };
}

/** A retained key's last check is admitted only while the review screen it was started from is still current. */
function checkStillCurrent(interaction: Interaction): boolean {
  return interaction.phase === 'building' && interaction.screen === 'review' && retainedSubmission(interaction) !== null;
}

/** After a reload the cart is empty: rebuilt from the frozen lines so the customer still has an order to edit or retry. */
function cartOrFrozen(state: State, submission: Submission) {
  return state.cart.lines.length > 0 ? state.cart : cartFromFrozen(submission.lines);
}

/**
 * Hydration from storage after a fresh load. The clock is applied first (a finished wait, an expired
 * deadline). Then, by phase: a `building` record starts again at the menu with an empty cart and no
 * unsent intent (spec edge case: a reload before submission loses the cart), keeping only a retained
 * key; any phase with a sent submission rebuilds the cart from the frozen lines so the declined
 * screen's Try again has an order to retry.
 */
function restoreInteraction(state: State, record: Interaction | null, now: number): State {
  const restored = record ? normalize(record, now) : null;
  if (!restored) return toIdle(state, now);
  if (restored.phase === 'building') {
    return { ...initialState, now, menu: state.menu, interaction: { ...restored, screen: 'menu', submission: retainedSubmission(restored) } };
  }
  return { ...initialState, now, menu: state.menu, cart: restored.submission ? cartFromFrozen(restored.submission.lines) : initialState.cart, interaction: restored };
}

/**
 * A fresh menu re-flags the cart. On the review or payment screen it can also invalidate an unsent
 * intent: a blocked cart goes back to the menu with the reason (FR-010, FR-006); moved prices go back
 * to the review so the new total is seen before it is frozen again (FR-008).
 */
function applyMenuUpdate(state: State, interaction: Interaction, items: MenuItem[], now: number): State {
  const cart = reflag(state.cart, items);
  let screen = interaction.screen;
  let submission = interaction.submission;
  if (interaction.phase === 'building' && (interaction.screen === 'review' || interaction.screen === 'payment')) {
    const unsent = unsentSubmission(interaction);
    if (cartBlocker(cart, items) !== null) {
      screen = 'menu';
      submission = retainedSubmission(interaction);
    } else if (unsent && isRepriced(unsent, items)) {
      screen = 'review';
      submission = retainedSubmission(interaction);
    }
  }
  const leftScreen = screen !== interaction.screen;
  return { ...state, now, menu: items, menuLoading: false, cart, activeCheck: leftScreen ? null : state.activeCheck, interaction: { ...interaction, screen, submission } };
}

/**
 * A recorded order state for the admitted submission: definiteness first (FR-033), then the
 * late-result transitions (FR-034) and the deadline preservation rule (research R4).
 */
function applyOutcome(state: State, admission: AdmittedResponse, status: OrderStatus, now: number): State {
  const { interaction, submission, fromRetained } = admission;
  const nextKnownState = knownStateOf(status);
  if (DEFINITENESS[nextKnownState] < DEFINITENESS[submission.knownState]) return state; // never regress (FR-033)
  // the recorded total belongs to the order the server holds, not to what this attempt sent (a 409
  // lookup or a retained key can resolve to an order with a different total)
  const nextSubmission: Submission = { ...submission, knownState: nextKnownState, reference: status.reference, recordedTotalMinor: status.totalMinor };

  if (nextKnownState === 'pending') {
    if (fromRetained) {
      // the retained key turned out to exist and is pending: no new intent, no pay-again (S7a)
      return { ...state, rejection: null, interaction: { ...interaction, phase: 'unresolved', screen: 'menu', submission: nextSubmission } };
    }
    if (restatesKnownState(submission, status)) return state; // an ordinary poll: nothing new
    const pollStartedAt = submission.pollStartedAt ?? now; // an early pending starts polling now (research R10)
    return { ...state, interaction: { ...interaction, submission: { ...nextSubmission, pollStartedAt } } };
  }
  if (nextKnownState === 'paid') {
    return { ...state, rejection: null, interaction: { ...interaction, phase: 'confirmed', resolvedAt: now, submission: nextSubmission } };
  }
  // failed: a late decline preserves the deadline in force; an in-time one is ordinary building math.
  const deadlineAt = interaction.phase === 'unresolved' ? inactivityDeadline(interaction) : null;
  return { ...state, cart: cartOrFrozen(state, submission), rejection: null, interaction: { ...interaction, phase: 'declined', screen: 'menu', deadlineAt, submission: nextSubmission } };
}

/**
 * A 422 for this request: the cart is re-flagged against what the server called out and the
 * rejected screen names the reasons. The key is retained (see retainedSubmission): this request
 * created nothing, but a concurrent request with the same key may still be accepted, so it is
 * checked once more before a new intent.
 */
function applyRejection(state: State, interaction: Interaction, submission: Submission, rejection: ValidationRejection): State {
  return {
    ...state,
    menu: menuWithCurrentItems(state.menu, rejection.currentItems),
    cart: flagRejectedItems(cartOrFrozen(state, submission), rejection),
    rejection: { reasons: rejection.reasons, affectedItemIds: rejection.affectedItemIds ?? [], currentTotalMinor: rejection.currentTotalMinor },
    interaction: { ...interaction, phase: 'building', screen: 'rejected', submission },
  };
}

/**
 * Applies a classified response after the admission rule. Returns the same state (identity) when
 * nothing is admitted, so the runtime can emit the right telemetry. A rejection or an error is less
 * definite than a known acceptance: once any response has established that the intent exists, a
 * late one of those for a single request is stale (FR-033).
 */
function applyResponse(state: State, response: ResponseEvent): State {
  const admission = admit(state.interaction, response);
  if (!admission.admitted) return state;
  const { interaction, submission } = admission;
  const result = response.result;
  const nothingKnownYet = interaction.phase === 'submitted' && submission.knownState === 'none';

  switch (result.category) {
    case 'outcome':
      return applyOutcome(state, admission, result.status, response.now);
    case 'conflict':
      return state; // an order exists under this key and may be paid: the runtime looks it up
    case 'rejected':
      if (!nothingKnownYet) return state;
      return applyRejection(state, interaction, submission, result.rejection);
    case 'bad_request':
    case 'reference_exhausted':
      if (!nothingKnownYet) return state;
      return { ...state, error: { kind: result.category }, interaction: { ...interaction, phase: 'building', screen: 'error', submission } };
    case 'unknown':
      if (interaction.phase !== 'submitted') return state;
      if (response.source === 'post' && submission.pollStartedAt === null) {
        return { ...state, interaction: { ...interaction, submission: { ...submission, pollStartedAt: response.now } } }; // the POST failed before the 8 s wait: poll now
      }
      return state;
  }
}

export function reduce(state: State, event: Event): State {
  const interaction = state.interaction;
  const now = event.now;

  if (event.type === 'RESUME') return restoreInteraction(state, event.interaction, now);

  if (event.type === 'START') {
    if (interaction && interaction.phase !== 'idle') return state;
    return {
      ...initialState, now, menu: state.menu, menuLoading: true,
      interaction: { v: INTERACTION_FORMAT_VERSION, id: event.interactionId, startedAt: now, lastActivityAt: now, phase: 'building', screen: 'menu', resolvedAt: null, deadlineAt: null, submission: null },
    };
  }

  if (event.type === 'START_NEW_ORDER') return toIdle(state, now);

  /** TICK is also what a live-page revalidation dispatches: it applies the clock and nothing else. */
  if (event.type === 'TICK') {
    if (!interaction) return { ...state, now };
    const normalized = normalize(interaction, now);
    if (!normalized) return toIdle(state, now);
    if (normalized !== interaction) return { ...state, now, interaction: normalized };
    return state.now === now ? state : { ...state, now };
  }

  if (event.type === 'RESPONSE') return applyResponse(state, event);

  if (!interaction) return state;
  if (isExpired(interaction, now)) return toIdle(state, now);

  // The last check of a retained key: one at a time, from the review screen only, identified so that a
  // check abandoned by navigation (even if the customer returns) or belonging to an ended interaction
  // can never be admitted. Every activity event below clears the active check.
  if (event.type === 'CHECK_START') {
    if (state.activeCheck !== null || !checkStillCurrent(interaction)) return state;
    return { ...state, now, activeCheck: event.checkId };
  }
  if (event.type === 'CHECK_END') return state.activeCheck === event.checkId ? { ...state, now, activeCheck: null } : state;
  if (event.type === 'CHECK_FAILED') {
    if (state.activeCheck !== event.checkId) return state;
    // transport failure, 5xx or an unrecognised body: nothing is known, nothing new is started (FR-024)
    return { ...state, now, activeCheck: null, error: { kind: 'lookup_failed' }, interaction: { ...interaction, screen: 'error' } };
  }

  const isActivity = ACTIVITY.has(event.type);
  const stamped = isActivity ? stamp(interaction, now) : interaction;
  if (isActivity && state.activeCheck !== null) state = { ...state, activeCheck: null };

  switch (event.type) {
    case 'MENU_LOADED':
      return applyMenuUpdate(state, stamped, event.items, now);
    case 'MENU_FAILED':
      // the loading flag always clears (the runtime starts refreshes on false → true); only a building
      // interaction shows the error screen for it
      if (interaction.phase !== 'building') return { ...state, now, menuLoading: false };
      return { ...state, now, menuLoading: false, error: { kind: 'menu_unreachable' }, interaction: { ...stamped, screen: 'error' } };
    case 'ADD_ITEM': {
      if (interaction.phase !== 'building') return state;
      const existing = state.cart.lines.find((line) => line.itemId === event.itemId)?.quantity ?? 0;
      if (cartChangeBlocker(state.cart, state.menu, event.itemId, existing + 1)) return { ...state, now, interaction: stamped };
      return { ...state, now, cart: setLine(state.cart, event.itemId, existing + 1), interaction: stamped };
    }
    case 'SET_QTY': {
      if (interaction.phase !== 'building') return state;
      // only increments are bounded; a decrement always applies, so a cart pushed over a bound by a
      // re-pricing can be reduced step by step (review and payment stay blocked until it is valid)
      const current = state.cart.lines.find((line) => line.itemId === event.itemId)?.quantity ?? 0;
      if (event.quantity > current && cartChangeBlocker(state.cart, state.menu, event.itemId, event.quantity)) return { ...state, now, interaction: stamped };
      return { ...state, now, cart: setLine(state.cart, event.itemId, Math.max(0, event.quantity)), interaction: stamped };
    }
    case 'REMOVE_ITEM':
      if (interaction.phase !== 'building' && interaction.phase !== 'declined') return state;
      return { ...state, now, cart: setLine(state.cart, event.itemId, 0), interaction: { ...stamped, phase: 'building', screen: 'menu', submission: retainedSubmission(interaction) } };
    case 'GO_REVIEW':
      if ((interaction.phase !== 'building' && interaction.phase !== 'declined') || !state.menu || !canReview(state.cart, state.menu)) return state;
      return { ...state, now, rejection: null, interaction: { ...stamped, phase: 'building', screen: 'review', submission: retainedSubmission(interaction) } };
    case 'GO_MENU':
      if (interaction.phase !== 'building' && interaction.phase !== 'declined') return state;
      return { ...state, now, interaction: { ...stamped, phase: 'building', screen: 'menu', submission: retainedSubmission(interaction) } };
    case 'GO_PAYMENT':
      if (interaction.phase !== 'building' || !state.menu || !canReview(state.cart, state.menu)) return state;
      return { ...state, now, interaction: { ...stamped, screen: 'payment', submission: newSubmission(state.cart, state.menu, event.idempotencyKey) } };
    case 'BACK_TO_CART':
      // before send only: discards the unsent key (ADR-002). In submitted/unresolved this is refused.
      if (interaction.phase !== 'building' || interaction.screen !== 'payment') return state;
      return { ...state, now, interaction: { ...stamped, screen: 'menu', submission: null } };
    case 'SET_SIMULATION':
      if (interaction.phase !== 'building' || !unsentSubmission(interaction)) return state;
      return { ...state, now, interaction: { ...stamped, submission: { ...interaction.submission!, simulation: event.outcome } } };
    case 'PAY':
      if (interaction.phase !== 'building' || interaction.screen !== 'payment' || !unsentSubmission(interaction)) return state;
      if (!canReview(state.cart, state.menu)) return state; // FR-006 on the client, also after a re-pricing
      return { ...state, now, interaction: { ...stamped, phase: 'submitted', submission: { ...interaction.submission!, sentAt: now } } };
    case 'POLL_START': {
      if (interaction.phase !== 'submitted' || !interaction.submission || interaction.submission.pollStartedAt !== null) return state;
      // a poll that could only start late (the app was suspended) must not extend the wait
      const due = (interaction.submission.sentAt ?? now) + NETWORK_WAIT_MS;
      return { ...state, now, interaction: { ...interaction, submission: { ...interaction.submission, pollStartedAt: Math.min(now, due) } } };
    }
    case 'CONTINUE':
      return { ...state, now, interaction: stamped };
    case 'RETRY_AFTER_ERROR':
      if (interaction.phase !== 'building' || interaction.screen !== 'error') return state;
      if (state.error?.kind === 'menu_unreachable') return { ...state, now, error: null, menuLoading: true, interaction: { ...stamped, screen: 'menu' } };
      return { ...state, now, error: null, interaction: { ...stamped, screen: canReview(state.cart, state.menu) ? 'review' : 'menu' } };
    case 'RETRY_PAYMENT': {
      // From declined only: the customer already reviewed the order and the decline was about payment,
      // so this goes straight to the payment screen with a fresh key (a declined key is terminal for
      // that order, ADR-005; the unsent payment screen is part of building, ADR-002). The menu is
      // re-fetched; a price change arriving on the payment screen sends the customer back to the review
      // to see the new total before it is frozen again (applyMenuUpdate).
      if (interaction.phase !== 'declined') return state;
      if (!state.menu || !canReview(state.cart, state.menu)) return { ...state, now, menuLoading: true, interaction: { ...stamped, phase: 'building', screen: 'menu', submission: null } };
      return { ...state, now, menuLoading: true, interaction: { ...stamped, phase: 'building', screen: 'payment', submission: newSubmission(state.cart, state.menu, event.idempotencyKey) } };
    }
    case 'TRY_AGAIN': {
      // From rejected only: back to the review with the re-priced cart, the retained key surviving for
      // the last check before a new intent. The menu is re-fetched so the next intent is priced and
      // flagged against current values (ui-states S8).
      if (interaction.phase !== 'building' || interaction.screen !== 'rejected') return state;
      const target = canReview(state.cart, state.menu) ? 'review' : 'menu';
      return { ...state, now, rejection: null, menuLoading: true, interaction: { ...stamped, phase: 'building', screen: target, submission: retainedSubmission(interaction) } };
    }
    case 'DONE':
      if (interaction.phase !== 'confirmed') return state;
      return toIdle(state, now);
    default:
      return state;
  }
}
