import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.ts';
import type { Logger } from '../observability/logger.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 7_331_001;

export interface MigrationResult {
  applied: string[];
  latest: string;
}

/**
 * Hand-rolled runner (research R11): ordered SQL files applied in ONE transaction under an advisory
 * lock, recorded in schema_migrations. Files must not contain BEGIN/COMMIT and are run through the
 * simple query protocol (parameter-less client.query), which allows multi-statement batches.
 */
export async function migrate(pool: Pool, logger: Logger, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const client = await pool.connect();
  const applied: string[] = [];
  let current = '';
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const recorded = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version),
    );
    const onDisk = new Set(files.map((f) => f.replace(/\.sql$/, '')));
    for (const v of recorded) {
      if (!onDisk.has(v)) throw new Error(`schema_migrations records ${v} but no such file exists in ${dir}; refusing to continue`);
    }
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (recorded.has(version)) continue;
      current = file;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      applied.push(version);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    logger.error({ event: 'migration.failed', file: current || null, code: (err as { code?: string }).code, err }, 'migration failed');
    throw err;
  } finally {
    client.release();
  }
  const all = [...files.map((f) => f.replace(/\.sql$/, ''))];
  return { applied, latest: all[all.length - 1] ?? '' };
}
