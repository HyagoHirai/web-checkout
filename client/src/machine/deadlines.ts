import { CONFIRMATION_MS, INACTIVITY_MS, NETWORK_WAIT_MS, POLL_MAX_MS, WARNING_MS } from '../../../shared/constants.ts';
import type { Interaction, Submission } from './types.ts';

/**
 * Deadline arithmetic from persisted timestamps only (research R4, data-model.md). A response is
 * never activity and never moves a deadline backward.
 */

/** When polling should begin if nothing else started it earlier. */
export function pollDueAt(submission: Submission): number | null {
  return submission.sentAt === null ? null : submission.sentAt + NETWORK_WAIT_MS;
}

/**
 * The bounded wait ends 30 s after polling started (OV-2), never later than sentAt + 38 s. The clamp
 * matters when the app was suspended: a poll that could only start late must not extend the wait.
 */
export function waitEndedAt(submission: Submission): number | null {
  const due = pollDueAt(submission);
  if (due === null) return null;
  const start = submission.pollStartedAt === null ? due : Math.min(submission.pollStartedAt, due);
  return start + POLL_MAX_MS;
}

/**
 * Normalise an interaction against the clock: a `submitted` interaction whose wait is over becomes
 * `unresolved`, and anything past its deadline becomes null (idle). Used by RESUME, TICK and the
 * admission rule, so a clock that jumped while the app was suspended is applied before any effect
 * or response, not one tick at a time.
 */
export function normalize(interaction: Interaction, now: number): Interaction | null {
  let current = interaction;
  if (current.phase === 'submitted' && current.submission) {
    const waitEnd = waitEndedAt(current.submission);
    if (waitEnd !== null && now >= waitEnd) current = { ...current, phase: 'unresolved' };
  }
  if (current.phase === 'idle') return null;
  return isExpired(current, now) ? null : current;
}

export function inactivityDeadline(interaction: Interaction): number | null {
  switch (interaction.phase) {
    case 'idle':
      return null;
    case 'submitted':
      return null; // suspended during the bounded wait
    case 'confirmed':
      return interaction.resolvedAt === null ? null : interaction.resolvedAt + CONFIRMATION_MS;
    case 'unresolved': {
      const waitEnd = interaction.submission ? waitEndedAt(interaction.submission) : null;
      return Math.max(interaction.lastActivityAt, waitEnd ?? 0) + INACTIVITY_MS;
    }
    case 'declined':
      // A decline that arrived late carries the deadline in force at the transition (deadlineAt);
      // the ordinary formula applies again once the customer's next qualifying interaction re-stamps.
      return interaction.deadlineAt ?? interaction.lastActivityAt + INACTIVITY_MS;
    case 'building':
      return interaction.deadlineAt ?? interaction.lastActivityAt + INACTIVITY_MS;
  }
}

export function warningAt(interaction: Interaction): number | null {
  if (interaction.phase === 'confirmed' || interaction.phase === 'submitted' || interaction.phase === 'idle') return null;
  const deadline = inactivityDeadline(interaction);
  return deadline === null ? null : deadline - WARNING_MS;
}

export function isExpired(interaction: Interaction, now: number): boolean {
  const deadline = inactivityDeadline(interaction);
  return deadline !== null && now >= deadline;
}
