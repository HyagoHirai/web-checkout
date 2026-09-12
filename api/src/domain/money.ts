import { MAX_QTY_PER_LINE, MAX_TOTAL_MINOR } from '../../../shared/constants.ts';

/** All money is an integer number of USD cents. No floats anywhere on the money path. */
export function lineTotalMinor(unitPriceMinor: number, quantity: number): number {
  return unitPriceMinor * quantity;
}

export function orderTotalMinor(lines: readonly { unitPriceMinor: number; quantity: number }[]): number {
  return lines.reduce((sum, l) => sum + lineTotalMinor(l.unitPriceMinor, l.quantity), 0);
}

export function quantityWithinBounds(q: number): boolean {
  return Number.isInteger(q) && q >= 1 && q <= MAX_QTY_PER_LINE;
}

export function totalWithinBounds(minor: number): boolean {
  return Number.isInteger(minor) && minor >= 1 && minor <= MAX_TOTAL_MINOR;
}
