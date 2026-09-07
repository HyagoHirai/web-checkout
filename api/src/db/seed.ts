import type { Pool } from './pool.ts';
import { MENU, type SeedMenuItem } from '../../seed/menu.ts';

export interface SeedResult {
  inserted: number;
  updated: number;
}

/**
 * Converging upsert in ONE statement (research R11). The WHERE compares the canonical menu columns
 * explicitly and excludes updated_at, which would otherwise always differ; updated_at moves only
 * when a canonical column actually changes. Re-running never duplicates (ADR-004); a restart puts
 * fixture-mutated rows back. Orders are unaffected: their snapshot is frozen at acceptance.
 */
export async function seed(pool: Pool, items: readonly SeedMenuItem[] = MENU): Promise<SeedResult> {
  const res = await pool.query<{ inserted: boolean }>(
    `INSERT INTO menu_items (id, slug, name, price_minor, currency, available, sort_order)
     SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::text[], $4::integer[], $5::text[], $6::boolean[], $7::integer[])
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       price_minor = EXCLUDED.price_minor,
       currency = EXCLUDED.currency,
       available = EXCLUDED.available,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()
     WHERE (menu_items.name, menu_items.price_minor, menu_items.currency, menu_items.available, menu_items.sort_order)
        IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.price_minor, EXCLUDED.currency, EXCLUDED.available, EXCLUDED.sort_order)
     RETURNING (xmax = 0) AS inserted`,
    [
      items.map((i) => i.id),
      items.map((i) => i.slug),
      items.map((i) => i.name),
      items.map((i) => i.priceMinor),
      items.map(() => 'USD'),
      items.map((i) => i.available),
      items.map((i) => i.sortOrder),
    ],
  );
  let inserted = 0;
  let updated = 0;
  for (const r of res.rows) {
    if (r.inserted) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated };
}
