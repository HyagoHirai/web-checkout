import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { lookup, makeTestApp, metrics, post, submission, type TestApp } from '../helpers/app.ts';
import { truncateOrders } from '../helpers/db.ts';

let t: TestApp;
beforeEach(async () => { t = await makeTestApp(); await truncateOrders(t.pool); });
afterAll(async () => { await t.app.close(); });

describe('US4: status lookup by key (ADR-002 "Recovery when the client loses state")', () => {
  it('returns each state and echoes the request interaction id', async () => {
    for (const [outcome, state] of [['success', 'paid'], ['declined', 'failed'], ['inconclusive', 'pending_payment']] as const) {
      const body = submission([{ slug: 'coffee', quantity: 1 }]);
      await post(t.app, body, { outcome });
      const iid = randomUUID();
      const res = await lookup(t.app, body.idempotencyKey, iid);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state, interactionId: iid, replay: true });
    }
    const m = await metrics(t.app);
    expect(m['status_lookup.paid']).toBe(1);
    expect(m['status_lookup.failed']).toBe(1);
    expect(m['status_lookup.pending_payment']).toBe(1);
  });
  it('404 not_found for an unknown key; 400 for a malformed key', async () => {
    const res = await lookup(t.app, randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
    expect((await metrics(t.app))['status_lookup.not_found']).toBe(1);
    expect((await lookup(t.app, 'ABCD')).statusCode).toBe(400);
  });
});
