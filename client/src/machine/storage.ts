import type { Interaction } from './types.ts';

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

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isNumOrNull(v: unknown): v is number | null {
  return v === null || isNum(v);
}

/** Returns null on any doubt about the shape; the caller then starts idle (FR-028). */
export function load(): Interaction | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.id !== 'string' || !isNum(v.startedAt) || !isNum(v.lastActivityAt)) return null;
    if (!PHASES.has(v.phase as string) || !SCREENS.has(v.screen as string)) return null;
    if (!isNumOrNull(v.resolvedAt) || !isNumOrNull(v.deadlineAt)) return null;
    const sub = v.submission as Record<string, unknown> | null;
    if (sub !== null) {
      if (typeof sub !== 'object' || typeof sub.idempotencyKey !== 'string' || !Array.isArray(sub.lines)) return null;
      if (!isNum(sub.expectedTotalMinor) || !isNumOrNull(sub.sentAt) || !isNumOrNull(sub.pollStartedAt)) return null;
      if (!KNOWN.has(sub.knownState as string)) return null;
    }
    return v as unknown as Interaction;
  } catch {
    return null;
  }
}
