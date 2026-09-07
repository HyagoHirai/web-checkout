# Data Model: Web Checkout

**Feature**: `specs/001-web-checkout/spec.md` | **Date**: 2026-09-07
**Governing decisions**: ADR-002 (identity, fingerprint, ownership of payment execution), ADR-003
(price authority, frozen snapshot), ADR-004 (Postgres), ADR-005 (interaction, order states).

Two models live in two places, deliberately. The **server** holds orders: the durable record that
must survive the customer leaving. The **client** holds the interaction and the cart: state that
must not outlive the interaction (constitution IV). Nothing about a cart reaches the server before
submission.

## Server-side (Postgres)

### `menu_items`

| Column | Type | Rules |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | Server-generated; referenced by the client as `itemId` |
| `slug` | `text` UNIQUE NOT NULL | Stable natural key for the seed, so re-running the seed cannot duplicate rows (ADR-004) |
| `name` | `text` NOT NULL | Displayed on the menu and frozen into the order snapshot |
| `price_minor` | `integer` NOT NULL, CHECK `> 0` | USD cents. The only source of prices (ADR-003) |
| `currency` | `text` NOT NULL DEFAULT `'USD'`, CHECK `= 'USD'` | One currency for the exercise (OV-4). `text` + CHECK, not `char(3)`: `char` pads and compares oddly (research R7) |
| `available` | `boolean` NOT NULL DEFAULT `true` | A flag, not a count (ADR-001) |
| `sort_order` | `integer` NOT NULL | Menu display order |
| `updated_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

Menu administration is out of scope. Tests that need a changed price or availability update rows
through fixtures (ADR-001), never through an endpoint.

### `orders`

| Column | Type | Rules |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | Internal identity |
| `idempotency_key` | `uuid` NOT NULL, CONSTRAINT `orders_idempotency_key_key` UNIQUE | Client-generated identity of the submission intent (ADR-002). The unique index is the concurrency backstop and the `ON CONFLICT` arbiter (research R5) |
| `fingerprint` | `text` NOT NULL | SHA-256 hex of the canonical intent: `{ currency, expectedTotalMinor, lines: [{ itemId, quantity }] sorted by itemId }`. Verifies a reused key carries the same intent. Never includes `simulation.*` or the interaction id |
| `interaction_id` | `uuid` NOT NULL | From the `X-Interaction-Id` request header at acceptance; for log correlation only (ADR-005). Not a lookup credential |
| `reference` | `text` NOT NULL, CONSTRAINT `orders_reference_key` UNIQUE, CHECK `~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$'` | Counter reference: 4 symbols, 31-symbol alphabet (no 0, O, 1, I, L). Server-generated with `crypto.randomInt`, retried on collision at most 5 times (OV-6, research R7) |
| `state` | `text` NOT NULL, CHECK in (`pending_payment`, `paid`, `failed`) | See state machine below |
| `currency` | `text` NOT NULL, CHECK `= 'USD'` | Frozen at acceptance |
| `total_minor` | `integer` NOT NULL, CHECK `> 0 AND <= 100000` | Frozen at acceptance; equals the sum of line totals in `snapshot` and the client's `expectedTotalMinor` (ADR-003, OV-5) |
| `snapshot` | `jsonb` NOT NULL | The frozen order: `{ lines: [{ itemId, name, unitPriceMinor, quantity, lineTotalMinor }], currency, totalMinor }` as validated at acceptance. Payment never re-reads the menu (ADR-003) |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | Committed before payment is attempted (constitution III) |
| `outcome_recorded_at` | `timestamptz` NULL | Set exactly once, when `state` leaves `pending_payment` |

**Why a JSONB snapshot and not an `order_items` table** (research R6): with the snapshot on the
row, accepting an order is one `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING`
statement in autocommit. No explicit transaction, no savepoint, and the aborted-transaction trap
ADR-004 names cannot arise on the money path. Nothing in scope queries lines relationally. What a
lines table would have done well: per-line referential integrity to `menu_items` and SQL over
lines; neither is needed. Availability at acceptance is implied: an unavailable item never reaches
a snapshot (FR-003, FR-010).

The order-level bounds (at most 50 units, total at most $1,000.00) are enforced in the submission
service before insert, on the client before submission, and by the `total_minor` CHECK as a last
line.

### `schema_migrations`

| Column | Type | Rules |
|---|---|---|
| `version` | `text` PK | Migration file identifier, applied in order |
| `applied_at` | `timestamptz` NOT NULL DEFAULT `now()` | |

Mechanism: hand-rolled runner, ordered SQL files applied in one transaction under an advisory lock, in the API process before it listens (research R11).

### Order state machine (ADR-005)

```text
pending_payment ──► paid
                └──► failed
```

- **pending_payment**: the order, its key and its snapshot are committed. Only the request whose
  insert created the row executes payment (ADR-002). Rows left here are never auto-resolved and
  never auto-cancelled; the simulator's inconclusive outcome and an exception in either post-commit window all land here.
- **paid**: the simulated payment returned success.
- **failed**: the simulated payment returned a definitive decline. Terminal for this order;
  confirming again creates a new order under a new key.

Invariants, enforced in code and by the schema:

1. `state` changes at most once, and only from `pending_payment`. The recording write is
   `UPDATE orders SET state = $2, outcome_recorded_at = now() WHERE id = $1 AND state = 'pending_payment'`;
   zero rows affected is logged and counted, never retried into an overwrite.
2. A replay never changes any column. Replays only read (ADR-002 "Replay behaviour").
3. A validation-rejected submission never creates a row (ADR-003 "Rejection is not failure").
4. One `idempotency_key` maps to at most one order, guaranteed by the unique index under concurrency.

### Seed

A fixed list of menu items keyed by `slug`, upserted in one statement with
`ON CONFLICT (slug) DO UPDATE SET name, price_minor, currency, available, sort_order, updated_at =
now() WHERE (menu_items.name, menu_items.price_minor, menu_items.currency, menu_items.available,
menu_items.sort_order) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.price_minor, EXCLUDED.currency,
EXCLUDED.available, EXCLUDED.sort_order)`. The comparison names the canonical columns and excludes
`updated_at`, which would otherwise always differ and make `updated: 0` unreachable; `updated_at`
moves only when a canonical column changes. Re-running never duplicates (ADR-004), and because the
seed file is the menu's only source of truth (menu administration is out of scope) a restart
converges fixture-mutated rows back to canonical values.
Orders are unaffected: the snapshot is frozen at acceptance. The startup log line
`startup.seed_applied inserted: 0 updated: 0` on restart is the "does not duplicate" proof. At least
one seeded item is `available = false` so the menu shows an unavailable item on first run (US1
scenario 3). Seeded ids are fixed lowercase UUIDs so tests can reference them.

## Client-side (browser, per tab)

### `Interaction` (persisted in `sessionStorage`, scoped to the tab)

| Field | Type | Rules |
|---|---|---|
| `id` | UUID v4 | Generated when the kiosk leaves idle. Sent with every request and compared against every response and timer (ADR-005) |
| `startedAt` | epoch ms | Fixed for the interaction's life |
| `lastActivityAt` | epoch ms | Updated by qualifying interactions only, stamped inside the reducer for a whitelist of event types; a reload continues the inactivity clock from here, it does not reset it (ADR-005 "Timers"). Entering `unresolved` stamps nothing |
| `phase` | `building` \| `submitted` \| `confirmed` \| `declined` \| `unresolved` | The interaction state machine, below |
| `resolvedAt` | epoch ms \| null | Set on entering `confirmed`; the 15 s display deadline is derived from it |
| `submission` | object \| null | Present from first send onward; see below |

`submission` (present from entering the payment screen; frozen from first send):

| Field | Type | Rules |
|---|---|---|
| `idempotencyKey` | UUID, lowercase | Generated on entering the payment screen; persisted **before** the first POST; frozen from first send until a definitive outcome (ADR-002) |
| `lines` | `{ itemId, name, unitPriceMinor, quantity }[]` | The lines **as displayed** at send, sorted by `itemId`. Two jobs: a replay after reload sends byte-identical content (or the fingerprint check turns it into a 409), and S6 can list the items after a reload that ends in `failed` (FR-016 + FR-020). Recovering an in-flight operation within its own interaction is permitted by constitution IV (research R4; owner confirmation requested) |
| `expectedTotalMinor` | integer | The total shown at review; derived from `lines`, the same value the review screen rendered (FR-008) |
| `sentAt` | epoch ms \| null | Time of the first POST; null until sent. Persisted so a reload cannot restart the wait (SC-006) |
| `pollStartedAt` | epoch ms \| null | When polling began: the earliest of `sentAt + 8 s`, a network rejection, or a `202 pending_payment`. The bounded wait ends at `waitEndedAt = pollStartedAt + 30 s` (OV-2), never later than `sentAt + 38 s` |
| `deadlineAt` | epoch ms \| null | The inactivity deadline carried across `unresolved → declined` by a late result (see Deadline preservation) |
| `knownState` | `none` \| `pending` \| `paid` \| `failed` | The most definite thing any response has established. Drives the unresolved screen's wording (FR-023). Moves only forward |
| `reference` | string \| null | Set when a response carries it |
| `simulation` | `success` \| `declined` \| `inconclusive` | The selector on the simulated payment screen (research R9); sent in the POST body; not part of the fingerprint; ignored by the server on replay |

Validity on load, on `pageshow`, and on `visibilitychange → visible` (research R4): the record is
restored only if its deadline, computed from persisted timestamps alone, has not passed:

| Phase | Deadline |
|---|---|
| `building`, `declined` (entered by a decline that arrived in time, or by editing) | `lastActivityAt + 90 s` |
| `submitted` | never expires by inactivity; the bounded wait ends at `waitEndedAt = pollStartedAt + 30 s`, after which the phase is `unresolved` |
| `unresolved` | `max(lastActivityAt, waitEndedAt) + 90 s` |
| `declined` entered from `unresolved` by a late result | `deadlineAt`: the deadline in force at the transition, preserved (see below) |
| `confirmed` | `resolvedAt + 15 s`; not restarted by a repeated `paid` |

**Deadline preservation rule** (stated identically in research R4): a response is not customer
activity and never moves a deadline backward. On `unresolved → declined` the deadline already in
force, `max(lastActivityAt, waitEndedAt) + 90 s`, is stored as `deadlineAt` and governs `declined`
until the customer's next qualifying interaction re-stamps `lastActivityAt`, at which point the
ordinary formula applies again and `deadlineAt` is cleared. Without this rule a late decline at
100 s (sentAt = 0, unresolved valid to 128 s) would set the deadline to 90 s and the next validation
would delete the interaction the customer is looking at, contradicting FR-034.

Anything past its deadline is deleted and the kiosk starts idle (FR-028). `sessionStorage` is not
reliably cleared on tab close (desktop Chrome restores it with session restore), so this check, not
tab lifetime, is the guarantee.

### `Cart` (memory only, never persisted)

| Field | Type | Rules |
|---|---|---|
| `lines` | `{ itemId, quantity }[]` | Quantity 1..10; setting 0 removes the line (FR-004); at most 50 units in total (FR-006) |
| `totalMinor` | derived | Sum of `quantity × unitPriceMinor` from the menu the client last fetched (on Start and on leaving S8). The review screen renders this value and the POST sends it as `expectedTotalMinor`: one derived value from one cart state, so the customer can never be charged a total the review screen did not show (FR-008, ADR-003) |
| `flagged` | `itemId[]` | Items reported unavailable by a rejection; the customer must act on each before re-confirming (FR-010) |

A reload before submission loses the cart by design (ADR-002, ADR-005); the interaction itself may
continue if still valid.

### Interaction state machine (ADR-005, extended by FR-034)

```text
idle ──► building ──► submitted ──┬──► confirmed ──► idle (after 15 s)
  ▲                                ├──► declined ──► building (new intent, items intact)
  │                                └──► unresolved ──┬──► idle (explicit exit or inactivity)
  │                                                  ├──► confirmed  (late definitive result, FR-034)
  │                                                  └──► declined   (late definitive result, FR-034)
  └──── "Start new order" or inactivity expiry, from any state
```

Guards:

- **Response admission rule** (stated identically in research R4 and `contracts/ui-states.md`). A
  response event is applied only if all five hold: (1) the interaction is valid (its deadline has
  not passed); (2) the event's `interactionId` equals the current interaction's (FR-032); (3) the
  event's `idempotencyKey`, captured in the request closure, equals the **current submission's**
  key, because monotonicity is per intent, not per interaction: after a decline the customer stays
  in the same interaction and creates K2, and a late K1 result must not touch the K2 attempt; (4)
  the transition is legal for the current phase: `submitted → confirmed|declined|unresolved`,
  `unresolved → confirmed|declined` (FR-034), `unresolved(S7b) → unresolved(S7a)` on a first
  `pending`; nothing leaves `confirmed` or `declined` on a response (FR-033); (5) a terminal result
  is not reapplied: a repeated `paid` in `confirmed` does not reset `resolvedAt` or restart the 15 s
  display, and a repeated `failed` in `declined` is a no-op.
- Editing the cart is not a route to a new key while `submitted` or `unresolved` (ADR-002).
- A second tap on Pay while `submitted` is ignored; the client never re-sends on its own. A network
  rejection before the 8 s wait ends starts polling by key immediately (research R10).
- A `409 intent_mismatch` (unreachable from this client, which re-sends the persisted `lines`)
  triggers a status lookup by key and shows the recorded state; it never shows a rejection for an
  order that may be paid.
- Leaving `declined` to `building` keeps the cart and discards the key; entering payment generates a
  new key (new intent).

### Timers (ADR-005, OV-1..3)

| Timer | Value | Counts as activity? | Notes |
|---|---|---|---|
| Inactivity | 90 s, warning at 75 s with Continue | Continue: yes; polling and passive events: no | Suspended during the bounded wait; resumes when it ends |
| Network wait | 8 s | no | For the initial POST response; the fetch is not aborted when it elapses |
| Polling | every 2 s, for at most 30 s | no | By idempotency key; starts at the earliest of 8 s, a network rejection, or a `202 pending_payment`, and ends at `pollStartedAt + 30 s` (never later than `sentAt + 38 s`); `404` is unknown, not failure; stops on a terminal result |
| Confirmation display | 15 s | no | Then idle |

## API entities (wire shapes)

Defined in `contracts/openapi.yaml`. Summary of the mapping:

| Wire object | Backed by |
|---|---|
| `MenuItem` `{ id, name, priceMinor, currency, available }` | `menu_items` |
| `OrderSubmission` `{ idempotencyKey, currency, expectedTotalMinor, lines[], simulation? }` + header `X-Interaction-Id` | Validated into `orders` (`snapshot` from the menu, never from the client); `simulation` never stored, never fingerprinted |
| `OrderStatus` `{ orderId, reference, state, totalMinor, interactionId, replay }` | `orders` |
| `ValidationRejection` `{ error: "validation_rejected", reasons[], currentTotalMinor?, currentItems? }` | No row; `currentItems` carries current prices/availability for the affected lines (FR-009, FR-010) |
| `IntentMismatch` `{ error: "intent_mismatch" }` | No **new** row; an order exists under that key and may be paid; the existing order is untouched (ADR-002). The client looks it up by key and shows the recorded state |
| `Error` `{ error: "reference_exhausted" }` (503) | No row; key not consumed; the client may re-confirm (research R7) |
