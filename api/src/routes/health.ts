import type { App } from '../app.ts';

export async function healthRoutes(app: App): Promise<void> {
  app.get('/api/health', async (_request, reply) => {
    try {
      await app.pool.query('SELECT 1');
    } catch {
      reply.code(503);
      return { status: 'unavailable' };
    }
    return { status: 'ok', migrations: app.boot.migrations, seed: app.boot.seed };
  });
}
