import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, post, submission, type TestApp } from '../helpers/app.ts';
import { countOrders, ordersByKey, truncateOrders } from '../helpers/db.ts';

/** A barrier: every caller waits until N have arrived, then all are released together. */
function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return {
    wait: async () => {
      arrived += 1;
      if (arrived === n) release();
      await gate;
    },
  };
}

describe('US2: N concurrent same-key POSTs (SC-002, ADR-002 "only one request performs the payment")', () => {
  const N = 8; // below pool.max (10): once released, each competitor holds a pool client while blocked on the winner's uncommitted INSERT
  let t: TestApp;
  beforeEach(async () => {
    const b = barrier(N);
    t = await makeTestApp({ hooks: { beforeInsert: () => b.wait() } });
    await truncateOrders(t.pool);
  });
  afterEach(async () => { await t.app.close(); });

  it('creates exactly one order and executes payment exactly once; every response carries the same orderId', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }, { slug: 'cookie', quantity: 2 }]);
    const responses = await Promise.all(Array.from({ length: N }, () => post(t.app, body)));
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200 || s === 202)).toHaveLength(N - 1);
    const ids = new Set(responses.map((r) => r.json().orderId));
    expect(ids.size).toBe(1);
    for (const r of responses) expect(['paid', 'pending_payment']).toContain(r.json().state);
    expect(await countOrders(t.pool)).toBe(1);
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
    const rows = await ordersByKey(t.pool, body.idempotencyKey);
    expect(rows[0].state).toBe('paid');
  });

  it('is deterministic across repeated runs', async () => {
    for (let run = 0; run < 3; run += 1) {
      const b = barrier(N);
      const tt = await makeTestApp({ hooks: { beforeInsert: () => b.wait() } });
      await truncateOrders(tt.pool);
      const body = submission([{ slug: 'latte', quantity: 1 }]);
      const responses = await Promise.all(Array.from({ length: N }, () => post(tt.app, body)));
      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(await countOrders(tt.pool)).toBe(1);
      expect(tt.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
      await tt.app.close();
    }
  });
});
