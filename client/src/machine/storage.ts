import { SIMULATED_OUTCOMES } from '../../../shared/wire.ts';
import { INTERACTION_FORMAT_VERSION, type Interaction } from './types.ts';

const KEY = 'webcheckout.interaction';

/** Every access is wrapped: storage can throw in private windows and some embedded contexts. */
export function save(interaction: Interaction | null): void {
  try {
    if (interaction === null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(interaction));
  } catch {
    /* best effort */
  }
}

export function clear(): void {
  save(null);
}

/** The raw stored record, or `undefined` when storage itself is unavailable (private window, blocked). */
export function readRaw(): string | null | undefined {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return undefined;
  }
}

/** Whether an in-memory interaction is still the tab's current record, byte for byte. */
export function isCurrent(interaction: Interaction, raw: string | null): boolean {
  return raw !== null && raw === JSON.stringify(interaction);
}

const PHASES = new Set(['idle', 'building', 'submitted', 'confirmed', 'declined', 'unresolved']);
const SCREENS = new Set(['menu', 'review', 'payment', 'rejected', 'error']);
const KNOWN = new Set(['none', 'pending', 'paid', 'failed']);
const OUTCOMES = new Set<string>(SIMULATED_OUTCOMES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function validLine(value: unknown): boolean {
  const line = value as Record<string, unknown> | null;
  return !!line && typeof line === 'object' && isStr(line.itemId) && UUID.test(line.itemId) && isStr(line.name) && isNum(line.unitPriceMinor) && isNum(line.quantity) && line.quantity >= 1;
}

function validSubmission(value: unknown): boolean {
  const submission = value as Record<string, unknown> | null;
  if (!submission || typeof submission !== 'object') return false;
  if (!isStr(submission.idempotencyKey) || !UUID.test(submission.idempotencyKey)) return false;
  if (!Array.isArray(submission.lines) || !submission.lines.every(validLine)) return false;
  if (!isNum(submission.expectedTotalMinor) || !isNumOrNull(submission.sentAt) || !isNumOrNull(submission.pollStartedAt) || !isNumOrNull(submission.recordedTotalMinor)) return false;
  if (!KNOWN.has(submission.knownState as string) || !OUTCOMES.has(submission.simulation as string)) return false;
  if (submission.reference !== null && !isStr(submission.reference)) return false;
  return true;
}

/**
 * Validates the record as a union of valid states, not field by field: phases with a sent
 * submission require one; confirmed requires resolvedAt; an unknown format version is rejected.
 * Returns null on any doubt; the caller then starts idle (FR-028).
 */
export function load(): Interaction | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Record<string, unknown>;
    if (record.v !== INTERACTION_FORMAT_VERSION) return null;
    if (!isStr(record.id) || !UUID.test(record.id) || !isNum(record.startedAt) || !isNum(record.lastActivityAt)) return null;
    if (!PHASES.has(record.phase as string) || !SCREENS.has(record.screen as string)) return null;
    if (!isNumOrNull(record.resolvedAt) || !isNumOrNull(record.deadlineAt)) return null;
    const submission = record.submission;
    if (submission !== null && !validSubmission(submission)) return null;
    const phase = record.phase as string;
    const sent = submission !== null && isNum((submission as Record<string, unknown>).sentAt);
    if ((phase === 'submitted' || phase === 'unresolved' || phase === 'declined' || phase === 'confirmed') && !sent) return null;
    if (phase === 'confirmed' && !isNum(record.resolvedAt)) return null;
    return record as unknown as Interaction;
  } catch {
    return null;
  }
}
