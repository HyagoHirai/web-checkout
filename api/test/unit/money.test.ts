import { describe, expect, it } from 'vitest';
import { MAX_QTY_PER_LINE, MAX_TOTAL_MINOR, MAX_UNITS_PER_ORDER } from '../../../shared/constants.ts';
import { lineTotalMinor, orderTotalMinor, quantityWithinBounds, totalWithinBounds, unitsWithinBounds } from '../../src/domain/money.ts';

describe('money (integer cents)', () => {
  it('computes line and order totals in cents', () => {
    expect(lineTotalMinor(350, 3)).toBe(1050);
    expect(orderTotalMinor([{ unitPriceMinor: 350, quantity: 2 }, { unitPriceMinor: 475, quantity: 1 }])).toBe(1175);
  });
  it('accepts values exactly at the bounds and rejects one step beyond (FR-006)', () => {
    expect(quantityWithinBounds(MAX_QTY_PER_LINE)).toBe(true);
    expect(quantityWithinBounds(MAX_QTY_PER_LINE + 1)).toBe(false);
    expect(quantityWithinBounds(0)).toBe(false);
    expect(unitsWithinBounds(MAX_UNITS_PER_ORDER)).toBe(true);
    expect(unitsWithinBounds(MAX_UNITS_PER_ORDER + 1)).toBe(false);
    expect(totalWithinBounds(MAX_TOTAL_MINOR)).toBe(true);
    expect(totalWithinBounds(MAX_TOTAL_MINOR + 1)).toBe(false);
    expect(totalWithinBounds(0)).toBe(false);
  });
  it('rejects non-integers', () => {
    expect(quantityWithinBounds(1.5)).toBe(false);
    expect(totalWithinBounds(12.5)).toBe(false);
  });
});
