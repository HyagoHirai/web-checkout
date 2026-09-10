import { loadConfig, type Config } from './config.ts';
import { createLogger, type Logger } from './observability/logger.ts';
import { createCounters } from './observability/counters.ts';
import { createPool, waitForDatabase, type Pool } from './db/pool.ts';
import { migrate } from './db/migrate.ts';
import { seed } from './db/seed.ts';
import { createSimulator } from './payment/simulator.ts';
import { buildApp, type BootInfo } from './app.ts';

/**
 * Boot sequence (ADR-004, research R13): connect → migrate → seed → simulator → build app. The
 * four startup lines in this order are the evidence that the API does not serve before schema and
 * seed are ready; `startup.listening` is emitted by `main` after listen() resolves. `boot` is
 * callable without listening so tests can assert the sequence.
 */
export async function boot(config: Config, logger: Logger, pool: Pool, counters = createCounters()): Promise<{ app: ReturnType<typeof buildApp>; bootInfo: BootInfo }> {
  await waitForDatabase(pool, logger);
  const migrations = await migrate(pool, logger);
  logger.info({ event: 'startup.migrations_applied', applied: migrations.applied, latest: migrations.latest }, 'migrations applied');
  const seeding = await seed(pool);
  logger.info({ event: 'startup.seed_applied', inserted: seeding.inserted, updated: seeding.updated }, 'seed applied');
  const simulator = createSimulator({
    defaultOutcome: config.simulatorDefaultOutcome,
    latencyMs: config.simulatorLatencyMs,
    acceptClientHint: config.simulatorAcceptClientHint,
  });
  logger.info(
    { event: 'startup.simulator_configured', defaultOutcome: simulator.defaultOutcome, acceptClientHint: simulator.acceptClientHint, latencyMs: simulator.latencyMs },
    'simulator configured',
  );
  const bootInfo: BootInfo = { migrations: migrations.latest, seed: seeding.inserted > 0 ? 'applied' : 'already-present' };
  const app = buildApp({ pool, simulator, logger, counters, boot: bootInfo });
  return { app, bootInfo };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  // One counters instance for the pool and the app, so db.pool_error is counted where it is served.
  const counters = createCounters();
  const pool = createPool(config.databaseUrl, logger, counters);
  try {
    const { app } = await boot(config, logger, pool, counters);
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ event: 'startup.listening', port: config.port }, 'listening');
    const shutdown = (signal: string) => {
      logger.info({ event: 'shutdown.signal', signal }, 'shutting down');
      app.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ event: 'startup.failed', err }, 'startup failed');
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) void main();
