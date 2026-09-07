# ADR-002 — Idempotent order submission

## Status

Accepted

## Context

The customer is alone at a touchscreen, in a hurry. Two things will happen in production:

1. They tap "Pay" twice, because the first tap didn't visibly do anything yet.
2. The request reaches the server, the order is created, and the response is lost on the way back — so the client retries.

Both produce the same failure: one customer, two orders, two charges. In a self-service context there is no cashier to catch it.

These are different problems. A double tap originates in the UI; a lost response originates in the network. A defence that only covers one leaves the other open.

## Decision

### The rule

**A submission intent has a stable identity. Transport-level repetitions reuse that identity; a new purchase decision gets a new one.**

Everything below follows from that sentence. The moment a key is created is a consequence of the rule, not its definition.

### Intent lifecycle on the client

The key's protection depends on the intent surviving from first send until the outcome is known. That gives three phases:

**Before first send.** The customer is on the payment screen with a key K already generated. Editing is allowed. Returning to the cart and changing what's being bought discards K; re-entering payment generates a fresh key. This is a new purchase decision, and it gets a new identity.

**From first send until a definitive outcome.** K is frozen. It is retained across refreshes of the payment screen. Returning to the cart is *not* a route to a new key while the outcome is unknown — the interface either treats "back" as viewing the submitted order, or blocks editing until the outcome resolves. This closes a path that would otherwise be open: POST K in flight → back → K discarded → re-enter payment → K2 → second POST. The server would correctly see two intents. Both could execute. The freeze has to start at send, not at acknowledgement.

**After a definitive outcome.** Success ends the interaction. A definitive decline permits re-confirmation under a new key (ADR-005). An unknown outcome permits status queries and an explicit end to the interaction — never a "pay again" shortcut with the same items under a new key.

"Start new order" remains available throughout. Using it after send *ends the interaction*: it is not a retry, it does not cancel the submitted order, and it does not carry the items into a new payment. The kiosk cannot tell whether the next person is the same person; the guarantee is *no additional effects per intent*, not *no additional purchases per human*.

### The key is bound to the payload

A key on its own is not sufficient. If a registered key reappears with different items, quantities or total, the server must not return the earlier order for a modified request.

The key is stored alongside a fingerprint of the normalised intent. If a known key arrives with incompatible content, the request is rejected without creating an order or attempting payment. The existing order's fingerprint, snapshot and state are never overwritten by a losing concurrent request.

**The key identifies the intent; the fingerprint verifies the intent wasn't altered.** These are different jobs, and this does not contradict rejecting a content hash as the deduplication mechanism.

### Replay behaviour

Idempotency does not mean "always return success". The guarantee is a **stable business outcome**, not an identical HTTP response.

| Situation | Behaviour |
|---|---|
| Same key and content; operation succeeded | Return the recorded result |
| Same key and content; payment definitively declined | Return the recorded decline, without retrying payment |
| Same key and content; operation still pending | Report pending, without creating another operation |
| Known key, incompatible content | Reject the reuse; no order, no payment; existing order untouched |
| Different intent, identical items | Accept as a new order under its own key |
| Invalid request, before the operation is accepted | Reject without attempting payment; the key is not consumed |

A recorded outcome is never changed by a replay — including by a change in the simulator's configured result between the original and the replay.

### Only one request performs the payment

A row in the database prevents a second *order*. It does not, on its own, prevent a second *payment*.

**The request that successfully inserts the order owns the payment execution.** Any request that finds an existing order observes its state and reports it — pending, succeeded or declined — but never initiates payment itself. Finding a pending order is not authorisation to charge.

This guarantees **at most one execution per accepted intent**. It does not guarantee eventual completion: a process death after COMMIT and before the payment call leaves a pending order with zero executions; a death after the call and before recording the outcome leaves one with exactly one. Both remain `pending_payment` and are not auto-resolved — there is no worker that resumes pending orders, because that would change who is allowed to execute. Tests demonstrate "at most one", and "exactly one" in concurrent scenarios without interruption.

### Durable before external

```
insert order as pending_payment
→ COMMIT
→ execute the (simulated) payment
→ record the outcome
```

Inserting the row, calling the provider and committing afterwards does not preserve the intent — a rollback erases the record of something that already happened externally.

### Recovery when the client loses state

The first response can be lost. If it is, the client never receives the server-generated order reference, and after a refresh the cart is gone (ADR-005). "Look up by order reference" is therefore unimplementable as written — the client doesn't have it.

**Recovery is by idempotency key.** The client generated K, so it has K before anything is sent. K is persisted in client storage scoped to the interaction — with the interaction's identifier and start time — *before* the first POST. The server exposes a status lookup by key. After a refresh within the same interaction, the client reads K back and queries.

A lookup that returns "not found" does **not** mean the submission failed. It may still be in the write window. The client preserves the uncertainty and the identity; it does not generate a new key.

The human-readable order reference shown at confirmation is a separate, shorter identifier returned in the response. It is for quoting at the counter, not for recovery, and the lookup endpoint must not expose one order's data to a caller holding a different order's reference.

**What is not promised:** if *all* client identifiers are lost — storage cleared, different device, interaction expired — there is no automatic individual recovery. The order still exists server-side if it was accepted, but the system has no correlation to offer. This is stated rather than hidden.

### Key retention

The key is stored with the order and retained for as long as the order exists. There is no separate expiry. An independent TTL would create a contradiction with the unique constraint.

### The UI layer

The button enters a loading state on tap. Not the guarantee, but it tells the customer the action is happening. In a self-service setting that feedback *is* the prevention: someone who taps and sees nothing will tap again.

## Alternatives

**A — UI lock only.** Covers the double tap, nothing else.

**B — Client-generated key, bound to the payload, frozen at send.** The chosen approach.

**C — Server-side content hash.** Rejects duplicates by content within a time window.

**D — Unique database constraint on the intent key.** The database arbitrates concurrent inserts.

## Why the alternatives were rejected

**Content hash.** Can only see *what* was ordered, not the intent behind it. Two identical orders placed deliberately collide; a time window narrows that only by picking an arbitrary number. It survives as the fingerprint that validates a key's reuse — a different job.

**Constraint as the primary mechanism.** A violation surfaces as an error, and an error is the wrong answer to a legitimate replay. It remains as the concurrency backstop, translated into the recorded outcome.

**UI lock alone.** Stays as a UX affordance, not the guarantee.

## Decision matrix

*The matrix separates the mechanism from the identity decision. No single mechanism defines replay semantics on its own; the rows are about what each one mechanically prevents.*

| Criterion | Weight | A — UI lock | B — key + fingerprint | C — content hash | D — constraint on intent key |
|---|---|---|---|---|---|
| Prevents duplicate from double tap | High | Yes | Yes | Yes | Yes |
| Prevents duplicate from lost-response retry | High | No | Yes | Yes | Yes |
| Prevents duplicate from refresh mid-submit | High | No | Yes | Yes | Yes |
| Distinguishes two real identical orders | High | n/a | Yes | No | Yes (different keys) |
| Detects altered content under a known key | High | n/a | Yes | n/a | No (needs fingerprint) |
| Serialises concurrent inserts | High | No | No (needs D) | No | Yes |
| Returns recorded outcome on replay | Medium | n/a | Yes | Possible | No (raises error) |

*B and D are used together: B defines identity and replay semantics, D serialises the write window. Neither is sufficient alone.*

## Where this still breaks

**The write window.** Between accepting an order and committing the row, a concurrent retry with the same key finds nothing recorded. The unique constraint on the key column serialises this: the second insert fails, and that failure is caught and translated into the recorded outcome. Recovering from a constraint violation inside a transaction requires a savepoint or a fresh transaction; and under Read Committed, `INSERT … ON CONFLICT DO NOTHING` can miss a row not yet visible to the statement's snapshot, so the recovery lookup must account for that. The plan chooses the mechanism; this ADR names the trap.

**The payment window.** Not solvable at this layer. If the provider accepts the charge and the response is lost before the outcome is recorded, the system doesn't know whether money moved. This is why the order is written before payment is attempted. Closing it properly requires the provider to support its own idempotency key — a real integration concern, out of scope, and named rather than papered over.

**Total identifier loss.** Covered above. No correlation, no automatic recovery. The accepted order persists; the customer's route to it is the counter.
