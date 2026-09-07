export function InactivityWarning({ secondsLeft, onContinue, onStartNew }: { secondsLeft: number; onContinue: () => void; onStartNew: () => void }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="warn-title" data-screen="inactivity-warning">
      <div className="card">
        <h2 id="warn-title">Are you still there?</h2>
        <p>This screen will reset in</p>
        <div className="countdown" aria-live="polite">{secondsLeft} s</div>
        <p className="hint">Tap Continue to keep your order.</p>
        <div className="actions">
          <button className="primary" onClick={onContinue}>Continue</button>
          <button className="quiet" onClick={onStartNew}>Start new order</button>
        </div>
      </div>
    </div>
  );
}
