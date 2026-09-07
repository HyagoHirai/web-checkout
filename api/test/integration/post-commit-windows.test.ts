import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, metrics, post, submission, type TestApp } from '../helpers/app.ts';
import { ordersByKey, testPool, truncateOrders } from '../helpers/db.ts';

let t: TestApp;
afterEach(async () => { await t.app.close(); });

describe('US4: an exception in either post-commit window leaves the row pending_payment, never failed (constitution III, ADR-002)', () => {
  it('after COMMIT, before the simulator call: 0 executions, row pending, replay executes nothing', async () => {
    t = await makeTestApp({ hooks: { afterCommit: () => { throw new Error('boom after commit'); } } });
    await truncateOrders(t.pool);
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const res = await post(t.app, body);
    expect(res.statusCode).toBe(500);
    const other = testPool();
    try {
      const rows = await ordersByKey(other, body.idempotencyKey);
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('pending_payment');
    } finally { await other.end(); }
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(0);
    expect((await metrics(t.app))['payment.post_commit_exception']).toBe(1);
    const replay = await post(t.app, body);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().state).toBe('pending_payment');
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(0);
  });

  it('after the simulator call, before recording: 1 execution, row pending, replay executes nothing', async () => {
    t = await makeTestApp({ hooks: { afterPayment: () => { throw new Error('boom after payment'); } } });
    await truncateOrders(t.pool);
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const res = await post(t.app, body);
    expect(res.statusCode).toBe(500);
    const rows = await ordersByKey(t.pool, body.idempotencyKey);
    expect(rows[0].state).toBe('pending_payment');
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
    const replay = await post(t.app, body);
    expect(replay.statusCode).toBe(202);
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
  });

  it('inconclusive leaves the row pending_payment and returns 202 with the reference', async () => {
    t = await makeTestApp();
    await truncateOrders(t.pool);
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const res = await post(t.app, body, { outcome: 'inconclusive' });
    expect(res.statusCode).toBe(202);
    expect(res.json().state).toBe('pending_payment');
    expect(res.json().reference).toMatch(/^[A-Z2-9]{4}$/);
    expect((await ordersByKey(t.pool, body.idempotencyKey))[0].state).toBe('pending_payment');
    expect((await metrics(t.app))['payment.executed.inconclusive']).toBe(1);
  });

  it('a 0-row outcome UPDATE is a 500, never a fabricated outcome', async () => {
    t = await makeTestApp({
      hooks: {
        afterPayment: async ({ orderId }) => {
          const other = testPool();
          try { await other.query(`UPDATE orders SET state = 'paid', outcome_recorded_at = now() WHERE id = $1`, [orderId]); } finally { await other.end(); }
        },
      },
    });
    await truncateOrders(t.pool);
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const res = await post(t.app, body, { outcome: 'declined' });
    expect(res.statusCode).toBe(500);
    expect((await ordersByKey(t.pool, body.idempotencyKey))[0].state).toBe('paid');
    expect((await metrics(t.app))['payment.outcome_record_failed']).toBe(1);
  });
});
