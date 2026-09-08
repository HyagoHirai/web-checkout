# Research: Web Checkout

**Feature**: `specs/001-web-checkout/spec.md` | **Date**: 2026-09-07
**Method**: eight parallel research agents (one per open technical question), each reading the
constitution, the spec and the ADRs first and checking current documentation via context7 and the
vendors' own pages; five adversarial verifiers that tried to refute the load-bearing claims; one
completeness critic over the whole set. Where researchers disagreed, the reconciliation and its
reason are recorded under the decision. Refuted claims are listed at the end so the corrections are
not lost.

Governing documents outrank everything here: constitution > ADR-001..005 > spec. Nothing below
changes an ADR; where a finding needs an ADR amended, it is listed under **Decisions requiring
owner approval** and the plan proceeds on the stated assumption.

## Pinned stack

| Component | Choice | Version | Evidence |
|---|---|---|---|
| Runtime | Node.js, Active LTS "Krypton" | 24.20.0 | nodejs.org release index, 2026-08-26 |
| Node image | `node:24.20.0-bookworm-slim` | | Docker Hub tag list |
| Language | TypeScript, type-check only | ~6.0.2 | npm; create-vite template pins ~6.0.2 |
| API framework | Fastify | 5.12.3 | npm; supports Node 24/26 |
| DB driver | node-postgres `pg` (+ `@types/pg`) | 8.23.0 / 8.23.1 | npm, 2026-08-08 |
| Logger | pino (Fastify `loggerInstance`) | 10.3.1 | npm; Fastify peer `^9.14 \|\| ^10.1` |
| Database | PostgreSQL, `postgres:18.6` | 18.6 | Docker Hub; 19 is beta |
| Client | React + Vite | 19.2.8 / 8.2.2 | npm |
| Client plugin | `@vitejs/plugin-react` | 6.1.1 | npm |
| Unit/integration tests | Vitest (+ jsdom, Testing Library) | 4.1.11 / 30.0.1 / 16.3.3 | npm; Vitest 5.0.0 is 2 days old, not pinned |
| Interface + ops tests | `@playwright/test` (Chromium) | 1.63.0 | npm |
| Static server | `nginx:1.30.4-alpine` | 1.30.4 | nginx.org stable |
| Orchestration | Docker Compose v2 file format, Compose ≥ 2.20 | local v5.0.2 | `docker compose version` |

`@types/node` is pinned to the 24.x line (24.13.3); `latest` is 26.x and types APIs the runtime lacks.

## R1. API runtime and framework

**Decision**: TypeScript on Node 24 with Fastify 5.12.3; `pg` used directly (not
`@fastify/postgres`); Fastify's built-in pino logger; Ajv JSON-Schema validation built into Fastify;
in-process `app.inject()` for API tests.

**Rationale**: one language across API and client means one toolchain, one Dockerfile idiom and a
shared vocabulary for order states and error codes, which the client state machine is driven by.
Fastify over Express/Hono: per-request child logger with request id is first-party; `genReqId`
plus `requestIdHeader` off by default (a caller cannot inject a request id); `setErrorHandler` +
`setNotFoundHandler` give one JSON error shape for 400/404/409/422/500; JSON-Schema validation is
built in so FR-006's bounds are declared, not hand-coded; `app.inject()` runs routes without a
port and real concurrency reaches the database because each request checks out its own pool
client. `@fastify/postgres` is rejected because its `transact` helper wraps the whole handler in
one transaction, the opposite of ADR-002's insert → COMMIT → pay → record.

**Alternatives**: Express 5.2.1 (same result, more glue, no in-process inject). Hono 4.13.7 (the
genuinely lighter framework; loses on structured-logging fit and because its request-id middleware
trusts an incoming header by default). Go 1.27 + pgx (excellent API on its own; rejected because
the deliverable is API + client under one command and one language, and its runtime advantages are
irrelevant at a handful of orders per minute).

**Gotchas**:
- Set `genReqId: () => randomUUID()`; the default is a per-process counter. Echo `x-request-id` on
  every reply so a failure screen can show it. Never make the client's interaction id the request id.
- A custom `setErrorHandler` takes over logging: log 5xx with `err`, log 4xx without the stack.
  Register it and `setNotFoundHandler` on the root instance before routes.
- Disable request logging for `/api/health` and `/api/metrics` via `logController: new
  LogController({ disableRequestLogging })`; the top-level option warns `FSTDEP023` on 5.12.3.
- Attach `pool.on('error')` before anything else; an idle-client error without a listener kills
  the process when the db container restarts (the ADR-004 restart scenario).
- Use exec-form `CMD ["node", "src/server.ts"]`, never `npm start` (npm does not forward SIGTERM;
  `docker compose stop` would SIGKILL after 10 s, which is the process-death window ADR-002
  discusses). Handle SIGTERM with `app.close()`; `onClose → pool.end()`.
- `pg` returns `bigint`/`numeric`/`count(*)` as strings. Every money and quantity column is
  `integer`; use `count(*)::int` in tests.

## R2. TypeScript execution model

**Decision**: the API runs `.ts` sources directly under Node 24's native type stripping. No
build step, no `tsx`. `tsc --noEmit` is the type gate, run by `npm test` and CI, not by the
Docker build. TypeScript ~6.0.2 for both packages.

**Rationale**: type stripping is Stable (Stability 2) since Node 24.12.0 (verified). It removes a
dev dependency, a Dockerfile stage and a source-map concern. Two researchers proposed a multi-stage
`tsc` build to `dist/`; the two models are mutually exclusive because `.ts` import specifiers are
not rewritten by `tsc` emit. The lighter one is chosen. TypeScript 7.0.2 (npm `latest`) is not
pinned: the create-vite template pins ~6.0.2, TS 7 has no stable programmatic API until 7.1, and
neither Vite nor Node invoke `tsc` for transpilation, so its speed buys nothing here.

**What the heavier option would have done well**: a `dist/` runtime image excludes TS sources and
devDependencies and fails the image build on a type error. Image size is irrelevant on a LAN
kiosk and the type gate runs in `npm test`.

**Constraints this imposes (enforced by tsconfig)**:
- `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`,
  `noEmit: true`, `module: nodenext`, `types: ["node"]` (TS 6 defaults `types` to `[]`).
- No `enum`, no value `namespace`, no parameter properties, no decorators. Relative imports carry
  the `.ts` extension. Type-only imports use `import type`.
- Node refuses to strip `.ts` under `node_modules`: shared code is imported by relative path from a
  top-level `shared/` directory, not through a workspace package (see R12 for the Docker context).
- Dev loop: `node --watch --env-file-if-exists=.env src/server.ts`.

## R3. Client framework and interaction state machine

**Decision**: React 19.2.8 + Vite 8.2.2. The interaction machine is a hand-rolled pure
`reduce(state, event)` over the six phases, plus a small runtime module that owns the four timers
and the fetches, exposed to React through `useSyncExternalStore`. No XState. No History-API
routing: one URL, one history entry, screens are state.

**Rationale**: a reconciling renderer is wanted for touch stability (a hand-written `render(state)`
that replaces innerHTML re-creates the button between `pointerdown` and `click` and drops taps,
which breaks NFR-003). Between React and Preact, Preact would serve fully at a tenth of the
payload; React is chosen because the create-vite `react-ts` template, plugin-react 6 and Testing
Library's canonical adapter target it, and Preact 11 is at rc.1. Bundle size is irrelevant on a LAN
kiosk. XState's `after` delays are in-memory `setTimeout`s restarted on state entry, so remaining
delays would still be computed from persisted timestamps by hand; it adds ≈27 kB and a second
execution model for no guarantee the reducer cannot give.

**What the lighter options would have done well**: vanilla TS with template literals would satisfy
every FR in a few hundred lines; its cost is the touch-stability bug class and a hand-rolled keyed
diff for the cart. Preact would do everything React does here.

**Gotchas**:
- The reducer is pure: `now` arrives on the event, never `Date.now()` inside `reduce`. React
  StrictMode double-invokes reducers and effects; timers and fetches live in the module-level
  runtime, not in `useEffect`.
- `useSyncExternalStore`'s `getSnapshot` must return the identical object while unchanged.
- Timers are wall-clock deadlines derived from persisted timestamps, evaluated by one 250 ms
  ticker. A `setTimeout(expire, 90_000)` armed before a bfcache freeze fires late after restore.
- Qualifying activity is stamped inside the reducer for a whitelist of event types (cart change,
  navigation, payment-screen interaction, Continue). Taps on empty screen, scroll, focus,
  pointermove, visibilitychange, TICK, poll and late responses, and menu loads never extend the
  interaction (FR-027, ADR-005).
- Touch: `<meta name="viewport" content="width=device-width, initial-scale=1">`,
  `touch-action: manipulation` on every control, `user-select: none` on controls, handle `click`
  (not `touchstart`), `html { overscroll-behavior: none }` so an edge swipe cannot navigate.

## R4. Client persistence, reload, back/forward and bfcache

**Decision**: the interaction record is persisted in `sessionStorage`, written through on every
transition and validated on boot, on `pageshow` (both `persisted` values) and on `visibilitychange
→ visible`. Validation computes deadlines from the persisted timestamps only; a record past its
deadline is deleted and the kiosk boots idle. The record holds the interaction id, `startedAt`,
`lastActivityAt`, phase, and (from first send) the frozen submission: key, `sentAt`, the lines as
displayed (id, name, unit price, quantity), `expectedTotalMinor`, `knownState`, `reference`.

**Rationale**: sessionStorage is partitioned by origin and tab, survives reload and back/forward
within the tab, and is not shared with other tabs (verified). localStorage is origin-wide and would
leak a stale interaction into any new tab. The frozen submission is persisted, not just the key,
because after a reload in `submitted` a later `failed` must render S6 with "the items still
listed" (FR-016 + FR-020), and the replay after reload must send byte-identical content or the
fingerprint check turns a legitimate replay into a 409 (ADR-002). Recovering an in-flight
operation within its own interaction is explicitly permitted (constitution IV).

**Verified corrections that shape the design**:
- sessionStorage is **not** reliably cleared on tab close: desktop Chrome restores it with "Reopen
  closed tab" and session restore, hours later. Boot validation against persisted timestamps is the
  guarantee, never tab close.
- Chrome **does** bfcache a page with an in-flight `fetch()`. The request keeps running while the
  page is frozen; the buffered response settles inside the restored document after `pageshow`
  with `persisted === true`. Eviction happens only if the request is still open after 60 s, exceeds
  ~1 MB, or redirects. So `revalidate()` must run synchronously inside the `pageshow` handler,
  before any queued response is admitted; the admission rule (interaction id match, monotonic
  definiteness) then discards a response for an interaction that expired during the freeze. Both
  paths, restored and evicted-then-fresh-load, are tested.
- A network error or abort carries no body and therefore no `interactionId`. The request closure
  captures `interactionId` and `idempotencyKey` and puts them on the dispatched RESPONSE event;
  the reducer compares those, never the body alone.

**Response admission rule** (the single guard, stated identically in `data-model.md` and
`contracts/ui-states.md`). A response event is applied only if all five hold:

1. The interaction is valid: its deadline, computed from persisted timestamps, has not passed.
2. The event's `interactionId` equals the current interaction's id (FR-032).
3. The event's `idempotencyKey` equals the **current submission's** key. Monotonicity is per
   intent, not per interaction: after a decline the customer stays in the same interaction and
   creates K2, and a late K1 `paid`/`failed` must not touch the K2 attempt.
4. The transition is legal for the current phase: `submitted → confirmed|declined|unresolved`,
   `unresolved → confirmed|declined` (FR-034), `unresolved(S7b) → unresolved(S7a)` on a first
   `pending`. Nothing leaves `confirmed` or `declined` on a response.
5. A terminal result is not reapplied: receiving `paid` again in `confirmed` does not reset
   `resolvedAt` or restart the 15 s display; receiving `failed` again in `declined` is a no-op.

**Polling follows the key** (review round five): the polling loop is bound to the interaction/key
pair it was started for. When a restored document adopts another attempt of the same interaction
(K2 replacing K1), the K1 loop is stopped and a K2 loop starts; the POST is never re-sent.

**Stale documents** (review round four): a document restored from the back/forward cache keeps
its heap. If another document in the same tab has since moved on (reset, a new interaction, a new
attempt under the same interaction), the restored document's memory is stale. On `pageshow` and
visibility the runtime compares its in-memory record with the tab's stored record byte for byte:
equal → apply the clock only; different or absent → abandon memory and hydrate the stored record
without ever writing over it; storage unavailable → apply the clock only. Playwright's default
headless shell never restores from the bfcache and Playwright passes
`--disable-back-forward-cache`, so the bfcache tests run in a separate project on the full Chromium
channel without that flag and assert `pageshow.persisted === true`.

**Deadline preservation rule** (stated identically in `data-model.md`): a response is not customer
activity and never moves a deadline backward. On `unresolved → declined` the inactivity deadline
already in force (`max(lastActivityAt, waitEndedAt) + 90 s`) is carried into `declined` unchanged;
the phase's ordinary `lastActivityAt + 90 s` formula does not apply until the customer's next
qualifying interaction re-stamps `lastActivityAt`. Without this rule a late decline at 100 s
(sentAt = 0, unresolved valid to 128 s) would set the deadline to 90 s and the next validation
would delete the interaction the customer is looking at, contradicting FR-034. On
`unresolved → confirmed`, `resolvedAt` is set and the 15 s display deadline applies; that ends the
interaction by design.

**Deadline arithmetic** (ADR-005 "Timers"; passive events never stamp activity):

| Phase | Deadline | Notes |
|---|---|---|
| building, declined (entered from S2/S3 edits or from a decline that arrived in time) | `lastActivityAt + 90 s` | warning from `+75 s` |
| submitted | none | suspended; the bounded wait ends at `waitEndedAt = pollStartedAt + 30 s` |
| unresolved | `max(lastActivityAt, waitEndedAt) + 90 s` | entry stamps nothing |
| declined (entered from unresolved by a late result) | the deadline in force at the transition, preserved | re-stamped only by the next qualifying interaction |
| confirmed | `resolvedAt + 15 s` | then idle; not restarted by a repeated `paid` |

**Gotchas**:
- Never register an `unload` listener (kills bfcache); `pagehide` only, and only for telemetry.
- Duplicate tab copies sessionStorage once; harmless (the second POST is a replay). Do not build a
  BroadcastChannel guard.
- `crypto.randomUUID()` is absent on plain-http non-loopback origins (`http://<LAN-IP>:8080`);
  `crypto.getRandomValues()` is available everywhere. The fallback builds a v4 UUID with version
  and variant bits set, lowercase.

## R5. The idempotent insert (ADR-004's deliberate choice)

**Decision**: one autocommit statement,
`INSERT INTO orders (…) VALUES (…) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, reference, state`,
followed, only when it returns zero rows, by a **separate** `SELECT … WHERE idempotency_key = $1`.
`rows.length === 1` from the INSERT is the sole authorisation to execute payment. No `BEGIN`, no
savepoint, no advisory lock on the accept path.

**Verified (Postgres 18 docs §63.5, §13.2.1, `execIndexing.c`, `nodeModifyTable.c`)**:
1. With a concurrent **uncommitted** row holding the same key, the statement blocks until that
   transaction ends, then returns the new row (competitor aborted) or zero rows (competitor
   committed). It never raises on the arbiter index at Read Committed.
2. Under Read Committed each statement gets a fresh snapshot, so the separate SELECT sees the row
   the competitor committed. The caveat both ADRs cite (DO NOTHING triggered by a row invisible to
   the INSERT's snapshot) is exactly why the lookup is a **separate statement**, never a CTE or
   RETURNING in the same statement.
3. `UPDATE orders SET state = $2, outcome_recorded_at = now() WHERE id = $1 AND state =
   'pending_payment'` cannot overwrite a recorded outcome: a concurrent updater waits and the WHERE
   is re-evaluated on the updated row. Zero rows affected is detected by `rowCount`.

**Why this over the alternatives**: plain INSERT + catch 23505 + ROLLBACK + fresh SELECT (proposed
by two researchers) is equally correct; it was not chosen because it introduces the aborted-
transaction state (25P02 on any further statement until ROLLBACK) and requires branching a 23505
between two constraints on every conflict. With ON CONFLICT on the named arbiter, the only 23505
that can reach the code is a **reference collision**, which is retried. Savepoints were rejected as
unnecessary once the accept path is a single statement; advisory locks as a heavier mechanism that
adds nothing the unique index does not already give.

**Consequences**:
- Leave isolation at Read Committed. At Repeatable Read/Serializable the same statement raises
  40001 against a row committed after the snapshot.
- Always name the conflict target. A bare `ON CONFLICT DO NOTHING` swallows a reference collision,
  the follow-up SELECT by key finds nothing, and the customer is told "unknown" for an order that
  was never created.
- Name every constraint (`orders_idempotency_key_key`, `orders_reference_key`) and branch on
  `err.constraint`. A 23505 on the reference constraint → regenerate and retry (bounded, 5
  attempts). A 23505 on anything else is a bug.
- Payment executes **after** the statement returns, on the owner path only. A losing request
  reports the recorded state and never writes. A found `pending_payment` is not authorisation to
  charge (ADR-002).
- Each blocked competitor holds a pool client while waiting; the concurrency test's N must be
  below `pool.max` (default 10) or the barrier deadlocks.

**Order of operations for POST /api/orders** (FR-018: a replay is never re-validated):

```text
1. schema validation                → 400, key not consumed
2. fingerprint from validated body
3. SELECT by key
   found → fingerprint mismatch → 409 (existing order untouched)
         → match → return recorded state (200 terminal / 202 pending), replay: true
4. validate against menu (unknown/unavailable item, bounds, sum ≤ 50, recomputed total ≟ expected)
   fail → SELECT by key once more (narrows, does not close, the validation window — see below)
          found → as step 3
          miss  → 422, no row, key not consumed
5. INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING
   0 rows → SELECT by key → as step 3
   1 row  → this request owns payment
6. simulator.execute(...)           → success | declined | inconclusive
7. record: conditional UPDATE       → paid | failed ; inconclusive leaves pending_payment
   0 rows affected → log + count, respond 500 (client treats as unknown and polls)
8. respond 201 (paid/failed) or 202 (pending_payment)
```

**Residual window, recorded rather than closed** (ADR-002 "Where this still breaks", amended
2026-09-07): two concurrent requests with the same key, and a price change landing between their
validations, can diverge: one validates and inserts, the other fails validation and its follow-up
lookup misses because the winner has not committed yet, so it is told 422 while an order under that
key exists and may be paid. The second SELECT shrinks the window to the winner's commit latency; it
does not eliminate it. No per-intent coordination or lock is added for a case that needs a
concurrent same-key replay and a menu change inside the same few milliseconds. The rejection screen
keeps "Start new order" available so the customer can always recover.

## R6. Order snapshot storage

**Decision**: the frozen order (lines with name, unit price, quantity, line total; currency;
total) is stored as a `snapshot jsonb` column on `orders`. No `order_items` table.

**Rationale**: with the snapshot on the row, the accept path is one statement and needs no explicit
transaction at all, which is what makes R5 simple. Nothing in scope queries lines relationally
(no fulfilment, no reporting, no admin). ADR-003 requires the snapshot be frozen at acceptance and
never re-read; a JSON document does that literally.

**What the relational option would have done well**: per-line referential integrity to
`menu_items` and easy SQL over lines. Neither is needed; if reporting were ever in scope, a
generated view over the JSON or a migration to a lines table would follow.

## R7. Money, fingerprint, identifiers, reference

**Decision**:
- Money is an integer number of USD cents end to end: JSON `integer`, TS `number`, Postgres
  `integer` with CHECKs. Display only through one module-level
  `Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })` fed `minor / 100`, verified
  exact for every integer 0..100000 on V8+ICU.
- Bounds live in `shared/constants.ts`: `MAX_QTY_PER_LINE = 10`, `MAX_UNITS_PER_ORDER = 50`,
  `MAX_TOTAL_MINOR = 100000`, `CURRENCY = 'USD'`. Enforced in the cart UI and again on the server
  (schema for per-field bounds; a hand-written cross-field check for the sum and the recomputed
  total, exact equality).
- Fingerprint: SHA-256 hex (`node:crypto` `hash`) of hand-built canonical JSON
  `{ currency, expectedTotalMinor, lines: [{ itemId, quantity }] sorted by itemId }` with literal
  key order. Sort with code-point comparison, never `localeCompare`. Duplicate `itemId`s are
  rejected before fingerprinting. `simulation.*` and the interaction id are **never** part of it.
- Idempotency key and interaction id: UUID generated in the browser (`crypto.randomUUID()` with the
  `getRandomValues` fallback), lowercase hyphenated. The server validates all UUID fields with the
  explicit pattern `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` rather than
  ajv-formats' `uuid` (which accepts mixed case and `urn:` prefixes; Postgres returns lowercase, so
  the strict pattern keeps client, wire and DB byte-identical). Version is not enforced, so seeded
  menu ids can be any lowercase UUID.
- Order reference: 4 symbols from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 symbols, 923,521
  combinations) drawn with `crypto.randomInt(31)` (unbiased). Stored as `text` with a CHECK on the
  alphabet and a named UNIQUE constraint. On a 23505 naming that constraint the INSERT is retried
  with a fresh reference, at most 5 times. Exhaustion (P ≈ 1.5e-10 at 10k orders) logs an error,
  increments `order_reference.exhausted`, and returns `503 { error: 'reference_exhausted' }`;
  nothing was inserted, the key is not consumed, and the client shows S9 and may re-confirm.
  Collisions become routine around ~1,200 orders (birthday bound) and are logged at warn, not
  error. Change condition: above ~90k orders, raise attempts or move to 5 characters.
- The reference is for reading aloud, never a lookup credential. Lookup is by key only (ADR-002).
- Offensive 4-letter combinations are possible with this alphabet; no blocklist is built. Recorded
  as a deliberate omission (constitution VII).

**`char(n)` rejected**: `reference` and `currency` are `text` with CHECK constraints, not
`char(4)`/`char(3)`; `char` pads and compares oddly. `data-model.md` is amended accordingly.

## R8. Request validation configuration

**Decision**: Fastify's built-in Ajv with
`ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } }`.
No zod, no TypeBox, no type-provider package. Cross-field rules in ~30 lines of hand-written code.

**Rationale** (verified on 5.12.3): Fastify's defaults are `coerceTypes: 'array'`,
`removeAdditional: true`, `useDefaults: true`, so `{"expectedTotalMinor": "1250"}` is silently
coerced and undeclared keys are stripped rather than rejected. With those defaults the 400 the
contract promises never fires and the fingerprint hashes coerced values. `customOptions` is merged
with `Object.assign`, so overriding those three keeps the other defaults and ajv-formats.
Submit schema: `additionalProperties: false`, `quantity` integer 1..10, `lines` minItems 1 /
maxItems 50, `expectedTotalMinor` integer 1..100000, `currency` const `USD`,
`simulation.outcome` enum. The 50-units-per-order rule and the recomputed total are code.

**Alternatives**: TypeBox (two incompatible package lines, `typebox` 1.x vs `@sinclair/typebox`
0.34; not worth it for five routes); zod + type provider (a second validator beside the built-in
one).

## R9. Payment simulator and outcome selection

**Decision (proposed; needs owner approval, see below)**: per-submission selection on the simulated
payment screen with a server default as fallback. S3 keeps one primary **Pay** control and adds a
clearly labelled, visually secondary three-way selector "What should the card terminal answer?":
Approve (default) / Decline / No answer. The selection travels as `simulation: { outcome }` in the
POST body. It is validated as an enum before any DB access, is **not** part of the fingerprint,
is **not** stored on the order, and is read by exactly one code path: the request that inserted
the row. Replays never look at it. When absent, or when `SIMULATOR_CLIENT_HINT=ignore`, the server
uses `SIMULATOR_DEFAULT_OUTCOME` (default `success`), read once at boot. A cosmetic
`SIMULATOR_LATENCY_MS` (compose demo 1500 ms so the waiting state is visible; tests 0) never
influences the outcome.

**Rationale**: the demo must show a decline and an unknown outcome at the kiosk without a second
device or a restart. An env-only default (option 1) needs a restart; a runtime mutator endpoint
(option 2) is option 1 by the back door and needs a second device; magic totals (option 4) are
hidden and dishonest on a screen that promises honesty. The selector is labelled as simulation, sits
on a screen that already says "this kiosk does not take real cards", and touches nothing that
constitution I protects: the amount is server-recomputed, order existence is server-decided, the
recorded outcome is immutable to replays. A real provider adapter would reject the field; the env
gate makes that posture explicit.

**Responses**: declines are **not** 402. `201 { state: 'failed' }` keeps the client's
classification simple: a known business outcome is a 2xx body whose `state` parses. The one
canonical classification rule (four categories, never the HTTP family alone) is stated in
`contracts/openapi.yaml` and R10; this section does not restate it. Inconclusive returns promptly
with `202 { state: 'pending_payment' }`; "no response" and "response lost" are **network**
scenarios produced in the browser with Playwright routes, tested separately from inconclusive
(ADR-001).

**Simulator module**: `createSimulator({ defaultOutcome, latencyMs, acceptClientHint, hooks })`
with `execute({ orderId, idempotencyKey, totalMinor, requestedOutcome })`, `calls()`,
`callsFor(idempotencyKey)`, `reset()`. The call record is appended **at entry**, before the outcome
is decided, so a throw after the call still counts as one execution (the semantics "at most one"
needs). Instances are created per app (`buildApp({ simulator })`), never a module singleton, or
parallel test files see each other's counts. The call log is a plain array capped at 1000 entries.
No inspection endpoint: interface tests read `payment.executed.*` deltas from `/api/metrics`.

**Post-commit exception seams** (ADR-002, tested in-process): the submission service accepts
optional `hooks: { beforeInsert?, afterCommit?, afterPayment? }`, `{}` in production and
unreachable over HTTP. They do not simulate a crash; they exercise a precise window and assert the
invariant that matters there: **an exception at that point leaves the row in `pending_payment`,
never `failed`, and a replay executes nothing.** `afterCommit` throwing exercises the window after
COMMIT and before the simulator call (0 executions, row pending). `afterPayment` throwing exercises
the window after the call and before the outcome is recorded (1 execution, row pending).
`beforeInsert` is an await-able barrier that makes the N-way same-key race deterministic instead of
probabilistic (and detects accidental serialisation by deadlocking). An exception in the
post-COMMIT window returns 500; it is never translated into `failed`, which would turn an unknown
outcome into a false decline. A real process kill would prove the same invariant at the cost of a
child-process harness and lost in-process counters; it is not built.

## R10. Client wait, polling and late results

**Decision**:
- The POST is raced against an 8 s timer and **never aborted**. Polling `GET
  /api/orders/by-key/{key}` every 2 s starts at the earliest of: 8 s without a response, a network
  rejection of the POST, or a `202 pending_payment`. The client never re-sends on its own.
- Polling lasts **at most 30 s** (OV-2): `pollStartedAt` is persisted and the bounded wait ends
  at `waitEndedAt = pollStartedAt + 30 s`, which is never later than `sentAt + 38 s`. Starting
  early shortens the total wait; it never lengthens the polling window.
- Each poll carries `AbortSignal.timeout(2000)`; a polls-only `AbortController` fires at
  `waitEndedAt`, on a terminal outcome, and on interaction end. Polling stops the moment a terminal
  state is displayed.
- `404` on lookup is unknown, not failure (ADR-002); it updates nothing.
- When the window closes without a terminal result: S7a if any response established `pending`
  (reference known), else S7b. Entry to unresolved stamps no activity (R4).
- A definitive result arriving later within the same interaction for the same intent, from the
  still-open POST or from a bfcache-buffered response, passes the admission rule and moves S7 →
  S5/S6 (FR-034), preserving the deadline in force (R4). Chrome imposes no client-side timeout on
  the open POST. The server does not promise a bound on handler duration (R15); the client's
  `waitEndedAt` is the guarantee that the screen never waits indefinitely (SC-006).

**Canonical response classification** (one rule; `contracts/openapi.yaml` carries the same text
and `contracts/ui-states.md` S4 applies it). Never treat the HTTP status family alone as evidence
about the intent; only a recognised body is evidence.

| Category | Recognised by | Client action |
|---|---|---|
| Known business outcome | 2xx with a body whose `state` parses (`paid`, `failed`, `pending_payment`) | Apply through the admission rule (R4) |
| Conflict with an existing intent | `409` with body `intent_mismatch` | An order exists under this key and may be paid: lookup by key and show the recorded state (S5/S6/S7a). Never a rejection screen |
| Request rejected, nothing created, key not consumed | `400` with a recognised body, `422 validation_rejected`, `503 reference_exhausted` | S8 (validation) or S9 (bad request / exhausted) with "try again" |
| Unknown outcome | Everything else: network failure, timeout, `404` on lookup, any status whose body is not recognised, any other 5xx | Keep waiting until `waitEndedAt`, then S7. Never a decline, never permission to pay again |

**Alternative rejected**: automatic re-POST of the same intent on early network rejection. Safe by
construction (ADR-002: transport repetitions reuse the identity) and it would place the order in
the connection-refused case, but it is a second send path with its own accounting inside the 38 s
bound. Polling to `404` and S7b ("check at the counter before ordering again") is honest and one
code path. Change condition: if a demo shows the connection-refused case as too pessimistic, add the
single re-send.

**Second tap on S4** is ignored: the control is disabled on first tap (NFR-003) and the raw touch
event reaches a disabled control. If a second POST ever slips through it is the same key and
content, a replay.

**409 `intent_mismatch`** should be unreachable from this client (it re-sends the persisted frozen
submission). If it arrives it is handled per the table above: lookup by key, show the recorded
state with the **recorded** total, never this attempt's. It is a conflict with an existing intent,
not a rejection. **400** on POST (nothing created, key not consumed) → S9 with "try again".

**A rejected key is kept until a new intent replaces it** (review rounds four and five). A 422
means this request created nothing; it is not evidence that no concurrent request with the same
key can be accepted (ADR-002 "The validation window"). The client keeps the key **only while its
outcome is unknown** (`knownState` none; a declined key is terminal for that order and is never
kept, so editing after a decline starts a new intent). It can never be re-sent (`sentAt` is set).
When the customer confirms again, one check of the kept key runs, one at a time, from the review
screen, and its continuation is admitted only if that screen is still current. Categories are
handled explicitly: a recorded outcome is applied; a `404` on that check is the one case where
"not found" permits a new intent, because otherwise FR-009's re-confirmation could never happen
and the owner ruled out per-intent coordination; anything else (network failure, 5xx, an
unrecognised body) keeps the key and permits nothing, and the customer is told the check could not
be made and may retry (FR-024). This narrows the window from the winner's commit latency to the
customer's reaction time. It is still not a proof, and the ADR says so.

**Menu refresh policy**: `GET /api/menu` on Start and on leaving S8. The cart is re-priced from
that fetch; the review total and `expectedTotalMinor` are one derived value from one cart state
(FR-008's client-side half, which server validation cannot catch). Between those points the server
is the only price check (ADR-003), and a stale price is a visible rejection, never a silent
correction.

## R11. Migrations and seed

**Decision**: a hand-rolled runner (~50 lines): ordered `NNNN_name.sql` files in
`api/migrations/`, applied inside one transaction guarded by `pg_advisory_xact_lock`, recorded in
`schema_migrations(version text PK, applied_at)`. Migrations and seed run **inside the API process
before `listen()`**. No node-pg-migrate, no dbmate, no one-shot compose service.

**Rationale**: three tables and a bookkeeping table, no down migrations, one author. Postgres makes
the hand-rolled runner safe cheaply: transactional DDL makes the batch all-or-nothing and the
advisory lock serialises concurrent runners (test workers). In-process before `listen()` makes
"the API does not serve traffic before schema and seed are ready" hold trivially, and lets
`/api/health` report `migrations` and `seed` (contract).

**What the heavier options would have done well**: node-pg-migrate/dbmate give down migrations,
drift tooling and a language-neutral history, none required. A one-shot `migrate` service with
`condition: service_completed_successfully` (verified to exist) makes "schema failed to apply"
unmistakable in `docker compose ps` and keeps DDL rights out of the serving process; here the
runner logs a structured `migration.failed` and exits 1, which `docker compose up --wait` reports.

**Seed**: one statement,
`INSERT … ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, price_minor = EXCLUDED.price_minor,
currency = EXCLUDED.currency, available = EXCLUDED.available, sort_order = EXCLUDED.sort_order,
updated_at = now() WHERE (menu_items.name, menu_items.price_minor, menu_items.currency,
menu_items.available, menu_items.sort_order) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.price_minor,
EXCLUDED.currency, EXCLUDED.available, EXCLUDED.sort_order) RETURNING (xmax = 0) AS inserted`.
The comparison names the canonical menu columns explicitly and excludes `updated_at`, which the
proposed row would take from `now()` and which would otherwise always differ, so `updated: 0` could
never appear. `updated_at` moves only when one of the canonical columns actually changes. Re-running never duplicates
(ADR-004) and, because the seed file is the menu's only source of truth (no admin), a restart
converges fixture-mutated rows back to canonical. Orders are unaffected: the snapshot is frozen at
acceptance. The restart proof line in `docker compose logs api` is `seed_applied inserted: 0
updated: 0`. At least one seeded item is unavailable so the first screen shows the state.

**Gotchas**:
- Migration files must not contain BEGIN/COMMIT (they run inside the runner's transaction; explicit
  control inside a simple-query batch would commit half a file). No `CREATE INDEX CONCURRENTLY`.
- Multi-statement files work only with parameter-less `client.query(text)` (simple query protocol;
  verified). Passing parameters switches to the extended protocol, which rejects batches.
- Accept only `^\d{4}_[a-z0-9_]+\.sql$`, sort bytewise, fail fast if `schema_migrations` lists a
  version not on disk (wrong image against an existing volume).
- Never put migrations or the seed in `/docker-entrypoint-initdb.d`: those scripts run only on an
  empty data directory.

## R12. Compose topology and static serving

**Decision**: three services. `db` (`postgres:18.6`, named volume mounted at
`/var/lib/postgresql`), `api` (Node, migrates + seeds + listens on 3000), `client`
(`nginx:1.30.4-alpine` serving the Vite build on `${CLIENT_PORT:-8080}` and proxying `/api/` to
`api:3000`). The single command is `docker compose up --build` (scripted:
`docker compose up --build -d --wait --wait-timeout 180`). Repository layout: npm workspaces
`api`, `client`, `e2e` with a root lockfile; `shared/` is a plain directory imported by relative
path; Docker build contexts are the repo root.

**nginx is the one place the heavier option is chosen, for a recorded reason**: with the API
serving its own static files, `docker compose stop api` (or any API outage) takes the screen down
with it: a reload during the outage shows a Chrome error page, not S9, which violates FR-026 in the
live stack. With nginx the app loads, fails its menu fetch, and shows S9 with a way back. That is
the live demonstration of User Story 8. ADR-004 also lists service startup ordering as part of the
operational surface being demonstrated. **What `@fastify/static` in the API container would have
done well**: one container fewer, same origin without a proxy, no nginx resolver or trailing-slash
traps; ~10 lines. `vite preview` is documented as not a production server and is not used.

**Verified compose behaviour**:
- `docker compose restart` drops every `depends_on` edge without `restart: true` before ordering.
  Both edges (api→db, client→api) carry `restart: true`. The API still has its own bounded DB
  connect retry because a daemon-level `restart: unless-stopped` (host reboot) never passes through
  Compose.
- `condition: service_healthy` on a service with no healthcheck is a hard failure. The API has a
  compose healthcheck (`node -e "fetch('http://127.0.0.1:3000/api/health')…"`, `start_period: 20s`
  so cold migration does not exhaust `retries`).
- Postgres healthcheck must force TCP: `pg_isready -h 127.0.0.1 -U $$POSTGRES_USER -d $$POSTGRES_DB`.
  During first init the entrypoint runs a socket-only temporary server; a socket `pg_isready`
  reports ready before TCP is up.
- `postgres:18` moved the data directory: `PGDATA=/var/lib/postgresql/18/docker`, `VOLUME
  /var/lib/postgresql`. Mount there. **Correction to a widely repeated claim**: mounting at the old
  `/var/lib/postgresql/data` on current 18.x does not silently lose data; the entrypoint detects the
  unused mount on first start and exits 1 with an explicit error. The README says which path.
- `docker compose down` (no `-v`) keeps named volumes and is the "restart" the acceptance test
  needs; `down -v` is the "empty environment" precondition. `docker compose restart` alone would
  preserve data even with no volume and is run only as an additional variant.
- Omit the obsolete top-level `version:` key; file name `compose.yaml`.

**Ports**: the db port is published on `127.0.0.1:${DB_PORT:-54329}` (a non-default host port so a
local Postgres on 5432 does not abort `up`) because integration and interface tests need a plain
`pg` connection for fixtures. `CLIENT_PORT` defaults to 8080. Both are named in the README.

**Gotchas**:
- `proxy_pass http://api:3000;` **without** a trailing slash, or nginx strips `/api/` and every
  route 404s.
- Vite 8 (Rolldown/Oxc) ships platform-specific native optional dependencies; generate
  `package-lock.json` from a clean `node_modules` so linux entries are recorded, or `npm ci` in the
  image fails with `Cannot find module @rolldown/binding-linux-…`. `.dockerignore` excludes
  `node_modules` and `dist`.
- Compose v5 delegates `--build` to Buildx; the README prerequisite is "Docker Desktop, or Engine
  ≥ 25 with the Compose and Buildx plugins".
- API responses carry `Cache-Control: no-store`; index.html is served without it (bfcache stays
  eligible; the app works either way).

## R13. Observability: logs, counters, telemetry

**Decision**: pino 10.3.1 injected via Fastify `loggerInstance`, NDJSON to stdout through
`pino.destination({ sync: true })` (so `startup.failed` followed by `process.exit(1)` cannot lose
the line). Base fields: numeric `level`, ISO `time`, `service: 'checkout-api'`; `pid`/`hostname`
dropped. Per line: `reqId`, `interactionId` (bound from the validated header by
`childLoggerFactory`), `event`, and where relevant `idempotencyKey`, `orderId`, `reference`. No
redaction: no PII exists, and the key is an intent identifier, not a secret; it is logged verbatim so
a line joins to `orders.idempotency_key` and to what the client persisted. Fastify's default `req`
serializer logs method/url/host/remoteAddress only; bodies are never logged above debug.

**Counters**: one module, `createCounters(names)` over a `Map<string, number>`, every key
pre-registered at 0, created per app instance (never a module singleton), decorated onto the app,
served at `GET /api/metrics` as `{ startedAt, uptimeSeconds, counters }`. No prom-client, no
exposition format. Counters reset on restart; `startedAt` says so.

**Server event and counter catalogue** (one per path that can fail silently):

| Event | Counter |
|---|---|
| `order.accepted` | `orders.accepted` |
| `order.validation_rejected` (`reason`) | `orders.validation_rejected.<reason>` |
| `order.replayed` (`state`) | `orders.replayed.<state>` |
| `order.intent_mismatch` | `orders.intent_mismatch` |
| `payment.executed` (`outcome`, `source: request\|default`) | `payment.executed.<outcome>` |
| `payment.outcome_recorded` | `payment.outcome_recorded` |
| `payment.outcome_record_failed` | `payment.outcome_record_failed` |
| `payment.post_commit_exception` | `payment.post_commit_exception` |
| `order_reference.collision` (warn) / `.exhausted` (error) | same names |
| `status.served` (debug; polling is chatty) | `status_lookup.<state>` / `status_lookup.not_found` |
| `client.event_received` (`name`) / `client.event_rejected` | `client_event.<name>` / `client_event.rejected` |
| `server.unhandled_error` (err) | `server.unhandled_error` |
| `request.rejected` (4xx, no stack) | — |
| `startup.migrations_applied`, `startup.seed_applied`, `startup.simulator_configured`, `startup.listening`, `startup.failed` | — |

The four startup lines in that order are the evidence for ADR-004's "does not serve before
ready"; `startup.listening` is last.

**Client telemetry**: one `emit(name, detail)` function. Primary transport
`navigator.sendBeacon('/api/events', JSON.stringify(payload))` with a **string** body, which Chrome
sends as `text/plain;charset=UTF-8` (CORS-safelisted; verified in Chromium source); fallback
`fetch(url, { method: 'POST', keepalive: true, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body })`.
Never awaited, wrapped in try/catch, dropped on failure, no queue (constitution VI). One event per
POST; `interactionId` travels in the body because beacons cannot set headers. The server overrides
the `text/plain` parser inside the events plugin with `getDefaultJsonParser`, validates against a
closed schema, replies 204, and 400 for a malformed body (counted; the client never reads the
reply). Events: `unresolved_shown`, `late_result_applied`, `stale_response_discarded`,
`foreign_response_discarded`, `interaction_expired`, `service_unreachable`, `rejection_shown`.

**SC-007 as qualified (owner-approved, applied to the spec)**: a failure whose cause is that the
server was not reached is recorded only when the client's best-effort event lands. That covers
User Story 8 and the never-reached-the-server cases in User Story 4 (a POST that fails before
arriving, which the interface tests produce with `route.abort()`). `service_unreachable` and
`unresolved_shown` are emitted at the moment they occur and land if the API is back. Every other
customer-visible failure has a server-originated line and counter independent of the client.

## R14. Test strategy

**Decision**: Vitest 4.1.11 as the single unit/integration runner for API and client (projects:
`api-unit`, `api-integration`, `client-unit`); Playwright 1.63.0 for interface tests and for the
two ADR-004 operational acceptance scenarios (`e2e/ops`). Root `npm test` runs type-check, unit,
integration; `npm run test:e2e` runs Playwright against the compose stack.

**Rationale**: one runner for the reviewer. node:test would do everything the API needs with zero
packages, but the client's TSX cannot run under Node's type stripping (`.tsx` is unsupported), so
node:test would need a second runner beside it. Vitest 5.0.0 was published 2026-09-05 with 33
documented breaking changes and is not pinned; 4.1.11 supports Vite 8. Real Postgres, never
mocked: every guarantee the spec asks tests to prove is a multi-connection commit-ordering property.

**What node:test would have done well**: the API suite alone, with `mock.method` for simulator
call counts and `--test-concurrency=1` for a shared database, at zero dependencies.

**API integration**: `buildApp({ pool, simulator, hooks })` + `app.inject()` against the compose
Postgres in a dedicated `webcheckout_test` database (created by a global setup that runs
`docker compose up -d --wait db` and `CREATE DATABASE` if missing, then `migrate()` which is
callable without `listen`). Isolation: `TRUNCATE orders` per test, `fileParallelism: false`; menu
mutations restored by a test-only `resetMenu()` guarded by a database-name check ending in `_test`.

**Concurrency test** (SC-002): N = 8 injected POSTs with the same key held at the `beforeInsert`
barrier before pool acquisition, released together. Verified: Postgres serialises the inserts;
losers block on the winner's transaction then take the 0-row path. Assert one row, exactly one
simulator call, all responses carry the same `orderId`, statuses `{201 once, 200/202 otherwise}`.
`Promise.all` of injected requests interleaves at await points (verified). Tests are agnostic to
the recovery mechanism; they assert outcomes only.

**Post-commit exception tests** (ADR-002): the invariant is that an exception in either window
leaves the row in `pending_payment`, never `failed`, and a replay executes nothing. `afterCommit`
throws → row `pending_payment` visible from a separate connection, 0 simulator calls, the request
returns 500, a replay returns 202 with the count unchanged. `afterPayment` throws → row pending,
exactly 1 call, 500, replay 202, count unchanged. Through hooks, not a real process kill: the
invariant is fully observable after the throw, and a real kill loses the in-process counters.

**Interface tests**: one Chromium project, `viewport: { width: 1024, height: 768 }`,
`hasTouch: true`, `isMobile: false` (override after spreading `devices['Desktop Chrome']`, which
sets 1280×720 and no touch), `workers: 1`, `fullyParallel: false`. `page.clock.install()` before
`page.goto`, then `pauseAt`; `runFor` for the 2 s polling loop (`fastForward` fires each due timer
at most once); Playwright ≥ 1.59 also fakes `AbortSignal.timeout`. Network faults via `page.route`
with `{ times: 1 }`: `route.abort()` (never reached the server), `route.fetch()` then
`route.abort('connectionreset')` (processed, response lost), `route.fetch()` then
`route.fulfill({ status: 500 })` (generic error after the order may exist), `route.fetch()` then a
delayed `route.fulfill` (late definitive result, FR-034), `404` on lookup. Double tap via
`page.touchscreen.tap(x, y)` twice (raw events, no actionability wait). "At most one payment" as a
delta of `payment.executed.*` from `/api/metrics`, read before and after. Reload during submission:
wrap a pending `route.fulfill` in try/catch (target closed). Screen transitions are synchronous
React state, never gated on animation end (a paused clock would stall them). Back/forward is
asserted on both restore paths (bfcache restored vs fresh load).

**Ops acceptance** (ADR-004): a Playwright project with its own compose project name
(`-p webcheckout-accept`) and port overrides, `down -v --remove-orphans` before and after. Scenario
1: from empty, `up --build --wait` → `/api/health` 200 with `seed: applied`, menu served, an order
accepted. Scenario 2: `down` (no `-v`), `up --wait` → the order is still returned by key, health
shows `seed: already-present`, `menu_items` count unchanged.

**Local machine note**: it runs Node 25.9.0, which is EOL. `.nvmrc` = 24 and `engines` `>=24 <25 ||
>=26`; the Docker images pin 24.20.0.

## R15. Server-side time bounds

**Decision**: pg Pool `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000`, `max: 10`;
`statement_timeout = 5000` via `options: '-c statement_timeout=5000'`; simulator latency 1500 ms in
the demo, 0 in tests. Startup DB connect retries for up to 60 s (error 57P03 "starting up" is
retryable), then `startup.failed`.

**What is not promised**: a universal bound on handler duration. Fastify's `requestTimeout` bounds
receipt of the request, not the handler; it is not used as a guarantee. The database and pool
timeouts bound the individual steps that touch Postgres, and the simulator latency is fixed, so a
POST resolves in seconds in normal operation, but the only guarantee that the screen never waits
indefinitely is the client's `waitEndedAt` (R10, SC-006).

## Decisions taken with the owner (plan review, 2026-09-07)

Per the constitution ("An agent may propose. The project owner decides."), each proposal below was
decided explicitly. Nothing was assumed accepted by silence.

| # | Proposal | Decision | Applied to |
|---|---|---|---|
| 1 | Per-submission simulator outcome selector on the simulated payment screen, server default as fallback, env-gated (R9) | **Approved.** Fallback if ever withdrawn: env default only; a decline or an unknown outcome is then shown by restarting the API with a different `SIMULATOR_DEFAULT_OUTCOME`. Rejecting the selector does not approve a runtime override endpoint or any other new mechanism | ADR-001 "The payment simulator" (one paragraph, amended) |
| 2 | `unresolved → confirmed \| declined` on a late definitive result within the same interaction (FR-034) | **Already decided** in the spec's Clarifications; ADR-005 reconciled to match, including monotonicity per intent and deadline preservation | ADR-005 diagram and one paragraph |
| 3 | SC-007 qualified where the server was not reached, covering User Story 8 and the never-arrived cases in User Story 4 | **Approved** | spec SC-007, Clarifications |
| 4 | The frozen submission's displayed lines are persisted client-side with the key (R4) | **Approved** | data-model.md (no rule change) |
| 5 | The residual validation window is recorded, not closed (R5) | **Decided**: no per-intent coordination or lock | ADR-002 "Where this still breaks" |
| 6 | Keep the `beforeInsert` / `afterCommit` / `afterPayment` hooks | **Decided**: keep; describe the window each exercises rather than calling it a crash | R9, R14, plan.md |

## Refuted claims log

What the adversarial verifiers corrected, kept so the wrong version does not resurface:

| Claimed | Correct | Consequence |
|---|---|---|
| sessionStorage is cleared when the tab closes | Desktop Chrome/Firefox restore it via "Reopen closed tab" and session restore, hours later | Boot validation from timestamps is the guarantee (R4) |
| Chrome does not bfcache a page with an in-flight fetch | It does; the response is delivered after `pageshow persisted=true`; eviction only after 60 s / 1 MB / redirect | Revalidate synchronously in `pageshow` before admitting responses; test both paths (R4) |
| An un-aborted `fetch()` has no timeout anywhere | True for Chrome (the target) and Firefox; WebKit applies a 60 s idle timeout; intermediaries may close idle connections | Server-side bounds keep the POST short (R15); Chrome is the only target (OV-7) |
| Playwright `page.clock` does not fake `AbortSignal.timeout` | It does since 1.59 | No constraint on implementing the 8 s wait; `fastForward` fires each timer at most once, use `runFor` for polling (R14) |
| Mounting the pg volume at `/var/lib/postgresql/data` on 18.x silently loses data | The entrypoint detects the unused mount and exits 1 with an explicit error on first start | The README names the path; the failure is loud, not silent (R12) |
| ON CONFLICT DO NOTHING might return "no row" against an uncommitted competitor | Verified: it blocks until the competitor ends | R5 stands |
| A conflicting concurrent INSERT waits then raises 23505 | Verified for Read Committed with a non-deferrable constraint; at Serializable a loser can get 40001 | Stay at Read Committed (R5) |
