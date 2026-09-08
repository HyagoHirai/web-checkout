import { INTERACTION_FORMAT_VERSION, type Interaction } from './types.ts';

const KEY = 'webcheckout.interaction';

/** Every access is wrapped: storage can throw in private windows and some embedded contexts. */
export function save(i: Interaction | null): void {
  try {
    if (i === null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(i));
  } catch {
    /* best effort */
  }
}

export function clear(): void {
  save(null);
}

const PHASES = new Set(['idle', 'building', 'submitted', 'confirmed', 'declined', 'unresolved']);
const SCREENS = new Set(['menu', 'review', 'payment', 'rejected', 'error']);
const KNOWN = new Set(['none', 'pending', 'paid', 'failed']);
const OUTCOMES = new Set(['success', 'declined', 'inconclusive']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function validLine(l: unknown): boolean {
  const o = l as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && isStr(o.itemId) && UUID.test(o.itemId) && isStr(o.name) && isNum(o.unitPriceMinor) && isNum(o.quantity) && o.quantity >= 1;
}

function validSubmission(s: unknown): boolean {
  const o = s as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return false;
  if (!isStr(o.idempotencyKey) || !UUID.test(o.idempotencyKey)) return false;
  if (!Array.isArray(o.lines) || !o.lines.every(validLine)) return false;
  if (!isNum(o.expectedTotalMinor) || !isNumOrNull(o.sentAt) || !isNumOrNull(o.pollStartedAt)) return false;
  if (!KNOWN.has(o.knownState as string) || !OUTCOMES.has(o.simulation as string)) return false;
  if (o.reference !== null && !isStr(o.reference)) return false;
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
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v.v !== INTERACTION_FORMAT_VERSION) return null;
    if (!isStr(v.id) || !UUID.test(v.id) || !isNum(v.startedAt) || !isNum(v.lastActivityAt)) return null;
    if (!PHASES.has(v.phase as string) || !SCREENS.has(v.screen as string)) return null;
    if (!isNumOrNull(v.resolvedAt) || !isNumOrNull(v.deadlineAt)) return null;
    const sub = v.submission;
    if (sub !== null && !validSubmission(sub)) return null;
    const phase = v.phase as string;
    const sent = sub !== null && isNum((sub as Record<string, unknown>).sentAt);
    if ((phase === 'submitted' || phase === 'unresolved' || phase === 'declined' || phase === 'confirmed') && !sent) return null;
    if (phase === 'confirmed' && !isNum(v.resolvedAt)) return null;
    return v as unknown as Interaction;
  } catch {
    return null;
  }
}
