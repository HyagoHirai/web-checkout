export function Idle({ onStart }: { onStart: () => void }) {
  return (
    <main className="idle" data-screen="idle">
      <h1>Snack Bar</h1>
      <p className="hint">Order and pay here. Tap the button to begin.</p>
      <button className="primary" onClick={onStart} autoFocus>
        Start your order
      </button>
    </main>
  );
}
