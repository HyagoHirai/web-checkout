import pg from 'pg';
import { createLogger } from '../../src/observability/logger.ts';
import { migrate } from '../../src/db/migrate.ts';
import { seed } from '../../src/db/seed.ts';
import { createPool, type Pool } from '../../src/db/pool.ts';

export const TEST_DB_NAME = 'webcheckout_test';
const dbPort = process.env.DB_PORT ?? '54329';
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? `postgres://checkout:checkout@127.0.0.1:${dbPort}/${TEST_DB_NAME}`;
const MAINTENANCE_URL = TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres');

export const silentLogger = createLogger('silent');

/** Creates the test database if missing. Only ever touches a database whose name ends in _test. */
export async function ensureTestDatabase(): Promise<void> {
  if (!TEST_DB_NAME.endsWith('_test')) throw new Error('refusing: test database name must end in _test');
  const client = new pg.Client({ connectionString: MAINTENANCE_URL });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB_NAME]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await client.end();
  }
}

export function testPool(): Pool {
  return createPool(TEST_DATABASE_URL, silentLogger);
}

export async function migrateAndSeed(pool: Pool): Promise<void> {
  await migrate(pool, silentLogger);
  await seed(pool);
}

async function guard(pool: Pool): Promise<void> {
  const r = await pool.query<{ db: string }>('SELECT current_database() AS db');
  if (!r.rows[0]?.db.endsWith('_test')) throw new Error(`refusing to mutate non-test database ${r.rows[0]?.db}`);
}

export async function truncateOrders(pool: Pool): Promise<void> {
  await guard(pool);
  await pool.query('TRUNCATE orders');
}

/** Restores the canonical menu after a fixture mutated it. */
export async function resetMenu(pool: Pool): Promise<void> {
  await guard(pool);
  await seed(pool);
}

export async function setMenuItem(pool: Pool, slug: string, patch: { priceMinor?: number; available?: boolean }): Promise<void> {
  await guard(pool);
  if (patch.priceMinor !== undefined) await pool.query('UPDATE menu_items SET price_minor = $2 WHERE slug = $1', [slug, patch.priceMinor]);
  if (patch.available !== undefined) await pool.query('UPDATE menu_items SET available = $2 WHERE slug = $1', [slug, patch.available]);
}

export interface OrderRowView {
  id: string;
  idempotency_key: string;
  reference: string;
  state: string;
  total_minor: number;
  snapshot: { lines: { itemId: string; name: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number }[]; totalMinor: number };
  outcome_recorded_at: string | null;
}

export async function ordersByKey(pool: Pool, key: string): Promise<OrderRowView[]> {
  const r = await pool.query<OrderRowView>('SELECT id, idempotency_key, reference, state, total_minor, snapshot, outcome_recorded_at FROM orders WHERE idempotency_key = $1', [key]);
  return r.rows;
}

export async function countOrders(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM orders');
  return r.rows[0]?.n ?? 0;
}
