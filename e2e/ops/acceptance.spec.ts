import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import pg from 'pg';

/**
 * ADR-004 / constitution X operational acceptance, run against a SEPARATE compose project with its
 * own ports and volume so it never touches the developer's stack.
 *   1. From an empty environment, one command produces a working stack (seed: applied).
 *   2. `down` (no -v) then `up` preserves orders and does not duplicate the seed (seed: already-present).
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const PROJECT = 'webcheckout-accept';
const CLIENT_PORT = process.env.ACCEPT_CLIENT_PORT ?? '8081';
const DB_PORT = process.env.ACCEPT_DB_PORT ?? '54330';
const base = `http://localhost:${CLIENT_PORT}`;
const env = { ...process.env, CLIENT_PORT, DB_PORT, SIMULATOR_LATENCY_MS: '0' };

function compose(args: string): string {
  return execSync(`docker compose -p ${PROJECT} ${args}`, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'inherit'], timeout: 600_000 }).toString();
}

/** Node's fetch keeps sockets alive across `docker compose down`; ask for a fresh one and retry once. */
async function call(url: string, init: RequestInit = {}): Promise<Response> {
  const withClose = { ...init, headers: { ...(init.headers as Record<string, string> | undefined), connection: 'close' } };
  try {
    return await fetch(url, withClose);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return fetch(url, withClose);
  }
}

async function health(): Promise<{ status: string; seed: string; migrations: string }> {
  const r = await call(`${base}/api/health`);
  expect(r.status).toBe(200);
  return (await r.json()) as { status: string; seed: string; migrations: string };
}

async function menuCount(): Promise<number> {
  const c = new pg.Client({ connectionString: `postgres://checkout:checkout@127.0.0.1:${DB_PORT}/webcheckout` });
  await c.connect();
  try {
    return (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM menu_items')).rows[0].n;
  } finally {
    await c.end();
  }
}

test.describe.serial('operational acceptance (ADR-004)', () => {
  test.beforeAll(() => { compose('down -v --remove-orphans'); });
  test.afterAll(() => { compose('down -v --remove-orphans'); });

  let key = '';
  let reference = '';
  let menuBefore = 0;

  test('1. from an empty environment, one command brings up a working stack', async () => {
    compose('up --build -d --wait --wait-timeout 300');
    const h = await health();
    expect(h.status).toBe('ok');
    expect(h.seed).toBe('applied');
    expect(h.migrations).toBe('0001_initial');
    const menu = (await (await call(`${base}/api/menu`)).json()) as { items: { id: string; name: string; available: boolean }[] };
    expect(menu.items.length).toBeGreaterThanOrEqual(8);
    menuBefore = await menuCount();

    key = randomUUID();
    const coffee = menu.items.find((i) => i.name === 'Coffee')!;
    const res = await call(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-interaction-id': randomUUID() },
      body: JSON.stringify({ idempotencyKey: key, currency: 'USD', expectedTotalMinor: 350, lines: [{ itemId: coffee.id, quantity: 1 }] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { reference: string; state: string };
    expect(body.state).toBe('paid');
    reference = body.reference;
  });

  test('2. down (no -v) then up preserves the order and does not duplicate the seed', async () => {
    compose('down');
    compose('up -d --wait --wait-timeout 300');
    const h = await health();
    expect(h.seed).toBe('already-present');
    const res = await call(`${base}/api/orders/by-key/${key}`, { headers: { 'x-interaction-id': randomUUID() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reference: string; state: string };
    expect(body.reference).toBe(reference);
    expect(body.state).toBe('paid');
    expect(await menuCount()).toBe(menuBefore);
    // and the startup log proves the seed converged nothing
    const logs = compose('logs api');
    expect(logs).toMatch(/"event":"startup\.seed_applied","inserted":0,"updated":0/);
  });

  test('3. docker compose restart (a different code path) also preserves the order', async () => {
    compose('restart');
    compose('up -d --wait --wait-timeout 300');
    const res = await call(`${base}/api/orders/by-key/${key}`, { headers: { 'x-interaction-id': randomUUID() } });
    expect(res.status).toBe(200);
  });
});
