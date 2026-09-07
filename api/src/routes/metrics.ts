import type { App } from '../app.ts';

export async function metricsRoutes(app: App): Promise<void> {
  app.get('/api/metrics', async () => ({
    startedAt: app.startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - app.startedAt.getTime()) / 1000),
    counters: app.counters.snapshot(),
  }));
}
