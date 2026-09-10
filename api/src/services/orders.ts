import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/pool.ts';
import type { Counters } from '../observability/counters.ts';
import type { PaymentSimulator } from '../payment/simulator.ts';
import type { OrderState, OrderStatus, OrderSubmission, SimulatedOutcome, ValidationRejection } from '../../../shared/wire.ts';
import { fingerprint as computeFingerprint } from '../domain/fingerprint.ts';
import { generateReference, MAX_REFERENCE_ATTEMPTS, type ReferenceGenerator } from '../domain/reference.ts';
import { validateSubmission, type MenuRow, type Snapshot, type ValidationResult } from '../domain/validate.ts';

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

type FailedValidation = Extract<ValidationResult, { ok: false }>;

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
    const result = await pool.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE idempotency_key = $1`, [key]);
    return result.rows[0] ?? null;
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
  function replayOf(row: OrderRow, fingerprint: string, interactionId: string, log: FastifyBaseLogger): SubmitOutcome {
    if (row.fingerprint !== fingerprint) {
      counters.inc('orders.intent_mismatch');
      log.warn({ event: 'order.intent_mismatch', idempotencyKey: row.idempotency_key, orderId: row.id }, 'known key with a different intent');
      return { kind: 'mismatch', status: 409 };
    }
    counters.inc(`orders.replayed.${row.state}`);
    log.info({ event: 'order.replayed', idempotencyKey: row.idempotency_key, orderId: row.id, state: row.state }, 'replay served');
    return { kind: 'status', status: row.state === 'pending_payment' ? 202 : 200, body: toStatus(row, interactionId, true) };
  }

  /** The 422 for a submission the menu does not accept: nothing was created, and the body says what changed (FR-009). */
  function rejectionOf(validation: FailedValidation, key: string, interactionId: string, log: FastifyBaseLogger): SubmitOutcome {
    for (const reason of validation.reasons) counters.inc(`orders.validation_rejected.${reason}`);
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

  /**
   * INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING as ONE autocommit statement
   * (research R5). Zero rows means a competitor committed the same key. A 23505 can only come from
   * the reference constraint, which is retried with a fresh reference.
   */
  async function insertPending(body: OrderSubmission, fingerprint: string, interactionId: string, snapshot: Snapshot, log: FastifyBaseLogger): Promise<OrderRow | null> {
    for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      const reference = nextReference();
      try {
        const result = await pool.query<OrderRow>(
          `INSERT INTO orders (idempotency_key, fingerprint, interaction_id, reference, state, currency, total_minor, snapshot)
           VALUES ($1, $2, $3, $4, 'pending_payment', $5, $6, $7)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING ${ORDER_COLUMNS}`,
          [body.idempotencyKey, fingerprint, interactionId, reference, snapshot.currency, snapshot.totalMinor, JSON.stringify(snapshot)],
        );
        return result.rows[0] ?? null;
      } catch (err) {
        const pgError = err as { code?: string; constraint?: string };
        if (pgError.code === '23505' && pgError.constraint === 'orders_reference_key') {
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

  /**
   * Step 6 of the order of operations (research R5), by the request that inserted the row. This is
   * the post-commit window: any exception here leaves the row pending_payment and surfaces as 500,
   * and a replay then serves that state.
   */
  async function executePayment(row: OrderRow, requestedOutcome: SimulatedOutcome | undefined, log: FastifyBaseLogger): Promise<SimulatedOutcome> {
    const key = row.idempotency_key;
    try {
      await hooks.afterCommit?.({ orderId: row.id, idempotencyKey: key });
      const result = await simulator.execute({ orderId: row.id, idempotencyKey: key, totalMinor: row.total_minor, requestedOutcome });
      const outcome = result.kind;
      counters.inc(`payment.executed.${outcome}`);
      log.info({ event: 'payment.executed', idempotencyKey: key, orderId: row.id, outcome, source: requestedOutcome !== undefined && simulator.acceptClientHint ? 'request' : 'default' }, 'simulated payment executed');
      await hooks.afterPayment?.({ orderId: row.id, idempotencyKey: key, outcome });
      return outcome;
    } catch (err) {
      counters.inc('payment.post_commit_exception');
      log.error({ event: 'payment.post_commit_exception', idempotencyKey: key, orderId: row.id, err }, 'exception after commit; row stays pending_payment');
      throw err;
    }
  }

  /** Conditional UPDATE: cannot overwrite a recorded outcome. Zero rows is a defect, never silently a success. */
  async function recordOutcome(orderId: string, state: 'paid' | 'failed'): Promise<boolean> {
    const result = await pool.query(
      `UPDATE orders SET state = $2, outcome_recorded_at = now() WHERE id = $1 AND state = 'pending_payment'`,
      [orderId, state],
    );
    return result.rowCount === 1;
  }

  /** The order of operations from ADR-002 and research R5, one step per numbered comment. */
  async function submit(args: { body: OrderSubmission; interactionId: string; log: FastifyBaseLogger }): Promise<SubmitOutcome> {
    const { body, interactionId, log } = args;
    const key = body.idempotencyKey;

    // 2. fingerprint from the validated body (never includes simulation or the interaction id)
    const fingerprint = computeFingerprint({ currency: body.currency, expectedTotalMinor: body.expectedTotalMinor, lines: body.lines });

    // 3. SELECT by key: a replay is never re-validated against the menu (FR-018)
    const existing = await findByKey(key);
    if (existing) return replayOf(existing, fingerprint, interactionId, log);

    // 4. validate against the menu; on failure look once more (narrows, does not close, the window: ADR-002)
    const menu = await deps.loadMenu();
    const validation = validateSubmission(body, menu);
    if (!validation.ok) {
      const raced = await findByKey(key);
      if (raced) return replayOf(raced, fingerprint, interactionId, log);
      return rejectionOf(validation, key, interactionId, log);
    }

    // 5. insert; the barrier hook (tests only) runs before any pool client is held
    await hooks.beforeInsert?.({ idempotencyKey: key });
    let row: OrderRow | null;
    try {
      row = await insertPending(body, fingerprint, interactionId, validation.snapshot, log);
    } catch (err) {
      if (err instanceof ReferenceExhaustedError) return { kind: 'reference_exhausted', status: 503 };
      throw err;
    }
    if (!row) {
      const winner = await findByKey(key);
      if (!winner) throw new Error(`ON CONFLICT reported a conflict for ${key} but no row is visible`);
      return replayOf(winner, fingerprint, interactionId, log);
    }

    // This request inserted the row: it owns payment execution (ADR-002). Durable before external.
    counters.inc('orders.accepted');
    log.info({ event: 'order.accepted', idempotencyKey: key, orderId: row.id, reference: row.reference, totalMinor: row.total_minor }, 'order recorded as pending_payment');

    // 6. execute the simulated payment (post-commit window)
    const outcome = await executePayment(row, body.simulation?.outcome, log);
    if (outcome === 'inconclusive') {
      // nothing to record: the row stays pending_payment and the client polls by key
      return { kind: 'status', status: 202, body: toStatus(row, interactionId, false) };
    }

    // 7. record the outcome; a row that is no longer pending is a defect, never a silent success
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
