import type { MenuItem } from '../../../shared/wire.ts';
import { formatMinor } from '../money/format.ts';
import { cartTotalMinor } from '../machine/reducer.ts';
import type { Cart } from '../machine/types.ts';

interface Props {
  menu: MenuItem[] | null;
  cart: Cart;
  onConfirm: () => void;
  onBack: () => void;
  onStartNew: () => void;
}

export function Review({ menu, cart, onConfirm, onBack, onStartNew }: Props) {
  const byId = new Map((menu ?? []).map((m) => [m.id, m]));
  const total = cartTotalMinor(cart, menu);
  return (
    <div className="screen" data-screen="review">
      <header className="topbar">
        <h1>Review your order</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content">
        <div className="card">
          {cart.lines.map((l) => {
            const m = byId.get(l.itemId);
            return (
              <div key={l.itemId} className="review-line">
                <span>{m?.name}</span>
                <span className="hint">{l.quantity} × {formatMinor(m?.priceMinor ?? 0)}</span>
                <span>{formatMinor((m?.priceMinor ?? 0) * l.quantity)}</span>
              </div>
            );
          })}
          <div className="total">
            <span>Total to pay</span>
            <span data-total>{formatMinor(total)}</span>
          </div>
          <p className="hint">This is the amount you will be charged. Tap Confirm and pay to continue.</p>
        </div>
      </div>
      <footer className="actions">
        <button onClick={onBack}>Back</button>
        <span className="spacer" />
        <button className="primary" onClick={onConfirm}>Confirm and pay {formatMinor(total)}</button>
      </footer>
    </div>
  );
}
