import type { SimulatedOutcome } from '../../../shared/wire.ts';
import { formatMinor } from '../money/format.ts';

interface Props {
  totalMinor: number;
  simulation: SimulatedOutcome;
  onSetSimulation: (o: SimulatedOutcome) => void;
  onPay: () => void;
  onBack: () => void;
  onStartNew: () => void;
}

const OPTIONS: { value: SimulatedOutcome; label: string }[] = [
  { value: 'success', label: 'Approve' },
  { value: 'declined', label: 'Decline' },
  { value: 'inconclusive', label: 'No answer' },
];

/** Hierarchy: step title (top bar), the total, a short simulation notice, the selector as secondary, then Pay. */
export function Payment({ totalMinor, simulation, onSetSimulation, onPay, onBack, onStartNew }: Props) {
  return (
    <div className="screen" data-screen="payment">
      <header className="topbar">
        <h1>Simulated payment</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content center">
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>Amount to pay</p>
          <div className="amount" data-total>{formatMinor(totalMinor)}</div>
          <p className="hint" style={{ margin: 0 }}>This kiosk does not take real cards and nothing will be charged.</p>
          <div className="sim">
            <p className="hint" id="sim-label">What should the card terminal answer?</p>
            <p className="fine">Choose an answer, then tap Pay.</p>
            <div className="selector" role="group" aria-labelledby="sim-label">
              {OPTIONS.map((o) => (
                <button key={o.value} className="secondary" aria-pressed={simulation === o.value} onClick={() => onSetSimulation(o.value)} data-simulation={o.value}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <footer className="actions">
        <button onClick={onBack}>Back</button>
        <span className="spacer" />
        <button className="primary" onClick={onPay} data-action="pay">Pay {formatMinor(totalMinor)}</button>
      </footer>
    </div>
  );
}
