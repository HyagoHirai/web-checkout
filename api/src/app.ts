import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type RawReplyDefaultExpression, type RawRequestDefaultExpression, type RawServerDefault } from 'fastify';
import { UUID_PATTERN } from '../../shared/constants.ts';
import { INTERACTION_HEADER } from '../../shared/wire.ts';
import type { Pool } from './db/pool.ts';
import type { Logger } from './observability/logger.ts';
import { createCounters, type Counters } from './observability/counters.ts';
import type { PaymentSimulator } from './payment/simulator.ts';
import { createOrdersService, type OrdersService, type SubmissionHooks } from './services/orders.ts';
import type { ReferenceGenerator } from './domain/reference.ts';
import { registerErrorHandling } from './plugins/errors.ts';
import { healthRoutes } from './routes/health.ts';
import { metricsRoutes } from './routes/metrics.ts';
import { menuRoutes } from './routes/menu.ts';
import { loadMenu } from './db/menu.ts';
import { ordersRoutes } from './routes/orders.ts';
import { eventsRoutes } from './routes/events.ts';

export type App = FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, Logger>;

export interface BootInfo {
  migrations: string;
  seed: 'applied' | 'already-present';
}

export interface BuildAppOptions {
  pool: Pool;
  simulator: PaymentSimulator;
  logger: Logger;
  counters?: Counters;
  hooks?: SubmissionHooks;
  referenceGenerator?: ReferenceGenerator;
  boot?: BootInfo;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    simulator: PaymentSimulator;
    counters: Counters;
    orders: OrdersService;
    boot: BootInfo;
    startedAt: Date;
  }
}

/**
 * The app factory. Everything is injected so integration tests build the exact production wiring
 * with a test simulator and hooks (research R1, R14). Strict Ajv: no coercion, no stripping, no
 * defaults, so the contract's 400 is real and the fingerprint hashes what the client sent (R8).
 */
export function buildApp(opts: BuildAppOptions): App {
  const counters = opts.counters ?? createCounters();
  const app: App = Fastify({
    loggerInstance: opts.logger,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // Fastify's own request/response lines are replaced by the single `request.completed` line below.
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false, allowUnionTypes: true } },
    childLoggerFactory(logger, bindings, loggerOpts, rawReq) {
      const raw = rawReq.headers[INTERACTION_HEADER];
      const v = Array.isArray(raw) ? raw[0] : raw;
      if (v && UUID_PATTERN.test(v)) bindings.interactionId = v;
      return logger.child(bindings, loggerOpts);
    },
  });

  // Lightweight request logging (excludes health and metrics, which poll every 2 s).
  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/api/health' || request.url === '/api/metrics') return;
    request.log.info({ event: 'request.completed', method: request.method, url: request.url, statusCode: reply.statusCode, elapsedMs: Math.round(reply.elapsedTime) }, 'request completed');
  });

  app.decorate('pool', opts.pool);
  app.decorate('simulator', opts.simulator);
  app.decorate('counters', counters);
  app.decorate('boot', opts.boot ?? { migrations: 'unknown', seed: 'already-present' });
  app.decorate('startedAt', new Date());
  app.decorate(
    'orders',
    createOrdersService({
      pool: opts.pool,
      simulator: opts.simulator,
      counters,
      hooks: opts.hooks,
      referenceGenerator: opts.referenceGenerator,
      loadMenu: () => loadMenu(opts.pool),
    }),
  );

  registerErrorHandling(app);
  app.register(healthRoutes);
  app.register(metricsRoutes);
  app.register(menuRoutes);
  app.register(ordersRoutes);
  app.register(eventsRoutes);

  app.addHook('onClose', async () => {
    await opts.pool.end();
  });
  return app;
}
