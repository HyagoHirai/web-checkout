import type { SimulatedOutcome } from '../../../shared/wire.ts';

export interface SimulatorOptions {
  defaultOutcome: SimulatedOutcome;
  latencyMs?: number;
  acceptClientHint?: boolean;
  maxLog?: number;
}

export interface ExecuteInput {
  orderId: string;
  idempotencyKey: string;
  totalMinor: number;
  requestedOutcome?: SimulatedOutcome;
}

export interface SimulatorCall extends ExecuteInput {
  effectiveOutcome: SimulatedOutcome;
  source: 'request' | 'default';
  at: number;
}

export interface SimulatorResult {
  kind: SimulatedOutcome;
}

export interface PaymentSimulator {
  execute(input: ExecuteInput): Promise<SimulatorResult>;
  calls(): readonly SimulatorCall[];
  callsFor(idempotencyKey: string): readonly SimulatorCall[];
  reset(): void;
  readonly defaultOutcome: SimulatedOutcome;
  readonly acceptClientHint: boolean;
  readonly latencyMs: number;
}

/**
 * ADR-001 "The payment simulator": success | declined | inconclusive, selected per submission on the
 * simulated payment screen with a server default (owner-approved amendment). The call record is
 * appended AT ENTRY, before the outcome is decided, so a throw after the call still counts as one
 * execution: the semantics "at most one" needs. One instance per app (never a module singleton).
 * Latency is cosmetic and never influences the outcome.
 */
export function createSimulator(opts: SimulatorOptions): PaymentSimulator {
  const latencyMs = opts.latencyMs ?? 0;
  const acceptClientHint = opts.acceptClientHint ?? true;
  const maxLog = opts.maxLog ?? 1000;
  let log: SimulatorCall[] = [];

  return {
    defaultOutcome: opts.defaultOutcome,
    acceptClientHint,
    latencyMs,
    async execute(input) {
      const useHint = acceptClientHint && input.requestedOutcome !== undefined;
      const effectiveOutcome = useHint ? (input.requestedOutcome as SimulatedOutcome) : opts.defaultOutcome;
      log.push({ ...input, effectiveOutcome, source: useHint ? 'request' : 'default', at: Date.now() });
      if (log.length > maxLog) log = log.slice(log.length - maxLog);
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return { kind: effectiveOutcome };
    },
    calls() {
      return log;
    },
    callsFor(key) {
      return log.filter((c) => c.idempotencyKey === key);
    },
    reset() {
      log = [];
    },
  };
}
