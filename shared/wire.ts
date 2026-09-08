/**
 * Wire types mirroring specs/001-web-checkout/contracts/openapi.yaml. The contract is the source of
 * truth; these types exist so the client and the API share one vocabulary.
 */

export type Currency = 'USD';
export type OrderState = 'pending_payment' | 'paid' | 'failed';

export const SIMULATED_OUTCOMES = ['success', 'declined', 'inconclusive'] as const;
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number];

export interface MenuItem {
  id: string;
  name: string;
  priceMinor: number;
  currency: Currency;
  available: boolean;
}

export interface MenuResponse {
  currency: Currency;
  items: MenuItem[];
}

export interface OrderLine {
  itemId: string;
  quantity: number;
}

export interface OrderSubmission {
  idempotencyKey: string;
  currency: Currency;
  expectedTotalMinor: number;
  lines: OrderLine[];
  simulation?: { outcome: SimulatedOutcome };
}

export interface OrderStatus {
  orderId: string;
  reference: string;
  state: OrderState;
  totalMinor: number;
  currency: Currency;
  interactionId: string;
  replay: boolean;
}

export const REJECTION_REASONS = [
  'price_mismatch',
  'item_unavailable',
  'unknown_item',
  'duplicate_item',
  'empty_cart',
  'quantity_out_of_bounds',
  'units_out_of_bounds',
  'total_out_of_bounds',
  'currency_unsupported',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface ValidationRejection {
  error: 'validation_rejected';
  reasons: RejectionReason[];
  interactionId: string;
  currentTotalMinor?: number;
  currentItems?: MenuItem[];
  affectedItemIds?: string[];
}

export interface IntentMismatch {
  error: 'intent_mismatch';
  interactionId: string;
}

export interface ApiError {
  error: string;
  requestId?: string;
  interactionId?: string;
}

export interface HealthResponse {
  status: 'ok';
  migrations: string;
  seed: 'applied' | 'already-present';
}

export interface MetricsResponse {
  startedAt: string;
  uptimeSeconds: number;
  counters: Record<string, number>;
}

export const CLIENT_EVENT_NAMES = [
  'unresolved_shown',
  'late_result_applied',
  'stale_response_discarded',
  'foreign_response_discarded',
  'interaction_expired',
  'service_unreachable',
  'rejection_shown',
] as const;
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

export interface ClientEvent {
  interactionId: string;
  idempotencyKey?: string;
  name: ClientEventName;
  at: number;
  detail?: Record<string, string | number | boolean>;
}

export const INTERACTION_HEADER = 'x-interaction-id';
