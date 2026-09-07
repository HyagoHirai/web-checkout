# ADR-005 — Order lifecycle and abandonment

## Status

Accepted

## Context

This is a kiosk in a public space. Two things follow, and neither appears in a normal web checkout:

**Customers abandon mid-order.** Someone adds three items, gets called away, and walks off.

**The next customer walks up to the same screen.** If the previous cart is still there, the new person either sees someone else's order or accidentally pays for it.

The physical device is shared and there is no login, so this can't be treated as ordinary session handling.

## Decision

The cart lives in client state only. An order is created server-side at submit, not before. An inactivity timeout returns the kiosk to idle, and an explicit "Start new order" control is always available.

The reasoning starts from what the failure modes cost. **Losing an abandoned cart is acceptable. Showing or charging one person's cart to the next is not.** The design reflects that asymmetry rather than treating cart recovery as an unqualified good.

In a normal web app, recovering a cart after a crash is a feature. On an unattended kiosk it's closer to a bug: whoever is at the screen when it returns is probably someone else. Client-only state gets the right behaviour by default — the abandoned cart ceases to exist — with no draft persistence, no session store, no expiry job.

## The interaction, end to end

An interaction begins when the kiosk leaves idle and ends at explicit reset, expiry, or completion. It carries an identifier and a start time, persisted client-side so they survive a refresh. Every server response and every timer is checked against the current interaction; anything belonging to another is discarded.

```
idle ──► building ──► submitted ──┬──► confirmed ──► idle
                                   ├──► declined ──► building (new intent)
                                   └──► unresolved ──► idle (explicit exit)
```

**building** — cart is editable. A payment-screen key may exist and may be replaced by editing (ADR-002).

**submitted** — the first POST has been sent. The key is frozen. Editing is not a route to a new key. The client waits, then polls by key.

**confirmed** — a terminal outcome was received and displayed. After the confirmation display period, the kiosk returns to idle.

**declined** — a definitive decline was received. Items stay on screen; confirming again creates a new intent, key and order. The declined order stays `failed`.

**unresolved** — the wait and the polling window elapsed without a terminal outcome, or the simulator returned inconclusive. The screen shows a defined exit; the interaction ends when the customer takes it or the inactivity timer fires.

**"Start new order"** from any state ends the interaction. From `submitted` or `unresolved` it is not a retry, does not cancel the submitted order, and does not carry the items into a new payment.

## What the timeout does and does not guarantee

A 90-second timeout does not prevent the next customer from seeing the previous cart. Someone leaves, another arrives ten seconds later, the cart is still on screen — and their first touch may reset the counter. The system has no signal that distinguishes one person continuing from a different person arriving.

The guarantee that *is* true, and testable:

**After an explicit reset or an interaction expiry, no previous cart or result is restored or associated with the new interaction.** This holds across reload and across browser history navigation: a reload checks the persisted interaction's validity against its start time, and an expired interaction is not restored.

The residual risk — a person swap before that point — is mitigated, not eliminated. A prominent "Start new order" control and a confirmation step before payment both help. Neither is reliable detection of a change of customer.

## Abandonment before and after submit are different

Before submit, discarding the cart means no order will exist.

After the first send, the operation continues server-side regardless of the screen. **Clearing the interface is not cancelling an order or a payment.** A customer who walks away after submitting may still have a completed order and a charge.

## Timers

Four, deliberately separated:

- **Inactivity** — 90 seconds without a qualifying interaction returns the kiosk to idle. A warning appears in the final 15 seconds with a "Continue" control; pressing it *counts as activity* even though it changes nothing. Qualifying interactions are touches that change the cart, navigate, interact with the payment form, or press Continue. Passive events do not count. Elapsed time is measured from the persisted interaction start, not reset by a reload.
- **Network wait** — how long the client waits for the initial response before treating the outcome as unknown and switching to polling. The inactivity timer is suspended during this wait.
- **Polling** — after the network wait, the client queries by key at a fixed interval for a bounded maximum duration. **Polling is not activity**; it must not keep a departed customer's interaction alive. When the polling window ends without a terminal outcome, the screen moves to `unresolved` and **the inactivity timer resumes**. This is what prevents a pending order from holding the kiosk indefinitely.
- **Confirmation display** — how long a terminal outcome stays on screen before returning to idle.

The 90/15 values are decided here; the network wait, polling interval, polling maximum and confirmation display are set in clarification. The *structure* — bounded wait, bounded polling, resumption of inactivity — is the decision.

## Late and out-of-order responses

**A response belonging to a concluded interaction must not modify a later interaction's interface.** Every response carries the interaction identifier it was issued for; the client discards any that don't match the current one.

Within the same interaction, polling responses may arrive out of order. **A terminal outcome already displayed is never regressed to pending** by a stale poll response. Presentation is monotonic: pending → terminal, never back.

## The unresolved exit

The specification promises that every error screen offers a way back to a working state without staff help. The unresolved state needs an explicit exception, because the *purchase* may not be resolvable without help even though the *interface* is.

**Interface recovery and purchase resolution are separate.** The kiosk always returns to a usable state — the exit is "Start new order" or the inactivity timer. The submitted order stays `pending_payment` server-side. Resolving it — determining whether payment happened — is outside the delivered system; there is no reconciler and no staff interface.

What the unresolved screen says depends on what the client knows:

- If a status lookup *confirmed* the order exists as pending: "Your order was received but payment couldn't be confirmed. Please check at the counter with reference X. Don't pay again."
- If no lookup ever confirmed acceptance: "We couldn't confirm whether your order went through. Please check at the counter before ordering again." — without a reference, and **without asserting the counter will find anything**, because the order may not exist.

Neither message invites a new payment.

## Order states

```
pending_payment ──► paid
                └──► failed
```

**pending_payment** — the order and its key are recorded and committed before payment is attempted. Only the inserting request executes payment (ADR-002).

**paid** — the payment flow returned success.

**failed** — payment was definitively declined.

A validation-rejected submission (ADR-003) never enters this machine. No order is created.

### Why pending_payment exists

Writing the order only after payment succeeds leaves a window where a process death produces a charged customer and no record. Writing the intent first inverts which failure is possible: the worst case becomes an orphaned `pending_payment` row — findable — rather than a charge with no record.

### What pending_payment does in practice

- Rows remain across restart. Not auto-resolved, not auto-cancelled.
- The simulator can return an inconclusive result, leaving the order pending — so this path is exercisable.
- Two crash windows also produce it (ADR-002): after COMMIT before payment, and after payment before recording. These are tested separately from the simulator's inconclusive result.

### Retry after a decline

A definitive decline is terminal for that order. Items remain in client state; confirming again creates a **new intent, new key, new order**. This excludes retrying payment against the same order.

**An inconclusive result is not a decline and does not qualify.** Generating a new key while the outcome is unknown abandons the protection of the original intent.

## Alternatives

**A — Client-only cart, order at submit.** Chosen.

**B — Server-side draft from first item.** Survives crash; creates rows that mostly never complete.

**C — Server session with TTL.** Recoverable, self-expiring, adds session infrastructure.

## Why the alternatives were rejected

**B.** Solves a secondary concern by introducing a primary one — expiry, cleanup, concurrency on records that never complete — for a recovery behaviour that isn't wanted here. Abandonment analytics does *not* require it: funnel events measure abandonment without persisting carts.

**C.** Session infrastructure earns its place when there's a continuity requirement it serves. There is none — no cross-device flow, no returning customer, an interaction under two minutes.

## Decision matrix

| Criterion | Weight | A — client only | B — server draft | C — session + TTL |
|---|---|---|---|---|
| Nothing prior restored after reset or expiry | High | Yes | Requires explicit discard | Requires explicit discard |
| Abandoned data to manage | High | None | Expiry, cleanup, monitoring | Expires itself |
| States to keep in sync client/server | High | Few | Many | Several |
| Implementation cost | Medium | Low | High | Medium |
| Recovers cart after crash or refresh | Low — arguably negative | No | Yes | Yes |

## When this decision would change

If the flow spanned devices — start at the kiosk, pay on your phone — continuity would become a genuine requirement and a session model would follow.
