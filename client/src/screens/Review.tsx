import type { MenuItem } from '../../../shared/wire.ts';
import { formatMinor } from '../money/format.ts';
import { cartTotalMinor } from '../machine/cart.ts';
import type { Cart } from '../machine/types.ts';

interface Props {
  menu: MenuItem[] | null;
  cart: Cart;
  checking: boolean;
  onConfirm: () => void;
  onBack: () => void;
  onStartNew: () => void;
}

export function Review({ menu, cart, checking, onConfirm, onBack, onStartNew }: Props) {
  const byId = new Map((menu ?? []).map((item) => [item.id, item]));
  const total = cartTotalMinor(cart, menu);
  return (
    <div className="screen" data-screen="review">
      <header className="topbar">
        <h1>Review your order</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content center">
        <div className="card">
          {cart.lines.map((line) => {
            const item = byId.get(line.itemId);
            return (
              <div key={line.itemId} className="review-line">
                <span>{item?.name}</span>
                <span className="hint">{line.quantity} × {formatMinor(item?.priceMinor ?? 0)}</span>
                <span>{formatMinor((item?.priceMinor ?? 0) * line.quantity)}</span>
              </div>
            );
          })}
          <div className="total">
            <span>Total to pay</span>
            <span data-total>{formatMinor(total)}</span>
          </div>
          <p className="hint">This is the amount you will be charged. Continue to payment when you are ready.</p>
        </div>
      </div>
      <footer className="actions">
        <button onClick={onBack}>Back</button>
        <span className="spacer" />
        <button className="primary" onClick={onConfirm} disabled={checking} aria-busy={checking}>{checking ? 'Checking…' : 'Continue to payment'}</button>
      </footer>
    </div>
  );
}
