import { describe, expect, it } from 'vitest';
import { COUNTER_NAMES, createCounters } from '../../src/observability/counters.ts';

describe('counters (constitution VI)', () => {
  it('pre-registers every catalogue key at zero', () => {
    const c = createCounters();
    const snap = c.snapshot();
    for (const n of COUNTER_NAMES) expect(snap[n]).toBe(0);
    expect(snap['payment.executed.success']).toBe(0);
  });
  it('throws on an unknown name so a typo cannot silently create a counter', () => {
    const c = createCounters();
    expect(() => c.inc('payment.executed.sucess')).toThrow(/Unknown counter/);
  });
  it('increments and resets', () => {
    const c = createCounters();
    c.inc('orders.accepted');
    c.inc('orders.accepted', 2);
    expect(c.get('orders.accepted')).toBe(3);
    c.reset();
    expect(c.get('orders.accepted')).toBe(0);
  });
});
