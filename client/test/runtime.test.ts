import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderStatus } from '../../shared/wire.ts';
import { createApi } from '../src/api/client.ts';
import { createRuntime, type Runtime } from '../src/machine/runtime.ts';
import { COFFEE, IID, K1, K2, MENU } from './helpers.ts';

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
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers });
    if (url === '/api/menu') return json(200, { currency: 'USD', items: MENU });
    if (url === '/api/orders' && method === 'POST') return onPost(url, init);
    if (url.startsWith('/api/orders/by-key/')) return onGet(url, init);
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { impl, calls, setPost: (h: Handler) => { onPost = h; }, setGet: (h: Handler) => { onGet = h; }, posts: () => calls.filter((c) => c.method === 'POST' && c.url === '/api/orders'), gets: () => calls.filter((c) => c.url.startsWith('/api/orders/by-key/')) };
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

describe('US1: the happy path through the runtime', () => {
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

describe('US2: freezing and recovery (FR-014, FR-016, FR-017)', () => {
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

describe('US4: the bounded wait, polling, unknown outcomes and late results (FR-022..FR-025, FR-031, FR-034)', () => {
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

describe('US8: unreachable before submission (FR-026)', () => {
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

describe('US9: discarded responses are reported', () => {
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

describe('review round three: suspension, visibility, cleanup, cadence', () => {
  it('finding 2: a visibility change keeps the cart of a live interaction', async () => {
    await toPayment();
    rt.actions.backToCart();
    expect(rt.getState().cart.lines).toEqual([{ itemId: COFFEE.id, quantity: 2 }]);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    rt.revalidate();
    expect(rt.getState().cart.lines).toEqual([{ itemId: COFFEE.id, quantity: 2 }]);
    expect(rt.getState().interaction?.phase).toBe('building');
  });

  it('finding 1 at the runtime: resuming a submitted record after 600 s suspended goes idle, not to a fresh wait', async () => {
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

  it('finding 1 at the runtime: resumed at 40 s the wait is over and a late paid is still applied (interaction valid until 128 s)', async () => {
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
