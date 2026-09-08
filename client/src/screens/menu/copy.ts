import { MAX_QTY_PER_LINE, MAX_TOTAL_MINOR, MAX_UNITS_PER_ORDER } from '../../../../shared/constants.ts';
import type { MenuItem } from '../../../../shared/wire.ts';
import { cartBlocker, orderLimitReached, type CartBlockReason } from '../../machine/cart.ts';
import { formatMinor } from '../../money/format.ts';
import type { Cart } from '../../machine/types.ts';

/** Customer-facing copy for every reason the cart rules can produce. Checked by the compiler against CartBlockReason. */
export const BLOCK_COPY: Record<CartBlockReason, string> = {
  empty_cart: 'Add at least one item to continue.',
  unknown_item: 'This item is no longer on the menu.',
  item_unavailable: 'This item is not available right now.',
  quantity_out_of_bounds: `At most ${MAX_QTY_PER_LINE} of any one item.`,
  units_out_of_bounds: `At most ${MAX_UNITS_PER_ORDER} items per order.`,
  total_out_of_bounds: `Orders are limited to ${formatMinor(MAX_TOTAL_MINOR)}.`,
};

/** The one line under the Review control that says what to do next (NFR-002). */
export function getCartHint(cart: Cart, menu: MenuItem[] | null): { blocker: CartBlockReason | null; text: string } {
  const blocker = cartBlocker(cart, menu);
  if (blocker === null) return { blocker, text: 'Review your order to pay.' };
  if (blocker === 'item_unavailable') return { blocker, text: 'Remove the unavailable item to continue.' };
  if (blocker === 'empty_cart') return { blocker, text: BLOCK_COPY.empty_cart };
  return { blocker, text: `Reduce your order to continue. ${BLOCK_COPY[blocker]}` };
}

/** Why nothing more can be added to a still-valid cart, or null (FR-006, visible on screen). */
export function getOrderLimitReason(cart: Cart, menu: MenuItem[] | null): string | null {
  const reason = orderLimitReached(cart, menu);
  return reason === null ? null : BLOCK_COPY[reason];
}
