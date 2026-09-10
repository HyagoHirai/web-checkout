import { MAX_QTY_PER_LINE, MAX_TOTAL_MINOR, MAX_UNITS_PER_ORDER } from '../../../shared/constants.ts';
import type { MenuItem, ValidationRejection } from '../../../shared/wire.ts';
import type { Cart } from './types.ts';

/**
 * Pure cart rules, shared by the reducer and the screens (FR-002..FR-006). Nothing here knows about
 * phases, submissions or the clock.
 */

export type CartBlockReason =
  | 'empty_cart'
  | 'unknown_item'
  | 'item_unavailable'
  | 'quantity_out_of_bounds'
  | 'units_out_of_bounds'
  | 'total_out_of_bounds';

export function cartTotalMinor(cart: Cart, menu: MenuItem[] | null): number {
  if (!menu) return 0;
  const price = new Map(menu.map((m) => [m.id, m.priceMinor]));
  return cart.lines.reduce((sum, l) => sum + (price.get(l.itemId) ?? 0) * l.quantity, 0);
}

export function cartUnits(cart: Cart): number {
  return cart.lines.reduce((s, l) => s + l.quantity, 0);
}

/** Why the cart cannot accept `quantity` of `itemId`; null when it can (FR-003, FR-006). */
export function cartChangeBlocker(cart: Cart, menu: MenuItem[] | null, itemId: string, quantity: number): CartBlockReason | null {
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
 * Why the whole cart cannot be reviewed or frozen; null when it can. A re-pricing after a rejection
 * can push a previously valid cart over a bound, so the bounds are checked here too, not only on
 * quantity changes (FR-006).
 */
export function cartBlocker(cart: Cart, menu: MenuItem[] | null): CartBlockReason | null {
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
 * A valid cart can still be at a limit that stops any further adding; that reason must be visible on
 * screen (FR-006). Null when something can still be added.
 */
export function orderLimitReached(cart: Cart, menu: MenuItem[] | null): 'units_out_of_bounds' | 'total_out_of_bounds' | null {
  if (cartUnits(cart) >= MAX_UNITS_PER_ORDER) return 'units_out_of_bounds';
  // Items already at their per-item maximum explain themselves on their card ("Max 10"); the order-level
  // reason is about the items that could still grow. If every one of those is stopped by the total,
  // the total is the reason, even when other items are at their own maximum (mixed limits).
  const blockers = (menu ?? [])
    .filter((m) => m.available)
    .map((m) => cartChangeBlocker(cart, menu, m.id, (cart.lines.find((l) => l.itemId === m.id)?.quantity ?? 0) + 1))
    .filter((b) => b !== 'quantity_out_of_bounds');
  if (blockers.length === 0) return null;
  return blockers.every((b) => b === 'total_out_of_bounds') ? 'total_out_of_bounds' : null;
}

/** Sets a line's quantity; zero removes the line and clears its flag (FR-004). */
export function setLine(cart: Cart, itemId: string, quantity: number): Cart {
  const lines = cart.lines.filter((l) => l.itemId !== itemId);
  if (quantity > 0) lines.push({ itemId, quantity });
  return { lines, flagged: cart.flagged.filter((f) => f !== itemId || quantity > 0) };
}

/** Lines whose item is gone from the menu or unavailable on it must be acted on before review (FR-010). */
export function reflag(cart: Cart, menu: MenuItem[]): Cart {
  const byId = new Map(menu.map((m) => [m.id, m]));
  const flagged = cart.lines.filter((l) => !byId.get(l.itemId)?.available).map((l) => l.itemId);
  return { ...cart, flagged: [...new Set([...cart.flagged.filter((f) => cart.lines.some((l) => l.itemId === f)), ...flagged])] };
}

/** The menu with the server's current version of the items it reported; nothing is added or removed. */
export function menuWithCurrentItems(menu: MenuItem[] | null, currentItems: MenuItem[] | undefined): MenuItem[] | null {
  if (!menu) return menu;
  const current = new Map((currentItems ?? []).map((item) => [item.id, item]));
  return menu.map((item) => current.get(item.id) ?? item);
}

/**
 * After a 422, the items the server called out are flagged so they must be acted on before the next
 * review (FR-010): the ones it reports unavailable, and the ones it reports unknown. The server
 * omits unknown items from currentItems, so an affected id that is not there is gone from the menu.
 */
export function flagRejectedItems(cart: Cart, rejection: ValidationRejection): Cart {
  const current = rejection.currentItems ?? [];
  const unavailableIds = current.filter((item) => !item.available).map((item) => item.id);
  const reportedIds = new Set(current.map((item) => item.id));
  const unknownIds = rejection.reasons.includes('unknown_item') ? (rejection.affectedItemIds ?? []).filter((id) => !reportedIds.has(id)) : [];
  return { ...cart, flagged: [...new Set([...cart.flagged, ...unavailableIds, ...unknownIds])] };
}
