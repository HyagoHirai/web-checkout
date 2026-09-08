import type { MenuItem } from '../../../../shared/wire.ts';
import { cartChangeBlocker, cartTotalMinor } from '../../machine/cart.ts';
import { formatMinor } from '../../money/format.ts';
import type { Cart } from '../../machine/types.ts';
import { getCartHint, getOrderLimitReason } from './copy.ts';

interface Props {
  menu: MenuItem[] | null;
  cart: Cart;
  onSetQty: (id: string, q: number) => void;
  onRemove: (id: string) => void;
  onReview: () => void;
}

/** The order panel: lines with quantity controls, the total, the Review action and the hint under it. */
export function CartPanel({ menu, cart, onSetQty, onRemove, onReview }: Props) {
  const byId = new Map((menu ?? []).map((m) => [m.id, m]));
  const flagged = new Set(cart.flagged);
  const hint = getCartHint(cart, menu);
  const limitReason = hint.blocker === null ? getOrderLimitReason(cart, menu) : null;

  return (
    <aside className="cart" aria-label="Your order">
      <h2>Your order</h2>
      <div className="cart-lines">
        {cart.lines.length === 0 && <p className="hint">Nothing yet. Tap + Add on an item.</p>}
        {cart.lines.map((l) => {
          const m = byId.get(l.itemId);
          const name = m?.name ?? '';
          const isFlagged = flagged.has(l.itemId);
          return (
            <div key={l.itemId} className={`line${isFlagged ? ' flagged' : ''}`} data-line={l.itemId}>
              <div className="line-top">
                <span className="line-name">
                  {m?.name ?? 'Item'}
                  {isFlagged && <> <span className="badge flag">Unavailable, remove</span></>}
                </span>
                <span className="line-price">{formatMinor((m?.priceMinor ?? 0) * l.quantity)}</span>
              </div>
              <div className="line-controls">
                <div className="qty">
                  <button onClick={() => onSetQty(l.itemId, l.quantity - 1)} aria-label={`Fewer ${name}`}>−</button>
                  <span aria-label={`Quantity of ${name}`}>{l.quantity}</span>
                  <button onClick={() => onSetQty(l.itemId, l.quantity + 1)} disabled={isFlagged || cartChangeBlocker(cart, menu, l.itemId, l.quantity + 1) !== null} aria-label={`More ${name}`}>+</button>
                </div>
                <button className="remove" onClick={() => onRemove(l.itemId)} aria-label={`Remove ${name}`}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="cart-foot">
        <div className="total">
          <span>Total</span>
          <span data-total>{formatMinor(cartTotalMinor(cart, menu))}</span>
        </div>
        <button className="primary" onClick={onReview} disabled={hint.blocker !== null}>Review order</button>
        <span className="hint" data-blocker={hint.blocker ?? ''}>{hint.text}</span>
        {limitReason && <span className="hint limit" data-limit="order" role="status">{limitReason}</span>}
      </div>
    </aside>
  );
}
