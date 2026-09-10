import { CLIENT_EVENT_NAMES, REJECTION_REASONS, SIMULATED_OUTCOMES } from '../../../shared/wire.ts';

/** The full catalogue from research R13. Every key exists at 0 so /api/metrics has a stable shape. */
export const COUNTER_NAMES: readonly string[] = [
  'orders.accepted',
  'orders.replayed.paid',
  'orders.replayed.failed',
  'orders.replayed.pending_payment',
  ...REJECTION_REASONS.map((r) => `orders.validation_rejected.${r}`),
  'orders.intent_mismatch',
  ...SIMULATED_OUTCOMES.map((o) => `payment.executed.${o}`),
  'payment.outcome_recorded',
  'payment.outcome_record_failed',
  'payment.post_commit_exception',
  'order_reference.collision',
  'order_reference.exhausted',
  'status_lookup.paid',
  'status_lookup.failed',
  'status_lookup.pending_payment',
  'status_lookup.not_found',
  ...CLIENT_EVENT_NAMES.map((n) => `client_event.${n}`),
  'client_event.rejected',
  'server.unhandled_error',
  'db.pool_error',
];

export interface Counters {
  inc(name: string, by?: number): void;
  get(name: string): number;
  snapshot(): Record<string, number>;
  reset(): void;
}

/** Simple in-process counters. Created per app instance, never a module singleton (research R13). */
export function createCounters(names: readonly string[] = COUNTER_NAMES): Counters {
  const map = new Map<string, number>();
  for (const name of names) map.set(name, 0);
  return {
    inc(name, by = 1) {
      if (!map.has(name)) throw new Error(`Unknown counter ${name}; register it in COUNTER_NAMES`);
      map.set(name, (map.get(name) ?? 0) + by);
    },
    get(name) {
      const value = map.get(name);
      if (value === undefined) throw new Error(`Unknown counter ${name}`);
      return value;
    },
    snapshot() {
      return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
    reset() {
      for (const name of map.keys()) map.set(name, 0);
    },
  };
}
