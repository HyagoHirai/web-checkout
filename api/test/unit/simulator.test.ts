import { describe, expect, it } from 'vitest';
import { createSimulator } from '../../src/payment/simulator.ts';

const input = { orderId: 'o1', idempotencyKey: 'k1', totalMinor: 350 };

describe('payment simulator (ADR-001)', () => {
  it('returns the requested outcome and records the call at entry', async () => {
    const sim = createSimulator({ defaultOutcome: 'success' });
    expect((await sim.execute({ ...input, requestedOutcome: 'declined' })).kind).toBe('declined');
    expect(sim.callsFor('k1')).toHaveLength(1);
    expect(sim.callsFor('k1')[0].source).toBe('request');
  });
  it('uses the server default when no hint is sent', async () => {
    const sim = createSimulator({ defaultOutcome: 'inconclusive' });
    expect((await sim.execute(input)).kind).toBe('inconclusive');
    expect(sim.calls()[0].source).toBe('default');
  });
  it('ignores the hint when acceptClientHint is false', async () => {
    const sim = createSimulator({ defaultOutcome: 'success', acceptClientHint: false });
    expect((await sim.execute({ ...input, requestedOutcome: 'declined' })).kind).toBe('success');
    expect(sim.calls()[0].source).toBe('default');
  });
  it('records the call before latency elapses', async () => {
    const sim = createSimulator({ defaultOutcome: 'success', latencyMs: 30 });
    const p = sim.execute(input);
    expect(sim.calls()).toHaveLength(1);
    await p;
  });
  it('reset clears the log', async () => {
    const sim = createSimulator({ defaultOutcome: 'success' });
    await sim.execute(input);
    sim.reset();
    expect(sim.calls()).toHaveLength(0);
  });
});
