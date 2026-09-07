import type { App } from '../app.ts';
import type { MenuResponse } from '../../../shared/wire.ts';
import type { MenuRow } from '../domain/validate.ts';

export async function loadMenu(app: App): Promise<MenuRow[]> {
  const res = await app.pool.query<MenuRow & { sort_order: number }>(
    'SELECT id, name, price_minor, currency, available, sort_order FROM menu_items ORDER BY sort_order, name',
  );
  return res.rows;
}

export async function menuRoutes(app: App): Promise<void> {
  app.get('/api/menu', async (): Promise<MenuResponse> => {
    const rows = await loadMenu(app);
    return {
      currency: 'USD',
      items: rows.map((r) => ({ id: r.id, name: r.name, priceMinor: r.price_minor, currency: 'USD', available: r.available })),
    };
  });
}
