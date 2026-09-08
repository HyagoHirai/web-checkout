import { describe, expect, it } from 'vitest';
import { inactivityDeadline, waitEndedAt } from '../src/machine/deadlines.ts';
import { canReview, reduce } from '../src/machine/reducer.ts';
import { load, save } from '../src/machine/storage.ts';
import type { Interaction } from '../src/machine/types.ts';
import { atPayment, COFFEE, IID, interactionOf, K1, MENU, response, run, submitted } from './helpers.ts';

/**
 * Review round three: the clock jumps while the app is suspended (bfcache, tab restore, laptop
 * lid), and the page reloads mid-flow. Every case here failed before the fix.
 */
describe('finding 1: a suspended `submitted` interaction is normalised by the clock on resume', () => {
  const sent = submitted(0); // sentAt 0, lastActivityAt 0
  const record = interactionOf(sent);

  it.each([
    ['polling not started, resumed at 40 s', record, 40_000, 'unresolved'],
    ['polling not started, resumed at 100 s', record, 100_000, 'unresolved'],
    ['polling not started, resumed at 600 s', record, 600_000, null],
    ['polling started at 8 s, resumed at 40 s', { ...record, submission: { ...record.submission!, pollStartedAt: 8_000 } }, 40_000, 'unresolved'],
    ['polling started at 8 s, resumed at 600 s', { ...record, submission: { ...record.submission!, pollStartedAt: 8_000 } }, 600_000, null],
  ] as const)('%s', (_name, rec, now, expectedPhase) => {
    const s = reduce({ ...sent, interaction: null }, { type: 'RESUME', now, interaction: rec as Interaction });
    if (expectedPhase === null) {
      expect(s.interaction).toBeNull();
    } else {
      expect(interactionOf(s).phase).toBe(expectedPhase);
      // the wait ended at 38 s at the latest, never at resume + 30 s
      expect(waitEndedAt(interactionOf(s).submission!)).toBe(38_000);
      expect(inactivityDeadline(interactionOf(s))).toBe(128_000);
    }
  });

  it('a late POLL_START never extends the wait beyond sentAt + 38 s', () => {
    const late = reduce(sent, { type: 'POLL_START', now: 600_000 });
    expect(waitEndedAt(interactionOf(late).submission!)).toBeLessThanOrEqual(38_000);
  });

  it('a paid result is not admitted into a resumed interaction whose wait and inactivity have both expired', () => {
    const resumed = reduce({ ...sent, interaction: null }, { type: 'RESUME', now: 600_000, interaction: record });
    expect(resumed.interaction).toBeNull();
    const admitted = response({ ...sent, interaction: record }, { now: 600_000, state: 'paid' });
    expect(admitted.interaction?.phase).not.toBe('confirmed');
  });

  it('TICK on a stale `submitted` record moves through unresolved to idle in one step when both are past', () => {
    const s = reduce({ ...sent, interaction: record }, { type: 'TICK', now: 600_000 });
    expect(s.interaction).toBeNull();
  });
});

describe('finding 2: revalidating a live interaction preserves the cart and screen state', () => {
  it('TICK (used by pageshow/visibility) keeps cart, rejection and error', () => {
    const s = run([
      { type: 'START', now: 0, interactionId: IID },
      { type: 'MENU_LOADED', now: 0, items: MENU },
      { type: 'ADD_ITEM', now: 0, itemId: COFFEE.id },
      { type: 'ADD_ITEM', now: 0, itemId: COFFEE.id },
    ]);
    const after = reduce(s, { type: 'TICK', now: 1_000 });
    expect(after.cart.lines).toEqual([{ itemId: COFFEE.id, quantity: 2 }]);
    expect(after.menu).toBe(MENU);
  });
});

describe('finding 4: a reload before PAY discards the unsent intent (spec edge case)', () => {
  it('RESUME of a building record on the payment screen returns to the menu with no submission', () => {
    const rec = interactionOf(atPayment(0));
    expect(rec.submission?.sentAt).toBeNull();
    const s = reduce({ ...atPayment(0), interaction: null, cart: { lines: [], flagged: [] } }, { type: 'RESUME', now: 1_000, interaction: rec });
    expect(interactionOf(s).phase).toBe('building');
    expect(interactionOf(s).screen).toBe('menu');
    expect(interactionOf(s).submission).toBeNull();
    expect(s.cart.lines).toHaveLength(0);
    expect(reduce(s, { type: 'PAY', now: 1_001 })).toBe(s);
  });
  it('RESUME of a building record on the review screen returns to the menu', () => {
    const rec: Interaction = { ...interactionOf(atPayment(0)), screen: 'review', submission: null };
    const s = reduce({ ...atPayment(0), interaction: null, cart: { lines: [], flagged: [] } }, { type: 'RESUME', now: 1_000, interaction: rec });
    expect(interactionOf(s).screen).toBe('menu');
  });
});

describe('finding 5: a decline after a reload can be retried with the frozen lines', () => {
  it('RESUME of a submitted record rebuilds the cart from the frozen lines; failed → Try again reaches review', () => {
    const rec = interactionOf(submitted(0));
    const restored = reduce({ ...submitted(0), interaction: null, cart: { lines: [], flagged: [] } }, { type: 'RESUME', now: 1_000, interaction: rec });
    expect(restored.cart.lines).toEqual([{ itemId: COFFEE.id, quantity: 2 }]);
    const declined = response(restored, { now: 1_500, state: 'failed' });
    expect(interactionOf(declined).phase).toBe('declined');
    const again = reduce(declined, { type: 'TRY_AGAIN', now: 2_000 });
    expect(interactionOf(again).screen).toBe('review');
    expect(canReview(again.cart)).toBe(true);
  });
  it('a decline admitted with an empty cart rebuilds it from the frozen lines', () => {
    const s = { ...submitted(0), cart: { lines: [], flagged: [] } };
    const declined = response(s, { now: 500, state: 'failed' });
    expect(declined.cart.lines).toEqual([{ itemId: COFFEE.id, quantity: 2 }]);
  });
});

describe('finding 6: persisted records are validated as a union of valid states', () => {
  const base = interactionOf(submitted(0));
  function persistedLoads(rec: unknown): boolean {
    sessionStorage.setItem('webcheckout.interaction', JSON.stringify(rec));
    return load() !== null;
  }
  it('rejects submitted/unresolved/declined/confirmed without a sent submission', () => {
    expect(persistedLoads({ ...base, submission: null })).toBe(false);
    expect(persistedLoads({ ...base, phase: 'unresolved', submission: null })).toBe(false);
    expect(persistedLoads({ ...base, phase: 'declined', submission: { ...base.submission, sentAt: null } })).toBe(false);
    expect(persistedLoads({ ...base, phase: 'confirmed', resolvedAt: null })).toBe(false);
  });
  it('rejects malformed frozen lines and unknown versions; accepts a valid record', () => {
    expect(persistedLoads({ ...base, submission: { ...base.submission, lines: [{ itemId: 1 }] } })).toBe(false);
    expect(persistedLoads({ ...base, v: 99 })).toBe(false);
    save(base);
    expect(load()).toEqual(base);
  });
});

describe('finding 7: unknown items are flagged and the menu is re-fetched on Review again', () => {
  it('unknown_item flags the line and blocks review until it is removed', () => {
    const s = reduce(submitted(0), {
      type: 'RESPONSE', now: 1, source: 'post', interactionId: IID, idempotencyKey: K1,
      result: { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['unknown_item'], interactionId: IID, affectedItemIds: [COFFEE.id], currentItems: [] } },
    });
    expect(s.cart.flagged).toEqual([COFFEE.id]);
    expect(canReview(s.cart)).toBe(false);
  });
  it('TRY_AGAIN from rejected requests a menu re-fetch; MENU_LOADED re-flags lines that are gone or unavailable', () => {
    const s = reduce(submitted(0), {
      type: 'RESPONSE', now: 1, source: 'post', interactionId: IID, idempotencyKey: K1,
      result: { category: 'rejected', rejection: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: 800, currentItems: [{ ...COFFEE, priceMinor: 400 }], affectedItemIds: [COFFEE.id] } },
    });
    const again = reduce(s, { type: 'TRY_AGAIN', now: 2 });
    expect(again.menuLoading).toBe(true);
    const gone = reduce(again, { type: 'MENU_LOADED', now: 3, items: MENU.filter((m) => m.id !== COFFEE.id) });
    expect(gone.cart.flagged).toEqual([COFFEE.id]);
    expect(canReview(gone.cart)).toBe(false);
  });
});
