import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { boot } from '../../src/server.ts';
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
});
