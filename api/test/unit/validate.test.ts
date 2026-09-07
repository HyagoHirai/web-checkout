import { describe, expect, it } from 'vitest';
import { validateSubmission, type MenuRow } from '../../src/domain/validate.ts';
import type { OrderSubmission } from '../../../shared/wire.ts';

const coffee: MenuRow = { id: '0a1d2c3b-0001-4a5b-8c6d-000000000001', name: 'Coffee', price_minor: 350, currency: 'USD', available: true };
const latte: MenuRow = { id: '0a1d2c3b-0002-4a5b-8c6d-000000000002', name: 'Latte', price_minor: 475, currency: 'USD', available: true };
const soup: MenuRow = { id: '0a1d2c3b-0009-4a5b-8c6d-000000000009', name: 'Soup', price_minor: 650, currency: 'USD', available: false };
const menu = [coffee, latte, soup];

function sub(lines: OrderSubmission['lines'], expectedTotalMinor: number, currency: 'USD' = 'USD'): OrderSubmission {
  return { idempotencyKey: '11111111-1111-4111-8111-111111111111', currency, expectedTotalMinor, lines };
}

describe('validateSubmission (ADR-003: the server is the price authority)', () => {
  it('accepts a matching total and freezes a snapshot', () => {
    const r = validateSubmission(sub([{ itemId: coffee.id, quantity: 2 }, { itemId: latte.id, quantity: 1 }], 1175), menu);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.totalMinor).toBe(1175);
      expect(r.snapshot.lines).toEqual([
        { itemId: coffee.id, name: 'Coffee', unitPriceMinor: 350, quantity: 2, lineTotalMinor: 700 },
        { itemId: latte.id, name: 'Latte', unitPriceMinor: 475, quantity: 1, lineTotalMinor: 475 },
      ]);
    }
  });
  it('rejects a total mismatch with the current total and items', () => {
    const r = validateSubmission(sub([{ itemId: coffee.id, quantity: 1 }], 300), menu);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toEqual(['price_mismatch']);
      expect(r.currentTotalMinor).toBe(350);
      expect(r.currentItems.map((i) => i.id)).toEqual([coffee.id]);
    }
  });
  it('the guarantee is over the total: equal-and-opposite line moves are accepted', () => {
    const moved: MenuRow[] = [{ ...coffee, price_minor: 375 }, { ...latte, price_minor: 450 }, soup];
    const r = validateSubmission(sub([{ itemId: coffee.id, quantity: 1 }, { itemId: latte.id, quantity: 1 }], 825), moved);
    expect(r.ok).toBe(true);
  });
  it('collects every reason instead of failing on the first', () => {
    const r = validateSubmission(sub([{ itemId: soup.id, quantity: 11 }, { itemId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', quantity: 1 }], 1), menu);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(new Set(r.reasons)).toEqual(new Set(['item_unavailable', 'quantity_out_of_bounds', 'unknown_item']));
      expect(r.currentTotalMinor).toBeUndefined();
    }
  });
  it('rejects duplicates, empty carts, unit and total bounds, other currencies', () => {
    expect((validateSubmission(sub([{ itemId: coffee.id, quantity: 1 }, { itemId: coffee.id, quantity: 1 }], 700), menu) as { reasons: string[] }).reasons).toContain('duplicate_item');
    expect((validateSubmission(sub([], 0), menu) as { reasons: string[] }).reasons).toContain('empty_cart');
    const many = validateSubmission(sub([{ itemId: coffee.id, quantity: 10 }, { itemId: latte.id, quantity: 10 }, { itemId: soup.id, quantity: 10 }], 14750), [coffee, latte, { ...soup, available: true }]);
    expect(many.ok).toBe(true);
    const tooMany = validateSubmission(sub([{ itemId: coffee.id, quantity: 10 }, { itemId: latte.id, quantity: 10 }, { itemId: soup.id, quantity: 10 }, { itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 10 }, { itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', quantity: 10 }, { itemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', quantity: 1 }], 1), menu);
    expect((tooMany as { reasons: string[] }).reasons).toContain('units_out_of_bounds');
    const pricey: MenuRow = { ...latte, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', price_minor: 50000 };
    expect((validateSubmission(sub([{ itemId: pricey.id, quantity: 3 }], 150000), [pricey]) as { reasons: string[] }).reasons).toContain('total_out_of_bounds');
    expect((validateSubmission(sub([{ itemId: coffee.id, quantity: 1 }], 350, 'EUR' as 'USD'), menu) as { reasons: string[] }).reasons).toContain('currency_unsupported');
  });
});
