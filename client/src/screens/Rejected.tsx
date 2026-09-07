import type { MenuItem } from '../../../shared/wire.ts';
import { formatMinor } from '../money/format.ts';
import type { Cart, Rejection } from '../machine/types.ts';

interface Props {
  rejection: Rejection;
  menu: MenuItem[] | null;
  cart: Cart;
  onReviewAgain: () => void;
  onStartNew: () => void;
}

const COPY: Record<string, string> = {
  price_mismatch: 'A price changed while you were ordering. Here is the current price.',
  item_unavailable: 'An item in your order is no longer available.',
  unknown_item: 'An item in your order could not be found on the menu.',
  duplicate_item: 'Your order listed the same item twice.',
  empty_cart: 'Your order was empty.',
  quantity_out_of_bounds: 'Too many of one item.',
  units_out_of_bounds: 'Too many items in one order.',
  total_out_of_bounds: 'The order total is above the limit.',
  currency_unsupported: 'Unsupported currency.',
};

export function Rejected({ rejection, menu, cart, onReviewAgain, onStartNew }: Props) {
  const byId = new Map((menu ?? []).map((m) => [m.id, m]));
  const unavailable = rejection.reasons.includes('item_unavailable');
  return (
    <div className="screen" data-screen="rejected">
      <header className="topbar">
        <h1>Please check your order</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content">
        <div className="card">
          <div className="notice warn" role="alert">Nothing has been charged. {rejection.reasons.map((r) => COPY[r] ?? r).join(' ')}</div>
          {rejection.affectedItemIds.map((id) => {
            const m = byId.get(id);
            const line = cart.lines.find((l) => l.itemId === id);
            if (!m) return null;
            return (
              <div key={id} className="review-line" data-affected={id}>
                <span>{m.name}{!m.available && <span className="badge flag">Unavailable</span>}</span>
                <span className="hint">{line ? `${line.quantity} ×` : ''} {formatMinor(m.priceMinor)}</span>
                <span>{line ? formatMinor(m.priceMinor * line.quantity) : ''}</span>
              </div>
            );
          })}
          {rejection.currentTotalMinor !== undefined && (
            <div className="total"><span>New total</span><span data-total>{formatMinor(rejection.currentTotalMinor)}</span></div>
          )}
          <p className="hint">{unavailable ? 'Remove the unavailable item, then review and confirm again.' : 'Review the new total and confirm again if you are happy with it.'}</p>
        </div>
      </div>
      <footer className="actions">
        <span className="spacer" />
        <button className="primary" onClick={onReviewAgain} data-action="review-again">{unavailable ? 'Fix my order' : 'Review again'}</button>
      </footer>
    </div>
  );
}
