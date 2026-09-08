import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderStatus } from '../../shared/wire.ts';
import { createApi } from '../src/api/client.ts';
import { createRuntime, type Runtime } from '../src/machine/runtime.ts';
import { COFFEE, IID, K1, K2, LATTE, MENU } from './helpers.ts';

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function orderStatus(state: OrderStatus['state'], interactionId = IID, extra: Partial<OrderStatus> = {}): OrderStatus {
  return { orderId: 'o1', reference: 'K7PM', state, totalMinor: 700, currency: 'USD', interactionId, replay: false, ...extra };
}

/** A scripted fetch: menu always succeeds; POST and GET handlers are set per test. */
function fakeFetch() {
  const calls: { url: string; method: string; body?: unknown; headers: Record<string, string> }[] = [];
  let onPost: Handler = () => json(201, orderStatus('paid'));
  let onGet: Handler = () => json(404, { error: 'not_found' });
  let menu = MENU;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers });
    if (url === '/api/menu') return json(200, { currency: 'USD', items: menu });
    if (url === '/api/orders' && method === 'POST') return onPost(url, init);
    if (url.startsWith('/api/orders/by-key/')) return onGet(url, init);
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { impl, calls, setPost: (h: Handler) => { onPost = h; }, setGet: (h: Handler) => { onGet = h; }, setMenu: (m: typeof MENU) => { menu = m; }, posts: () => calls.filter((c) => c.method === 'POST' && c.url === '/api/orders'), gets: () => calls.filter((c) => c.url.startsWith('/api/orders/by-key/')) };
}

let rt: Runtime;
let ff: ReturnType<typeof fakeFetch>;
let emitted: string[];
const ids = [IID, K1, K2, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  sessionStorage.clear();
  ff = fakeFetch();
  emitted = [];
  let n = 0;
  rt = createRuntime({ api: createApi(ff.impl), uuid: () => ids[n++ % ids.length], emit: (_i, name) => { emitted.push(name); } });
  rt.boot();
});
afterEach(() => { rt.stop(); vi.useRealTimers(); });

/** Reach the payment screen with coffee x2. */
async function toPayment() {
  rt.actions.start();
  await vi.advanceTimersByTimeAsync(10);
  rt.actions.addItem(COFFEE.id);
  rt.actions.addItem(COFFEE.id);
  rt.actions.goReview();
  rt.actions.goPayment();
}


/** A 422 for K1, then Try again with the re-fetched menu carrying the new price: the review with a retained key. */
const rejected422 = () => json(422, { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: 800, currentItems: [{ ...COFFEE, priceMinor: 400 }], affectedItemIds: [COFFEE.id] });
const priced = () => MENU.map((m) => (m.id === COFFEE.id ? { ...m, priceMinor: 400 } : m));
async function rejectedThenReview() {
  ff.setPost(rejected422);
  await toPayment();
  rt.actions.pay();
  await vi.advanceTimersByTimeAsync(10);
  expect(rt.getState().interaction?.screen).toBe('rejected');
  ff.setMenu(priced());
  rt.actions.tryAgain();
  await vi.advanceTimersByTimeAsync(10);
  expect(rt.getState().interaction?.screen).toBe('review');
}

describe('the happy path through the runtime (US1)', () => {
  it('loads the menu on start, POSTs once on pay with the frozen intent, confirms, and idles after 15 s', async () => {
    await toPayment();
    expect(rt.getState().menu).toEqual(MENU);
    rt.actions.pay();
    expect(rt.getState().interaction?.phase).toBe('submitted');
    await vi.advanceTimersByTimeAsync(10);
    expect(ff.posts()).toHaveLength(1);
    expect(ff.posts()[0].headers['x-interaction-id']).toBe(IID);
    expect(ff.posts()[0].body).toMatchObject({ idempotencyKey: K1, currency: 'USD', expectedTotalMinor: 700, lines: [{ itemId: COFFEE.id, quantity: 2 }], simulation: { outcome: 'success' } });
    expect(rt.getState().interaction?.phase).toBe('confirmed');
    expect(rt.getState().interaction?.submission?.reference).toBe('K7PM');
    await vi.advanceTimersByTimeAsync(15_300); // 15 s + one 250 ms tick
    expect(rt.getState().interaction).toBeNull();
    expect(sessionStorage.getItem('webcheckout.interaction')).toBeNull();
  });
});

describe('freezing and recovery (US2: FR-014, FR-016, FR-017)', () => {
  it('a second pay while submitted sends nothing', async () => {
    let release!: () => void;
    ff.setPost(() => new Promise<Response>((r) => { release = () => r(json(201, orderStatus('paid'))); }));
    await toPayment();
    rt.actions.pay();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(100);
    expect(ff.posts()).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.phase).toBe('confirmed');
  });
  it('a reload in submitted restores the key and polls without re-POSTing', async () => {
    ff.setPost(() => new Promise<Response>(() => { /* never resolves: the reload will drop it */ }));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(3_000);
    const persisted = sessionStorage.getItem('webcheckout.interaction');
    expect(persisted).toContain(K1);
    rt.stop();
    ff.setGet(() => json(200, orderStatus('pending_payment')));
    const ff2 = ff;
    rt = createRuntime({ api: createApi(ff2.impl), uuid: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', emit: (_i, name) => { emitted.push(name); } });
    rt.boot();
    expect(rt.getState().interaction?.phase).toBe('submitted');
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K1);
    await vi.advanceTimersByTimeAsync(6_000); // past the 8 s network wait from sentAt
    expect(ff2.posts()).toHaveLength(1); // no second POST
    expect(ff2.gets().length).toBeGreaterThanOrEqual(1);
    expect(rt.getState().interaction?.submission?.knownState).toBe('pending');
  });
  it('Start new order during an unknown outcome ends the interaction without a second POST', async () => {
    ff.setPost(() => new Promise<Response>(() => {}));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10_000);
    rt.actions.startNewOrder();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rt.getState().interaction).toBeNull();
    expect(ff.posts()).toHaveLength(1);
  });
});

describe('the bounded wait, polling, unknown outcomes and late results (US4: FR-022..FR-025, FR-031, FR-034)', () => {
  it('no response: polling starts at 8 s every 2 s and unresolved arrives at 38 s (S7b, no reference)', async () => {
    ff.setPost(() => new Promise<Response>(() => {}));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(7_900);
    expect(ff.gets()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400); // 8 s + one tick
    expect(ff.gets()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ff.gets().length).toBeGreaterThanOrEqual(5);
    await vi.advanceTimersByTimeAsync(20_000);
    const i = rt.getState().interaction!;
    expect(i.phase).toBe('unresolved');
    expect(i.submission?.knownState).toBe('none');
    expect(i.submission?.reference).toBeNull();
    expect(emitted).toContain('unresolved_shown');
    const polls = ff.gets().length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ff.gets().length).toBe(polls); // polling stopped
  });
  it('a network rejection at 1 s starts polling immediately and the wait ends at 31 s', async () => {
    ff.setPost(() => new Promise<Response>((_, reject) => { setTimeout(() => reject(new TypeError('Failed to fetch')), 1_000); }));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(rt.getState().interaction?.submission?.pollStartedAt).toBe(Date.now() - 100);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(rt.getState().interaction?.phase).toBe('submitted');
    await vi.advanceTimersByTimeAsync(1_300); // 31 s + one tick
    expect(rt.getState().interaction?.phase).toBe('unresolved');
  });
  it('a 202 pending starts polling at once; a pending poll sets S7a wording (reference known)', async () => {
    ff.setPost(() => json(202, orderStatus('pending_payment', IID, { reference: 'PEND' })));
    ff.setGet(() => json(200, orderStatus('pending_payment', IID, { reference: 'PEND', replay: true })));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(100);
    expect(rt.getState().interaction?.submission?.knownState).toBe('pending');
    expect(rt.getState().interaction?.submission?.pollStartedAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(29_500);
    expect(rt.getState().interaction?.phase).toBe('submitted');
    await vi.advanceTimersByTimeAsync(1_000); // 30 s after the early pending + one tick
    const i = rt.getState().interaction!;
    expect(i.phase).toBe('unresolved');
    expect(i.submission?.reference).toBe('PEND');
  });
  it('a generic 500 is unknown, never a decline', async () => {
    ff.setPost(() => json(500, { error: 'internal' }));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(100);
    expect(rt.getState().interaction?.phase).toBe('submitted');
    expect(rt.getState().interaction?.submission?.knownState).toBe('none');
  });
  it('a late paid from the still-open POST after unresolved moves to confirmed (FR-034)', async () => {
    let release!: () => void;
    ff.setPost(() => new Promise<Response>((r) => { release = () => r(json(201, orderStatus('paid'))); }));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(rt.getState().interaction?.phase).toBe('unresolved');
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.phase).toBe('confirmed');
    expect(emitted).toContain('late_result_applied');
  });
  it('a 409 conflict triggers a lookup and shows the recorded state, never a rejection', async () => {
    ff.setPost(() => json(409, { error: 'intent_mismatch', interactionId: IID }));
    ff.setGet(() => json(200, orderStatus('paid', IID, { replay: true })));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(100);
    expect(rt.getState().interaction?.phase).toBe('confirmed');
    expect(rt.getState().interaction?.screen).not.toBe('rejected');
  });
});

describe('unreachable before submission (US8: FR-026)', () => {
  it('menu failure shows the error screen; retry re-fetches and emits service_unreachable', async () => {
    const good = ff.impl;
    let fail = true;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/menu' && fail) throw new TypeError('Failed to fetch');
      return good(input, init);
    }) as typeof fetch;
    rt.stop();
    rt = createRuntime({ api: createApi(flaky), uuid: () => IID, emit: (_i, name) => { emitted.push(name); } });
    rt.boot();
    rt.actions.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('error');
    expect(rt.getState().error?.kind).toBe('menu_unreachable');
    fail = false;
    rt.actions.retryAfterError();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('menu');
    expect(rt.getState().menu).toEqual(MENU);
    expect(emitted).toContain('service_unreachable');
  });
});

describe('discarded responses are reported (US9)', () => {
  it('a response for a concluded interaction is discarded and reported as foreign', async () => {
    let release!: () => void;
    ff.setPost(() => new Promise<Response>((r) => { release = () => r(json(201, orderStatus('paid'))); }));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(1_000);
    rt.actions.startNewOrder();
    rt.actions.start();
    await vi.advanceTimersByTimeAsync(10);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.phase).toBe('building');
    expect(emitted).toContain('foreign_response_discarded');
  });
});

describe('suspension, visibility, cleanup and polling cadence', () => {
  it('a visibility change keeps the cart of a live interaction', async () => {
    await toPayment();
    rt.actions.backToCart();
    expect(rt.getState().cart.lines).toEqual([{ itemId: COFFEE.id, quantity: 2 }]);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    rt.revalidate();
    expect(rt.getState().cart.lines).toEqual([{ itemId: COFFEE.id, quantity: 2 }]);
    expect(rt.getState().interaction?.phase).toBe('building');
  });

  it('resuming a submitted record after 600 s suspended goes idle, not to a fresh wait', async () => {
    ff.setPost(() => new Promise<Response>(() => {}));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    rt.stop();
    vi.setSystemTime(Date.now() + 600_000); // the clock jumps while nothing ticks
    const rt2 = createRuntime({ api: createApi(ff.impl), uuid: () => IID, emit: (_i, name) => { emitted.push(name); } });
    rt2.boot();
    expect(rt2.getState().interaction).toBeNull();
    expect(ff.gets()).toHaveLength(0);
    rt2.stop();
  });

  it('resumed at 40 s the wait is over: unresolved, still valid until 128 s, and no polling restarts', async () => {
    ff.setPost(() => new Promise<Response>(() => {}));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    rt.stop();
    vi.setSystemTime(Date.now() + 40_000);
    ff.setGet(() => json(200, orderStatus('paid', IID, { replay: true })));
    const rt2 = createRuntime({ api: createApi(ff.impl), uuid: () => IID, emit: (_i, name) => { emitted.push(name); } });
    rt2.boot();
    expect(rt2.getState().interaction?.phase).toBe('unresolved');
    expect(ff.gets()).toHaveLength(0); // no polling after the wait ended
    rt2.stop();
  });

  it('stop() removes the page listeners so a stopped runtime no longer reacts', async () => {
    await toPayment();
    rt.actions.backToCart();
    const before = rt.getState();
    rt.stop();
    vi.setSystemTime(Date.now() + 200_000);
    window.dispatchEvent(new Event('pageshow'));
    expect(rt.getState()).toBe(before); // untouched: the listener is gone
  });

  it('polling cadence is measured from the start of each poll', async () => {
    ff.setPost(() => new Promise<Response>(() => {}));
    ff.setGet(() => new Promise<Response>((r) => { setTimeout(() => r(json(404, { error: 'not_found' })), 1_500); }));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(8_300);
    expect(ff.gets()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000); // 1.5 s response + 0.5 s → the next poll at +2 s, not +3.5 s
    expect(ff.gets()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ff.gets()).toHaveLength(3);
  });
});

describe('stale documents (back/forward cache) and the last check of a retained key', () => {
  it('a restored document whose interaction was ended by another document abandons its state', async () => {
    await toPayment();
    rt.actions.backToCart();
    expect(rt.getState().cart.lines).toHaveLength(1);
    // another document in this tab reset and started B; this document's heap still holds A
    sessionStorage.setItem('webcheckout.interaction', JSON.stringify({ ...rt.getState().interaction, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', submission: null, screen: 'menu', phase: 'building' }));
    window.dispatchEvent(new Event('pageshow'));
    expect(rt.getState().interaction?.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(rt.getState().cart.lines).toHaveLength(0);
  });
  it('when the other document reset to idle, the restored document goes idle too', async () => {
    await toPayment();
    sessionStorage.removeItem('webcheckout.interaction');
    window.dispatchEvent(new Event('pageshow'));
    expect(rt.getState().interaction).toBeNull();
  });
  it('a live document whose record is still current keeps everything', async () => {
    await toPayment();
    rt.actions.backToCart();
    window.dispatchEvent(new Event('pageshow'));
    expect(rt.getState().cart.lines).toHaveLength(1);
  });
  it('confirming again after a 422 checks the kept key first; found paid → confirmed with the recorded total, no second POST', async () => {
    ff.setPost(() => json(422, { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: 800, currentItems: [{ ...COFFEE, priceMinor: 400 }], affectedItemIds: [COFFEE.id] }));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('rejected');
    // meanwhile the concurrent request that had passed validation paid K1 at $7.00
    ff.setGet(() => json(200, orderStatus('paid', IID, { totalMinor: 700, replay: true })));
    rt.actions.tryAgain();
    await vi.advanceTimersByTimeAsync(10);
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    expect(ff.gets()).toHaveLength(1);
    expect(ff.posts()).toHaveLength(1);
    expect(rt.getState().interaction?.phase).toBe('confirmed');
    expect(rt.getState().interaction?.submission?.recordedTotalMinor).toBe(700);
  });
  it('when the kept key is still not found, a new key is created and sent', async () => {
    ff.setPost(() => json(422, { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: IID, currentTotalMinor: 800, currentItems: [{ ...COFFEE, priceMinor: 400 }], affectedItemIds: [COFFEE.id] }));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    ff.setGet(() => json(404, { error: 'not_found' }));
    ff.setPost(() => json(201, orderStatus('paid', IID, { totalMinor: 800 })));
    ff.setMenu(MENU.map((m) => (m.id === COFFEE.id ? { ...m, priceMinor: 400 } : m))); // the re-fetched menu carries the new price
    rt.actions.tryAgain();
    await vi.advanceTimersByTimeAsync(10);
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('payment');
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K2);
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    expect(ff.posts()).toHaveLength(2);
    expect(ff.posts()[1].body).toMatchObject({ idempotencyKey: K2, expectedTotalMinor: 800 });
    expect(rt.getState().interaction?.phase).toBe('confirmed');
  });
});

describe('the last check: failures, declined keys, polling ownership, abandoned continuations', () => {

  it.each([
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['500', () => json(500, { error: 'internal' })],
    ['unrecognised body', () => json(200, { hello: 'world' })],
  ] as const)('finding 1: when the last check fails (%s) no new key is created; the kept key stays and the customer can retry', async (_n, handler) => {
    await rejectedThenReview();
    ff.setGet(handler as Handler);
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('error');
    expect(rt.getState().error?.kind).toBe('lookup_failed');
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K1);
    expect(ff.posts()).toHaveLength(1);
    // the network is back and the concurrent request had paid K1 meanwhile: the retry finds it
    ff.setGet(() => json(200, orderStatus('paid', IID, { totalMinor: 700, replay: true })));
    rt.actions.retryAfterError();
    expect(rt.getState().interaction?.screen).toBe('review');
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.phase).toBe('confirmed');
    expect(ff.posts()).toHaveLength(1);
  });

  it('Edit order after a decline discards the declined key; re-confirming is a new intent with the edited items', async () => {
    ff.setPost(() => json(201, orderStatus('failed')));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.phase).toBe('declined');
    rt.actions.goMenu();
    expect(rt.getState().interaction?.submission).toBeNull();
    rt.actions.addItem(LATTE.id);
    rt.actions.goReview();
    ff.setPost(() => json(201, orderStatus('paid', IID, { totalMinor: 1175 })));
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('payment');
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K2);
    expect(ff.gets()).toHaveLength(0); // nothing to check: a decline is terminal for that order
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    expect(ff.posts()).toHaveLength(2);
    expect(ff.posts()[1].body).toMatchObject({ idempotencyKey: K2, expectedTotalMinor: 1175, lines: [{ itemId: COFFEE.id, quantity: 2 }, { itemId: LATTE.id, quantity: 1 }] });
    expect(rt.getState().interaction?.phase).toBe('confirmed');
  });

  it('adopting another attempt of the same interaction moves polling to the new key without a POST', async () => {
    ff.setPost(() => new Promise<Response>(() => {}));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(8_300); // polling K1
    expect(ff.gets().every((g) => g.url.endsWith(K1))).toBe(true);
    const k1Polls = ff.gets().length;
    // another document in this tab followed K1's decline and sent K2; it is now the tab's record
    const rec = rt.getState().interaction!;
    const k2 = { ...rec, submission: { ...rec.submission!, idempotencyKey: K2, sentAt: Date.now(), pollStartedAt: Date.now() } };
    sessionStorage.setItem('webcheckout.interaction', JSON.stringify(k2));
    window.dispatchEvent(new Event('pageshow'));
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K2);
    await vi.advanceTimersByTimeAsync(2_300);
    const k2Polls = ff.gets().filter((g) => g.url.endsWith(K2)).length;
    expect(k2Polls).toBeGreaterThanOrEqual(1);
    expect(ff.gets().filter((g) => g.url.endsWith(K1)).length).toBe(k1Polls); // K1 polling stopped
    expect(ff.posts()).toHaveLength(1);
  });

  it('only one check runs at a time, and a check whose screen was left navigates nowhere', async () => {
    await rejectedThenReview();
    const releases: (() => void)[] = [];
    ff.setGet(() => new Promise<Response>((r) => { releases.push(() => r(json(404, { error: 'not_found' }))); }));
    rt.actions.goPayment();
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    expect(releases).toHaveLength(1); // the second tap did not start a second check
    expect(rt.getState().activeCheck).not.toBeNull();
    // the customer leaves the review while the check is in flight and edits the cart
    rt.actions.goMenu();
    rt.actions.addItem(LATTE.id);
    expect(rt.getState().interaction?.screen).toBe('menu');
    releases[0]();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().activeCheck).toBeNull();
    expect(rt.getState().interaction?.screen).toBe('menu'); // no navigation, no new key
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K1);
    expect(rt.getState().cart.lines).toHaveLength(2);
  });
});

describe('the last check: unrecognised 404s and check identity; late menu updates; error copy', () => {

  it.each([
    ['HTML 404', () => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } })],
    ['invalid JSON 404', () => new Response('{oops', { status: 404, headers: { 'content-type': 'application/json' } })],
    ['JSON 404 with another error', () => json(404, { error: 'route_missing' })],
  ] as const)('finding 1: a 404 whose body is not the API\'s not_found (%s) keeps the key and starts nothing', async (_n, handler) => {
    await rejectedThenReview();
    ff.setGet(handler as Handler);
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('error');
    expect(rt.getState().error?.kind).toBe('lookup_failed');
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K1);
    expect(ff.posts()).toHaveLength(1);
  });

  it('leaving the review invalidates the check even if the customer returns before it completes', async () => {
    await rejectedThenReview();
    let release!: () => void;
    ff.setGet(() => new Promise<Response>((r) => { release = () => r(json(404, { error: 'not_found' })); }));
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    rt.actions.goMenu();
    rt.actions.addItem(LATTE.id);
    rt.actions.goReview();
    expect(rt.getState().interaction?.screen).toBe('review');
    expect(rt.getState().activeCheck).toBeNull(); // the old check no longer belongs to this review
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('review'); // no automatic navigation
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K1);
    // a fresh tap performs its own check and then proceeds
    ff.setGet(() => json(404, { error: 'not_found' }));
    rt.actions.goPayment();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('payment');
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K2);
  });

  it('a check from an ended interaction completing later does not clear the next interaction\'s check', async () => {
    await rejectedThenReview();
    const releases: (() => void)[] = [];
    ff.setGet(() => new Promise<Response>((r) => { releases.push(() => r(json(404, { error: 'not_found' }))); }));
    rt.actions.goPayment(); // check A, held
    await vi.advanceTimersByTimeAsync(10);
    rt.actions.startNewOrder();
    // interaction B goes through the same rejection and starts its own check
    ff.setPost(rejected422);
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    rt.actions.tryAgain();
    await vi.advanceTimersByTimeAsync(10);
    rt.actions.goPayment(); // check B, held
    await vi.advanceTimersByTimeAsync(10);
    expect(releases).toHaveLength(2);
    expect(rt.getState().activeCheck).not.toBeNull();
    releases[0](); // A completes
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().activeCheck).not.toBeNull(); // B's check is still the active one
    expect(rt.getState().interaction?.screen).toBe('review');
    rt.actions.goPayment(); // ignored: B's check is in flight
    await vi.advanceTimersByTimeAsync(10);
    expect(releases).toHaveLength(2);
    releases[1]();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('payment');
  });

  it('a late menu update that invalidates an unsent intent on the payment screen returns to the cart with the reason', async () => {
    // the first menu load succeeds; the refresh after Try again is held until the test releases it
    let releaseMenu!: () => void;
    let menuCalls = 0;
    const soldOut = MENU.map((m) => (m.id === COFFEE.id ? { ...m, available: false } : m));
    const base = ff.impl;
    const gated = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/menu') {
        menuCalls += 1;
        if (menuCalls === 1) return json(200, { currency: 'USD', items: MENU });
        await new Promise<void>((r) => { releaseMenu = r; });
        return json(200, { currency: 'USD', items: soldOut });
      }
      return base(input, init);
    }) as typeof fetch;
    rt.stop();
    let n = 0;
    rt = createRuntime({ api: createApi(gated), uuid: () => ids[n++ % ids.length], emit: () => {} });
    rt.boot();
    ff.setPost(() => json(201, orderStatus('failed')));
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.phase).toBe('declined');
    rt.actions.retryPayment(); // menu refresh starts (held); the payment screen is shown at once with a fresh key
    expect(rt.getState().interaction?.screen).toBe('payment');
    releaseMenu();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('menu');
    expect(rt.getState().interaction?.submission).toBeNull();
    expect(rt.getState().cart.flagged).toEqual([COFFEE.id]);
    expect(rt.getState().cart.lines).toHaveLength(1); // the rest of the order is preserved
    rt.actions.pay();
    expect(ff.posts()).toHaveLength(1); // nothing invalid was sent
  });

  it('a menu failure after a rejection keeps the key and does not claim nothing was charged', async () => {
    ff.setPost(rejected422);
    await toPayment();
    rt.actions.pay();
    await vi.advanceTimersByTimeAsync(10);
    const base = ff.impl;
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/menu') throw new TypeError('Failed to fetch');
      return base(input, init);
    }) as typeof fetch;
    rt.stop();
    rt = createRuntime({ api: createApi(failing), uuid: () => K2, emit: () => {} });
    rt.boot();
    rt.actions.tryAgain();
    await vi.advanceTimersByTimeAsync(10);
    expect(rt.getState().interaction?.screen).toBe('error');
    expect(rt.getState().error?.kind).toBe('menu_unreachable');
    expect(rt.getState().interaction?.submission?.idempotencyKey).toBe(K1);
  });
});
