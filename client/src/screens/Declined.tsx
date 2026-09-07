import { formatMinor } from '../money/format.ts';
import type { FrozenLine } from '../machine/types.ts';

interface Props {
  lines: FrozenLine[];
  totalMinor: number;
  onTryAgain: () => void;
  onEdit: () => void;
  onStartNew: () => void;
}

export function Declined({ lines, totalMinor, onTryAgain, onEdit, onStartNew }: Props) {
  return (
    <div className="screen" data-screen="declined">
      <header className="topbar">
        <h1>Payment declined</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content">
        <div className="card">
          <div className="notice bad" role="alert">The card terminal declined the payment. Nothing was charged. Your items are still here.</div>
          {lines.map((l) => (
            <div key={l.itemId} className="review-line">
              <span>{l.name}</span>
              <span className="hint">{l.quantity} × {formatMinor(l.unitPriceMinor)}</span>
              <span>{formatMinor(l.unitPriceMinor * l.quantity)}</span>
            </div>
          ))}
          <div className="total"><span>Total</span><span>{formatMinor(totalMinor)}</span></div>
          <p className="hint">You can try paying again, or change your order.</p>
        </div>
      </div>
      <footer className="actions">
        <button onClick={onEdit}>Edit order</button>
        <span className="spacer" />
        <button className="primary" onClick={onTryAgain} data-action="try-again">Try again</button>
      </footer>
    </div>
  );
}
