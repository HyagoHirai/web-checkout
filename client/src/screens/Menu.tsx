import type { MenuItem } from '../../../shared/wire.ts';
import { MAX_QTY_PER_LINE, MAX_UNITS_PER_ORDER, MAX_TOTAL_MINOR } from '../../../shared/constants.ts';
import { formatMinor } from '../money/format.ts';
import { cartBlocker, cartChangeBlocker, cartTotalMinor } from '../machine/reducer.ts';
import type { Cart } from '../machine/types.ts';

interface Props {
  menu: MenuItem[] | null;
  loading: boolean;
  cart: Cart;
  onAdd: (id: string) => void;
  onSetQty: (id: string, q: number) => void;
  onRemove: (id: string) => void;
  onReview: () => void;
  onStartNew: () => void;
}

const BLOCK_COPY: Record<string, string> = {
  quantity_out_of_bounds: `At most ${MAX_QTY_PER_LINE} of any one item.`,
  units_out_of_bounds: `At most ${MAX_UNITS_PER_ORDER} items per order.`,
  total_out_of_bounds: `Orders are limited to ${formatMinor(MAX_TOTAL_MINOR)}.`,
  item_unavailable: 'This item is not available right now.',
};

export function Menu({ menu, loading, cart, onAdd, onSetQty, onRemove, onReview, onStartNew }: Props) {
  const byId = new Map((menu ?? []).map((m) => [m.id, m]));
  const total = cartTotalMinor(cart, menu);
  const flagged = new Set(cart.flagged);
  const blocker = cartBlocker(cart, menu);
  const reviewable = blocker === null;
  // Presentation only: available items first, unavailable ones after (item 10 of the UI pass).
  const available = (menu ?? []).filter((m) => m.available);
  const unavailable = (menu ?? []).filter((m) => !m.available);

  const hint = reviewable
    ? 'Review your order to pay.'
    : blocker === 'item_unavailable'
      ? 'Remove the unavailable item to continue.'
      : blocker === 'empty_cart'
        ? 'Add at least one item to continue.'
        : `Reduce your order to continue. ${BLOCK_COPY[blocker] ?? ''}`;

  return (
    <div className="screen" data-screen="menu">
      <header className="topbar">
        <h1>Choose your items</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content">
        <div className="menu-layout">
          <section className="menu-scroll" aria-label="Menu">
            {flagged.size > 0 && (
              <div className="notice bad" role="alert">
                An item in your order is no longer available. Remove it to continue; the rest of your order is kept.
              </div>
            )}
            {loading && !menu && <p className="hint">Loading the menu…</p>}
            <div className="menu">
              {available.map((m) => {
                const existing = cart.lines.find((l) => l.itemId === m.id)?.quantity ?? 0;
                const changeBlocker = cartChangeBlocker(cart, menu, m.id, existing + 1);
                return (
                  <div key={m.id} className="item" data-item={m.id}>
                    <div className="name">{m.name}</div>
                    <div className="row">
                      <span className="price">{formatMinor(m.priceMinor)}</span>
                      <button onClick={() => onAdd(m.id)} disabled={changeBlocker !== null} aria-label={`Add ${m.name}`} title={changeBlocker ? BLOCK_COPY[changeBlocker] : undefined}>
                        + Add
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {unavailable.length > 0 && (
              <div className="menu unavailable-list" aria-label="Unavailable today">
                {unavailable.map((m) => (
                  <div key={m.id} className="item unavailable" data-item={m.id}>
                    <div className="name">
                      {m.name} <span className="badge">Unavailable</span>
                    </div>
                    <div className="row">
                      <span className="price">{formatMinor(m.priceMinor)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <aside className="cart" aria-label="Your order">
            <h2>Your order</h2>
            <div className="cart-lines">
              {cart.lines.length === 0 && <p className="hint">Nothing yet. Tap + Add on an item.</p>}
              {cart.lines.map((l) => {
                const m = byId.get(l.itemId);
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
                        <button onClick={() => onSetQty(l.itemId, l.quantity - 1)} aria-label={`Fewer ${m?.name ?? ''}`}>−</button>
                        <span aria-label={`Quantity of ${m?.name ?? ''}`}>{l.quantity}</span>
                        <button onClick={() => onSetQty(l.itemId, l.quantity + 1)} disabled={isFlagged || cartChangeBlocker(cart, menu, l.itemId, l.quantity + 1) !== null} aria-label={`More ${m?.name ?? ''}`}>+</button>
                      </div>
                      <button className="remove" onClick={() => onRemove(l.itemId)} aria-label={`Remove ${m?.name ?? ''}`}>Remove</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="cart-foot">
              <div className="total">
                <span>Total</span>
                <span data-total>{formatMinor(total)}</span>
              </div>
              <button className="primary" onClick={onReview} disabled={!reviewable}>Review order</button>
              <span className="hint" data-blocker={blocker ?? ''}>{hint}</span>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
