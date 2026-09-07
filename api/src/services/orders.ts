import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/pool.ts';
import type { Counters } from '../observability/counters.ts';
import type { PaymentSimulator } from '../payment/simulator.ts';
import type { OrderState, OrderStatus, OrderSubmission, SimulatedOutcome, ValidationRejection } from '../../../shared/wire.ts';
import { fingerprint as computeFingerprint } from '../domain/fingerprint.ts';
import { generateReference, MAX_REFERENCE_ATTEMPTS, type ReferenceGenerator } from '../domain/reference.ts';
import { validateSubmission, type MenuRow, type Snapshot } from '../domain/validate.ts';

/**
 * Test seams (research R9): `{}` in production, unreachable over HTTP. They do not simulate a crash;
 * they exercise a precise window and let a test assert that an exception there leaves the row in
 * pending_payment, never failed, and that a replay executes nothing. `beforeInsert` is an awaitable
 * barrier that makes the N-way same-key race deterministic.
 */
export interface SubmissionHooks {
  beforeInsert?: (ctx: { idempotencyKey: string }) => Promise<void> | void;
  afterCommit?: (ctx: { orderId: string; idempotencyKey: string }) => Promise<void> | void;
  afterPayment?: (ctx: { orderId: string; idempotencyKey: string; outcome: SimulatedOutcome }) => Promise<void> | void;
}

export interface OrdersServiceDeps {
  pool: Pool;
  simulator: PaymentSimulator;
  counters: Counters;
  hooks?: SubmissionHooks;
  referenceGenerator?: ReferenceGenerator;
  loadMenu: () => Promise<MenuRow[]>;
}

export type SubmitOutcome =
  | { kind: 'status'; status: 201 | 202 | 200; body: OrderStatus }
  | { kind: 'rejected'; status: 422; body: ValidationRejection }
  | { kind: 'mismatch'; status: 409 }
  | { kind: 'reference_exhausted'; status: 503 };

interface OrderRow {
  id: string;
  idempotency_key: string;
  fingerprint: string;
  interaction_id: string;
  reference: string;
  state: OrderState;
  currency: 'USD';
  total_minor: number;
}

const ORDER_COLUMNS = 'id, idempotency_key, fingerprint, interaction_id, reference, state, currency, total_minor';

export class ReferenceExhaustedError extends Error {
  constructor() {
    super('could not generate a unique order reference');
    this.name = 'ReferenceExhaustedError';
  }
}

export function createOrdersService(deps: OrdersServiceDeps) {
  const { pool, simulator, counters } = deps;
  const hooks = deps.hooks ?? {};
  const nextReference = deps.referenceGenerator ?? generateReference;

  async function findByKey(key: string): Promise<OrderRow | null> {
    const res = await pool.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE idempotency_key = $1`, [key]);
    return res.rows[0] ?? null;
  }

  function toStatus(row: OrderRow, interactionId: string, replay: boolean): OrderStatus {
    return {
      orderId: row.id,
      reference: row.reference,
      state: row.state,
      totalMinor: row.total_minor,
      currency: row.currency,
      interactionId,
      replay,
    };
  }

  /** A replay returns the recorded state at the recorded values; nothing executes (ADR-002). */
  function replayOf(row: OrderRow, fp: string, interactionId: string, log: FastifyBaseLogger): SubmitOutcome {
    if (row.fingerprint !== fp) {
      counters.inc('orders.intent_mismatch');
      log.warn({ event: 'order.intent_mismatch', idempotencyKey: row.idempotency_key, orderId: row.id }, 'known key with a different intent');
      return { kind: 'mismatch', status: 409 };
    }
    counters.inc(`orders.replayed.${row.state}`);
    log.info({ event: 'order.replayed', idempotencyKey: row.idempotency_key, orderId: row.id, state: row.state }, 'replay served');
    return { kind: 'status', status: row.state === 'pending_payment' ? 202 : 200, body: toStatus(row, interactionId, true) };
  }

  /**
   * INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING as ONE autocommit statement
   * (research R5). Zero rows means a competitor committed the same key. A 23505 can only come from
   * the reference constraint, which is retried with a fresh reference.
   */
  async function insertPending(body: OrderSubmission, fp: string, interactionId: string, snapshot: Snapshot, log: FastifyBaseLogger): Promise<OrderRow | null> {
    for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      const reference = nextReference();
      try {
        const res = await pool.query<OrderRow>(
          `INSERT INTO orders (idempotency_key, fingerprint, interaction_id, reference, state, currency, total_minor, snapshot)
           VALUES ($1, $2, $3, $4, 'pending_payment', $5, $6, $7)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING ${ORDER_COLUMNS}`,
          [body.idempotencyKey, fp, interactionId, reference, snapshot.currency, snapshot.totalMinor, JSON.stringify(snapshot)],
        );
        return res.rows[0] ?? null;
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'orders_reference_key') {
          counters.inc('order_reference.collision');
          log.warn({ event: 'order_reference.collision', attempt, reference }, 'reference collision, retrying');
          continue;
        }
        throw err;
      }
    }
    counters.inc('order_reference.exhausted');
    log.error({ event: 'order_reference.exhausted', attempts: MAX_REFERENCE_ATTEMPTS }, 'reference space exhausted for this attempt');
    throw new ReferenceExhaustedError();
  }

  /** Conditional UPDATE: cannot overwrite a recorded outcome. Zero rows is a defect, never silently a success. */
  async function recordOutcome(orderId: string, state: 'paid' | 'failed'): Promise<boolean> {
    const res = await pool.query(
      `UPDATE orders SET state = $2, outcome_recorded_at = now() WHERE id = $1 AND state = 'pending_payment'`,
      [orderId, state],
    );
    return res.rowCount === 1;
  }

  async function submit(args: { body: OrderSubmission; interactionId: string; log: FastifyBaseLogger }): Promise<SubmitOutcome> {
    const { body, interactionId, log } = args;
    const key = body.idempotencyKey;
    const requestedOutcome = body.simulation?.outcome;

    // 2. fingerprint from the validated body (never includes simulation or the interaction id)
    const fp = computeFingerprint({ currency: body.currency, expectedTotalMinor: body.expectedTotalMinor, lines: body.lines });

    // 3. SELECT by key: a replay is never re-validated against the menu (FR-018)
    const existing = await findByKey(key);
    if (existing) return replayOf(existing, fp, interactionId, log);

    // 4. validate against the menu; on failure look once more (narrows, does not close, the window: ADR-002)
    const menu = await deps.loadMenu();
    const validation = validateSubmission(body, menu);
    if (!validation.ok) {
      const raced = await findByKey(key);
      if (raced) return replayOf(raced, fp, interactionId, log);
      for (const r of validation.reasons) counters.inc(`orders.validation_rejected.${r}`);
      log.info({ event: 'order.validation_rejected', idempotencyKey: key, reasons: validation.reasons, affectedItemIds: validation.affectedItemIds }, 'submission rejected before payment');
      return {
        kind: 'rejected',
        status: 422,
        body: {
          error: 'validation_rejected',
          reasons: validation.reasons,
          interactionId,
          currentItems: validation.currentItems,
          affectedItemIds: validation.affectedItemIds,
          ...(validation.currentTotalMinor !== undefined ? { currentTotalMinor: validation.currentTotalMinor } : {}),
        },
      };
    }

    // 5. insert; the barrier hook (tests only) runs before any pool client is held
    await hooks.beforeInsert?.({ idempotencyKey: key });
    let row: OrderRow | null;
    try {
      row = await insertPending(body, fp, interactionId, validation.snapshot, log);
    } catch (err) {
      if (err instanceof ReferenceExhaustedError) return { kind: 'reference_exhausted', status: 503 };
      throw err;
    }
    if (!row) {
      const winner = await findByKey(key);
      if (!winner) throw new Error(`ON CONFLICT reported a conflict for ${key} but no row is visible`);
      return replayOf(winner, fp, interactionId, log);
    }

    // This request inserted the row: it owns payment execution (ADR-002). Durable before external.
    counters.inc('orders.accepted');
    log.info({ event: 'order.accepted', idempotencyKey: key, orderId: row.id, reference: row.reference, totalMinor: row.total_minor }, 'order recorded as pending_payment');

    // 6-7. post-commit window: any exception leaves the row pending_payment and surfaces as 500
    let outcome: SimulatedOutcome;
    try {
      await hooks.afterCommit?.({ orderId: row.id, idempotencyKey: key });
      const result = await simulator.execute({ orderId: row.id, idempotencyKey: key, totalMinor: row.total_minor, requestedOutcome });
      outcome = result.kind;
      counters.inc(`payment.executed.${outcome}`);
      log.info({ event: 'payment.executed', idempotencyKey: key, orderId: row.id, outcome, source: requestedOutcome !== undefined && simulator.acceptClientHint ? 'request' : 'default' }, 'simulated payment executed');
      await hooks.afterPayment?.({ orderId: row.id, idempotencyKey: key, outcome });
    } catch (err) {
      counters.inc('payment.post_commit_exception');
      log.error({ event: 'payment.post_commit_exception', idempotencyKey: key, orderId: row.id, err }, 'exception after commit; row stays pending_payment');
      throw err;
    }

    if (outcome === 'inconclusive') {
      return { kind: 'status', status: 202, body: toStatus(row, interactionId, false) };
    }
    const state: OrderState = outcome === 'success' ? 'paid' : 'failed';
    const recorded = await recordOutcome(row.id, state);
    if (!recorded) {
      counters.inc('payment.outcome_record_failed');
      log.error({ event: 'payment.outcome_record_failed', idempotencyKey: key, orderId: row.id, outcome }, 'outcome could not be recorded: row no longer pending');
      throw new Error(`outcome for order ${row.id} could not be recorded`);
    }
    counters.inc('payment.outcome_recorded');
    log.info({ event: 'payment.outcome_recorded', idempotencyKey: key, orderId: row.id, state }, 'outcome recorded');
    return { kind: 'status', status: 201, body: toStatus({ ...row, state }, interactionId, false) };
  }

  async function lookupByKey(key: string, interactionId: string, log: FastifyBaseLogger): Promise<OrderStatus | null> {
    const row = await findByKey(key);
    if (!row) {
      counters.inc('status_lookup.not_found');
      log.debug({ event: 'status.not_found', idempotencyKey: key }, 'status lookup: not found');
      return null;
    }
    counters.inc(`status_lookup.${row.state}`);
    log.debug({ event: 'status.served', idempotencyKey: key, orderId: row.id, state: row.state }, 'status lookup served');
    return toStatus(row, interactionId, true);
  }

  return { submit, lookupByKey };
}

export type OrdersService = ReturnType<typeof createOrdersService>;
