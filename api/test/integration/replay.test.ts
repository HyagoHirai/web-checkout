import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, metrics, post, submission, ITEM, type TestApp } from '../helpers/app.ts';
import { countOrders, ordersByKey, resetMenu, setMenuItem, truncateOrders } from '../helpers/db.ts';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
  await truncateOrders(t.pool);
  await resetMenu(t.pool);
});
afterEach(async () => { await resetMenu(t.pool); await t.app.close(); });

describe('US2: replay semantics (ADR-002 "Replay behaviour", FR-014..FR-018)', () => {
  it('replays a paid order with the recorded state and executes nothing', async () => {
    const body = submission([{ slug: 'coffee', quantity: 2 }]);
    const first = await post(t.app, body);
    expect(first.statusCode).toBe(201);
    const again = await post(t.app, body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ orderId: first.json().orderId, state: 'paid', replay: true, reference: first.json().reference });
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
    expect(await countOrders(t.pool)).toBe(1);
    expect((await metrics(t.app))['orders.replayed.paid']).toBe(1);
  });
  it('a replay carrying a different simulation hint never changes a recorded outcome', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    await post(t.app, body, { outcome: 'declined' });
    const replay = await post(t.app, body, { outcome: 'success' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().state).toBe('failed');
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
  });
  it('a replay is never re-validated against the menu: price change and unavailability are ignored (FR-018)', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const first = await post(t.app, body);
    await setMenuItem(t.pool, 'coffee', { priceMinor: 999, available: false });
    const replay = await post(t.app, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ state: 'paid', totalMinor: 350, orderId: first.json().orderId });
  });
  it('a known key with different content is rejected and the existing order is untouched', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const first = await post(t.app, body);
    const tampered = await post(t.app, { ...body, lines: [{ itemId: ITEM.coffee.id, quantity: 2 }], expectedTotalMinor: 700 });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().error).toBe('intent_mismatch');
    const rows = await ordersByKey(t.pool, body.idempotencyKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.json().orderId);
    expect(rows[0].total_minor).toBe(350);
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
    expect((await metrics(t.app))['orders.intent_mismatch']).toBe(1);
  });
  it('two genuinely separate orders with identical items are both accepted (FR-015)', async () => {
    const a = submission([{ slug: 'bagel', quantity: 1 }]);
    const b = submission([{ slug: 'bagel', quantity: 1 }]);
    expect((await post(t.app, a)).statusCode).toBe(201);
    expect((await post(t.app, b)).statusCode).toBe(201);
    expect(await countOrders(t.pool)).toBe(2);
  });
  it('the fingerprint is stable under line reordering', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }, { slug: 'latte', quantity: 2 }]);
    await post(t.app, body);
    const reordered = await post(t.app, { ...body, lines: [...body.lines].reverse() });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().replay).toBe(true);
  });
  it('a replay of a pending order reports pending without executing (202)', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const first = await post(t.app, body, { outcome: 'inconclusive' });
    expect(first.statusCode).toBe(202);
    const replay = await post(t.app, body, { outcome: 'success' });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().state).toBe('pending_payment');
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
  });
});
