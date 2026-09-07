import { CURRENCY, MAX_TOTAL_MINOR, MAX_UNITS_PER_ORDER } from '../../../shared/constants.ts';
import type { MenuItem, OrderSubmission, RejectionReason } from '../../../shared/wire.ts';
import { orderTotalMinor, quantityWithinBounds } from './money.ts';

export interface MenuRow {
  id: string;
  name: string;
  price_minor: number;
  currency: string;
  available: boolean;
}

export interface SnapshotLine {
  itemId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface Snapshot {
  lines: SnapshotLine[];
  currency: string;
  totalMinor: number;
}

export type ValidationResult =
  | { ok: true; snapshot: Snapshot; totalMinor: number }
  | {
      ok: false;
      reasons: RejectionReason[];
      affectedItemIds: string[];
      currentItems: MenuItem[];
      currentTotalMinor?: number;
    };

function toMenuItem(r: MenuRow): MenuItem {
  return { id: r.id, name: r.name, priceMinor: r.price_minor, currency: 'USD', available: r.available };
}

/**
 * The server is the price authority (ADR-003). Every reason is collected, not first-fail, so the
 * client can flag items and refresh prices in one round trip (FR-009, FR-010). The price guarantee is
 * over the TOTAL: per-line movements that leave the total unchanged are accepted.
 */
export function validateSubmission(body: OrderSubmission, menu: readonly MenuRow[]): ValidationResult {
  const reasons = new Set<RejectionReason>();
  const affected = new Set<string>();
  const byId = new Map(menu.map((m) => [m.id, m]));

  if (body.currency !== CURRENCY) reasons.add('currency_unsupported');
  if (body.lines.length === 0) reasons.add('empty_cart');

  const seen = new Set<string>();
  const snapshotLines: SnapshotLine[] = [];
  let units = 0;
  for (const line of body.lines) {
    if (seen.has(line.itemId)) {
      reasons.add('duplicate_item');
      affected.add(line.itemId);
    }
    seen.add(line.itemId);
    if (!quantityWithinBounds(line.quantity)) {
      reasons.add('quantity_out_of_bounds');
      affected.add(line.itemId);
    }
    units += line.quantity;
    const row = byId.get(line.itemId);
    if (!row) {
      reasons.add('unknown_item');
      affected.add(line.itemId);
      continue;
    }
    if (!row.available) {
      reasons.add('item_unavailable');
      affected.add(line.itemId);
    }
    snapshotLines.push({
      itemId: row.id,
      name: row.name,
      unitPriceMinor: row.price_minor,
      quantity: line.quantity,
      lineTotalMinor: row.price_minor * line.quantity,
    });
  }
  if (units > MAX_UNITS_PER_ORDER) reasons.add('units_out_of_bounds');

  const currentTotal = orderTotalMinor(snapshotLines);
  const allKnown = !reasons.has('unknown_item') && !reasons.has('duplicate_item');
  if (allKnown && (currentTotal < 1 || currentTotal > MAX_TOTAL_MINOR)) reasons.add('total_out_of_bounds');
  if (allKnown && body.lines.length > 0 && currentTotal !== body.expectedTotalMinor) {
    reasons.add('price_mismatch');
    for (const l of snapshotLines) affected.add(l.itemId);
  }

  if (reasons.size > 0) {
    const affectedIds = [...affected];
    return {
      ok: false,
      reasons: [...reasons],
      affectedItemIds: affectedIds,
      currentItems: affectedIds.map((id) => byId.get(id)).filter((r): r is MenuRow => !!r).map(toMenuItem),
      ...(allKnown ? { currentTotalMinor: currentTotal } : {}),
    };
  }
  return {
    ok: true,
    totalMinor: currentTotal,
    snapshot: { lines: snapshotLines, currency: CURRENCY, totalMinor: currentTotal },
  };
}
