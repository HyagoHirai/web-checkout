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

export function Payment({ totalMinor, simulation, onSetSimulation, onPay, onBack, onStartNew }: Props) {
  return (
    <div className="screen" data-screen="payment">
      <header className="topbar">
        <h1>Simulated payment</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content">
        <div className="card">
          <div className="notice info">
            This kiosk does not take real cards and nothing will be charged. Choose what the card terminal should answer, then tap Pay.
          </div>
          <div className="big" data-total>{formatMinor(totalMinor)}</div>
          <p className="hint" id="sim-label">What should the card terminal answer?</p>
          <div className="selector" role="group" aria-labelledby="sim-label">
            {OPTIONS.map((o) => (
              <button key={o.value} aria-pressed={simulation === o.value} onClick={() => onSetSimulation(o.value)} data-simulation={o.value}>
                {o.label}
              </button>
            ))}
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
