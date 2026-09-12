import { describe, expect, it } from 'vitest';
import { canReview, cartChangeBlocker, flagRejectedItems, menuWithCurrentItems, orderLimitReached, setLine } from '../src/machine/cart.ts';
import type { ValidationRejection } from '../../shared/wire.ts';
import { COFFEE, IID, LATTE, MENU, PRICEY, SOUP } from './helpers.ts';

describe('orderLimitReached: the order-level reason is about the items that could still grow (FR-006)', () => {
  it('mixed limits: two items at Max 10 and one expensive item stopped by the total → the total is the reason', () => {
    // 10 × $3.50 + 10 × $4.75 + 4 × $200.00 = $882.50: valid, and nothing more can be added
    const cart = { lines: [{ itemId: COFFEE.id, quantity: 10 }, { itemId: LATTE.id, quantity: 10 }, { itemId: PRICEY.id, quantity: 4 }], flagged: [] };
    expect(canReview(cart, MENU)).toBe(true);
    expect(cartChangeBlocker(cart, MENU, COFFEE.id, 11)).toBe('quantity_out_of_bounds');
    expect(cartChangeBlocker(cart, MENU, PRICEY.id, 5)).toBe('total_out_of_bounds');
    expect(orderLimitReached(cart, MENU)).toBe('total_out_of_bounds');
  });
  it('every item at Max 10 with the total far below the cap: no order-level reason (each card explains itself)', () => {
    const cart = { lines: [{ itemId: COFFEE.id, quantity: 10 }, { itemId: LATTE.id, quantity: 10 }], flagged: [] };
    const menu = MENU.filter((m) => m.id === COFFEE.id || m.id === LATTE.id);
    expect(orderLimitReached(cart, menu)).toBeNull();
  });
  it('50 units is the unit reason even when the total would also block', () => {
    const cheap = ['a1', 'a2', 'a3', 'a4', 'a5'].map((n, k) => ({ id: `0a1d2c3b-00${k + 5}0-4a5b-8c6d-0000000000${k + 5}0`, name: n, priceMinor: 100, currency: 'USD' as const, available: true }));
    const cart = { lines: cheap.map((m) => ({ itemId: m.id, quantity: 10 })), flagged: [] };
    expect(orderLimitReached(cart, cheap)).toBe('units_out_of_bounds');
  });
  it('something can still be added: no reason', () => {
    const cart = { lines: [{ itemId: COFFEE.id, quantity: 1 }], flagged: [] };
    expect(orderLimitReached(cart, MENU)).toBeNull();
  });
});

describe('setLine keeps the order of the cart (a row must not move under the finger that changed it)', () => {
  const cart = { lines: [{ itemId: COFFEE.id, quantity: 1 }, { itemId: LATTE.id, quantity: 2 }, { itemId: PRICEY.id, quantity: 1 }], flagged: [] };
  it('changing a quantity leaves the line where it was', () => {
    expect(setLine(cart, COFFEE.id, 3).lines.map((l) => [l.itemId, l.quantity])).toEqual([[COFFEE.id, 3], [LATTE.id, 2], [PRICEY.id, 1]]);
  });
  it('a new item goes to the end; zero removes the line and its flag', () => {
    expect(setLine(cart, SOUP.id, 1).lines.map((l) => l.itemId)).toEqual([COFFEE.id, LATTE.id, PRICEY.id, SOUP.id]);
    const flagged = { ...cart, flagged: [LATTE.id] };
    expect(setLine(flagged, LATTE.id, 0)).toEqual({ lines: [{ itemId: COFFEE.id, quantity: 1 }, { itemId: PRICEY.id, quantity: 1 }], flagged: [] });
  });
});

describe('what a 422 does to the cart and the menu (FR-010)', () => {
  const rejection = (partial: Partial<ValidationRejection>): ValidationRejection => ({ error: 'validation_rejected', reasons: [], interactionId: IID, ...partial });

  it('flagRejectedItems: items the server reports unavailable are flagged, existing flags kept, an item flagged on both sides appears once', () => {
    const cart = { lines: [{ itemId: COFFEE.id, quantity: 1 }, { itemId: LATTE.id, quantity: 2 }], flagged: [LATTE.id] };
    const reported = rejection({ reasons: ['item_unavailable'], currentItems: [{ ...COFFEE, available: false }, { ...LATTE, available: false }], affectedItemIds: [COFFEE.id, LATTE.id] });
    expect(flagRejectedItems(cart, reported).flagged).toEqual([LATTE.id, COFFEE.id]);
  });
  it('flagRejectedItems: with the unknown_item reason, an affected id that IS in currentItems is not treated as unknown', () => {
    const cart = { lines: [{ itemId: COFFEE.id, quantity: 1 }], flagged: [] };
    expect(flagRejectedItems(cart, rejection({ reasons: ['unknown_item'], currentItems: [COFFEE], affectedItemIds: [COFFEE.id] })).flagged).toEqual([]);
  });
  it('flagRejectedItems: an unknown item is absent from currentItems, so its affected id is flagged', () => {
    const gone = '0a1d2c3b-0099-4a5b-8c6d-000000000099';
    const cart = { lines: [{ itemId: gone, quantity: 1 }], flagged: [] };
    expect(flagRejectedItems(cart, rejection({ reasons: ['unknown_item'], currentItems: [], affectedItemIds: [gone] })).flagged).toEqual([gone]);
  });
  it('flagRejectedItems: without the unknown_item reason, an affected id missing from currentItems is not flagged', () => {
    const cart = { lines: [{ itemId: COFFEE.id, quantity: 1 }], flagged: [] };
    expect(flagRejectedItems(cart, rejection({ reasons: ['price_mismatch'], currentItems: [], affectedItemIds: [COFFEE.id] })).flagged).toEqual([]);
  });
  it('menuWithCurrentItems: reported items replace their menu entry in place; nothing is added; no menu stays no menu', () => {
    const repriced = { ...COFFEE, priceMinor: COFFEE.priceMinor + 25 };
    const unlisted = { ...COFFEE, id: '0a1d2c3b-0098-4a5b-8c6d-000000000098', name: 'Not on this menu' };
    const merged = menuWithCurrentItems(MENU, [repriced, unlisted]);
    expect(merged?.map((item) => item.id)).toEqual(MENU.map((item) => item.id));
    expect(merged?.find((item) => item.id === COFFEE.id)?.priceMinor).toBe(COFFEE.priceMinor + 25);
    expect(menuWithCurrentItems(MENU, undefined)).toEqual(MENU);
    expect(menuWithCurrentItems(null, [repriced])).toBeNull();
  });
});
