import { describe, expect, it } from 'vitest';
import { canonicalIntent, fingerprint } from '../../src/domain/fingerprint.ts';

const a = '0a1d2c3b-0001-4a5b-8c6d-000000000001';
const b = '0a1d2c3b-0002-4a5b-8c6d-000000000002';

describe('fingerprint (ADR-002 "the key is bound to the payload")', () => {
  it('is independent of line order', () => {
    const x = fingerprint({ currency: 'USD', expectedTotalMinor: 1175, lines: [{ itemId: a, quantity: 2 }, { itemId: b, quantity: 1 }] });
    const y = fingerprint({ currency: 'USD', expectedTotalMinor: 1175, lines: [{ itemId: b, quantity: 1 }, { itemId: a, quantity: 2 }] });
    expect(x).toBe(y);
    expect(x).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when any quantity or the total changes', () => {
    const base = { currency: 'USD', expectedTotalMinor: 1175, lines: [{ itemId: a, quantity: 2 }] };
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, lines: [{ itemId: a, quantity: 3 }] }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, expectedTotalMinor: 1176 }));
  });
  it('uses literal key order in the canonical form (no dependency on object key order)', () => {
    expect(canonicalIntent({ currency: 'USD', expectedTotalMinor: 1, lines: [{ quantity: 1, itemId: a } as never] })).toBe(
      `{"currency":"USD","expectedTotalMinor":1,"lines":[{"itemId":"${a}","quantity":1}]}`,
    );
  });
});
