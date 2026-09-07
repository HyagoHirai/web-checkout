import { randomInt } from 'node:crypto';
import { REFERENCE_ALPHABET, REFERENCE_LENGTH } from '../../../shared/constants.ts';

export const MAX_REFERENCE_ATTEMPTS = 5;

export type ReferenceGenerator = () => string;

/** 4 symbols from the 31-symbol alphabet, drawn with crypto.randomInt (no modulo bias). FR-012. */
export function generateReference(): string {
  let out = '';
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) {
    out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return out;
}
