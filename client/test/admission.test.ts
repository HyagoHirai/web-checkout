import { describe, expect, it } from 'vitest';
import { reduce } from '../src/machine/reducer.ts';
import { IID, IID2, K1, K2, interactionOf, response, run, submitted } from './helpers.ts';

const t = 1000;

describe('US9: the five-condition response admission rule (FR-032..FR-034)', () => {
  it('1. an expired interaction admits nothing', () => {
    const s = submitted(t);
    const u = reduce(s, { type: 'TICK', now: t + 38_000 }); // unresolved; deadline 38 s + 90 s
    const late = response(u, { now: t + 200_000, state: 'paid' });
    expect(late).toBe(u);
  });
  it('2. a foreign interaction id is discarded', () => {
    const s = submitted(t);
    expect(response(s, { now: t + 1, state: 'paid', interactionId: IID2 })).toBe(s);
  });
  it('3. a foreign key is discarded: a late K1 result never touches the K2 attempt', () => {
    const declined = response(submitted(t), { now: t + 100, state: 'failed' });
    const k2 = run([{ type: 'TRY_AGAIN', now: t + 200 }, { type: 'GO_PAYMENT', now: t + 300, idempotencyKey: K2 }, { type: 'PAY', now: t + 400 }], declined);
    expect(interactionOf(k2).submission?.idempotencyKey).toBe(K2);
    const lateK1 = response(k2, { now: t + 500, state: 'paid', idempotencyKey: K1 });
    expect(lateK1).toBe(k2);
    const k2Result = response(k2, { now: t + 600, state: 'paid', idempotencyKey: K2 });
    expect(interactionOf(k2Result).phase).toBe('confirmed');
  });
  it('4. nothing leaves confirmed or declined on a response; pending never regresses a terminal', () => {
    const paid = response(submitted(t), { now: t + 100, state: 'paid' });
    expect(interactionOf(paid).phase).toBe('confirmed');
    expect(response(paid, { now: t + 200, state: 'pending_payment', source: 'poll' })).toBe(paid);
    expect(response(paid, { now: t + 200, state: 'failed' })).toBe(paid);
    const failed = response(submitted(t), { now: t + 100, state: 'failed' });
    expect(response(failed, { now: t + 200, state: 'paid' })).toBe(failed);
  });
  it('5. a repeated terminal is not reapplied: resolvedAt does not move', () => {
    const paid = response(submitted(t), { now: t + 100, state: 'paid' });
    expect(interactionOf(paid).resolvedAt).toBe(t + 100);
    const again = response(paid, { now: t + 5000, state: 'paid' });
    expect(again).toBe(paid);
    expect(interactionOf(again).resolvedAt).toBe(t + 100);
  });
  it('S7b upgrades to S7a on the first pending (knownState and reference), never the reverse', () => {
    const s = submitted(t);
    const pending = response(s, { now: t + 500, state: 'pending_payment', reference: 'QQQQ' });
    expect(interactionOf(pending).submission?.knownState).toBe('pending');
    expect(interactionOf(pending).submission?.reference).toBe('QQQQ');
    expect(interactionOf(pending).submission?.pollStartedAt).toBe(t + 500); // early pending starts polling
    const same = response(pending, { now: t + 2500, state: 'pending_payment', source: 'poll', reference: 'QQQQ' });
    expect(same).toBe(pending);
  });
  it('FR-034: a late definitive result on unresolved is applied, for the same intent only', () => {
    const u = reduce(submitted(t), { type: 'TICK', now: t + 38_000 });
    expect(interactionOf(u).phase).toBe('unresolved');
    expect(interactionOf(response(u, { now: t + 60_000, state: 'paid' })).phase).toBe('confirmed');
    expect(interactionOf(response(u, { now: t + 60_000, state: 'failed' })).phase).toBe('declined');
    expect(response(u, { now: t + 60_000, state: 'paid', idempotencyKey: K2 })).toBe(u);
  });
  it('an unknown result on the POST before 8 s starts polling immediately; on a poll it changes nothing', () => {
    const s = submitted(t);
    const early = reduce(s, { type: 'RESPONSE', now: t + 1000, source: 'post', interactionId: IID, idempotencyKey: K1, result: { category: 'unknown', reason: 'network' } });
    expect(interactionOf(early).submission?.pollStartedAt).toBe(t + 1000);
    const poll404 = reduce(early, { type: 'RESPONSE', now: t + 3000, source: 'poll', interactionId: IID, idempotencyKey: K1, result: { category: 'unknown', reason: 'not found' } });
    expect(poll404).toBe(early);
  });
});
