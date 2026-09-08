import type { Pool } from './pool.ts';
import type { MenuRow } from '../domain/validate.ts';

/** The menu as the price authority sees it (ADR-003). Shared by the menu route and the orders service. */
export async function loadMenu(pool: Pool): Promise<MenuRow[]> {
  const res = await pool.query<MenuRow & { sort_order: number }>(
    'SELECT id, name, price_minor, currency, available, sort_order FROM menu_items ORDER BY sort_order, name',
  );
  return res.rows;
}
