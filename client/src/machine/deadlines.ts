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

/** The bounded wait ends 30 s after polling started (OV-2), never later than sentAt + 38 s. */
export function waitEndedAt(sub: Submission): number | null {
  if (sub.pollStartedAt !== null) return sub.pollStartedAt + POLL_MAX_MS;
  const due = pollDueAt(sub);
  return due === null ? null : due + POLL_MAX_MS;
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

/** In `submitted`, the moment the bounded wait is over and the phase must become `unresolved`. */
export function waitIsOver(i: Interaction, now: number): boolean {
  if (i.phase !== 'submitted' || !i.submission) return false;
  const end = waitEndedAt(i.submission);
  return end !== null && now >= end;
}
