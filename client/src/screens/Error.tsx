import type { ErrorInfo } from '../machine/types.ts';

const TITLE: Record<ErrorInfo['kind'], string> = {
  menu_unreachable: 'Something went wrong',
  bad_request: 'We could not place your order',
  reference_exhausted: 'We could not place your order',
  lookup_failed: 'We could not check your previous attempt',
};

const CAUSE: Record<ErrorInfo['kind'], string> = {
  menu_unreachable: 'We could not reach the ordering service.',
  bad_request: 'Something went wrong with the request.',
  reference_exhausted: 'The system could not issue an order reference.',
  lookup_failed: 'The ordering service did not answer.',
};

/**
 * S9. "Nothing has been charged" is said only when no sent key is kept. While a rejected key is kept,
 * its outcome is unknown (ADR-002 "The validation window"), so the copy says the previous attempt has
 * not been checked and that nothing new was started, and never asserts absence of a charge.
 */
export function ErrorScreen({ error, hasKeptKey, onTryAgain, onStartNew }: { error: ErrorInfo; hasKeptKey: boolean; onTryAgain: () => void; onStartNew: () => void }) {
  const body = hasKeptKey
    ? `${CAUSE[error.kind]} Your previous attempt has not been checked and nothing new has been started. Please try again in a moment.`
    : `${CAUSE[error.kind]} Nothing has been charged. Please try again.`;
  return (
    <div className="screen" data-screen="error">
      <header className="topbar"><h1>{TITLE[error.kind]}</h1></header>
      <div className="content center">
        <div className="card">
          <div className="notice bad" role="alert">{body}</div>
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
