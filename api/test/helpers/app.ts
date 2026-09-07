import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp, type App } from '../../src/app.ts';
import { createCounters, type Counters } from '../../src/observability/counters.ts';
import { createSimulator, type PaymentSimulator, type SimulatorOptions } from '../../src/payment/simulator.ts';
import type { SubmissionHooks } from '../../src/services/orders.ts';
import type { ReferenceGenerator } from '../../src/domain/reference.ts';
import type { OrderSubmission, SimulatedOutcome } from '../../../shared/wire.ts';
import { MENU } from '../../seed/menu.ts';
import { silentLogger, testPool } from './db.ts';
import type { Pool } from '../../src/db/pool.ts';

export interface TestApp {
  app: App;
  pool: Pool;
  simulator: PaymentSimulator;
  counters: Counters;
}

export async function makeTestApp(opts: { simulator?: Partial<SimulatorOptions>; hooks?: SubmissionHooks; referenceGenerator?: ReferenceGenerator } = {}): Promise<TestApp> {
  const pool = testPool();
  const simulator = createSimulator({ defaultOutcome: 'success', latencyMs: 0, acceptClientHint: true, ...opts.simulator });
  const counters = createCounters();
  const app = buildApp({ pool, simulator, logger: silentLogger, counters, hooks: opts.hooks, referenceGenerator: opts.referenceGenerator, boot: { migrations: '0001_initial', seed: 'already-present' } });
  await app.ready();
  return { app, pool, simulator, counters };
}

export const ITEM = Object.fromEntries(MENU.map((m) => [m.slug, m])) as Record<string, (typeof MENU)[number]>;

export function submission(lines: { slug: string; quantity: number }[], overrides: Partial<OrderSubmission> = {}): OrderSubmission {
  const mapped = lines.map((l) => ({ itemId: ITEM[l.slug].id, quantity: l.quantity }));
  const total = lines.reduce((s, l) => s + ITEM[l.slug].priceMinor * l.quantity, 0);
  return { idempotencyKey: randomUUID(), currency: 'USD', expectedTotalMinor: total, lines: mapped, ...overrides };
}

export async function post(app: App, body: unknown, opts: { interactionId?: string; outcome?: SimulatedOutcome } = {}): Promise<LightMyRequestResponse> {
  const payload = opts.outcome && typeof body === 'object' && body ? { ...(body as object), simulation: { outcome: opts.outcome } } : body;
  return app.inject({ method: 'POST', url: '/api/orders', headers: { 'x-interaction-id': opts.interactionId ?? randomUUID(), 'content-type': 'application/json' }, payload: payload as object });
}

export async function lookup(app: App, key: string, interactionId: string = randomUUID()): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/api/orders/by-key/${key}`, headers: { 'x-interaction-id': interactionId } });
}

export async function metrics(app: App): Promise<Record<string, number>> {
  const r = await app.inject({ method: 'GET', url: '/api/metrics' });
  return (r.json() as { counters: Record<string, number> }).counters;
}
