import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { COUNTER_NAMES } from '../../src/observability/counters.ts';
import { makeTestApp, metrics, type TestApp } from '../helpers/app.ts';

let t: TestApp;
beforeEach(async () => { t = await makeTestApp(); });
afterAll(async () => { await t.app.close(); });

describe('observability surface (constitution VI)', () => {
  it('metrics exposes every catalogue key at 0 on a fresh app, with startedAt', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/metrics' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(typeof body.startedAt).toBe('string');
    for (const n of COUNTER_NAMES) expect(body.counters[n]).toBe(0);
  });
  it('accepts a beacon-style text/plain JSON event with 204 and counts it', async () => {
    const ev = { interactionId: randomUUID(), name: 'unresolved_shown', at: Date.now(), detail: { knownState: 'pending' } };
    const r = await t.app.inject({ method: 'POST', url: '/api/events', headers: { 'content-type': 'text/plain;charset=UTF-8' }, payload: JSON.stringify(ev) });
    expect(r.statusCode).toBe(204);
    expect((await metrics(t.app))['client_event.unresolved_shown']).toBe(1);
  });
  it('rejects an unknown event name with 400 and counts the rejection', async () => {
    const ev = { interactionId: randomUUID(), name: 'made_up', at: Date.now() };
    const r = await t.app.inject({ method: 'POST', url: '/api/events', headers: { 'content-type': 'application/json' }, payload: ev });
    expect(r.statusCode).toBe(400);
    expect((await metrics(t.app))['client_event.rejected']).toBe(1);
  });
  it('unknown routes return the JSON error shape', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('not_found');
  });
});
