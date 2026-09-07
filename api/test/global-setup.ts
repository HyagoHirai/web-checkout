import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureTestDatabase, migrateAndSeed, testPool } from './helpers/db.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default async function setup(): Promise<void> {
  if (!process.env.SKIP_COMPOSE) {
    execSync('docker compose up -d --wait db', { cwd: repoRoot, stdio: 'inherit' });
  }
  await ensureTestDatabase();
  const pool = testPool();
  try {
    await migrateAndSeed(pool);
  } finally {
    await pool.end();
  }
}
