# Feature Specification: Web Checkout

**Feature Branch**: `001-web-checkout` (no branch created; no branch hook is configured, work is on `main`)

**Created**: 2026-09-07

**Status**: Draft

**Input**: User description: the owner's specification "Specification — Web Checkout"
(`docs/specification.md`), supplied verbatim to `/speckit-specify`. This document restates it in
the Spec Kit structure. Where it draws customer-visible behaviour from an ADR, the ADR is cited.
Implementation decisions live in `docs/adr/` and in the plan — deliberately not here.

## Context

A snack bar wants customers to order and pay themselves at a screen, without staff involvement.

The person using this is standing at a terminal in a public space, alone, probably in a hurry,
with nobody to ask for help. There is no login, no account, and no way to reach them once they
walk away. The device is shared: whoever is at the screen now is probably not whoever was there a
minute ago. Almost every requirement below follows from that.

**Users.** One role: the **customer**. Walks up, browses, orders, pays, leaves. Uses the system
once, briefly. May abandon at any point. There is no second user role in scope.

## Scope

**In scope**

- Browsing a menu of items with prices
- Building an order: adding items, changing quantities, removing items
- Reviewing the order and its total before committing
- Paying (simulated) and receiving confirmation
- Defined behaviour when things fail or the customer abandons

**Out of scope** — deliberately, see ADR-001. These generate no implementation tasks.

- Real payment processing — the payment step is simulated; no card data is collected
- Authentication or customer accounts
- Menu administration
- Order fulfilment tracking
- Order cancellation after confirmation
- Promotions, discounts, coupons
- Counted inventory (availability is a flag)
- Receipt printing and hardware integration
- Reconciliation of orders left in an unknown state; any staff-facing interface

## Clarifications

### Session 2026-09-07

- Q: How long should the kiosk wait for a payment result, how often and for how long should it
  poll afterwards, and how long should the confirmation stay on screen before returning to idle?
  → A: Network wait 8 s, then poll every 2 s for up to 30 s; confirmation shown for 15 s.
- Q: What are the maximum quantity per item, the maximum total quantity per order, and the
  maximum order total that the kiosk and the server should both enforce? → A: 10 of any one
  item, 50 units across the order, order total 1,000.00 in the order currency.
- Q: Which single currency should every price and total in the exercise use? → A: USD (US
  dollar), displayed as $12.50.
- Q: What should the order reference shown on the confirmation screen look like, given that its
  only job is to be read aloud at the counter? → A: 4 characters, uppercase letters and digits
  with look-alikes removed (no 0, O, 1, I, L), e.g. "K7PM", unique across all orders.
- Q: If a definitive payment result arrives late, after the customer has already been shown the
  unresolved screen but before the interaction has ended, should the screen update to that
  result? → A: Yes. Update to the confirmation or the decline exactly as if the result had
  arrived in time; never the reverse.
- Q: What is the target environment for the demonstration? → A: Chrome at a 1024×768 viewport.
  Owner decision: this is a project decision, not a technical choice. It fixes the viewport
  developed against, where interface tests run, and what "tablet-sized" means in NFR-001.
- Q: Is "unreachable" (User Story 8) correctly read as failures before a submission is sent,
  with anything after send falling under the unknown-outcome rules? → A: Yes, confirmed by the
  owner. The distinction is deliberate: a screen-side error is not evidence about the order,
  which is why FR-025 exists.
- Q: Are the proposed story priorities accepted? → A: Yes. P3 on User Story 9 is an ordering
  priority, not optional scope: it is a correctness guarantee, and dropping it would produce
  exactly the stranger's-order and false-status failures the P1 stories prevent.
- Q (plan review): Is the price guarantee per line or over the total? → A: Over the total,
  consistent with ADR-003. A per-line movement that leaves the total unchanged is accepted.
- Q (plan review): When is availability checked? → A: At the point the submission is validated,
  and only there. An accepted order is never re-checked (FR-018).
- Q (plan review): Does SC-007 hold when the server was never reached? → A: No, and it cannot.
  SC-007 is qualified: a failure whose cause is that the server was not reached is recorded only
  when the client's best-effort event lands. This covers User Story 8 and the never-reached-the-
  server cases in User Story 4.
- Q (plan review): What exactly does "at most one payment" promise? → A: At most one order per
  intent, exactly one where acceptance occurred, and the simulator called at most once per intent.
- Q (review round six): How does the "not found" rule reconcile with re-confirmation after a
  rejection? → A (owner, 2026-09-08): Confirmed with the narrow scope: only the service's explicit
  `not_found` permits a new key; a network failure, a 5xx, or any other answer keeps it. The check
  narrows the window rather than closing it, and ADR-002 says so under "Where this still breaks".
- Q (plan review, round four): FR-009 said "No order MUST be created for a rejected submission".
  → A (owner, 2026-09-08): Changed to "No order is created by a rejected request." The mechanism
  guarantees something about the request, not the intent; the earlier wording contradicted ADR-002.

## User Scenarios & Testing *(mandatory)*

Priorities follow the owner's success criteria: the happy path and the four guarantees named
there (never charged twice, never charged an amount not shown, nothing of a stranger's order
survives a reset, honesty about what is and is not known) are P1. Other defined failure paths are
P2. Ordering of late responses is P3. **Priority orders the work; it does not make any story
optional.** Every story in this specification is in scope for the delivery.

### User Story 1 - Order and pay at the kiosk (Priority: P1)

A customer walks up to an idle kiosk, starts an order, sees the menu with prices and
availability, adds items and adjusts quantities while the running total updates, reviews the
complete order and its total, confirms, and the simulated payment runs. They see a confirmation
with a reference they can quote at the counter. The kiosk returns to idle on its own.

**Why this priority**: This is the product. Every other story protects this one.

**Independent Test**: From idle, add two available items, adjust a quantity, review, confirm
with the simulator set to succeed, observe a confirmation carrying an order reference, wait the
confirmation display period, observe idle. Delivers a complete self-service purchase.

**Acceptance Scenarios**:

1. **Given** the kiosk is idle, **When** the customer starts an order, **Then** the menu is shown
   with each item's price and availability.
2. **Given** an available item, **When** the customer adds it and changes its quantity, **Then**
   the cart shows the item at that quantity and the running total updates.
3. **Given** an unavailable item, **When** the customer attempts to add it, **Then** it is not
   added and the cart is unchanged.
4. **Given** an item in the cart, **When** the customer sets its quantity to zero, **Then** the
   item is removed from the cart.
5. **Given** an empty cart, **When** the customer attempts to submit, **Then** submission is not
   possible.
6. **Given** a cart with items, **When** the customer proceeds to review, **Then** the complete
   order and its total are shown before anything is committed.
7. **Given** the total shown at review, **When** the customer confirms and the simulated payment
   succeeds, **Then** the order is accepted at exactly that total and a confirmation showing an
   order reference is displayed.
8. **Given** the confirmation is displayed, **When** the confirmation display period of 15 s
   elapses, **Then** the kiosk returns to idle without customer action.
9. **Given** a quantity above 10 for one item, more than 50 units in the order, or a total above
   $1,000.00, **When** the customer attempts it, **Then** it is rejected on the client before
   submission; **and Given** such a value reaches
   the server anyway, **Then** the server independently rejects it.

---

### User Story 2 - Submitting more than once creates one order (Priority: P1)

The customer taps confirm twice because the first tap did not visibly do anything, or refreshes
the page while the submission is in progress, or goes back to the cart or presses "Start new
order" while the outcome is still unknown. Only one order is created and at most one payment is
attempted. The customer sees the outcome of that single order, not an error.

**Why this priority**: A double charge at an unattended terminal has no cashier to catch it.
"Nobody is charged twice" is a named success criterion.

**Independent Test**: Confirm, then confirm again before the result is shown; refresh during
submission; go back to the cart during an unknown outcome. In each case count orders and count
the simulator's calls: one order, at most one call.

**Acceptance Scenarios**:

1. **Given** the customer has confirmed and no result is shown yet, **When** they tap confirm
   again, **Then** only one order exists, at most one payment was attempted, and the customer sees
   that single order's outcome rather than an error.
2. **Given** a submission is in progress, **When** the page is refreshed, **Then** no second order
   is created and, after the refresh, the customer sees the same order's status.
3. **Given** the outcome of a submission is unknown, **When** the customer goes back to the cart
   or presses "Start new order", **Then** no second payment is made for the same items.
4. **Given** an accepted order, **When** a genuinely separate order with the same items is placed
   minutes apart, **Then** both orders are accepted.
5. **Given** an already accepted order, **When** the same submission is repeated, **Then** it is
   not re-checked against the current menu (price or availability) and its recorded outcome is
   returned.

---

### User Story 3 - Never charged an amount that was not shown (Priority: P1)

A price changed while the customer was ordering. The customer is never charged an amount
different from what was displayed: the submission is rejected before any payment, the current
price is shown, and the customer confirms again.

**Why this priority**: "Nobody is charged an amount they were not shown" is a named success
criterion, and a silent correction at an unattended terminal leaves the customer no recourse.

**Independent Test**: Build a cart, change an item's price behind the scenes, confirm. Observe
rejection with the current price shown, zero orders created, zero payment attempts; re-confirm and
observe acceptance at the newly displayed total.

**Acceptance Scenarios**:

1. **Given** a price changed after the customer saw it such that the total recomputed by the
   server differs from the total displayed, **When** they confirm, **Then** the submission is
   rejected before any payment, no order is created, the current prices and total are shown, and
   the customer is asked to confirm again. (A price movement that leaves the total unchanged is
   accepted: the guarantee is over the total, ADR-003.)
2. **Given** the customer re-confirms at the current price, **When** the payment succeeds,
   **Then** the order is accepted at the total displayed at that re-confirmation.

---

### User Story 4 - Outcome unknown: honest about what is known (Priority: P1)

The submission was sent but no result came back within the wait — a network failure, or a
simulated inconclusive response. The customer is not told payment failed, because that is not
known. They are told the result is not confirmed, directed to check at the counter, and not
invited to pay again.

**Why this priority**: "When something fails, the customer knows what happened — or knows
honestly that it isn't yet known — and what to do next" is a named success criterion. Telling the
customer a payment failed when it may have succeeded invites a second charge.

**Independent Test**: Set the simulator to inconclusive, or drop the response; confirm; let the
bounded wait elapse. Observe the unresolved screen, its wording, the absence of any pay-again
action, and that the kiosk still returns to idle.

**Acceptance Scenarios**:

1. **Given** a submission was sent and no result arrived within the bounded wait (8 s network
   wait, then polling every 2 s for up to 30 s), **When** the wait ends, **Then** the customer is told the result is not confirmed, is directed
   to the counter, is not told payment failed, and is not offered a way to pay again.
2. **Given** a status check confirmed that the order exists without a payment result, **When**
   the unresolved screen is shown, **Then** it says the order was received, shows the order
   reference, and says not to pay again (ADR-005).
3. **Given** no status check ever confirmed that the order exists, **When** the unresolved
   screen is shown, **Then** it says it could not confirm whether the order went through, shows no
   reference, and does not assert that the counter will find anything (ADR-005).
4. **Given** a generic server error or a failed status lookup during or after submission,
   **When** it occurs, **Then** it is treated as unknown — never as a decline — and no new payment
   for the same items is offered.
5. **Given** the unresolved screen, **When** the customer takes the exit or the inactivity timer
   fires, **Then** the kiosk returns to idle, and the submitted order continues server-side and is
   not cancelled.
6. **Given** the unresolved screen is showing and the interaction has not ended, **When** a
   definitive result arrives late, **Then** the screen updates to the confirmation (with
   reference) or to the decline screen (items intact, may confirm again), exactly as if the
   result had arrived in time.

---

### User Story 5 - Shared device: nothing survives a reset or expiry (Priority: P1)

A customer walks away mid-order. After a visible warning, the screen clears and returns to idle.
The next person at the screen never sees, and can never pay for, the previous person's cart or
result — including after a reload or browser navigation.

**Why this priority**: "Nobody sees a stranger's order after a reset" is a named success
criterion. Losing an abandoned cart is acceptable; showing or charging one person's cart to the
next is not (ADR-005).

**Independent Test**: Build a cart, stop interacting; observe the warning, then idle. Reload and
navigate back; observe that nothing from the previous interaction is shown. Verify no order and
no charge exist for a cart abandoned before submission.

**Acceptance Scenarios**:

1. **Given** a customer is mid-interaction and stops interacting, **When** the inactivity period
   elapses (90 s, warning visible during the final 15 s — decided in ADR-005), **Then** the screen
   clears and returns to idle.
2. **Given** the inactivity warning is showing, **When** the customer presses Continue, **Then**
   that counts as activity and the interaction continues unchanged (ADR-005).
3. **Given** a reset or an expiry has occurred, **When** the next interaction starts — including
   after a reload or browser navigation — **Then** no previous cart, result, or reference is
   restored or shown.
4. **Given** a cart abandoned before submission, **When** the interaction ends, **Then** no order
   exists and nothing is charged.
5. **Given** an order abandoned after submission, **When** the screen clears, **Then** the order
   continues server-side; clearing the screen does not cancel it.
6. **Given** the client is waiting for a payment result, **When** the bounded wait ends without a
   result, **Then** the inactivity timer resumes; the wait cannot hold the screen indefinitely.

---

### User Story 6 - Payment declined (Priority: P2)

The simulated payment definitively declines. The customer is told clearly. The items remain on
screen, and confirming again places a new order rather than retrying the declined one.

**Why this priority**: A defined, common failure with a clear customer path. It does not risk
money or leak state, so it ranks below the P1 guarantees.

**Independent Test**: Set the simulator to decline; confirm; observe the decline message with the
cart intact; confirm again with the simulator set to succeed; observe a second, distinct order
accepted while the first stays declined.

**Acceptance Scenarios**:

1. **Given** the simulated payment declines, **When** the result arrives, **Then** the customer
   is told clearly that payment was declined and the items remain on screen.
2. **Given** the decline screen, **When** the customer confirms again, **Then** a new order is
   created — not a retry of the declined one — and the declined order remains declined.

---

### User Story 7 - An item becomes unavailable mid-order (Priority: P2)

An item in the cart becomes unavailable before the customer pays. The customer is told before
payment, the item is flagged in the cart rather than silently removed, and the rest of the order
is preserved. Payment cannot proceed until the customer has acted on the flagged item and
re-confirmed.

**Why this priority**: Prevents paying for something that cannot be served, with the customer in
control of the change. Ranks below P1 because no charge can occur without re-confirmation.

**Independent Test**: Build a cart, flag an item unavailable behind the scenes, attempt to pay;
observe the flagged item, the preserved remainder, and that payment is blocked until the item is
resolved and the order re-confirmed.

**Acceptance Scenarios**:

1. **Given** an item in the cart is unavailable at the moment the submission is validated,
   **When** the customer attempts to pay, **Then** the submission is rejected before payment, they
   are told, the item is flagged in the cart, and the rest of the order is preserved.
2. **Given** a flagged item the customer has not acted on, **When** they attempt to pay, **Then**
   payment does not proceed.
3. **Given** the customer removes the flagged item and re-confirms, **When** the payment
   succeeds, **Then** the order is accepted with the remaining items at the displayed total.

---

### User Story 8 - The system is unreachable or errors (Priority: P2)

Something goes wrong that the customer did not cause. They see what happened in plain language,
the screen never hangs with no explanation and no way forward, and there is always a way back to
a known state.

**Why this priority**: The customer must never be stranded at an unattended terminal. Ranks
below P1 because it moves no money.

**Independent Test**: Make the service unreachable while loading the menu and while building the
cart; observe a plain-language message and a working way back to idle. A failure during or after
submission is tested under User Story 4: this story covers failures before a submission is sent,
and nothing after (owner decision, see Clarifications and FR-025).

**Acceptance Scenarios**:

1. **Given** the service is unreachable before any submission, **When** the customer performs an
   action that needs it, **Then** a plain-language message explains that something went wrong and
   at least one action returns the kiosk to a working state.
2. **Given** any error screen, **When** it is displayed, **Then** it does not hang without
   explanation and offers a way forward.
3. **Given** a failure during or after submission, **When** it occurs, **Then** it is handled
   under the unknown-outcome rules (User Story 4), never as a known decline.

---

### User Story 9 - Late responses never leak or regress (Priority: P3)

A response arrives after the interaction it belongs to has ended, or a stale response arrives
after a final result has already been displayed. Neither changes what the current screen shows.

**Why this priority**: A correctness guarantee on top of the other stories; rarely visible, but
if violated it produces exactly the stranger's-order and false-status failures the P1 stories
exclude. P3 orders this story last; it is not optional scope and MUST NOT be dropped if time runs
short (owner decision, see Clarifications).

**Independent Test**: Delay a response until after a reset; observe that the new interaction is
untouched. Deliver a stale "pending" response after a final result; observe that the final result
stays.

**Acceptance Scenarios**:

1. **Given** an interaction has ended, **When** a confirmation or error belonging to it arrives,
   **Then** it never appears in a later interaction.
2. **Given** a final result is displayed within an interaction, **When** a stale response
   arrives, **Then** the displayed result never turns back into "pending".

### Edge Cases

- A quantity or total exactly at the allowed bound (10 of one item, 50 units in the order, a
  total of exactly $1,000.00) is accepted; one step beyond is rejected by the client and,
  independently, by the server.
- A status lookup during the wait returns "not found" while the submission may still be in
  flight: this is unknown, not failure; the customer is not invited to pay again (ADR-002).
- The page is reloaded before submission, within a live interaction: the cart is not preserved
  and the customer starts again; no order exists and nothing is charged (ADR-002, ADR-005).
- After a decline, the customer confirms again but a price changed in between: the new order is
  validated like any new submission and is rejected before payment if the total no longer
  matches.
- Removing a flagged unavailable item leaves the cart empty: submission is not possible.
- A repeat of an already accepted order arrives after the menu changed (price or availability):
  the recorded outcome is returned; the current menu is not consulted.
- The inactivity warning is showing when a submission's bounded wait begins: the inactivity timer
  is suspended for the wait and resumes when it ends (ADR-005).
- A response belonging to a previous interaction arrives during a new one: it is discarded, and
  nothing from it is shown.

## Requirements *(mandatory)*

### Functional Requirements

**Menu and cart**

- **FR-001**: The system MUST display a menu of items with, for each item, its name, price, and
  availability.
- **FR-002**: Customers MUST be able to add items, change quantities, and remove items; the
  running total MUST update on every change.
- **FR-003**: The system MUST NOT allow an unavailable item to be added to the cart.
- **FR-004**: Setting an item's quantity to zero MUST remove the item from the cart.
- **FR-005**: The system MUST NOT allow submission of an empty cart.
- **FR-006**: Quantity per item, quantity per order, and order total MUST be bounded: at most 10
  of any one item, at most 50 units across the order, and an order total of at most $1,000.00.
  Values outside the allowed range MUST be rejected on the client before submission **and**
  independently by the server.
- **FR-007**: Before committing, the customer MUST see the complete order and its total on a
  review screen.

**Submission and payment**

- **FR-008**: The total shown at review MUST be the total the order is accepted at. The customer
  MUST never be charged an amount different from what was displayed.
- **FR-009**: If, at submission, the total the server recomputes from current prices differs
  from the total the customer was shown, the system MUST reject the submission before any payment,
  show the current prices and total, and require the customer to confirm again. No order is created
  by a rejected request; a concurrent request carrying the same key may still be accepted (ADR-002,
  "The validation window"). The guarantee is over the total (ADR-003): per-line movements that
  leave the total unchanged are accepted.
- **FR-010**: If, at the point a submission is validated, an item in the cart is unavailable, the
  system MUST reject the submission before payment, tell the customer, flag the item in the cart
  without removing it, preserve the rest of the order, and MUST NOT proceed to payment until the
  customer has acted on the flagged item and re-confirmed. Availability is checked at that
  validation point only; an accepted order is never re-checked (FR-018).
- **FR-011**: The payment step MUST be simulated. It MUST NOT collect card data. It MUST be able
  to produce three outcomes — success, a definitive decline, and an inconclusive result — each
  selectable deterministically in tests (ADR-001).
- **FR-012**: On success, the confirmation MUST display an order reference the customer can quote
  at the counter: 4 characters drawn from uppercase letters and digits with look-alikes removed
  (no 0, O, 1, I, L), e.g. "K7PM", unique across all orders.
- **FR-013**: After the confirmation has been displayed for 15 s, the kiosk MUST return to idle
  without customer action.

**Submitting more than once**

- **FR-014**: Repeated submission of the same order MUST create only one order and attempt at
  most one payment. The customer MUST see the outcome of that single order, not an error.
- **FR-015**: Two genuinely separate orders with the same items, placed at different times, MUST
  both be accepted.
- **FR-016**: Refreshing the page during submission MUST NOT create a second order; after the
  refresh the customer MUST see the same order's status.
- **FR-017**: Going back to the cart, or pressing "Start new order", while the outcome is unknown
  MUST NOT create a second payment for the same items.
- **FR-018**: A repeat of an already accepted order MUST NOT be re-checked against the current
  menu (price or availability) and MUST return its recorded outcome.
- **FR-019**: A "Start new order" control MUST be available throughout the interaction. Using it
  after submission ends the interaction; it MUST NOT retry, MUST NOT cancel the submitted order,
  and MUST NOT carry the items into a new payment (ADR-005).

**Declined payment**

- **FR-020**: When payment is declined, the system MUST tell the customer clearly, keep the items
  on screen, and allow the customer to confirm again without rebuilding the order.
- **FR-021**: Confirming again after a decline MUST create a new order; the declined order MUST
  remain declined.

**Unknown outcome**

- **FR-022**: When no result arrives within the bounded wait (8 s network wait, then polling
  every 2 s for up to 30 s), whether through a network failure or a simulated inconclusive
  response, the system MUST NOT tell the customer that
  payment failed. It MUST tell them the result is not confirmed, direct them to check at the
  counter, and MUST NOT invite them to pay again.
- **FR-023**: The unresolved screen's wording MUST reflect what the client has established: if
  the order was confirmed to exist, say so and show the reference; if not, say the system could
  not confirm whether the order went through, show no reference, and do not assert that the
  counter will find anything (ADR-005).
- **FR-024**: A generic server error, or a failed status lookup, MUST be treated as unknown —
  never as a known decline, and never as permission to start a new payment for the same items.
  One exception, decided with ADR-002 (amended 2026-09-08, confirmed by the owner): after a
  submission was rejected before payment, the re-confirmation the customer makes first checks the
  rejected key, and a "not found" recognised as the service's own answer permits a new intent; a
  network failure, a 5xx, or any other answer to that check keeps the key and permits nothing. The
  check narrows ADR-002's window; it does not close it.
- **FR-025**: What the customer's screen shows MUST be kept separate from what exists server-side.
  A client-side timeout on its own confirms neither acceptance nor rejection; if the order was
  accepted, its record remains, unresolved.

**Unreachable service and errors**

- **FR-026**: When the system is unreachable or errors, the customer MUST see, in plain language,
  that something went wrong. The screen MUST never hang with no explanation and no way forward,
  and there MUST always be a way back to a known state.

**Abandonment and the shared device**

- **FR-027**: After 90 s without a qualifying interaction, with a visible warning during the
  final 15 s that offers a Continue action, the screen MUST clear and return to idle. Pressing
  Continue counts as activity. Passive events, and polling for a payment result, do not
  (ADR-005).
- **FR-028**: Following a reset or an expiry, no previous cart or result MUST be restored or
  shown in the new interaction, including after reload or browser navigation.
- **FR-029**: A cart abandoned before submission MUST result in no order and no charge.
- **FR-030**: An order abandoned after submission MUST continue server-side; clearing the screen
  MUST NOT cancel it.
- **FR-031**: Waiting for a payment result MUST be bounded: a network wait of up to 8 s for the
  initial response, followed by polling for the outcome every 2 s for a maximum of 30 s (38 s
  worst case; polling starts earlier when the initial request fails or reports a pending
  outcome, and never runs longer than 30 s). The inactivity timer is suspended during the wait
  and MUST resume when it ends.

**Late and out-of-order responses**

- **FR-032**: A confirmation or error belonging to a previous interaction MUST never appear in a
  later one.
- **FR-033**: Within the same interaction, a stale response MUST never turn a displayed final
  result back into "pending".
- **FR-034**: Within the same interaction, a definitive result that arrives after the unresolved
  screen is shown MUST update the screen to the confirmation or the decline, exactly as if it had
  arrived in time. The display moves only from unknown to known, never back.

### Non-Functional Requirements

- **NFR-001 Touch-first**: No interaction MAY depend on a keyboard, hover, or right-click. Touch
  targets MUST be large enough to hit accurately while standing at a tablet-sized screen, which
  for this delivery means Chrome at a 1024×768 viewport (OV-7).
- **NFR-002 Self-explanatory**: A first-time user MUST be able to complete an order without
  instruction: every screen states what to do next.
- **NFR-003 Responsive to input**: Any action that may take longer than a moment MUST show a
  visible state change immediately on tap, persisting until the action resolves.
- **NFR-004 Recoverable**: Every error screen MUST offer at least one action that returns the
  *kiosk* to a working state without staff help. **Exception**: resolving an order whose payment
  outcome is unknown may require help at the counter. The screen still recovers; the purchase may
  not. This MUST be stated on screen rather than hidden.
- **NFR-005 Observable**: Failures that reach a customer MUST be recorded server-side.
  Client-originated telemetry is best-effort.

### Key Entities

- **Menu item**: Something the customer can buy. Has a name, a price, and an availability flag.
  Availability is a flag, not a count. All prices and totals in the exercise are in US dollars
  (USD), displayed as $12.50; there is no second currency.
- **Cart**: The order the customer is building on screen: items with quantities and a running
  total. Exists only for the current interaction; never persists past a reset or expiry.
- **Submission intent**: One purchase decision, with a stable identity from first send until its
  outcome is known. Repeats of the same intent resolve to the same order; a new decision (editing
  after a decline, re-confirming after a rejection) is a new intent.
- **Order**: The server-side record of an accepted submission: items, quantities, unit prices,
  total, and the availability as validated at acceptance, all frozen; a 4-character order
  reference for the counter (FR-012), unique across all orders; and a state of pending payment,
  paid, or failed. A rejected submission never becomes an
  order.
- **Payment outcome**: The result of the simulated payment for an order — success, declined, or
  inconclusive (no outcome, order stays pending).
- **Interaction**: One customer's time at the screen, from leaving idle to completion, explicit
  reset, or expiry. Every response and timer belongs to exactly one interaction.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A customer who has never seen the system completes an order, from idle to
  confirmation, using touch alone and with no instruction beyond what the screens show.
- **SC-002**: Across every repeated-submission scenario in this specification (double tap,
  refresh during submission, back or "Start new order" during an unknown outcome), at most one
  order exists per intent, exactly one where acceptance occurred, and the payment simulator is
  called at most once per intent. No exceptions.
- **SC-003**: Zero orders are accepted at a total different from the one displayed at review.
  Every total mismatch is rejected before payment, with zero orders created and the current prices
  and total visible to the customer. The guarantee is over the total (ADR-003).
- **SC-004**: After every reset or expiry, including reload and browser navigation, zero elements
  of the previous interaction (cart, result, reference) are visible or restorable in the new one.
- **SC-005**: Every failure path a customer can reach — decline, unknown outcome, rejection before
  payment, unreachable service — ends on a screen that names what happened, or states honestly
  that it is not yet known, and offers at least one action that returns the kiosk to a working
  state.
- **SC-006**: No screen waits indefinitely. Every wait for a payment result ends within 38 s
  (8 s network wait plus 30 s of polling), after which the inactivity timer resumes and the kiosk
  returns to idle without customer action.
- **SC-007**: Every failure that reaches a customer has a corresponding server-side record, except
  a failure whose cause is that the server was not reached (an unreachable service before
  submission, or a submission that never arrived); those are recorded only when the client's
  best-effort event lands.
- **SC-008**: Automated tests cover every acceptance scenario and edge case in this
  specification and pass. Concurrency and persistence guarantees are verified against a real
  database. "At most one payment" is verified by observing the simulator's calls, not by counting
  order rows.

## Verification

Automated tests covering the acceptance criteria and the failure behaviours above are part of
the delivery.

Concurrency and persistence guarantees are verified against a real database. "At most one
payment" is verified by observing the simulator's calls, not by counting order rows.

## Assumptions

- One kiosk, one customer at a time, no staff role. Nothing in this specification requires more
  than one screen.
- The payment step is simulated with the three-outcome contract in ADR-001; no provider, no card
  data, no credentials.
- The menu is seeded data. Because menu administration is out of scope, scenarios that need a
  price or availability change mid-order are exercised through test fixtures, not an admin path
  (ADR-001).
- "Unreachable" (User Story 8) covers failures before any submission is sent — loading the menu,
  building the cart. Once a submission has been sent, any failure is handled under the
  unknown-outcome rules, because a screen-side error is not evidence about the order (FR-025).
  Confirmed by the owner as deliberate.
- The inactivity timeout of 90 s with a 15 s warning is decided (ADR-005) and is not an open
  value.
- Orders left in pending payment stay there. Resolving them is outside the delivered system; the
  customer's route is the counter.
- The demonstration runs in Chrome at a 1024×768 viewport (OV-7). Interface tests run against
  that viewport, and NFR-001's touch-target sizing is judged at it; the implementation uses a
  minimum touch target of 64×64 px (plan-level constant, not a rule).

## Open Values

*Project decisions that were pending a value when the specification was written. All are now
resolved. Values were set by the owner in clarification, never guessed by an agent; they are kept
here so the identifiers stay stable.*

**Resolved in clarification (2026-09-07)**

- **OV-1**: Network wait before switching to status polling — **8 s** (FR-022, FR-031)
- **OV-2**: Polling interval and maximum polling duration — **every 2 s, up to 30 s** (FR-022,
  FR-031)
- **OV-3**: Confirmation display duration — **15 s** (FR-013)
- **OV-4**: Currency for the exercise — **USD, displayed as $12.50** (FR-006, Key Entities)
- **OV-5**: Maximum quantity per item, per order, and maximum order total — **10 per item, 50
  units per order, total $1,000.00** (FR-006)
- **OV-6**: Format of the order reference shown at confirmation — **4 characters, uppercase
  letters and digits without look-alikes (no 0, O, 1, I, L), unique across all orders** (FR-012)
- **OV-7**: Target environment for the demonstration — **Chrome at a 1024×768 viewport**
  (NFR-001, Assumptions)

**Still open**: none.

*Decided in ADR-005, never open here: inactivity timeout 90 s with a 15 s warning.*
