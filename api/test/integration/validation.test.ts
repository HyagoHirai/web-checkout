import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, metrics, post, submission, ITEM, type TestApp } from '../helpers/app.ts';
import { countOrders, ordersByKey, resetMenu, setMenuItem, truncateOrders } from '../helpers/db.ts';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
  await truncateOrders(t.pool);
  await resetMenu(t.pool);
});
afterAll(async () => { await resetMenu(t.pool); await t.app.close(); });

describe('US1: bounds and availability enforced independently by the server (FR-003, FR-006)', () => {
  it('rejects quantity 11 with no row and leaves the key usable', async () => {
    const body = submission([{ slug: 'coffee', quantity: 11 }]);
    const res = await post(t.app, body);
    expect(res.statusCode).toBe(400); // schema bound: 1..10
    expect(await countOrders(t.pool)).toBe(0);
    const ok = await post(t.app, { ...body, lines: [{ itemId: ITEM.coffee.id, quantity: 10 }], expectedTotalMinor: 3500 });
    expect(ok.statusCode).toBe(201);
  });
  it('rejects 51 units and 100001 cents in code, accepts exactly 50 and exactly 100000', async () => {
    await setMenuItem(t.pool, 'sandwich', { priceMinor: 20000 });
    const fiftyOne = submission([{ slug: 'coffee', quantity: 10 }, { slug: 'latte', quantity: 10 }, { slug: 'iced-tea', quantity: 10 }, { slug: 'water', quantity: 10 }, { slug: 'bagel', quantity: 10 }, { slug: 'cookie', quantity: 1 }]);
    const r1 = await post(t.app, fiftyOne);
    expect(r1.statusCode).toBe(422);
    expect(r1.json().reasons).toContain('units_out_of_bounds');
    const fifty = submission([{ slug: 'coffee', quantity: 10 }, { slug: 'latte', quantity: 10 }, { slug: 'iced-tea', quantity: 10 }, { slug: 'water', quantity: 10 }, { slug: 'bagel', quantity: 10 }]);
    expect((await post(t.app, fifty)).statusCode).toBe(201);
    // the helper prices from the seed constants; the sandwich is now 20000 in the database
    const exact = submission([{ slug: 'sandwich', quantity: 5 }], { expectedTotalMinor: 100000 });
    expect((await post(t.app, exact)).statusCode).toBe(201);
    // expectedTotalMinor 100000 passes the schema; the recomputed total is 100275, so code rejects it
    const over = submission([{ slug: 'sandwich', quantity: 5 }, { slug: 'cookie', quantity: 1 }], { expectedTotalMinor: 100000 });
    const r4 = await post(t.app, over);
    expect(r4.statusCode).toBe(422);
    expect(r4.json().reasons).toContain('total_out_of_bounds');
    // and a client that sends the true 100275 is stopped by the schema bound
    const r5 = await post(t.app, { ...over, expectedTotalMinor: 100275 });
    expect(r5.statusCode).toBe(400);
  });
  it('rejects an unavailable item with currentItems and no row', async () => {
    const body = submission([{ slug: 'soup', quantity: 1 }]);
    const res = await post(t.app, body);
    expect(res.statusCode).toBe(422);
    expect(res.json().reasons).toEqual(['item_unavailable']);
    expect(res.json().currentItems[0]).toMatchObject({ id: ITEM.soup.id, available: false });
    expect(res.json().affectedItemIds).toEqual([ITEM.soup.id]);
    expect(await ordersByKey(t.pool, body.idempotencyKey)).toHaveLength(0);
  });
  it('rejects an empty cart and a string total at the schema (400), never coerces', async () => {
    const empty = await post(t.app, { ...submission([{ slug: 'coffee', quantity: 1 }]), lines: [] });
    expect(empty.statusCode).toBe(400);
    const str = await post(t.app, { ...submission([{ slug: 'coffee', quantity: 1 }]), expectedTotalMinor: '350' });
    expect(str.statusCode).toBe(400);
    const extra = await post(t.app, { ...submission([{ slug: 'coffee', quantity: 1 }]), unitPriceMinor: 1 });
    expect(extra.statusCode).toBe(400);
    expect(await countOrders(t.pool)).toBe(0);
  });
});

describe('US3: the server is the price authority over the TOTAL (FR-008, FR-009, ADR-003)', () => {
  it('rejects a total mismatch before payment with the current total and items, no row, key reusable', async () => {
    const body = submission([{ slug: 'coffee', quantity: 2 }]);
    await setMenuItem(t.pool, 'coffee', { priceMinor: 400 });
    const res = await post(t.app, body);
    expect(res.statusCode).toBe(422);
    expect(res.json().reasons).toEqual(['price_mismatch']);
    expect(res.json().currentTotalMinor).toBe(800);
    expect(res.json().currentItems[0]).toMatchObject({ id: ITEM.coffee.id, priceMinor: 400 });
    expect(await countOrders(t.pool)).toBe(0);
    expect(t.simulator.calls()).toHaveLength(0);
    const again = await post(t.app, { ...body, expectedTotalMinor: 800 });
    expect(again.statusCode).toBe(201);
    expect(again.json().totalMinor).toBe(800);
    expect((await metrics(t.app))['orders.validation_rejected.price_mismatch']).toBe(1);
  });
  it('accepts equal-and-opposite price moves that leave the total unchanged', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }, { slug: 'latte', quantity: 1 }]); // 825
    await setMenuItem(t.pool, 'coffee', { priceMinor: 375 });
    await setMenuItem(t.pool, 'latte', { priceMinor: 450 });
    const res = await post(t.app, body);
    expect(res.statusCode).toBe(201);
    expect(res.json().totalMinor).toBe(825);
  });
});

describe('US7: availability is checked at the validation point (FR-010)', () => {
  it('returns both reasons when an item is unavailable and the total moved', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }, { slug: 'latte', quantity: 1 }]);
    await setMenuItem(t.pool, 'coffee', { available: false });
    await setMenuItem(t.pool, 'latte', { priceMinor: 500 });
    const res = await post(t.app, body);
    expect(res.statusCode).toBe(422);
    expect(new Set(res.json().reasons)).toEqual(new Set(['item_unavailable', 'price_mismatch']));
    expect(res.json().affectedItemIds).toEqual(expect.arrayContaining([ITEM.coffee.id, ITEM.latte.id]));
  });
});
