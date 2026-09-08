# ADR-001 — Scope

## Status

Accepted

## Context

The brief is deliberately open: a kiosk where a customer browses a menu, builds an order, pays, and leaves. Everything beyond that is left to me.

That makes scope itself a decision. The constraint is time — a few days — and the risk cuts both ways. Too little looks incomplete. Too much means everything is shallow, and shallow is worse than absent.

## Decision

The happy path plus deliberate handling of what goes wrong around it. Menu, cart, payment and submission, with real behaviour for duplicate submission, network failure, unavailable items, and abandonment.

In a self-service context, failure handling *is* the product. There's no cashier to catch a double charge. A checkout that only works when everything cooperates isn't finished — it's a demo.

The broader feature set was rejected for the opposite reason: shallow implementations of five things demonstrate less than solid implementations of two.

## Alternatives

**A — Happy path only.** Fastest; risks reading as a tutorial app.

**B — Happy path plus failure handling.** Chosen.

**C — Broader feature set.** More surface, less depth.

## Decision matrix

| Criterion | Weight | A | B | C |
|---|---|---|---|---|
| Addresses the self-service brief | High | Weak | Strong | Partial |
| Depth per feature | High | High | High | Low |
| Fits the stated time budget | High | Yes | Yes | No |
| Surface area to defend in follow-up | Medium | Small | Medium | Large |

## The payment simulator

Payment is simulated with a defined contract. It produces exactly three outcomes, each selectable deterministically in tests:

- **Success**
- **Declined** — a definitive, known refusal
- **Inconclusive** — no outcome returned; the order stays pending. This exercises the unknown-result path. It is a different scenario from "success, then the response was lost", which is tested separately.

The simulator's configured outcome applies to *new* executions only. Changing it never alters a recorded outcome, and a replay of a declined order does not become a success because the configuration changed.

In simulation the requested outcome is selected per submission on the simulated payment screen, with a server default when none is sent. It is not money: it is excluded from the intent fingerprint, never stored on the order, read only by the request that inserted the order, and ignored on every replay. A real provider adapter would reject the field. *(Amended 2026-09-07, plan review; approved by the owner.)*

**The payment screen is explicitly simulated.** It says so on screen. It collects the minimum interaction needed to demonstrate the flow — a confirm action — and **no card number, expiry, or CVV fields**, functional or decorative. No provider credentials are required to run the application.

## Observability, bounded

Structured logs and simple counters on the paths that can fail. Nobody reports a failure on an unattended kiosk, so instrumentation is the only feedback channel. Scope stops there: no dashboarding platform, no metrics backend. Server-side events are recorded; client-originated events are best-effort.

## Explicitly out of scope

**Real payment processing.** The brief says payment need not be real.

**Authentication.** There is no user to authenticate.

**Admin interface for the menu.** Seeded data. Tests that need a changed menu use fixtures, not an admin path.

**Order fulfilment tracking.** Kitchen states belong to a different product.

**Order cancellation after confirmation.** Implies refund semantics the simulated step cannot model.

**Promotions, discounts, coupons.** Pricing is already a non-trivial decision in ADR-003.

**Counted inventory.** Availability is a flag. Real inventory means reservations and races on the last item.

**Reconciliation of unresolved orders, and any staff-facing interface.** Orders left in `pending_payment` stay there. Resolving them is outside the delivered system.

**Receipts, printing, hardware.** The actual complexity of a real kiosk, and none of it testable here.

**Multi-language and accessibility beyond the basics.** A genuine gap for a public terminal, not a scoping choice.

**Product photography.** *(Added 2026-09-07 at the owner's instruction, UI pass.)* A production kiosk would show it, since that is what drives selection. Omitted here as asset work rather than engineering, and outside what the brief asks for.

## Possible future direction

*Not requirements of this delivery. These generate no tasks.*

Inventory with reservation semantics; abandonment analytics via event instrumentation; accessibility.
