import type { MenuItem, OrderStatus } from '../../shared/wire.ts';
import { initialState, reduce } from '../src/machine/reducer.ts';
import type { Event, Interaction, State } from '../src/machine/types.ts';

export const COFFEE: MenuItem = { id: '0a1d2c3b-0001-4a5b-8c6d-000000000001', name: 'Coffee', priceMinor: 350, currency: 'USD', available: true };
export const LATTE: MenuItem = { id: '0a1d2c3b-0002-4a5b-8c6d-000000000002', name: 'Latte', priceMinor: 475, currency: 'USD', available: true };
export const SOUP: MenuItem = { id: '0a1d2c3b-0009-4a5b-8c6d-000000000009', name: 'Soup', priceMinor: 650, currency: 'USD', available: false };
export const PRICEY: MenuItem = { id: '0a1d2c3b-0010-4a5b-8c6d-000000000010', name: 'Feast', priceMinor: 20000, currency: 'USD', available: true };
export const MENU = [COFFEE, LATTE, SOUP, PRICEY];

export const IID = '11111111-1111-4111-8111-111111111111';
export const IID2 = '22222222-2222-4222-8222-222222222222';
export const K1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const K2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Runs a sequence of events from the initial state. */
export function run(events: Event[], from: State = initialState): State {
  return events.reduce((s, e) => reduce(s, e), from);
}

/** A state on the payment screen with coffee x2 in the cart, key K1, at time t. */
export function atPayment(t = 1000, key = K1): State {
  return run([
    { type: 'START', now: t, interactionId: IID },
    { type: 'MENU_LOADED', now: t, items: MENU },
    { type: 'ADD_ITEM', now: t, itemId: COFFEE.id },
    { type: 'ADD_ITEM', now: t, itemId: COFFEE.id },
    { type: 'GO_REVIEW', now: t },
    { type: 'GO_PAYMENT', now: t, idempotencyKey: key },
  ]);
}

/** A state that has sent the POST at time t. */
export function submitted(t = 1000, key = K1): State {
  return reduce(atPayment(t, key), { type: 'PAY', now: t });
}

export function status(state: OrderStatus['state'], overrides: Partial<OrderStatus> = {}): OrderStatus {
  return { orderId: 'o1', reference: 'K7PM', state, totalMinor: 700, currency: 'USD', interactionId: IID, replay: false, ...overrides };
}

export function response(s: State, opts: { now: number; state: OrderStatus['state']; interactionId?: string; idempotencyKey?: string; source?: 'post' | 'poll' | 'lookup'; reference?: string }): State {
  return reduce(s, {
    type: 'RESPONSE', now: opts.now, source: opts.source ?? 'post',
    interactionId: opts.interactionId ?? IID, idempotencyKey: opts.idempotencyKey ?? K1,
    result: { category: 'outcome', status: status(opts.state, { reference: opts.reference ?? 'K7PM' }) },
  });
}

export function interactionOf(s: State): Interaction {
  if (!s.interaction) throw new Error('no interaction');
  return s.interaction;
}
