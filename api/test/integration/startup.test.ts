import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { boot } from '../../src/server.ts';
import { createCounters } from '../../src/observability/counters.ts';
import { createPool } from '../../src/db/pool.ts';
import { TEST_DATABASE_URL, testPool } from '../helpers/db.ts';

interface Line { event?: string; inserted?: number; updated?: number }

function collectingLogger(lines: Line[]) {
  return pino({ level: 'info' }, { write: (s: string) => { lines.push(JSON.parse(s) as Line); } });
}

describe('startup ordering (ADR-004, research R13)', () => {
  it('logs migrations → seed → simulator before the app exists, and a second run seeds nothing', async () => {
    const config = { databaseUrl: TEST_DATABASE_URL, port: 0, logLevel: 'info', simulatorDefaultOutcome: 'success' as const, simulatorAcceptClientHint: true, simulatorLatencyMs: 0 };
    const lines: Line[] = [];
    const pool = testPool();
    const { app } = await boot(config, collectingLogger(lines), pool);
    await app.close();
    const events = lines.map((l) => l.event).filter((e) => e?.startsWith('startup.'));
    expect(events).toEqual(['startup.migrations_applied', 'startup.seed_applied', 'startup.simulator_configured']);
    const seedLine = lines.find((l) => l.event === 'startup.seed_applied');
    expect(seedLine?.inserted).toBe(0);
    expect(seedLine?.updated).toBe(0);
  });

  it('a pool error on the production wiring is counted where it is served', async () => {
    const config = { databaseUrl: TEST_DATABASE_URL, port: 0, logLevel: 'silent', simulatorDefaultOutcome: 'success' as const, simulatorAcceptClientHint: true, simulatorLatencyMs: 0 };
    const logger = pino({ level: 'silent' });
    const counters = createCounters();
    const pool = createPool(TEST_DATABASE_URL, logger, counters);
    const { app } = await boot(config, logger, pool, counters);
    try {
      pool.emit('error', new Error('idle client dropped'));
      const r = await app.inject({ method: 'GET', url: '/api/metrics' });
      expect(r.json().counters['db.pool_error']).toBe(1);
    } finally {
      await app.close();
    }
  });
});
