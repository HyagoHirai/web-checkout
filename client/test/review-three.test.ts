import { describe, expect, it } from 'vitest';
import { canReview, cartBlocker, reduce } from '../src/machine/reducer.ts';
import { isCurrent } from '../src/machine/storage.ts';
import { atPayment, COFFEE, IID, interactionOf, K1, K2, MENU, PRICEY, response, run, status, submitted } from './helpers.ts';

const t = 1000;

function rejected(priceNow: number) {
  return reduce(submitted(t), {
    type: 'RESPONSE', now: t + 1, source: 'post', interactionId: IID, idempotencyKey: K1,
    result: { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: priceNow * 2, currentItems: [{ ...COFFEE, priceMinor: priceNow }], affectedItemIds: [COFFEE.id] } },
  });
}

describe('finding 2: a rejected key is kept and checked once more before a new intent (ADR-002 "The validation window")', () => {
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

describe('finding 3: re-pricing can push a valid cart over a bound; the client refuses to freeze or send it (FR-006)', () => {
  it('a 422 that re-prices the total above $1,000.00 blocks review, GO_PAYMENT and PAY until the order is reduced', () => {
    const big = run([
      { type: 'START', now: t, interactionId: IID },
      { type: 'MENU_LOADED', now: t, items: MENU },
      { type: 'SET_QTY', now: t, itemId: PRICEY.id, quantity: 5 }, // 5 × $200 = $1,000.00 exactly
      { type: 'GO_REVIEW', now: t },
      { type: 'GO_PAYMENT', now: t, idempotencyKey: K1 },
      { type: 'PAY', now: t },
    ]);
    expect(interactionOf(big).phase).toBe('submitted');
    const s = reduce(big, {
      type: 'RESPONSE', now: t + 1, source: 'post', interactionId: IID, idempotencyKey: K1,
      result: { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['price_mismatch', 'total_out_of_bounds'], interactionId: IID, currentTotalMinor: 101_000, currentItems: [{ ...PRICEY, priceMinor: 20_200 }], affectedItemIds: [PRICEY.id] } },
    });
    expect(cartBlocker(s.cart, s.menu)).toBe('total_out_of_bounds');
    expect(canReview(s.cart, s.menu)).toBe(false);
    const tryAgain = reduce(s, { type: 'TRY_AGAIN', now: t + 2 });
    expect(interactionOf(tryAgain).screen).toBe('menu');
    expect(reduce(tryAgain, { type: 'GO_REVIEW', now: t + 3 })).toBe(tryAgain);
    expect(reduce(tryAgain, { type: 'GO_PAYMENT', now: t + 3, idempotencyKey: K2 })).toBe(tryAgain);
    const reduced = reduce(tryAgain, { type: 'SET_QTY', now: t + 4, itemId: PRICEY.id, quantity: 4 });
    expect(canReview(reduced.cart, reduced.menu)).toBe(true);
  });
});

describe('finding 4: a 409 recovery shows the recorded total, not the conflicting attempt', () => {
  it('confirmed carries recordedTotalMinor from the lookup while the frozen intent keeps what it sent', () => {
    const s = submitted(t); // expected 700
    const looked = reduce(s, { type: 'RESPONSE', now: t + 1, source: 'lookup', interactionId: IID, idempotencyKey: K1, result: { category: 'outcome', status: status('paid', { totalMinor: 350, reference: 'OLDR' }) } });
    expect(interactionOf(looked).phase).toBe('confirmed');
    expect(interactionOf(looked).submission?.recordedTotalMinor).toBe(350);
    expect(interactionOf(looked).submission?.expectedTotalMinor).toBe(700);
    expect(interactionOf(looked).submission?.reference).toBe('OLDR');
  });
});

describe('finding 1 (storage side): isCurrent compares the live record with the stored one byte for byte', () => {
  it('matches its own serialisation and nothing else', () => {
    const i = interactionOf(submitted(t));
    expect(isCurrent(i, JSON.stringify(i))).toBe(true);
    expect(isCurrent(i, JSON.stringify({ ...i, id: '22222222-2222-4222-8222-222222222222' }))).toBe(false);
    expect(isCurrent(i, null)).toBe(false);
  });
});
