import { INTERACTION_HEADER, type MenuResponse, type OrderStatus, type OrderSubmission, type ValidationRejection } from '../../../shared/wire.ts';
import type { Classified } from '../machine/types.ts';

export type Fetch = typeof fetch;

const STATES = new Set(['pending_payment', 'paid', 'failed']);

function isOrderStatus(value: unknown): value is OrderStatus {
  const candidate = value as Record<string, unknown> | null;
  return (
    !!candidate && typeof candidate === 'object' && typeof candidate.orderId === 'string' && typeof candidate.reference === 'string' && STATES.has(candidate.state as string) &&
    typeof candidate.interactionId === 'string' && Number.isInteger(candidate.totalMinor) && candidate.currency === 'USD' && typeof candidate.replay === 'boolean'
  );
}

function isMenuItem(value: unknown): value is MenuResponse['items'][number] {
  const candidate = value as Record<string, unknown> | null;
  return !!candidate && typeof candidate === 'object' && typeof candidate.id === 'string' && typeof candidate.name === 'string' && Number.isInteger(candidate.priceMinor) && (candidate.priceMinor as number) > 0 && typeof candidate.available === 'boolean';
}

function isMenuResponse(value: unknown): value is MenuResponse {
  const candidate = value as Record<string, unknown> | null;
  return !!candidate && typeof candidate === 'object' && candidate.currency === 'USD' && Array.isArray(candidate.items) && candidate.items.every(isMenuItem);
}

/** Validates every field the reducer consumes, including the optional ones. */
function isRejection(value: unknown): value is ValidationRejection {
  const candidate = value as Record<string, unknown> | null;
  if (!candidate || typeof candidate !== 'object' || candidate.error !== 'validation_rejected') return false;
  if (!Array.isArray(candidate.reasons) || !candidate.reasons.every((r) => typeof r === 'string')) return false;
  if (candidate.currentTotalMinor !== undefined && !Number.isInteger(candidate.currentTotalMinor)) return false;
  if (candidate.affectedItemIds !== undefined && !(Array.isArray(candidate.affectedItemIds) && candidate.affectedItemIds.every((id) => typeof id === 'string'))) return false;
  if (candidate.currentItems !== undefined && !(Array.isArray(candidate.currentItems) && candidate.currentItems.every(isMenuItem))) return false;
  return true;
}

/**
 * The canonical response classification (contracts/openapi.yaml, research R10). Four categories,
 * and never the HTTP status family alone: only a recognised body is evidence about the intent.
 */
export async function classify(response: Response): Promise<Classified> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) {
    return isOrderStatus(body) ? { category: 'outcome', status: body } : { category: 'unknown', reason: `2xx without a recognised body (${response.status})` };
  }
  const errorCode = (body as { error?: unknown } | null)?.error;
  if (response.status === 409 && errorCode === 'intent_mismatch') return { category: 'conflict' };
  if (response.status === 422 && isRejection(body)) return { category: 'rejected', rejection: body };
  if (response.status === 400 && typeof errorCode === 'string') return { category: 'bad_request' };
  if (response.status === 503 && errorCode === 'reference_exhausted') return { category: 'reference_exhausted' };
  return { category: 'unknown', reason: `status ${response.status}` };
}

export function createApi(fetchImpl: Fetch = (...args) => fetch(...args)) {
  return {
    async fetchMenu(): Promise<MenuResponse> {
      const response = await fetchImpl('/api/menu', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`menu ${response.status}`);
      const body: unknown = await response.json();
      if (!isMenuResponse(body)) throw new Error('menu: unrecognised body');
      return body;
    },
    /** Never aborted by the caller (research R10). Never throws: a network failure is returned as `unknown`. */
    async postOrder(submission: OrderSubmission, interactionId: string): Promise<Classified> {
      try {
        const response = await fetchImpl('/api/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', [INTERACTION_HEADER]: interactionId },
          body: JSON.stringify(submission),
        });
        return await classify(response);
      } catch (error) {
        return { category: 'unknown', reason: `network: ${(error as Error).message}` };
      }
    },
    async lookupByKey(key: string, interactionId: string, signal?: AbortSignal): Promise<Classified> {
      try {
        const response = await fetchImpl(`/api/orders/by-key/${key}`, { headers: { accept: 'application/json', [INTERACTION_HEADER]: interactionId }, signal });
        if (response.status === 404) {
          // Only the API's own not_found body is "not found". An HTML 404 from a proxy, invalid JSON or a
          // different error code is an unrecognised answer and proves nothing (contract classification).
          let body: unknown = null;
          try { body = await response.json(); } catch { body = null; }
          const recognised = !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'not_found';
          return recognised ? { category: 'unknown', reason: 'not found', notFound: true } : { category: 'unknown', reason: 'unrecognised 404 body' };
        }
        return await classify(response);
      } catch (error) {
        return { category: 'unknown', reason: `network: ${(error as Error).message}` };
      }
    },
  };
}

export type Api = ReturnType<typeof createApi>;
