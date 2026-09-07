import type { MenuItem, OrderState, OrderStatus, RejectionReason, SimulatedOutcome, ValidationRejection } from '../../../shared/wire.ts';

export type Phase = 'idle' | 'building' | 'submitted' | 'confirmed' | 'declined' | 'unresolved';

/** Which screen the building phase shows. Persisted so a reload lands on the same screen. */
export type BuildingScreen = 'menu' | 'review' | 'payment' | 'rejected' | 'error';

export type KnownState = 'none' | 'pending' | 'paid' | 'failed';

export interface FrozenLine {
  itemId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
}

export interface Submission {
  idempotencyKey: string;
  lines: FrozenLine[];
  expectedTotalMinor: number;
  sentAt: number | null;
  pollStartedAt: number | null;
  knownState: KnownState;
  reference: string | null;
  simulation: SimulatedOutcome;
}

export interface CartLine {
  itemId: string;
  quantity: number;
}

export interface Cart {
  lines: CartLine[];
  flagged: string[];
}

export interface Rejection {
  reasons: RejectionReason[];
  affectedItemIds: string[];
  currentTotalMinor?: number;
}

export interface ErrorInfo {
  kind: 'menu_unreachable' | 'bad_request' | 'reference_exhausted';
}

/** Persisted in sessionStorage (data-model.md "Interaction"). */
export interface Interaction {
  id: string;
  startedAt: number;
  lastActivityAt: number;
  phase: Phase;
  screen: BuildingScreen;
  resolvedAt: number | null;
  deadlineAt: number | null;
  submission: Submission | null;
}

export interface State {
  interaction: Interaction | null;
  menu: MenuItem[] | null;
  menuLoading: boolean;
  cart: Cart;
  rejection: Rejection | null;
  error: ErrorInfo | null;
  now: number;
}

/** The canonical classification of a response (contracts/openapi.yaml). */
export type Classified =
  | { category: 'outcome'; status: OrderStatus }
  | { category: 'conflict' }
  | { category: 'rejected'; rejection: ValidationRejection }
  | { category: 'bad_request' }
  | { category: 'reference_exhausted' }
  | { category: 'unknown'; reason: string };

export type Event =
  | { type: 'START'; now: number; interactionId: string }
  | { type: 'MENU_LOADED'; now: number; items: MenuItem[] }
  | { type: 'MENU_FAILED'; now: number }
  | { type: 'ADD_ITEM'; now: number; itemId: string }
  | { type: 'SET_QTY'; now: number; itemId: string; quantity: number }
  | { type: 'REMOVE_ITEM'; now: number; itemId: string }
  | { type: 'GO_REVIEW'; now: number }
  | { type: 'GO_MENU'; now: number }
  | { type: 'GO_PAYMENT'; now: number; idempotencyKey: string }
  | { type: 'BACK_TO_CART'; now: number }
  | { type: 'SET_SIMULATION'; now: number; outcome: SimulatedOutcome }
  | { type: 'PAY'; now: number }
  | { type: 'POLL_START'; now: number }
  | { type: 'RESPONSE'; now: number; source: 'post' | 'poll' | 'lookup'; interactionId: string; idempotencyKey: string; result: Classified }
  | { type: 'TICK'; now: number }
  | { type: 'CONTINUE'; now: number }
  | { type: 'RETRY_AFTER_ERROR'; now: number }
  | { type: 'TRY_AGAIN'; now: number }
  | { type: 'START_NEW_ORDER'; now: number }
  | { type: 'DONE'; now: number }
  | { type: 'RESUME'; now: number; interaction: Interaction | null };

export type { OrderState, MenuItem, SimulatedOutcome };
