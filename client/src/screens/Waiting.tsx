export function Waiting({ onStartNew }: { onStartNew: () => void }) {
  return (
    <div className="screen" data-screen="waiting" aria-busy="true">
      <header className="topbar">
        <h1>Processing your payment</h1>
        <button className="quiet" onClick={onStartNew}>Start new order</button>
      </header>
      <div className="content">
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="spinner" aria-hidden="true" />
          <p className="big">Please wait</p>
          <p className="hint">We are confirming your payment. Do not tap Pay again.</p>
          <button className="primary" disabled data-action="pay">Paying…</button>
        </div>
      </div>
      <footer className="actions" />
    </div>
  );
}
