import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createRuntime } from './machine/runtime.ts';
import './styles.css';

/** Timers and fetches live in the runtime, not in effects, so StrictMode's double-invocation is harmless. */
const runtime = createRuntime();
runtime.boot();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
