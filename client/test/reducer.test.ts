import { describe, expect, it } from 'vitest';
import { canReview, cartBlocker, cartTotalMinor } from '../src/machine/cart.ts';
import { reduce } from '../src/machine/reducer.ts';
import type { Classified } from '../src/machine/types.ts';
import { atPayment, COFFEE, IID, K1, K2, LATTE, MENU, PRICEY, response, run, SOUP, submitted, interactionOf } from './helpers.ts';

const t = 1000;

describe('US1: cart rules (FR-002..FR-006)', () => {
  const started = run([{ type: 'START', now: t, interactionId: IID }, { type: 'MENU_LOADED', now: t, items: MENU }]);

  it('adds, adjusts, removes; the running total follows', () => {
    let s = reduce(started, { type: 'ADD_ITEM', now: t, itemId: COFFEE.id });
    s = reduce(s, { type: 'ADD_ITEM', now: t, itemId: LATTE.id });
    expect(cartTotalMinor(s.cart, s.menu)).toBe(825);
    s = reduce(s, { type: 'SET_QTY', now: t, itemId: COFFEE.id, quantity: 3 });
    expect(cartTotalMinor(s.cart, s.menu)).toBe(1525);
    s = reduce(s, { type: 'SET_QTY', now: t, itemId: LATTE.id, quantity: 0 });
    expect(s.cart.lines.map((l) => l.itemId)).toEqual([COFFEE.id]);
    s = reduce(s, { type: 'REMOVE_ITEM', now: t, itemId: COFFEE.id });
    expect(s.cart.lines).toHaveLength(0);
  });
  it('an unavailable item cannot be added', () => {
    const s = reduce(started, { type: 'ADD_ITEM', now: t, itemId: SOUP.id });
    expect(s.cart.lines).toHaveLength(0);
  });
  it('an eleventh of one item and a total above $1,000 are refused', () => {
    let s = reduce(started, { type: 'SET_QTY', now: t, itemId: COFFEE.id, quantity: 10 });
    expect(s.cart.lines[0].quantity).toBe(10);
    s = reduce(s, { type: 'ADD_ITEM', now: t, itemId: COFFEE.id });
    expect(s.cart.lines[0].quantity).toBe(10);
    s = reduce(s, { type: 'SET_QTY', now: t, itemId: LATTE.id, quantity: 10 });
    s = reduce(s, { type: 'SET_QTY', now: t, itemId: PRICEY.id, quantity: 5 }); // 100000 exactly with 3500+4750? no: 3500+4750+100000 > cap
    expect(s.cart.lines.find((l) => l.itemId === PRICEY.id)).toBeUndefined();
    s = reduce(s, { type: 'SET_QTY', now: t, itemId: PRICEY.id, quantity: 4 }); // 3500+4750+80000 = 88250
    expect(s.cart.lines.find((l) => l.itemId === PRICEY.id)?.quantity).toBe(4);
  });
  it('a 51st unit is refused while 50 are accepted (FR-006)', () => {
    // six cheap items so the unit cap is reached long before the total cap
    const cheap = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((n, k) => ({ id: `0a1d2c3b-00${k + 5}0-4a5b-8c6d-0000000000${k + 5}0`, name: n, priceMinor: 100, currency: 'USD' as const, available: true }));
    let s = run([{ type: 'START', now: t, interactionId: IID }, { type: 'MENU_LOADED', now: t, items: cheap }]);
    for (const m of cheap.slice(0, 5)) s = reduce(s, { type: 'SET_QTY', now: t, itemId: m.id, quantity: 10 });
    expect(s.cart.lines.reduce((n, l) => n + l.quantity, 0)).toBe(50);
    expect(canReview(s.cart, s.menu)).toBe(true); // 50 is allowed
    const over = reduce(s, { type: 'ADD_ITEM', now: t, itemId: cheap[5].id });
    expect(over.cart.lines.find((l) => l.itemId === cheap[5].id)).toBeUndefined(); // the 51st is refused
    expect(cartBlocker(over.cart, over.menu)).toBeNull(); // and the cart stays valid
  });
  it('review is blocked on an empty cart and on a flagged line', () => {
    expect(canReview(started.cart, MENU)).toBe(false);
    const s = reduce(reduce(started, { type: 'ADD_ITEM', now: t, itemId: COFFEE.id }), { type: 'GO_REVIEW', now: t });
    expect(interactionOf(s).screen).toBe('review');
    expect(canReview({ lines: [{ itemId: COFFEE.id, quantity: 1 }], flagged: [COFFEE.id] }, MENU)).toBe(false);
  });
  it('entering payment freezes the lines and the review total as expectedTotalMinor (FR-008)', () => {
    const s = atPayment(t);
    const sub = interactionOf(s).submission!;
    expect(sub.idempotencyKey).toBe(K1);
    expect(sub.lines).toEqual([{ itemId: COFFEE.id, name: 'Coffee', unitPriceMinor: 350, quantity: 2 }]);
    expect(sub.expectedTotalMinor).toBe(cartTotalMinor(s.cart, s.menu));
    expect(sub.sentAt).toBeNull();
  });
});

describe('the review needs a menu (a cart rebuilt from frozen lines after a reload has none until the fetch lands)', () => {
  it('GO_REVIEW is refused while the menu is null, like GO_PAYMENT; it is accepted once the menu arrives', () => {
    const rec = interactionOf(submitted(t));
    const restored = run([{ type: 'RESUME', now: t + 1_000, interaction: rec }], { ...submitted(t), interaction: null, cart: { lines: [], flagged: [] }, menu: null });
    const declined = response(restored, { now: t + 1_500, state: 'failed' });
    expect(declined.cart.lines).toEqual([{ itemId: COFFEE.id, quantity: 2 }]);
    expect(declined.menu).toBeNull();
    const tooEarly = reduce(declined, { type: 'GO_REVIEW', now: t + 2_000 });
    expect(tooEarly).toBe(declined);
    const withMenu = reduce(declined, { type: 'MENU_LOADED', now: t + 2_000, items: MENU });
    expect(interactionOf(reduce(withMenu, { type: 'GO_REVIEW', now: t + 2_100 })).screen).toBe('review');
  });
});

describe('US2: the intent is frozen from first send (ADR-002)', () => {
  it('PAY stamps sentAt; a second PAY is a no-op', () => {
    const s = submitted(t);
    expect(interactionOf(s).phase).toBe('submitted');
    expect(interactionOf(s).submission?.sentAt).toBe(t);
    expect(reduce(s, { type: 'PAY', now: t + 1 })).toBe(s);
  });
  it('back to cart is refused while submitted or unresolved; allowed before send (discards the key)', () => {
    const sub = submitted(t);
    expect(reduce(sub, { type: 'BACK_TO_CART', now: t + 1 })).toBe(sub);
    const unresolved = reduce(sub, { type: 'TICK', now: t + 38_000 });
    expect(reduce(unresolved, { type: 'BACK_TO_CART', now: t + 38_001 })).toBe(unresolved);
    const before = reduce(atPayment(t), { type: 'BACK_TO_CART', now: t + 1 });
    expect(interactionOf(before).submission).toBeNull();
    expect(interactionOf(before).screen).toBe('menu');
  });
  it('Start new order from submitted ends the interaction and carries nothing', () => {
    const s = reduce(submitted(t), { type: 'START_NEW_ORDER', now: t + 1 });
    expect(s.interaction).toBeNull();
    expect(s.cart.lines).toHaveLength(0);
  });
  it('after a decline, entering payment again generates a new key with the cart intact (FR-021)', () => {
    const declined = reduce(submitted(t), { type: 'RESPONSE', now: t + 500, source: 'post', interactionId: IID, idempotencyKey: K1, result: { category: 'outcome', status: { orderId: 'o1', reference: 'AAAA', state: 'failed', totalMinor: 700, currency: 'USD', interactionId: IID, replay: false } } });
    expect(interactionOf(declined).phase).toBe('declined');
    expect(declined.cart.lines).toHaveLength(1);
    const again = reduce(declined, { type: 'RETRY_PAYMENT', now: t + 600, idempotencyKey: K2 });
    expect(interactionOf(again).phase).toBe('building');
    expect(interactionOf(again).screen).toBe('payment'); // straight to payment: the decline was about payment, not contents
    expect(interactionOf(again).submission?.idempotencyKey).toBe(K2);
    expect(interactionOf(again).submission?.sentAt).toBeNull();
    expect(again.menuLoading).toBe(true); // the menu is still refreshed; a price change returns the customer to the review
  });
});

describe('US3/US7: rejection before payment (FR-009, FR-010)', () => {
  it('price_mismatch re-prices the menu, keeps the rejected key for a last check, and the next payment carries the new total under a new key', () => {
    const s = reduce(submitted(t), {
      type: 'RESPONSE', now: t + 1, source: 'post', interactionId: IID, idempotencyKey: K1,
      result: { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: 800, currentItems: [{ ...COFFEE, priceMinor: 400 }], affectedItemIds: [COFFEE.id] } },
    });
    expect(interactionOf(s).screen).toBe('rejected');
    expect(interactionOf(s).submission?.idempotencyKey).toBe(K1); // kept (ADR-002 "The validation window")
    expect(reduce(s, { type: 'PAY', now: t + 1 })).toBe(s); // but it can never be re-sent
    expect(s.rejection?.reasons).toEqual(['price_mismatch']);
    expect(cartTotalMinor(s.cart, s.menu)).toBe(800);
    const again = run([{ type: 'TRY_AGAIN', now: t + 2 }, { type: 'GO_PAYMENT', now: t + 3, idempotencyKey: K2 }], s);
    expect(interactionOf(again).submission?.expectedTotalMinor).toBe(800);
    expect(interactionOf(again).submission?.idempotencyKey).toBe(K2);
  });
  it('item_unavailable flags the line; review is blocked until it is removed', () => {
    const s = reduce(submitted(t), {
      type: 'RESPONSE', now: t + 1, source: 'post', interactionId: IID, idempotencyKey: K1,
      result: { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['item_unavailable'], interactionId: IID, currentItems: [{ ...COFFEE, available: false }], affectedItemIds: [COFFEE.id] } },
    });
    expect(s.cart.flagged).toEqual([COFFEE.id]);
    expect(canReview(s.cart, MENU)).toBe(false);
    const removed = reduce(s, { type: 'REMOVE_ITEM', now: t + 2, itemId: COFFEE.id });
    expect(removed.cart.flagged).toEqual([]);
    expect(removed.cart.lines).toHaveLength(0);
    expect(canReview(removed.cart, MENU)).toBe(false); // empty now
  });
});

describe('US5: activity whitelist and expiry (FR-027, FR-028)', () => {
  it('only qualifying events re-stamp lastActivityAt', () => {
    const s = submitted(t);
    const base = interactionOf(s).lastActivityAt;
    expect(interactionOf(reduce(s, { type: 'TICK', now: t + 5000 })).lastActivityAt).toBe(base);
    const st = run([{ type: 'START', now: t, interactionId: IID }, { type: 'MENU_LOADED', now: t + 3000, items: MENU }]);
    expect(interactionOf(st).lastActivityAt).toBe(t);
    expect(interactionOf(reduce(st, { type: 'CONTINUE', now: t + 4000 })).lastActivityAt).toBe(t + 4000);
  });
  it('expiry on TICK returns to idle and drops everything', () => {
    const st = run([{ type: 'START', now: t, interactionId: IID }, { type: 'MENU_LOADED', now: t, items: MENU }, { type: 'ADD_ITEM', now: t, itemId: COFFEE.id }]);
    const s = reduce(st, { type: 'TICK', now: t + 90_000 });
    expect(s.interaction).toBeNull();
    expect(s.cart.lines).toHaveLength(0);
    expect(s.menu).toBe(MENU); // the menu is not interaction state
  });
  it('RESUME with an expired record starts idle; with a valid one continues', () => {
    const st = run([{ type: 'START', now: t, interactionId: IID }, { type: 'MENU_LOADED', now: t, items: MENU }]);
    const i = interactionOf(st);
    expect(reduce(st, { type: 'RESUME', now: t + 90_000, interaction: i }).interaction).toBeNull();
    expect(reduce(st, { type: 'RESUME', now: t + 10_000, interaction: i }).interaction).toEqual(i);
  });
  it('entering unresolved stamps nothing', () => {
    const s = submitted(t);
    const u = reduce(s, { type: 'TICK', now: t + 38_000 });
    expect(interactionOf(u).phase).toBe('unresolved');
    expect(interactionOf(u).lastActivityAt).toBe(t);
  });
});

describe('re-pricing can push a valid cart over a bound; the client refuses to freeze or send it (FR-006)', () => {
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


describe('a menu failure outside building clears the loading flag so later refreshes can start', () => {
  it('MENU_FAILED while submitted clears menuLoading without touching the screen', () => {
    const s = { ...submitted(t), menuLoading: true };
    const after = reduce(s, { type: 'MENU_FAILED', now: t + 1 });
    expect(after.menuLoading).toBe(false);
    expect(interactionOf(after).phase).toBe('submitted');
    expect(after.error).toBeNull();
    // a later Try again from a decline requests a refresh again (false → true)
    const declined = response(after, { now: t + 2, state: 'failed' });
    const retry = reduce(declined, { type: 'RETRY_PAYMENT', now: t + 3, idempotencyKey: K2 });
    expect(retry.menuLoading).toBe(true);
  });
});


describe('decrements always apply, even while the cart is above a bound (FR-006)', () => {
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
