import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, metrics, post, submission, type TestApp } from '../helpers/app.ts';
import { countOrders, ordersByKey, truncateOrders } from '../helpers/db.ts';

let t: TestApp;
beforeEach(async () => { t = await makeTestApp(); await truncateOrders(t.pool); });
afterEach(async () => { await t.app.close(); });

describe('US6: a definitive decline (FR-020, FR-021)', () => {
  it('records failed, returns 201 failed (not 402), and a replay stays failed', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const res = await post(t.app, body, { outcome: 'declined' });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('failed');
    expect((await ordersByKey(t.pool, body.idempotencyKey))[0].state).toBe('failed');
    expect((await metrics(t.app))['payment.executed.declined']).toBe(1);
    const replay = await post(t.app, body, { outcome: 'success' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().state).toBe('failed');
  });
  it('confirming again is a new order under a new key', async () => {
    const first = submission([{ slug: 'coffee', quantity: 1 }]);
    await post(t.app, first, { outcome: 'declined' });
    const second = submission([{ slug: 'coffee', quantity: 1 }]);
    const res = await post(t.app, second, { outcome: 'success' });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('paid');
    expect(await countOrders(t.pool)).toBe(2);
  });
});
