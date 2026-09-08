import { INTERACTION_HEADER, type MenuResponse, type OrderStatus, type OrderSubmission, type ValidationRejection } from '../../../shared/wire.ts';
import type { Classified } from '../machine/types.ts';

export type Fetch = typeof fetch;

const STATES = new Set(['pending_payment', 'paid', 'failed']);

function isOrderStatus(v: unknown): v is OrderStatus {
  const o = v as Record<string, unknown> | null;
  return (
    !!o && typeof o === 'object' && typeof o.orderId === 'string' && typeof o.reference === 'string' && STATES.has(o.state as string) &&
    typeof o.interactionId === 'string' && Number.isInteger(o.totalMinor) && o.currency === 'USD' && typeof o.replay === 'boolean'
  );
}

function isMenuItem(v: unknown): v is MenuResponse['items'][number] {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && typeof o.name === 'string' && Number.isInteger(o.priceMinor) && (o.priceMinor as number) > 0 && typeof o.available === 'boolean';
}

function isMenuResponse(v: unknown): v is MenuResponse {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && o.currency === 'USD' && Array.isArray(o.items) && o.items.every(isMenuItem);
}

function isRejection(v: unknown): v is ValidationRejection {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && o.error === 'validation_rejected' && Array.isArray(o.reasons);
}

/**
 * The canonical response classification (contracts/openapi.yaml, research R10). Four categories,
 * and never the HTTP status family alone: only a recognised body is evidence about the intent.
 */
export async function classify(res: Response): Promise<Classified> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) {
    return isOrderStatus(body) ? { category: 'outcome', status: body } : { category: 'unknown', reason: `2xx without a recognised body (${res.status})` };
  }
  const err = (body as { error?: unknown } | null)?.error;
  if (res.status === 409 && err === 'intent_mismatch') return { category: 'conflict' };
  if (res.status === 422 && isRejection(body)) return { category: 'rejected', rejection: body };
  if (res.status === 400 && typeof err === 'string') return { category: 'bad_request' };
  if (res.status === 503 && err === 'reference_exhausted') return { category: 'reference_exhausted' };
  return { category: 'unknown', reason: `status ${res.status}` };
}

export function createApi(fetchImpl: Fetch = (...a) => fetch(...a)) {
  return {
    async fetchMenu(): Promise<MenuResponse> {
      const res = await fetchImpl('/api/menu', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`menu ${res.status}`);
      const body: unknown = await res.json();
      if (!isMenuResponse(body)) throw new Error('menu: unrecognised body');
      return body;
    },
    /** Never aborted by the caller (research R10). Rejects only on a network failure. */
    async postOrder(submission: OrderSubmission, interactionId: string): Promise<Classified> {
      try {
        const res = await fetchImpl('/api/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', [INTERACTION_HEADER]: interactionId },
          body: JSON.stringify(submission),
        });
        return await classify(res);
      } catch (e) {
        return { category: 'unknown', reason: `network: ${(e as Error).message}` };
      }
    },
    async lookupByKey(key: string, interactionId: string, signal?: AbortSignal): Promise<Classified> {
      try {
        const res = await fetchImpl(`/api/orders/by-key/${key}`, { headers: { accept: 'application/json', [INTERACTION_HEADER]: interactionId }, signal });
        if (res.status === 404) {
          // Only the API's own not_found body is "not found". An HTML 404 from a proxy, invalid JSON or a
          // different error code is an unrecognised answer and proves nothing (contract classification).
          let body: unknown = null;
          try { body = await res.json(); } catch { body = null; }
          const recognised = !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'not_found';
          return recognised ? { category: 'unknown', reason: 'not found', notFound: true } : { category: 'unknown', reason: 'unrecognised 404 body' };
        }
        return await classify(res);
      } catch (e) {
        return { category: 'unknown', reason: `network: ${(e as Error).message}` };
      }
    },
  };
}

export type Api = ReturnType<typeof createApi>;
