import { describe, expect, it } from 'vitest';
import { canReview, reduce } from '../src/machine/reducer.ts';
import type { Classified } from '../src/machine/types.ts';
import { COFFEE, IID, interactionOf, K1, MENU, PRICEY, response, run, submitted } from './helpers.ts';

const t = 1000;
const REJECTED: Classified = { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: 800, currentItems: [{ ...COFFEE, priceMinor: 400 }], affectedItemIds: [COFFEE.id] } };

describe('finding 1: a rejection that arrives after the intent is known to exist is stale and admits nothing', () => {
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

describe('finding 2: a menu failure outside building clears the loading flag so later refreshes can start', () => {
  it('MENU_FAILED while submitted clears menuLoading without touching the screen', () => {
    const s = { ...submitted(t), menuLoading: true };
    const after = reduce(s, { type: 'MENU_FAILED', now: t + 1 });
    expect(after.menuLoading).toBe(false);
    expect(interactionOf(after).phase).toBe('submitted');
    expect(after.error).toBeNull();
    // a later Try again from a decline requests a refresh again (false → true)
    const declined = response(after, { now: t + 2, state: 'failed' });
    const retry = reduce(declined, { type: 'TRY_AGAIN', now: t + 3 });
    expect(retry.menuLoading).toBe(true);
  });
});

describe('finding 4: decrements always apply, even while the cart is above a bound', () => {
  it('a re-pricing that needs two decrements to get under the cap allows each of them', () => {
    const big = run([
      { type: 'START', now: t, interactionId: IID },
      { type: 'MENU_LOADED', now: t, items: MENU },
      { type: 'SET_QTY', now: t, itemId: PRICEY.id, quantity: 5 }, // $1,000.00
    ]);
    const repriced = reduce(big, { type: 'MENU_LOADED', now: t + 1, items: MENU.map((m) => (m.id === PRICEY.id ? { ...m, priceMinor: 30_000 } : m)) }); // $1,500.00
    expect(canReview(repriced.cart, repriced.menu)).toBe(false);
    const four = reduce(repriced, { type: 'SET_QTY', now: t + 2, itemId: PRICEY.id, quantity: 4 }); // $1,200.00, still over
    expect(four.cart.lines[0].quantity).toBe(4);
    expect(canReview(four.cart, four.menu)).toBe(false);
    const three = reduce(four, { type: 'SET_QTY', now: t + 3, itemId: PRICEY.id, quantity: 3 }); // $900.00
    expect(three.cart.lines[0].quantity).toBe(3);
    expect(canReview(three.cart, three.menu)).toBe(true);
    // increments are still refused above the cap
    expect(reduce(four, { type: 'SET_QTY', now: t + 4, itemId: PRICEY.id, quantity: 5 }).cart.lines[0].quantity).toBe(4);
  });
});
