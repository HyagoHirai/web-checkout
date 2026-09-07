import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, metrics, post, submission, type TestApp } from '../helpers/app.ts';
import { countOrders, truncateOrders } from '../helpers/db.ts';

let t: TestApp;
afterEach(async () => { await t.app.close(); });

describe('FR-012: reference uniqueness and collision retry (research R7)', () => {
  it('retries on a collision with a distinct reference and counts it', async () => {
    const seq = ['AAAA', 'AAAA', 'BBBB'];
    let i = 0;
    t = await makeTestApp({ referenceGenerator: () => seq[Math.min(i++, seq.length - 1)] });
    await truncateOrders(t.pool);
    const first = await post(t.app, submission([{ slug: 'coffee', quantity: 1 }]));
    expect(first.json().reference).toBe('AAAA');
    const second = await post(t.app, submission([{ slug: 'coffee', quantity: 1 }]));
    expect(second.statusCode).toBe(201);
    expect(second.json().reference).toBe('BBBB');
    expect((await metrics(t.app))['order_reference.collision']).toBe(1);
  });
  it('after five collisions returns 503 reference_exhausted with no row and the key reusable', async () => {
    t = await makeTestApp({ referenceGenerator: () => 'CCCC' });
    await truncateOrders(t.pool);
    await post(t.app, submission([{ slug: 'coffee', quantity: 1 }]));
    const body = submission([{ slug: 'latte', quantity: 1 }]);
    const res = await post(t.app, body);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('reference_exhausted');
    expect(await countOrders(t.pool)).toBe(1);
    expect((await metrics(t.app))['order_reference.exhausted']).toBe(1);
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(0);
  });
});
