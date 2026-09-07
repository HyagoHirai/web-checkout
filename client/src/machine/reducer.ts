import { MAX_QTY_PER_LINE, MAX_TOTAL_MINOR, MAX_UNITS_PER_ORDER } from '../../../shared/constants.ts';
import type { MenuItem, OrderStatus } from '../../../shared/wire.ts';
import { inactivityDeadline, isExpired, waitIsOver } from './deadlines.ts';
import type { Cart, Classified, Event, FrozenLine, Interaction, KnownState, State, Submission } from './types.ts';

export const initialState: State = {
  interaction: null,
  menu: null,
  menuLoading: false,
  cart: { lines: [], flagged: [] },
  rejection: null,
  error: null,
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

export function canReview(cart: Cart): boolean {
  return cart.lines.length > 0 && cart.flagged.length === 0;
}

function setLine(cart: Cart, itemId: string, quantity: number): Cart {
  const lines = cart.lines.filter((l) => l.itemId !== itemId);
  if (quantity > 0) lines.push({ itemId, quantity });
  return { lines, flagged: cart.flagged.filter((f) => f !== itemId || quantity > 0) };
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
  const i = state.interaction;
  if (!i || !i.submission) return state; // 1. no live interaction
  if (isExpired(i, ev.now)) return state; // 1. interaction not valid
  if (!attributed(i, ev)) return state; // 2, 3. interaction and intent
  if (i.phase !== 'submitted' && i.phase !== 'unresolved') return state; // 4. nothing leaves confirmed/declined; 5. terminal not reapplied
  const sub = i.submission;
  const r = ev.result;

  switch (r.category) {
    case 'outcome': {
      const known = knownOf(r.status);
      if (DEFINITENESS[known] < DEFINITENESS[sub.knownState]) return state; // never regress (FR-033)
      const nextSub: Submission = { ...sub, knownState: known, reference: r.status.reference };
      if (known === 'pending') {
        if (sub.knownState === 'pending' && sub.reference === r.status.reference) return state; // nothing new
        // an early pending starts polling now (research R10)
        const pollStartedAt = sub.pollStartedAt ?? ev.now;
        return { ...state, interaction: { ...i, submission: { ...nextSub, pollStartedAt } } };
      }
      if (known === 'paid') {
        return { ...state, interaction: { ...i, phase: 'confirmed', resolvedAt: ev.now, submission: nextSub } };
      }
      // failed: a late decline preserves the deadline in force; an in-time one is ordinary building math
      const deadlineAt = i.phase === 'unresolved' ? inactivityDeadline(i) : null;
      return { ...state, interaction: { ...i, phase: 'declined', screen: 'menu', deadlineAt, submission: nextSub } };
    }
    case 'conflict':
      // an order exists under this key and may be paid: the runtime performs a lookup; nothing changes here
      return state;
    case 'rejected': {
      if (i.phase !== 'submitted') return state;
      const current = new Map((r.rejection.currentItems ?? []).map((m) => [m.id, m]));
      const menu = state.menu ? state.menu.map((m) => current.get(m.id) ?? m) : state.menu;
      const flaggedIds = r.rejection.reasons.includes('item_unavailable')
        ? (r.rejection.currentItems ?? []).filter((m) => !m.available).map((m) => m.id)
        : [];
      return {
        ...state,
        menu,
        cart: { ...state.cart, flagged: [...new Set([...state.cart.flagged, ...flaggedIds])] },
        rejection: { reasons: r.rejection.reasons, affectedItemIds: r.rejection.affectedItemIds ?? [], currentTotalMinor: r.rejection.currentTotalMinor },
        interaction: { ...i, phase: 'building', screen: 'rejected', submission: null },
      };
    }
    case 'bad_request':
    case 'reference_exhausted': {
      if (i.phase !== 'submitted') return state;
      return { ...state, error: { kind: r.category }, interaction: { ...i, phase: 'building', screen: 'error', submission: null } };
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

  if (ev.type === 'RESUME') {
    const restored = ev.interaction;
    if (!restored || restored.phase === 'idle' || isExpired(restored, now)) return toIdle(state, now);
    return { ...initialState, now, menu: state.menu, interaction: restored };
  }

  if (ev.type === 'START') {
    if (i && i.phase !== 'idle') return state;
    return {
      ...initialState, now, menu: state.menu, menuLoading: true,
      interaction: { id: ev.interactionId, startedAt: now, lastActivityAt: now, phase: 'building', screen: 'menu', resolvedAt: null, deadlineAt: null, submission: null },
    };
  }

  if (ev.type === 'START_NEW_ORDER') return toIdle(state, now);

  if (ev.type === 'TICK') {
    if (!i) return { ...state, now };
    if (isExpired(i, now)) return toIdle(state, now);
    if (waitIsOver(i, now)) return { ...state, now, interaction: { ...i, phase: 'unresolved' } };
    return state.now === now ? state : { ...state, now };
  }

  if (ev.type === 'RESPONSE') return applyResponse(state, ev);

  if (!i) return state;
  if (isExpired(i, now)) return toIdle(state, now);
  const active = ACTIVITY.has(ev.type) ? stamp(i, now) : i;

  switch (ev.type) {
    case 'MENU_LOADED':
      return { ...state, now, menu: ev.items, menuLoading: false, interaction: active };
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
      return { ...state, now, cart: setLine(state.cart, ev.itemId, 0), interaction: { ...active, phase: 'building', screen: 'menu', submission: null } };
    case 'GO_REVIEW':
      if ((i.phase !== 'building' && i.phase !== 'declined') || !canReview(state.cart)) return state;
      return { ...state, now, rejection: null, interaction: { ...active, phase: 'building', screen: 'review', submission: null } };
    case 'GO_MENU':
      if (i.phase !== 'building' && i.phase !== 'declined') return state;
      return { ...state, now, interaction: { ...active, phase: 'building', screen: 'menu', submission: null } };
    case 'GO_PAYMENT': {
      if (i.phase !== 'building' || !state.menu || !canReview(state.cart)) return state;
      const lines = freeze(state.cart, state.menu);
      const submission: Submission = {
        idempotencyKey: ev.idempotencyKey, lines, expectedTotalMinor: cartTotalMinor(state.cart, state.menu),
        sentAt: null, pollStartedAt: null, knownState: 'none', reference: null, simulation: 'success',
      };
      return { ...state, now, interaction: { ...active, screen: 'payment', submission } };
    }
    case 'BACK_TO_CART':
      // before send only: discards the key (ADR-002). In submitted/unresolved this is refused.
      if (i.phase !== 'building' || i.screen !== 'payment') return state;
      return { ...state, now, interaction: { ...active, screen: 'menu', submission: null } };
    case 'SET_SIMULATION':
      if (i.phase !== 'building' || !i.submission || i.submission.sentAt !== null) return state;
      return { ...state, now, interaction: { ...active, submission: { ...i.submission, simulation: ev.outcome } } };
    case 'PAY':
      if (i.phase !== 'building' || i.screen !== 'payment' || !i.submission || i.submission.sentAt !== null) return state;
      return { ...state, now, interaction: { ...active, phase: 'submitted', submission: { ...i.submission, sentAt: now } } };
    case 'POLL_START':
      if (i.phase !== 'submitted' || !i.submission || i.submission.pollStartedAt !== null) return state;
      return { ...state, now, interaction: { ...i, submission: { ...i.submission, pollStartedAt: now } } };
    case 'CONTINUE':
      return { ...state, now, interaction: active };
    case 'RETRY_AFTER_ERROR':
      if (i.phase !== 'building' || i.screen !== 'error') return state;
      if (state.error?.kind === 'menu_unreachable') return { ...state, now, error: null, menuLoading: true, interaction: { ...active, screen: 'menu' } };
      return { ...state, now, error: null, interaction: { ...active, screen: canReview(state.cart) ? 'review' : 'menu' } };
    case 'TRY_AGAIN':
      // from declined (new intent, cart intact) or from rejected (re-priced cart)
      if (i.phase === 'declined' || (i.phase === 'building' && i.screen === 'rejected')) {
        const target = canReview(state.cart) ? 'review' : 'menu';
        return { ...state, now, rejection: null, interaction: { ...active, phase: 'building', screen: target, submission: null } };
      }
      return state;
    case 'DONE':
      if (i.phase !== 'confirmed') return state;
      return toIdle(state, now);
    default:
      return state;
  }
}
