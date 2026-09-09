import { describe, expect, it } from 'vitest';
import { canReview, cartChangeBlocker, orderLimitReached } from '../src/machine/cart.ts';
import { COFFEE, LATTE, MENU, PRICEY } from './helpers.ts';

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
