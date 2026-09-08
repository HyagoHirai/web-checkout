import type { ErrorInfo } from '../machine/types.ts';

const COPY: Record<ErrorInfo['kind'], { title: string; body: string }> = {
  menu_unreachable: { title: 'Something went wrong', body: 'We could not reach the ordering service. Nothing has been charged.' },
  bad_request: { title: 'We could not place your order', body: 'Something went wrong with the request. Nothing has been charged. Please try again.' },
  reference_exhausted: { title: 'We could not place your order', body: 'The system could not issue an order reference. Nothing has been charged. Please try again.' },
};

export function ErrorScreen({ error, onTryAgain, onStartNew }: { error: ErrorInfo; onTryAgain: () => void; onStartNew: () => void }) {
  const c = COPY[error.kind];
  return (
    <div className="screen" data-screen="error">
      <header className="topbar"><h1>{c.title}</h1></header>
      <div className="content center">
        <div className="card">
          <div className="notice bad" role="alert">{c.body}</div>
          <p className="hint">Tap Try again to retry, or Start new order to begin from the start.</p>
        </div>
      </div>
      <footer className="actions">
        <button className="quiet" onClick={onStartNew}>Start new order</button>
        <span className="spacer" />
        <button className="primary" onClick={onTryAgain} data-action="try-again">Try again</button>
      </footer>
    </div>
  );
}
