# ADR-003 — Price authority

## Status

Accepted

## Context

The client displays a menu with prices and builds a cart. When the order is submitted, someone has to decide the total.

If the client sends prices and the server accepts them, anyone with developer tools open can buy a sandwich for one cent. A kiosk app is still a web app served over HTTP.

There is also a timing question: the menu is fetched when the customer arrives; the order is submitted minutes later. If a price changed in between, which one applies?

## Decision

### The contract

The client submits item identifiers, quantities, currency, and the total it displayed — a single `expectedTotalMinor` field. It does not submit unit prices. The prices used in the order come exclusively from the server.

The server recomputes the total from the current menu and compares. Equal: accepted. Different: the submission is rejected, and the client refreshes the menu and asks the customer to confirm the new total.

The comparison covers the total, not each line. Two items moving in opposite directions by the same amount would pass. That's acceptable here because the customer's exposure is the total they were shown, which is what the guarantee protects.

### Money representation

Integers in the currency's minor unit. One currency for the exercise, fixed in clarification. Comparison is exact. Quantities, line totals and the order total are bounded so that malformed input cannot produce values outside the range the arithmetic is defined for. **The server enforces these bounds independently of the client.**

### Accepted values are frozen

On acceptance, the order stores a snapshot: items, quantities, unit prices, currency, total, and the availability as validated at that moment. Payment uses the snapshot and does not re-read the menu.

### A replay is never re-validated

Menu revalidation — price *and* availability — applies to new intents only. A replay of an already accepted intent returns the recorded result at the recorded values. It is not rejected for divergence from the current menu, and it is not rejected because an item has since become unavailable. Re-validating a replay would mean refusing an operation that has already succeeded.

### Rejection is not failure

A price mismatch produces a **validation-rejected submission**. No order is created, no payment is attempted, nothing enters `pending_payment`. This is distinct from `failed` in ADR-005, which means payment was attempted and declined.

## Alternatives

**A — Client sends prices, server trusts them.**

**B — Client sends identifiers only; server computes and charges its own total.**

**C — Client sends its expected total; server recomputes and rejects mismatches.** Chosen.

**D — Server issues a signed quote.**

## Why the alternatives were rejected

**A.** A price sent by the client is a price an attacker controls. Direct financial loss, cheap fix.

**B.** Secure, and dishonest: the customer can be charged an amount they were never shown, with no recourse at an unattended terminal.

**D.** Technically the strongest and arguably the most correct semantics — it pins the price at quote time. Rejected on proportionality: signing, key handling and quote expiry for a problem that validation solves at this scale. Note that a signed quote protects whatever it signs: a signature over the total alone would not guarantee per-line prices either.

## Decision matrix

| Criterion | Weight | A — trust client | B — server computes | C — validate total | D — signed quote |
|---|---|---|---|---|---|
| Resists client tampering | High | No | Yes | Yes | Yes |
| Customer charged what they were shown | High | Yes | Not guaranteed | Yes, or explicit rejection | Yes |
| Price change handled visibly | Medium | No | Silently applies new price | Rejected, then re-confirmed | Honours quoted price |
| Implementation cost | Medium | None | Low | Low | Medium |
| Detects per-line price movement | Low | No | n/a | No | Only if lines are signed |

*The per-line row is weighted low deliberately. Weighting it higher would push toward D with line-level signing.*

## What this costs

A stale menu produces a rejected submission rather than a completed order. Acceptable where prices rarely change during a session.

## When this decision would change

If prices became dynamic, rejection rates would climb and the signed quote would be the natural successor.
