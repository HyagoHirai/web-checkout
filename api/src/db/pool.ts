import pg from 'pg';
import type { Logger } from '../observability/logger.ts';
import type { Counters } from '../observability/counters.ts';

export type Pool = pg.Pool;

/**
 * One pool per process. Bounds on the database steps (research R15): connect 5 s, statement 5 s.
 * The error listener is mandatory: when the db container restarts, idle clients emit `error`, and an
 * EventEmitter without a listener throws and kills the process.
 */
export function createPool(databaseUrl: string, logger: Logger, counters?: Counters): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: '-c statement_timeout=5000',
  });
  pool.on('error', (err) => {
    counters?.inc('db.pool_error');
    logger.warn({ event: 'db.pool_error', err }, 'idle database client error');
  });
  return pool;
}

const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', '57P03', '08006', '08001']);

/** Retry `SELECT 1` until the database accepts connections, for at most `maxMs`. */
export async function waitForDatabase(pool: Pool, logger: Logger, maxMs = 60_000): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const elapsed = Date.now() - start;
      if (!RETRYABLE.has(code) && !/timeout/i.test(String((err as Error).message))) throw err;
      if (elapsed > maxMs) throw err;
      logger.info({ event: 'db.waiting', attempt, code, elapsedMs: elapsed }, 'database not ready yet');
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}
