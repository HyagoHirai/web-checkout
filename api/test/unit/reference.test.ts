import { describe, expect, it } from 'vitest';
import { REFERENCE_ALPHABET, REFERENCE_PATTERN } from '../../../shared/constants.ts';
import { generateReference } from '../../src/domain/reference.ts';

describe('order reference (FR-012, OV-6)', () => {
  it('uses the 31-symbol alphabet without 0, O, 1, I, L', () => {
    expect(REFERENCE_ALPHABET).toHaveLength(31);
    for (const c of '0O1IL') expect(REFERENCE_ALPHABET.includes(c)).toBe(false);
  });
  it('generates 4 symbols from the alphabet', () => {
    for (let i = 0; i < 500; i += 1) expect(generateReference()).toMatch(REFERENCE_PATTERN);
  });
  it('spreads across the alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) for (const c of generateReference()) seen.add(c);
    expect(seen.size).toBe(31);
  });
});
