import { formatMinor } from '../money/format.ts';

export function Confirmed({ reference, totalMinor, onDone }: { reference: string; totalMinor: number; onDone: () => void }) {
  return (
    <div className="screen" data-screen="confirmed">
      <header className="topbar"><h1>Thank you</h1></header>
      <div className="content">
        <div className="card" style={{ textAlign: 'center' }}>
          <h2>Payment confirmed, {formatMinor(totalMinor)}</h2>
          <p>Your order reference is</p>
          <div className="reference" data-reference>{reference}</div>
          <p className="hint">Quote this at the counter. This screen resets by itself in a few seconds.</p>
        </div>
      </div>
      <footer className="actions">
        <span className="spacer" />
        <button className="primary" onClick={onDone}>Done</button>
      </footer>
    </div>
  );
}
