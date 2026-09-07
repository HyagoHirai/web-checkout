import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { REFERENCE_PATTERN } from '../../../shared/constants.ts';
import { makeTestApp, metrics, post, submission, type TestApp } from '../helpers/app.ts';
import { ordersByKey, truncateOrders } from '../helpers/db.ts';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
  await truncateOrders(t.pool);
});
afterAll(async () => { await t.app.close(); });

describe('US1: submit and pay (happy path)', () => {
  it('accepts, executes payment once, records paid, returns a counter reference', async () => {
    const body = submission([{ slug: 'coffee', quantity: 2 }, { slug: 'latte', quantity: 1 }]);
    const interactionId = randomUUID();
    const res = await post(t.app, body, { interactionId });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.state).toBe('paid');
    expect(json.replay).toBe(false);
    expect(json.reference).toMatch(REFERENCE_PATTERN);
    expect(json.totalMinor).toBe(1175);
    expect(json.interactionId).toBe(interactionId);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();

    const rows = await ordersByKey(t.pool, body.idempotencyKey);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('paid');
    expect(rows[0].outcome_recorded_at).not.toBeNull();
    expect(rows[0].snapshot.lines.map((l) => [l.name, l.unitPriceMinor, l.quantity, l.lineTotalMinor])).toEqual([
      ['Coffee', 350, 2, 700],
      ['Latte', 475, 1, 475],
    ]);
    expect(t.simulator.callsFor(body.idempotencyKey)).toHaveLength(1);
    const m = await metrics(t.app);
    expect(m['orders.accepted']).toBe(1);
    expect(m['payment.executed.success']).toBe(1);
    expect(m['payment.outcome_recorded']).toBe(1);
  });

  it('serves the menu with prices and availability, and health with boot info', async () => {
    const menu = await t.app.inject({ method: 'GET', url: '/api/menu' });
    expect(menu.statusCode).toBe(200);
    const items = menu.json().items as { id: string; name: string; priceMinor: number; available: boolean }[];
    expect(items.length).toBeGreaterThanOrEqual(8);
    expect(items.some((i) => i.available === false)).toBe(true);
    expect(items.every((i) => Number.isInteger(i.priceMinor) && i.priceMinor > 0)).toBe(true);
    const health = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', migrations: '0001_initial', seed: 'already-present' });
  });

  it('requires the interaction header and rejects a malformed one before touching the key', async () => {
    const body = submission([{ slug: 'coffee', quantity: 1 }]);
    const noHeader = await t.app.inject({ method: 'POST', url: '/api/orders', payload: body });
    expect(noHeader.statusCode).toBe(400);
    const bad = await t.app.inject({ method: 'POST', url: '/api/orders', headers: { 'x-interaction-id': 'NOT-A-UUID' }, payload: body });
    expect(bad.statusCode).toBe(400);
    expect(await ordersByKey(t.pool, body.idempotencyKey)).toHaveLength(0);
  });
});
