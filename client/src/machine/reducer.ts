import { MAX_QTY_PER_LINE, MAX_TOTAL_MINOR, MAX_UNITS_PER_ORDER, NETWORK_WAIT_MS } from '../../../shared/constants.ts';
import type { MenuItem, OrderStatus } from '../../../shared/wire.ts';
import { inactivityDeadline, isExpired, normalize } from './deadlines.ts';
import { INTERACTION_FORMAT_VERSION, type Cart, type Event, type FrozenLine, type Interaction, type KnownState, type State, type Submission } from './types.ts';

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

export function cartTotalMinor(cart: Cart, menu: MenuItem[] | null): number {
  if (!menu) return 0;
  const price = new Map(menu.map((m) => [m.id, m.priceMinor]));
  return cart.lines.reduce((sum, l) => sum + (price.get(l.itemId) ?? 0) * l.quantity, 0);
}

export function cartUnits(cart: Cart): number {
  return cart.lines.reduce((s, l) => s + l.quantity, 0);
}

/** Why the cart cannot accept a change; null when it can (FR-003, FR-006). */
export function cartChangeBlocker(cart: Cart, menu: MenuItem[] | null, itemId: string, quantity: number): string | null {
  const item = menu?.find((m) => m.id === itemId);
  if (!item) return 'unknown_item';
  if (!item.available) return 'item_unavailable';
  if (quantity > MAX_QTY_PER_LINE) return 'quantity_out_of_bounds';
  const others = cart.lines.filter((l) => l.itemId !== itemId);
  const units = others.reduce((s, l) => s + l.quantity, 0) + quantity;
  if (units > MAX_UNITS_PER_ORDER) return 'units_out_of_bounds';
  const total = cartTotalMinor({ lines: [...others, { itemId, quantity }], flagged: [] }, menu);
  if (total > MAX_TOTAL_MINOR) return 'total_out_of_bounds';
  return null;
}

/**
 * Why the whole cart cannot be reviewed or frozen; null when it can. Re-pricing after a rejection
 * can push a previously valid cart over a bound, so the bounds are checked here too, not only on
 * quantity changes (FR-006).
 */
export function cartBlocker(cart: Cart, menu: MenuItem[] | null): string | null {
  if (cart.lines.length === 0) return 'empty_cart';
  if (cart.flagged.length > 0) return 'item_unavailable';
  if (cart.lines.some((l) => l.quantity < 1 || l.quantity > MAX_QTY_PER_LINE)) return 'quantity_out_of_bounds';
  if (cartUnits(cart) > MAX_UNITS_PER_ORDER) return 'units_out_of_bounds';
  if (cartTotalMinor(cart, menu) > MAX_TOTAL_MINOR) return 'total_out_of_bounds';
  return null;
}

export function canReview(cart: Cart, menu: MenuItem[] | null): boolean {
  return cartBlocker(cart, menu) === null;
}

/**
 * A submission that was sent and rejected, with NO known outcome, is kept until a new intent replaces
 * it (ADR-002 "The validation window"). A key whose outcome is known (a decline is terminal for that
 * order, ADR-005) is never kept: editing after a decline starts a new intent.
 */
function keptIntent(i: Interaction): Submission | null {
  return i.submission && i.submission.sentAt !== null && i.submission.knownState === 'none' ? i.submission : null;
}

function setLine(cart: Cart, itemId: string, quantity: number): Cart {
  const lines = cart.lines.filter((l) => l.itemId !== itemId);
  if (quantity > 0) lines.push({ itemId, quantity });
  return { lines, flagged: cart.flagged.filter((f) => f !== itemId || quantity > 0) };
}

/** After a reload the cart is gone but the frozen submission is not: rebuild the customer's lines from it. */
function cartFromFrozen(lines: readonly FrozenLine[]): Cart {
  return { lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })), flagged: [] };
}

/** Lines whose item is gone from the menu or unavailable on it must be acted on before review (FR-010). */
function reflag(cart: Cart, menu: MenuItem[]): Cart {
  const byId = new Map(menu.map((m) => [m.id, m]));
  const flagged = cart.lines.filter((l) => !byId.get(l.itemId)?.available).map((l) => l.itemId);
  return { ...cart, flagged: [...new Set([...cart.flagged.filter((f) => cart.lines.some((l) => l.itemId === f)), ...flagged])] };
}

function freeze(cart: Cart, menu: MenuItem[]): FrozenLine[] {
  const byId = new Map(menu.map((m) => [m.id, m]));
  return [...cart.lines]
    .map((l) => ({ itemId: l.itemId, name: byId.get(l.itemId)?.name ?? '', unitPriceMinor: byId.get(l.itemId)?.priceMinor ?? 0, quantity: l.quantity }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

function stamp(i: Interaction, now: number): Interaction {
  return { ...i, lastActivityAt: now, deadlineAt: null };
}

function toIdle(state: State, now: number): State {
  return { ...initialState, now, menu: state.menu };
}

/** A rejected key's last check is admitted only while the screen it was started from is still current. */
function checkStillCurrent(i: Interaction): boolean {
  return i.phase === 'building' && i.screen === 'review' && keptIntent(i) !== null;
}

const DEFINITENESS: Record<KnownState, number> = { none: 0, pending: 1, paid: 2, failed: 2 };

function knownOf(status: OrderStatus): KnownState {
  return status.state === 'pending_payment' ? 'pending' : status.state;
}

/** Conditions 2 and 3 of the admission rule: attribution by interaction AND by intent. */
function attributed(i: Interaction, ev: { interactionId: string; idempotencyKey: string }): boolean {
  return i.id === ev.interactionId && i.submission !== null && i.submission.idempotencyKey === ev.idempotencyKey;
}

/**
 * Applies a classified response. Returns the same state (identity) when the response is not
 * admitted, so the runtime can emit the right telemetry. Implements the five-condition admission
 * rule and the deadline preservation rule (research R4, data-model.md, contracts/ui-states.md).
 */
function applyResponse(state: State, ev: Extract<Event, { type: 'RESPONSE' }>): State {
  const live = state.interaction;
  if (!live || !live.submission) return state; // 1. no live interaction
  const i = normalize(live, ev.now); // 1. valid by the clock, with a finished wait already applied
  if (!i || !i.submission) return state;
  if (!attributed(i, ev)) return state; // 2, 3. interaction and intent
  // 4. legal transitions: from submitted, from unresolved, and from building only for a sent-and-rejected
  // key being checked once more before a new intent (research R10). Nothing leaves confirmed/declined;
  // 5. a terminal is not reapplied.
  const fromKept = i.phase === 'building' && keptIntent(i) !== null;
  if (i.phase !== 'submitted' && i.phase !== 'unresolved' && !fromKept) return state;
  const sub = i.submission;
  const r = ev.result;

  switch (r.category) {
    case 'outcome': {
      const known = knownOf(r.status);
      if (DEFINITENESS[known] < DEFINITENESS[sub.knownState]) return state; // never regress (FR-033)
      // the recorded total belongs to the order the server holds, not to what this attempt sent (a 409
      // lookup or a kept key can resolve to an order with a different total)
      const nextSub: Submission = { ...sub, knownState: known, reference: r.status.reference, recordedTotalMinor: r.status.totalMinor };
      if (known === 'pending') {
        if (fromKept) {
          // the rejected key turned out to exist and is pending: no new intent, no pay-again (S7a)
          return { ...state, rejection: null, interaction: { ...i, phase: 'unresolved', screen: 'menu', submission: nextSub } };
        }
        if (sub.knownState === 'pending' && sub.reference === r.status.reference) return state; // nothing new
        // an early pending starts polling now (research R10)
        const pollStartedAt = sub.pollStartedAt ?? ev.now;
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
      // an order exists under this key and may be paid: the runtime performs a lookup; nothing changes here
      return state;
    case 'rejected': {
      if (i.phase !== 'submitted') return state;
      const current = new Map((r.rejection.currentItems ?? []).map((m) => [m.id, m]));
      const menu = state.menu ? state.menu.map((m) => current.get(m.id) ?? m) : state.menu;
      const affected = r.rejection.affectedItemIds ?? [];
      const unavailableIds = (r.rejection.currentItems ?? []).filter((m) => !m.available).map((m) => m.id);
      // the server omits unknown items from currentItems: an affected id that is not there is gone from the menu
      const unknownIds = r.rejection.reasons.includes('unknown_item') ? affected.filter((id) => !current.has(id)) : [];
      const baseCart = state.cart.lines.length > 0 ? state.cart : cartFromFrozen(sub.lines);
      // The key is KEPT: this request created nothing, but under ADR-002's residual validation window a
      // concurrent request with the same key may still be accepted. It is looked up once more before
      // any new intent replaces it (runtime, goPayment).
      return {
        ...state,
        menu,
        cart: { ...baseCart, flagged: [...new Set([...baseCart.flagged, ...unavailableIds, ...unknownIds])] },
        rejection: { reasons: r.rejection.reasons, affectedItemIds: r.rejection.affectedItemIds ?? [], currentTotalMinor: r.rejection.currentTotalMinor },
        interaction: { ...i, phase: 'building', screen: 'rejected', submission: sub },
      };
    }
    case 'bad_request':
    case 'reference_exhausted': {
      if (i.phase !== 'submitted') return state;
      return { ...state, error: { kind: r.category }, interaction: { ...i, phase: 'building', screen: 'error', submission: sub } };
    }
    case 'unknown':
      if (i.phase !== 'submitted') return state;
      if (ev.source === 'post' && sub.pollStartedAt === null) {
        // the POST failed before the 8 s wait: start polling now (research R10)
        return { ...state, interaction: { ...i, submission: { ...sub, pollStartedAt: ev.now } } };
      }
      return state;
  }
}

export function reduce(state: State, ev: Event): State {
  const i = state.interaction;
  const now = ev.now;

  /**
   * Hydration from storage after a fresh load. The clock is applied first (a finished wait, an
   * expired deadline). Then, by phase: a `building` record starts again at the menu with an empty
   * cart and no unsent intent (spec edge case: a reload before submission loses the cart); any
   * phase with a sent submission rebuilds the cart from the frozen lines so the declined screen's
   * Try again has an order to retry.
   */
  if (ev.type === 'RESUME') {
    const restored = ev.interaction ? normalize(ev.interaction, now) : null;
    if (!restored) return toIdle(state, now);
    if (restored.phase === 'building') {
      // an unsent intent is discarded; a sent-and-rejected key is kept for the last check before a new intent
      return { ...initialState, now, menu: state.menu, interaction: { ...restored, screen: 'menu', submission: keptIntent(restored), deadlineAt: restored.deadlineAt } };
    }
    return { ...initialState, now, menu: state.menu, cart: restored.submission ? cartFromFrozen(restored.submission.lines) : initialState.cart, interaction: restored };
  }

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

  // The last check of a kept key: one at a time, from the review screen only, identified so that a
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
    case 'MENU_LOADED': {
      const cart = reflag(state.cart, ev.items);
      let screen = active.screen;
      let submission = active.submission;
      if (i.phase === 'building' && (i.screen === 'review' || i.screen === 'payment')) {
        const unsent = i.submission !== null && i.submission.sentAt === null ? i.submission : null;
        const byId = new Map(ev.items.map((m) => [m.id, m]));
        const repriced = unsent !== null && unsent.lines.some((l) => byId.get(l.itemId)?.priceMinor !== l.unitPriceMinor);
        if (cartBlocker(cart, ev.items) !== null) {
          // a line is flagged or a bound is exceeded: back to the cart with the reason; an unsent intent is discarded (FR-010, FR-006)
          screen = 'menu';
          submission = keptIntent(i);
        } else if (repriced) {
          // the frozen prices are stale: back to the review so the new total is seen before it is frozen again (FR-008)
          screen = 'review';
          submission = keptIntent(i);
        }
      }
      const left = screen !== i.screen;
      return { ...state, now, menu: ev.items, menuLoading: false, cart, activeCheck: left ? null : state.activeCheck, interaction: { ...active, screen, submission } };
    }
    case 'MENU_FAILED':
      if (i.phase !== 'building') return state;
      return { ...state, now, menuLoading: false, error: { kind: 'menu_unreachable' }, interaction: { ...active, screen: 'error' } };
    case 'ADD_ITEM': {
      if (i.phase !== 'building') return state;
      const existing = state.cart.lines.find((l) => l.itemId === ev.itemId)?.quantity ?? 0;
      if (cartChangeBlocker(state.cart, state.menu, ev.itemId, existing + 1)) return { ...state, now, interaction: active };
      return { ...state, now, cart: setLine(state.cart, ev.itemId, existing + 1), interaction: active };
    }
    case 'SET_QTY': {
      if (i.phase !== 'building') return state;
      if (ev.quantity > 0 && cartChangeBlocker(state.cart, state.menu, ev.itemId, ev.quantity)) return { ...state, now, interaction: active };
      return { ...state, now, cart: setLine(state.cart, ev.itemId, Math.max(0, ev.quantity)), interaction: active };
    }
    case 'REMOVE_ITEM':
      if (i.phase !== 'building' && i.phase !== 'declined') return state;
      return { ...state, now, cart: setLine(state.cart, ev.itemId, 0), interaction: { ...active, phase: 'building', screen: 'menu', submission: keptIntent(i) } };
    case 'GO_REVIEW':
      if ((i.phase !== 'building' && i.phase !== 'declined') || !canReview(state.cart, state.menu)) return state;
      return { ...state, now, rejection: null, interaction: { ...active, phase: 'building', screen: 'review', submission: keptIntent(i) } };
    case 'GO_MENU':
      if (i.phase !== 'building' && i.phase !== 'declined') return state;
      return { ...state, now, interaction: { ...active, phase: 'building', screen: 'menu', submission: keptIntent(i) } };
    case 'GO_PAYMENT': {
      if (i.phase !== 'building' || !state.menu || !canReview(state.cart, state.menu)) return state;
      const lines = freeze(state.cart, state.menu);
      const submission: Submission = {
        idempotencyKey: ev.idempotencyKey, lines, expectedTotalMinor: cartTotalMinor(state.cart, state.menu),
        sentAt: null, pollStartedAt: null, knownState: 'none', reference: null, recordedTotalMinor: null, simulation: 'success',
      };
      return { ...state, now, interaction: { ...active, screen: 'payment', submission } };
    }
    case 'BACK_TO_CART':
      // before send only: discards the unsent key (ADR-002). In submitted/unresolved this is refused.
      if (i.phase !== 'building' || i.screen !== 'payment') return state;
      return { ...state, now, interaction: { ...active, screen: 'menu', submission: null } };
    case 'SET_SIMULATION':
      if (i.phase !== 'building' || !i.submission || i.submission.sentAt !== null) return state;
      return { ...state, now, interaction: { ...active, submission: { ...i.submission, simulation: ev.outcome } } };
    case 'PAY':
      if (i.phase !== 'building' || i.screen !== 'payment' || !i.submission || i.submission.sentAt !== null) return state;
      if (!canReview(state.cart, state.menu)) return state; // FR-006 on the client, also after a re-pricing
      return { ...state, now, interaction: { ...active, phase: 'submitted', submission: { ...i.submission, sentAt: now } } };
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
        // a declined key is terminal for that order; a rejected key is kept for the last check
        const kept = i.phase === 'declined' ? null : keptIntent(i);
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
