import type { MenuItem, OrderSubmission } from '../../../shared/wire.ts';
import { cartTotalMinor } from './cart.ts';
import type { Cart, FrozenLine, Interaction, Submission } from './types.ts';

/**
 * Building, freezing and selecting submissions. One place for the rules the reducer, the runtime and
 * the screens all depend on.
 */

/**
 * The single definition of a retained submission: sent, rejected, and with NO known outcome. It is
 * kept until a new intent replaces it, because under ADR-002 "The validation window" a concurrent
 * request with the same key may still be accepted. A key whose outcome is known (a decline is
 * terminal for that order, ADR-005) is never retained: editing after a decline starts a new intent.
 */
export function retainedSubmission(interaction: Interaction): Submission | null {
  const submission = interaction.submission;
  return submission && submission.sentAt !== null && submission.knownState === 'none' ? submission : null;
}

/** An intent that exists on the payment screen but was never sent; discarded by Back and by a reload. */
export function unsentSubmission(interaction: Interaction): Submission | null {
  const submission = interaction.submission;
  return submission && submission.sentAt === null ? submission : null;
}

/** Freezes the cart at the prices the customer saw, sorted by item id so a replay is byte-identical (ADR-002). */
export function freezeCart(cart: Cart, menu: MenuItem[]): FrozenLine[] {
  const byId = new Map(menu.map((m) => [m.id, m]));
  return [...cart.lines]
    .map((l) => ({ itemId: l.itemId, name: byId.get(l.itemId)?.name ?? '', unitPriceMinor: byId.get(l.itemId)?.priceMinor ?? 0, quantity: l.quantity }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

/** A fresh, unsent intent for the current cart (GO_PAYMENT). */
export function newSubmission(cart: Cart, menu: MenuItem[], idempotencyKey: string): Submission {
  return {
    idempotencyKey,
    lines: freezeCart(cart, menu),
    expectedTotalMinor: cartTotalMinor(cart, menu),
    sentAt: null,
    pollStartedAt: null,
    knownState: 'none',
    reference: null,
    recordedTotalMinor: null,
    simulation: 'success',
  };
}

/** After a reload the cart is gone but the frozen submission is not: rebuild the customer's lines from it. */
export function cartFromFrozen(lines: readonly FrozenLine[]): Cart {
  return { lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })), flagged: [] };
}

/** Whether a fresh menu prices any frozen line differently from what was frozen. */
export function isRepriced(submission: Submission, menu: MenuItem[]): boolean {
  const byId = new Map(menu.map((m) => [m.id, m]));
  return submission.lines.some((l) => byId.get(l.itemId)?.priceMinor !== l.unitPriceMinor);
}

/** The wire shape the API accepts (contracts/openapi.yaml). No unit prices travel; the server is the price authority. */
export function toWire(submission: Submission): OrderSubmission {
  return {
    idempotencyKey: submission.idempotencyKey,
    currency: 'USD',
    expectedTotalMinor: submission.expectedTotalMinor,
    lines: submission.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
    simulation: { outcome: submission.simulation },
  };
}
