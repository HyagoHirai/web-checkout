import { hash } from 'node:crypto';
import type { OrderLine } from '../../../shared/wire.ts';

export interface CanonicalIntent {
  currency: string;
  expectedTotalMinor: number;
  lines: readonly OrderLine[];
}

/** Code-point comparison; never localeCompare, which is locale- and ICU-dependent (research R7). */
function byItemId(a: OrderLine, b: OrderLine): number {
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

/**
 * Canonical JSON of the intent with literal key order, hashed with SHA-256. `simulation.*` and the
 * interaction id are never part of it (ADR-002 "The key is bound to the payload"; research R7).
 */
export function canonicalIntent(intent: CanonicalIntent): string {
  const lines = [...intent.lines]
    .sort(byItemId)
    .map((l) => `{"itemId":${JSON.stringify(l.itemId)},"quantity":${l.quantity}}`)
    .join(',');
  return `{"currency":${JSON.stringify(intent.currency)},"expectedTotalMinor":${intent.expectedTotalMinor},"lines":[${lines}]}`;
}

export function fingerprint(intent: CanonicalIntent): string {
  return hash('sha256', canonicalIntent(intent), 'hex');
}
