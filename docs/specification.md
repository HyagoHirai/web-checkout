# Specification — Web Checkout

*What the system does and why, from the customer's point of view. Implementation decisions live in `docs/adr/` and in the plan — deliberately not here.*

## Context

A snack bar wants customers to order and pay themselves at a screen, without staff involvement.

The person using this is standing at a terminal in a public space, alone, probably in a hurry, with nobody to ask for help. There is no login, no account, and no way to reach them once they walk away. The device is shared: whoever is at the screen now is probably not whoever was there a minute ago.

Almost every requirement below follows from that.

## Users

**Customer.** Walks up, browses, orders, pays, leaves. Uses the system once, briefly. May abandon at any point.

There is no second user role in scope.

## Scope

**In scope**

- Browsing a menu of items with prices
- Building an order: adding items, changing quantities, removing items
- Reviewing the order and its total before committing
- Paying (simulated) and receiving confirmation
- Defined behaviour when things fail or the customer abandons

**Out of scope** — deliberately, see ADR-001. These do not generate implementation tasks.

- Real payment processing — the payment step is simulated; no card data is collected
- Authentication or customer accounts
- Menu administration
- Order fulfilment tracking
- Order cancellation after confirmation
- Promotions, discounts, coupons
- Counted inventory (availability is a flag)
- Receipt printing and hardware integration
- Reconciliation of orders left in an unknown state; any staff-facing interface

## Primary flow

1. The kiosk sits idle, inviting interaction
2. The customer starts an order and sees the menu, with prices and availability
3. They add items and adjust quantities; the running total updates
4. They review the complete order and the total
5. They confirm and the simulated payment runs
6. They see confirmation with a reference they can quote at the counter
7. The kiosk returns to idle

### Acceptance criteria

- The total shown at review is the total the order is accepted at
- An unavailable item cannot be added
- Adjusting quantity to zero removes the item
- Submitting with an empty cart is not possible
- Quantities and totals are bounded; values outside the allowed range are rejected on the client before submission **and** independently by the server
- Confirmation displays an order reference
- After the confirmation display period, the kiosk returns to idle without customer action

## Failure and edge behaviour

### The customer submits more than once

- Only one order is created and at most one payment is attempted
- The customer sees the outcome of that single order, not an error
- Two genuinely separate orders with the same items — placed minutes apart — are both accepted
- Refreshing the page during submission does not create a second order; the customer sees the same order's status after the refresh
- Going back to the cart, or pressing "Start new order", while the outcome is unknown does not create a second payment for the same items

### Payment is declined

- The customer is told clearly that payment was declined
- The items remain on screen; they can confirm again without rebuilding the order
- Confirming again is a new order, not a retry of the declined one

### The outcome is unknown

The submission was sent but no result came back within the wait — a network failure, or a simulated inconclusive response.

- The customer is **not** told payment failed, because that isn't known
- They are told the result isn't confirmed and directed to check at the counter
- They are not invited to pay again
- **What the customer's screen knows is separate from what exists server-side.** If the order was accepted, its record remains, unresolved. A client-side timeout on its own confirms neither acceptance nor rejection — the order may not exist at all. The screen's wording reflects which of these the client has been able to establish.
- A generic server error, or a failed status lookup, is treated as unknown — never as a known decline, and never as permission to start a new payment for the same items

### The price changed while the customer was ordering

- The customer is never charged an amount different from what was displayed
- If the price no longer matches, the submission is rejected before any payment, the current price is shown, and the customer confirms again
- No order is created for a rejected submission
- A repeat of an already accepted order is not re-checked against the menu and returns its recorded outcome

### The system is unreachable or errors

- The customer sees that something went wrong, in plain language
- The screen never hangs with no explanation and no way forward
- There is always a way back to a known state

### An item becomes unavailable mid-order

- The customer is told before payment, not after
- The item is flagged in the cart, not silently removed; the rest of the order is preserved
- The customer must act on the flagged item and re-confirm before payment can proceed
- An already accepted order is not re-checked for availability on replay

### The customer abandons

- After the inactivity period, with a visible warning first, the screen clears and returns to idle
- Following a reset or expiry, no previous cart or result is restored or shown in the new interaction — including after reload or browser navigation
- A cart abandoned *before* submission results in no order and no charge
- An order abandoned *after* submission continues server-side; clearing the screen does not cancel it
- Waiting for a payment result cannot hold the screen indefinitely: the wait is bounded, and the inactivity timer resumes when it ends

### A response arrives after the interaction ended

- A confirmation or error belonging to a previous interaction never appears in a later one
- Within the same interaction, a stale response never turns a displayed final result back into "pending"

## Non-functional requirements

**Touch-first.** No interaction depends on a keyboard, hover, or right-click. Touch targets are large enough to hit accurately while standing at a tablet-sized screen.

**Self-explanatory.** A first-time user completes an order without instruction: every screen states what to do next.

**Responsive to input.** Any action that may take longer than a moment shows a visible state change immediately on tap, persisting until the action resolves.

**Recoverable.** Every error screen offers at least one action that returns the *kiosk* to a working state without staff help. **Exception:** resolving an order whose payment outcome is unknown may require help at the counter. The screen still recovers; the purchase may not. This is stated on screen rather than hidden.

**Observable.** Failures reaching a customer are recorded server-side. Client-originated telemetry is best-effort.

## Values to be confirmed

*Project decisions pending a number. The behaviour around them is defined; the number is not yet.*

- Network wait before switching to status polling
- Polling interval and maximum polling duration
- Confirmation display duration
- Currency for the exercise
- Maximum quantity per item, per order, and maximum order total
- Format of the order reference shown at confirmation
- Target environment for the demonstration (browser, viewport)

*Already decided, not open: inactivity timeout 90 s with a 15 s warning (ADR-005).*

## Verification

Automated tests covering the acceptance criteria and the failure behaviours above are part of the delivery.

Concurrency and persistence guarantees are verified against a real database. "At most one payment" is verified by observing the simulator's calls, not by counting order rows.

## Success criteria

A customer who has never seen the system can complete an order without help. Within the boundaries of the simulated payment step, nobody is charged twice or charged an amount they were not shown. Nobody sees a stranger's order after a reset. When something fails, the customer knows what happened — or knows honestly that it isn't yet known — and what to do next.
