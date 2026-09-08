import { describe, expect, it } from 'vitest';
import { reduce } from '../src/machine/reducer.ts';
import { atPayment, COFFEE, IID, IID2, K1, K2, interactionOf, response, run, status, submitted } from './helpers.ts';
import type { Classified } from '../src/machine/types.ts';

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

function rejected(priceNow: number) {
  return reduce(submitted(t), {
    type: 'RESPONSE', now: t + 1, source: 'post', interactionId: IID, idempotencyKey: K1,
    result: { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: priceNow * 2, currentItems: [{ ...COFFEE, priceMinor: priceNow }], affectedItemIds: [COFFEE.id] } },
  });
}

describe('a rejected key is retained until a new intent replaces it (ADR-002 "The validation window")', () => {
  it('after a 422 the key is kept, cannot be re-sent, and a later paid for it is admitted with the recorded total', () => {
    const s = rejected(400);
    expect(interactionOf(s).submission?.idempotencyKey).toBe(K1);
    const later = response(s, { now: t + 5000, state: 'paid', source: 'lookup' });
    expect(interactionOf(later).phase).toBe('confirmed');
    expect(interactionOf(later).submission?.recordedTotalMinor).toBe(700);
    expect(later.rejection).toBeNull();
  });
  it('a later pending for the kept key goes to unresolved (S7a); a failed goes to declined', () => {
    const pending = response(rejected(400), { now: t + 5000, state: 'pending_payment', source: 'lookup', reference: 'PEND' });
    expect(interactionOf(pending).phase).toBe('unresolved');
    expect(interactionOf(pending).submission?.knownState).toBe('pending');
    const failed = response(rejected(400), { now: t + 5000, state: 'failed', source: 'lookup' });
    expect(interactionOf(failed).phase).toBe('declined');
  });
  it('the kept key survives editing the cart and a reload; an unsent key does not', () => {
    const edited = run([{ type: 'TRY_AGAIN', now: t + 2 }, { type: 'GO_MENU', now: t + 3 }, { type: 'ADD_ITEM', now: t + 4, itemId: COFFEE.id }], rejected(400));
    expect(interactionOf(edited).submission?.idempotencyKey).toBe(K1);
    const reloaded = reduce({ ...edited, interaction: null }, { type: 'RESUME', now: t + 10, interaction: interactionOf(edited) });
    expect(interactionOf(reloaded).submission?.idempotencyKey).toBe(K1);
    const unsent = reduce({ ...atPayment(t), interaction: null }, { type: 'RESUME', now: t + 10, interaction: interactionOf(atPayment(t)) });
    expect(interactionOf(unsent).submission).toBeNull();
  });
  it('a new intent replaces the kept key at GO_PAYMENT', () => {
    const again = run([{ type: 'TRY_AGAIN', now: t + 2 }, { type: 'GO_PAYMENT', now: t + 3, idempotencyKey: K2 }], rejected(400));
    expect(interactionOf(again).submission?.idempotencyKey).toBe(K2);
    expect(interactionOf(again).submission?.expectedTotalMinor).toBe(800);
    // and K1's late result is now foreign to the live attempt
    expect(response(again, { now: t + 4, state: 'paid', idempotencyKey: K1, source: 'lookup' })).toBe(again);
  });
});


describe('a lookup after a 409 shows the recorded total, not the conflicting attempt', () => {
  it('confirmed carries recordedTotalMinor from the lookup while the frozen intent keeps what it sent', () => {
    const s = submitted(t); // expected 700
    const looked = reduce(s, { type: 'RESPONSE', now: t + 1, source: 'lookup', interactionId: IID, idempotencyKey: K1, result: { category: 'outcome', status: status('paid', { totalMinor: 350, reference: 'OLDR' }) } });
    expect(interactionOf(looked).phase).toBe('confirmed');
    expect(interactionOf(looked).submission?.recordedTotalMinor).toBe(350);
    expect(interactionOf(looked).submission?.expectedTotalMinor).toBe(700);
    expect(interactionOf(looked).submission?.reference).toBe('OLDR');
  });
});


const REJECTED: Classified = { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: 800, currentItems: [{ ...COFFEE, priceMinor: 400 }], affectedItemIds: [COFFEE.id] } };

describe('a rejection that arrives after the intent is known to exist is stale and admits nothing (FR-033)', () => {
  const pending = response(submitted(t), { now: t + 500, state: 'pending_payment', source: 'poll', reference: 'PEND' });

  it.each([
    ['422', REJECTED],
    ['400', { category: 'bad_request' } as Classified],
    ['503 reference_exhausted', { category: 'reference_exhausted' } as Classified],
  ])('a late %s after a pending poll leaves submitted/pending intact, keeps K1, and Try again is impossible', (_n, result) => {
    expect(interactionOf(pending).submission?.knownState).toBe('pending');
    const after = reduce(pending, { type: 'RESPONSE', now: t + 900, source: 'post', interactionId: IID, idempotencyKey: K1, result });
    expect(after).toBe(pending);
    expect(interactionOf(after).phase).toBe('submitted');
    expect(interactionOf(after).submission?.idempotencyKey).toBe(K1);
    expect(reduce(after, { type: 'TRY_AGAIN', now: t + 1000 })).toBe(after);
    expect(reduce(after, { type: 'GO_PAYMENT', now: t + 1000, idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).toBe(after);
  });

  it('the deadlines continue from the polling already in progress', () => {
    const after = reduce(pending, { type: 'RESPONSE', now: t + 900, source: 'post', interactionId: IID, idempotencyKey: K1, result: REJECTED });
    const done = reduce(after, { type: 'TICK', now: t + 500 + 30_000 });
    expect(interactionOf(done).phase).toBe('unresolved');
    expect(interactionOf(done).submission?.reference).toBe('PEND');
  });

  it('a rejection with no known acceptance is still admitted (the ordinary FR-009 path)', () => {
    const after = reduce(submitted(t), { type: 'RESPONSE', now: t + 1, source: 'post', interactionId: IID, idempotencyKey: K1, result: REJECTED });
    expect(interactionOf(after).screen).toBe('rejected');
  });
});

