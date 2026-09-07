import type { ClientEvent, ClientEventName } from '../../../shared/wire.ts';

/**
 * Best-effort, fire-and-forget (constitution VI). A STRING body goes out as text/plain, which is
 * CORS-safelisted and needs no preflight; the keepalive fetch fallback sets the same type. Never
 * awaited, never throws, no queue.
 */
export function emit(interactionId: string | null, name: ClientEventName, detail?: ClientEvent['detail'], idempotencyKey?: string | null): void {
  if (!interactionId) return;
  const payload: ClientEvent = { interactionId, name, at: Date.now(), ...(idempotencyKey ? { idempotencyKey } : {}), ...(detail ? { detail } : {}) };
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/events', body)) return;
  } catch {
    /* fall through */
  }
  try {
    void fetch('/api/events', { method: 'POST', keepalive: true, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body }).catch(() => undefined);
  } catch {
    /* dropped */
  }
}
