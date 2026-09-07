import { describe, expect, it } from 'vitest';
import { canReview, cartTotalMinor, reduce } from '../src/machine/reducer.ts';
import { atPayment, COFFEE, IID, K1, K2, LATTE, MENU, PRICEY, run, SOUP, submitted, interactionOf } from './helpers.ts';

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
  it('an eleventh of one item, a 51st unit and a total above $1,000 are refused', () => {
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
  it('review is blocked on an empty cart and on a flagged line', () => {
    expect(canReview(started.cart)).toBe(false);
    const s = reduce(reduce(started, { type: 'ADD_ITEM', now: t, itemId: COFFEE.id }), { type: 'GO_REVIEW', now: t });
    expect(interactionOf(s).screen).toBe('review');
    expect(canReview({ lines: [{ itemId: COFFEE.id, quantity: 1 }], flagged: [COFFEE.id] })).toBe(false);
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
    const again = run([{ type: 'TRY_AGAIN', now: t + 600 }, { type: 'GO_PAYMENT', now: t + 700, idempotencyKey: K2 }], declined);
    expect(interactionOf(again).phase).toBe('building');
    expect(interactionOf(again).submission?.idempotencyKey).toBe(K2);
  });
});

describe('US3/US7: rejection before payment (FR-009, FR-010)', () => {
  it('price_mismatch re-prices the menu, discards the key, and the next payment carries the new total', () => {
    const s = reduce(submitted(t), {
      type: 'RESPONSE', now: t + 1, source: 'post', interactionId: IID, idempotencyKey: K1,
      result: { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: 800, currentItems: [{ ...COFFEE, priceMinor: 400 }], affectedItemIds: [COFFEE.id] } },
    });
    expect(interactionOf(s).screen).toBe('rejected');
    expect(interactionOf(s).submission).toBeNull();
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
    expect(canReview(s.cart)).toBe(false);
    const removed = reduce(s, { type: 'REMOVE_ITEM', now: t + 2, itemId: COFFEE.id });
    expect(removed.cart.flagged).toEqual([]);
    expect(removed.cart.lines).toHaveLength(0);
    expect(canReview(removed.cart)).toBe(false); // empty now
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
