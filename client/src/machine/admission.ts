import type { OrderStatus } from '../../../shared/wire.ts';
import { normalize } from './deadlines.ts';
import { retainedSubmission } from './submission.ts';
import type { Event, Interaction, KnownState, Submission } from './types.ts';

/**
 * The five-condition response admission rule, stated identically in research R4, data-model.md and
 * contracts/ui-states.md. A response event is admitted only if:
 *   1. the interaction is valid by the clock (a finished wait already applied);
 *   2. the event's interactionId is the current interaction's (FR-032);
 *   3. the event's idempotencyKey is the current submission's — monotonicity is per intent (FR-033);
 *   4. the transition is legal for the current phase: from submitted, from unresolved, or from
 *      building only for a retained (sent, rejected, outcome unknown) key being checked once more;
 *   5. a terminal result is not reapplied — nothing leaves confirmed or declined on a response.
 * Category-specific handling (definiteness, what a rejection may do) stays in the reducer.
 */

export type Admission =
  | { admitted: false }
  | { admitted: true; interaction: Interaction; submission: Submission; fromRetained: boolean };

export function admit(live: Interaction | null, response: Extract<Event, { type: 'RESPONSE' }>): Admission {
  if (!live || !live.submission) return { admitted: false };
  const interaction = normalize(live, response.now); // 1
  if (!interaction || !interaction.submission) return { admitted: false };
  if (interaction.id !== response.interactionId) return { admitted: false }; // 2
  if (interaction.submission.idempotencyKey !== response.idempotencyKey) return { admitted: false }; // 3
  const fromRetained = interaction.phase === 'building' && retainedSubmission(interaction) !== null;
  if (interaction.phase !== 'submitted' && interaction.phase !== 'unresolved' && !fromRetained) return { admitted: false }; // 4, 5
  return { admitted: true, interaction, submission: interaction.submission, fromRetained };
}

/** How definite a known state is: unknown < pending < terminal. Presentation never moves backward (FR-033). */
export const DEFINITENESS: Record<KnownState, number> = { none: 0, pending: 1, paid: 2, failed: 2 };

export function knownStateOf(status: OrderStatus): KnownState {
  return status.state === 'pending_payment' ? 'pending' : status.state;
}
