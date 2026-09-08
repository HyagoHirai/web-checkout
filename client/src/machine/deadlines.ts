import { CONFIRMATION_MS, INACTIVITY_MS, NETWORK_WAIT_MS, POLL_MAX_MS, WARNING_MS } from '../../../shared/constants.ts';
import type { Interaction, Submission } from './types.ts';

/**
 * Deadline arithmetic from persisted timestamps only (research R4, data-model.md). A response is
 * never activity and never moves a deadline backward.
 */

/** When polling should begin if nothing else started it earlier. */
export function pollDueAt(sub: Submission): number | null {
  return sub.sentAt === null ? null : sub.sentAt + NETWORK_WAIT_MS;
}

/**
 * The bounded wait ends 30 s after polling started (OV-2), never later than sentAt + 38 s. The clamp
 * matters when the app was suspended: a poll that could only start late must not extend the wait.
 */
export function waitEndedAt(sub: Submission): number | null {
  const due = pollDueAt(sub);
  if (due === null) return null;
  const start = sub.pollStartedAt === null ? due : Math.min(sub.pollStartedAt, due);
  return start + POLL_MAX_MS;
}

/**
 * Normalise an interaction against the clock: a `submitted` interaction whose wait is over becomes
 * `unresolved`, and anything past its deadline becomes null (idle). Used by RESUME, TICK and the
 * admission rule, so a clock that jumped while the app was suspended is applied before any effect
 * or response, not one tick at a time.
 */
export function normalize(i: Interaction, now: number): Interaction | null {
  let cur = i;
  if (cur.phase === 'submitted' && cur.submission) {
    const end = waitEndedAt(cur.submission);
    if (end !== null && now >= end) cur = { ...cur, phase: 'unresolved' };
  }
  if (cur.phase === 'idle') return null;
  return isExpired(cur, now) ? null : cur;
}

export function inactivityDeadline(i: Interaction): number | null {
  switch (i.phase) {
    case 'idle':
      return null;
    case 'submitted':
      return null; // suspended during the bounded wait
    case 'confirmed':
      return i.resolvedAt === null ? null : i.resolvedAt + CONFIRMATION_MS;
    case 'unresolved': {
      const end = i.submission ? waitEndedAt(i.submission) : null;
      return Math.max(i.lastActivityAt, end ?? 0) + INACTIVITY_MS;
    }
    case 'declined':
      // A decline that arrived late carries the deadline in force at the transition (deadlineAt);
      // the ordinary formula applies again once the customer's next qualifying interaction re-stamps.
      return i.deadlineAt ?? i.lastActivityAt + INACTIVITY_MS;
    case 'building':
      return i.deadlineAt ?? i.lastActivityAt + INACTIVITY_MS;
  }
}

export function warningAt(i: Interaction): number | null {
  if (i.phase === 'confirmed' || i.phase === 'submitted' || i.phase === 'idle') return null;
  const d = inactivityDeadline(i);
  return d === null ? null : d - WARNING_MS;
}

export function isExpired(i: Interaction, now: number): boolean {
  const d = inactivityDeadline(i);
  return d !== null && now >= d;
}
