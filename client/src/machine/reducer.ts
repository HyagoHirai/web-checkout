import { NETWORK_WAIT_MS } from '../../../shared/constants.ts';
import type { MenuItem } from '../../../shared/wire.ts';
import { admit, DEFINITENESS, knownStateOf } from './admission.ts';
import { canReview, cartBlocker, cartChangeBlocker, reflag, setLine } from './cart.ts';
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
  'SET_SIMULATION', 'PAY', 'CONTINUE', 'RETRY_AFTER_ERROR', 'TRY_AGAIN', 'DONE',
]);

function stamp(i: Interaction, now: number): Interaction {
  return { ...i, lastActivityAt: now, deadlineAt: null };
}

function toIdle(state: State, now: number): State {
  return { ...initialState, now, menu: state.menu };
}

/** A retained key's last check is admitted only while the review screen it was started from is still current. */
function checkStillCurrent(i: Interaction): boolean {
  return i.phase === 'building' && i.screen === 'review' && retainedSubmission(i) !== null;
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
function applyMenuUpdate(state: State, i: Interaction, items: MenuItem[], now: number): State {
  const cart = reflag(state.cart, items);
  let screen = i.screen;
  let submission = i.submission;
  if (i.phase === 'building' && (i.screen === 'review' || i.screen === 'payment')) {
    const unsent = unsentSubmission(i);
    if (cartBlocker(cart, items) !== null) {
      screen = 'menu';
      submission = retainedSubmission(i);
    } else if (unsent && isRepriced(unsent, items)) {
      screen = 'review';
      submission = retainedSubmission(i);
    }
  }
  const left = screen !== i.screen;
  return { ...state, now, menu: items, menuLoading: false, cart, activeCheck: left ? null : state.activeCheck, interaction: { ...i, screen, submission } };
}

/**
 * Applies a classified response after the admission rule. Returns the same state (identity) when
 * nothing is admitted, so the runtime can emit the right telemetry. Implements definiteness (FR-033),
 * the late-result transitions (FR-034) and the deadline preservation rule (research R4).
 */
function applyResponse(state: State, ev: Extract<Event, { type: 'RESPONSE' }>): State {
  const a = admit(state.interaction, ev);
  if (!a.admitted) return state;
  const { interaction: i, submission: sub, fromRetained } = a;
  const r = ev.result;

  switch (r.category) {
    case 'outcome': {
      const known = knownStateOf(r.status);
      if (DEFINITENESS[known] < DEFINITENESS[sub.knownState]) return state; // never regress (FR-033)
      // the recorded total belongs to the order the server holds, not to what this attempt sent (a 409
      // lookup or a retained key can resolve to an order with a different total)
      const nextSub: Submission = { ...sub, knownState: known, reference: r.status.reference, recordedTotalMinor: r.status.totalMinor };
      if (known === 'pending') {
        if (fromRetained) {
          // the retained key turned out to exist and is pending: no new intent, no pay-again (S7a)
          return { ...state, rejection: null, interaction: { ...i, phase: 'unresolved', screen: 'menu', submission: nextSub } };
        }
        if (sub.knownState === 'pending' && sub.reference === r.status.reference) return state; // nothing new
        const pollStartedAt = sub.pollStartedAt ?? ev.now; // an early pending starts polling now (research R10)
        return { ...state, interaction: { ...i, submission: { ...nextSub, pollStartedAt } } };
      }
      if (known === 'paid') {
        return { ...state, rejection: null, interaction: { ...i, phase: 'confirmed', resolvedAt: ev.now, submission: nextSub } };
      }
      // failed: a late decline preserves the deadline in force; an in-time one is ordinary building math.
      // After a reload the cart is empty: rebuild it from the frozen lines so Try again has an order.
      const deadlineAt = i.phase === 'unresolved' ? inactivityDeadline(i) : null;
      const cart = state.cart.lines.length > 0 ? state.cart : cartFromFrozen(sub.lines);
      return { ...state, cart, rejection: null, interaction: { ...i, phase: 'declined', screen: 'menu', deadlineAt, submission: nextSub } };
    }
    case 'conflict':
      return state; // an order exists under this key and may be paid: the runtime looks it up
    case 'rejected': {
      // A rejection is less definite than a known acceptance: once any response has established that
      // the intent exists, a late rejection of one request is stale (FR-033).
      if (i.phase !== 'submitted' || sub.knownState !== 'none') return state;
      const current = new Map((r.rejection.currentItems ?? []).map((m) => [m.id, m]));
      const menu = state.menu ? state.menu.map((m) => current.get(m.id) ?? m) : state.menu;
      const affected = r.rejection.affectedItemIds ?? [];
      const unavailableIds = (r.rejection.currentItems ?? []).filter((m) => !m.available).map((m) => m.id);
      // the server omits unknown items from currentItems: an affected id that is not there is gone from the menu
      const unknownIds = r.rejection.reasons.includes('unknown_item') ? affected.filter((id) => !current.has(id)) : [];
      const baseCart = state.cart.lines.length > 0 ? state.cart : cartFromFrozen(sub.lines);
      // The key is retained (see retainedSubmission): this request created nothing, but a concurrent
      // request with the same key may still be accepted. It is checked once more before a new intent.
      return {
        ...state,
        menu,
        cart: { ...baseCart, flagged: [...new Set([...baseCart.flagged, ...unavailableIds, ...unknownIds])] },
        rejection: { reasons: r.rejection.reasons, affectedItemIds: affected, currentTotalMinor: r.rejection.currentTotalMinor },
        interaction: { ...i, phase: 'building', screen: 'rejected', submission: sub },
      };
    }
    case 'bad_request':
    case 'reference_exhausted': {
      if (i.phase !== 'submitted' || sub.knownState !== 'none') return state; // same monotonicity as above
      return { ...state, error: { kind: r.category }, interaction: { ...i, phase: 'building', screen: 'error', submission: sub } };
    }
    case 'unknown':
      if (i.phase !== 'submitted') return state;
      if (ev.source === 'post' && sub.pollStartedAt === null) {
        return { ...state, interaction: { ...i, submission: { ...sub, pollStartedAt: ev.now } } }; // the POST failed before the 8 s wait: poll now
      }
      return state;
  }
}

export function reduce(state: State, ev: Event): State {
  const i = state.interaction;
  const now = ev.now;

  if (ev.type === 'RESUME') return restoreInteraction(state, ev.interaction, now);

  if (ev.type === 'START') {
    if (i && i.phase !== 'idle') return state;
    return {
      ...initialState, now, menu: state.menu, menuLoading: true,
      interaction: { v: INTERACTION_FORMAT_VERSION, id: ev.interactionId, startedAt: now, lastActivityAt: now, phase: 'building', screen: 'menu', resolvedAt: null, deadlineAt: null, submission: null },
    };
  }

  if (ev.type === 'START_NEW_ORDER') return toIdle(state, now);

  /** TICK is also what a live-page revalidation dispatches: it applies the clock and nothing else. */
  if (ev.type === 'TICK') {
    if (!i) return { ...state, now };
    const norm = normalize(i, now);
    if (!norm) return toIdle(state, now);
    if (norm !== i) return { ...state, now, interaction: norm };
    return state.now === now ? state : { ...state, now };
  }

  if (ev.type === 'RESPONSE') return applyResponse(state, ev);

  if (!i) return state;
  if (isExpired(i, now)) return toIdle(state, now);

  // The last check of a retained key: one at a time, from the review screen only, identified so that a
  // check abandoned by navigation (even if the customer returns) or belonging to an ended interaction
  // can never be admitted. Every activity event below clears the active check.
  if (ev.type === 'CHECK_START') {
    if (state.activeCheck !== null || !checkStillCurrent(i)) return state;
    return { ...state, now, activeCheck: ev.checkId };
  }
  if (ev.type === 'CHECK_END') return state.activeCheck === ev.checkId ? { ...state, now, activeCheck: null } : state;
  if (ev.type === 'CHECK_FAILED') {
    if (state.activeCheck !== ev.checkId) return state;
    // transport failure, 5xx or an unrecognised body: nothing is known, nothing new is started (FR-024)
    return { ...state, now, activeCheck: null, error: { kind: 'lookup_failed' }, interaction: { ...i, screen: 'error' } };
  }

  const active = ACTIVITY.has(ev.type) ? stamp(i, now) : i;
  if (ACTIVITY.has(ev.type) && state.activeCheck !== null) state = { ...state, activeCheck: null };

  switch (ev.type) {
    case 'MENU_LOADED':
      return applyMenuUpdate(state, active, ev.items, now);
    case 'MENU_FAILED':
      // the loading flag always clears (the runtime starts refreshes on false → true); only a building
      // interaction shows the error screen for it
      if (i.phase !== 'building') return { ...state, now, menuLoading: false };
      return { ...state, now, menuLoading: false, error: { kind: 'menu_unreachable' }, interaction: { ...active, screen: 'error' } };
    case 'ADD_ITEM': {
      if (i.phase !== 'building') return state;
      const existing = state.cart.lines.find((l) => l.itemId === ev.itemId)?.quantity ?? 0;
      if (cartChangeBlocker(state.cart, state.menu, ev.itemId, existing + 1)) return { ...state, now, interaction: active };
      return { ...state, now, cart: setLine(state.cart, ev.itemId, existing + 1), interaction: active };
    }
    case 'SET_QTY': {
      if (i.phase !== 'building') return state;
      // only increments are bounded; a decrement always applies, so a cart pushed over a bound by a
      // re-pricing can be reduced step by step (review and payment stay blocked until it is valid)
      const current = state.cart.lines.find((l) => l.itemId === ev.itemId)?.quantity ?? 0;
      if (ev.quantity > current && cartChangeBlocker(state.cart, state.menu, ev.itemId, ev.quantity)) return { ...state, now, interaction: active };
      return { ...state, now, cart: setLine(state.cart, ev.itemId, Math.max(0, ev.quantity)), interaction: active };
    }
    case 'REMOVE_ITEM':
      if (i.phase !== 'building' && i.phase !== 'declined') return state;
      return { ...state, now, cart: setLine(state.cart, ev.itemId, 0), interaction: { ...active, phase: 'building', screen: 'menu', submission: retainedSubmission(i) } };
    case 'GO_REVIEW':
      if ((i.phase !== 'building' && i.phase !== 'declined') || !canReview(state.cart, state.menu)) return state;
      return { ...state, now, rejection: null, interaction: { ...active, phase: 'building', screen: 'review', submission: retainedSubmission(i) } };
    case 'GO_MENU':
      if (i.phase !== 'building' && i.phase !== 'declined') return state;
      return { ...state, now, interaction: { ...active, phase: 'building', screen: 'menu', submission: retainedSubmission(i) } };
    case 'GO_PAYMENT':
      if (i.phase !== 'building' || !state.menu || !canReview(state.cart, state.menu)) return state;
      return { ...state, now, interaction: { ...active, screen: 'payment', submission: newSubmission(state.cart, state.menu, ev.idempotencyKey) } };
    case 'BACK_TO_CART':
      // before send only: discards the unsent key (ADR-002). In submitted/unresolved this is refused.
      if (i.phase !== 'building' || i.screen !== 'payment') return state;
      return { ...state, now, interaction: { ...active, screen: 'menu', submission: null } };
    case 'SET_SIMULATION':
      if (i.phase !== 'building' || !unsentSubmission(i)) return state;
      return { ...state, now, interaction: { ...active, submission: { ...i.submission!, simulation: ev.outcome } } };
    case 'PAY':
      if (i.phase !== 'building' || i.screen !== 'payment' || !unsentSubmission(i)) return state;
      if (!canReview(state.cart, state.menu)) return state; // FR-006 on the client, also after a re-pricing
      return { ...state, now, interaction: { ...active, phase: 'submitted', submission: { ...i.submission!, sentAt: now } } };
    case 'POLL_START': {
      if (i.phase !== 'submitted' || !i.submission || i.submission.pollStartedAt !== null) return state;
      // a poll that could only start late (the app was suspended) must not extend the wait
      const due = (i.submission.sentAt ?? now) + NETWORK_WAIT_MS;
      return { ...state, now, interaction: { ...i, submission: { ...i.submission, pollStartedAt: Math.min(now, due) } } };
    }
    case 'CONTINUE':
      return { ...state, now, interaction: active };
    case 'RETRY_AFTER_ERROR':
      if (i.phase !== 'building' || i.screen !== 'error') return state;
      if (state.error?.kind === 'menu_unreachable') return { ...state, now, error: null, menuLoading: true, interaction: { ...active, screen: 'menu' } };
      return { ...state, now, error: null, interaction: { ...active, screen: canReview(state.cart, state.menu) ? 'review' : 'menu' } };
    case 'TRY_AGAIN':
      // from declined (new intent, cart intact) or from rejected (re-priced cart). The menu is
      // re-fetched so the next intent is priced and flagged against current values (ui-states S8).
      if (i.phase === 'declined' || (i.phase === 'building' && i.screen === 'rejected')) {
        const target = canReview(state.cart, state.menu) ? 'review' : 'menu';
        // a declined key is terminal for that order; a retained (rejected) key survives for the last check
        const kept = i.phase === 'declined' ? null : retainedSubmission(i);
        return { ...state, now, rejection: null, menuLoading: true, interaction: { ...active, phase: 'building', screen: target, submission: kept } };
      }
      return state;
    case 'DONE':
      if (i.phase !== 'confirmed') return state;
      return toIdle(state, now);
    default:
      return state;
  }
}
