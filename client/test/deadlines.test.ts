import { describe, expect, it } from 'vitest';
import { inactivityDeadline, isExpired, waitEndedAt, warningAt } from '../src/machine/deadlines.ts';
import { reduce } from '../src/machine/reducer.ts';
import { interactionOf, response, submitted } from './helpers.ts';

describe('deadline arithmetic from persisted timestamps (research R4, data-model.md)', () => {
  it('the bounded wait ends 30 s after polling starts, never later than sentAt + 38 s', () => {
    const s = submitted(0);
    expect(waitEndedAt(interactionOf(s).submission!)).toBe(38_000);
    const early = reduce(s, { type: 'POLL_START', now: 1_000 });
    expect(waitEndedAt(interactionOf(early).submission!)).toBe(31_000);
  });
  it('unresolved deadline is max(lastActivityAt, waitEndedAt) + 90 s; the warning is 15 s before', () => {
    const u = reduce(submitted(0), { type: 'TICK', now: 38_000 });
    expect(inactivityDeadline(interactionOf(u))).toBe(128_000);
    expect(warningAt(interactionOf(u))).toBe(113_000);
  });
  it('a late decline at 100 s keeps the interaction valid until the deadline in force, 128 s', () => {
    const u = reduce(submitted(0), { type: 'TICK', now: 38_000 });
    const declined = response(u, { now: 100_000, state: 'failed' });
    expect(interactionOf(declined).phase).toBe('declined');
    expect(interactionOf(declined).deadlineAt).toBe(128_000);
    expect(inactivityDeadline(interactionOf(declined))).toBe(128_000);
    expect(isExpired(interactionOf(declined), 100_001)).toBe(false);
    expect(reduce(declined, { type: 'TICK', now: 100_001 }).interaction).not.toBeNull();
    expect(reduce(declined, { type: 'TICK', now: 128_000 }).interaction).toBeNull();
  });
  it('the next qualifying interaction after a late decline re-stamps and clears the preserved deadline', () => {
    const u = reduce(submitted(0), { type: 'TICK', now: 38_000 });
    const declined = response(u, { now: 100_000, state: 'failed' });
    const touched = reduce(declined, { type: 'CONTINUE', now: 110_000 });
    expect(interactionOf(touched).deadlineAt).toBeNull();
    expect(inactivityDeadline(interactionOf(touched))).toBe(200_000);
  });
  it('a decline that arrives in time uses ordinary building math', () => {
    const declined = response(submitted(0), { now: 500, state: 'failed' });
    expect(interactionOf(declined).deadlineAt).toBeNull();
    expect(inactivityDeadline(interactionOf(declined))).toBe(90_000);
  });
  it('confirmed ends 15 s after resolvedAt and is not restarted by a repeated paid', () => {
    const paid = response(submitted(0), { now: 500, state: 'paid' });
    expect(inactivityDeadline(interactionOf(paid))).toBe(15_500);
    const again = response(paid, { now: 10_000, state: 'paid' });
    expect(inactivityDeadline(interactionOf(again))).toBe(15_500);
    expect(reduce(again, { type: 'TICK', now: 15_500 }).interaction).toBeNull();
  });
  it('submitted has no inactivity deadline (suspended)', () => {
    expect(inactivityDeadline(interactionOf(submitted(0)))).toBeNull();
    expect(warningAt(interactionOf(submitted(0)))).toBeNull();
  });
});
