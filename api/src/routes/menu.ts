import type { App } from '../app.ts';
import type { MenuResponse } from '../../../shared/wire.ts';
import { loadMenu } from '../db/menu.ts';

export async function menuRoutes(app: App): Promise<void> {
  app.get('/api/menu', async (): Promise<MenuResponse> => {
    const rows = await loadMenu(app.pool);
    return {
      currency: 'USD',
      items: rows.map((r) => ({ id: r.id, name: r.name, priceMinor: r.price_minor, currency: 'USD', available: r.available })),
    };
  });
}
