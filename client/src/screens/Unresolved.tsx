interface Props {
  knownState: 'none' | 'pending';
  reference: string | null;
  onStartNew: () => void;
}

/** S7a (order known to exist) and S7b (nothing confirmed). Neither offers a way to pay again (FR-022). */
export function Unresolved({ knownState, reference, onStartNew }: Props) {
  const known = knownState === 'pending' && reference;
  return (
    <div className="screen" data-screen={known ? 'unresolved-known' : 'unresolved-unknown'}>
      <header className="topbar"><h1>Payment not confirmed</h1></header>
      <div className="content center">
        <div className="card">
          {known ? (
            <>
              <div className="notice warn" role="alert">Your order was received but payment could not be confirmed.</div>
              <p>Please check at the counter with this reference. <strong>Do not pay again.</strong></p>
              <div className="reference" data-reference>{reference}</div>
            </>
          ) : (
            <>
              <div className="notice warn" role="alert">We could not confirm whether your order went through.</div>
              <p>Please check at the counter before ordering again.</p>
            </>
          )}
          <p className="hint">This kiosk is ready for the next order; the counter can resolve your payment.</p>
        </div>
      </div>
      <footer className="actions">
        <span className="spacer" />
        <button className="primary" onClick={onStartNew}>Start new order</button>
      </footer>
    </div>
  );
}
