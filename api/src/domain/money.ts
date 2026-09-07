import { MAX_QTY_PER_LINE, MAX_TOTAL_MINOR, MAX_UNITS_PER_ORDER } from '../../../shared/constants.ts';

/** All money is an integer number of USD cents. No floats anywhere on the money path. */
export function lineTotalMinor(unitPriceMinor: number, quantity: number): number {
  return unitPriceMinor * quantity;
}

export function orderTotalMinor(lines: readonly { unitPriceMinor: number; quantity: number }[]): number {
  return lines.reduce((sum, l) => sum + lineTotalMinor(l.unitPriceMinor, l.quantity), 0);
}

export function isSafeMinor(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
}

export function quantityWithinBounds(q: number): boolean {
  return Number.isInteger(q) && q >= 1 && q <= MAX_QTY_PER_LINE;
}

export function unitsWithinBounds(total: number): boolean {
  return Number.isInteger(total) && total >= 1 && total <= MAX_UNITS_PER_ORDER;
}

export function totalWithinBounds(minor: number): boolean {
  return Number.isInteger(minor) && minor >= 1 && minor <= MAX_TOTAL_MINOR;
}
