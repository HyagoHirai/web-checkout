# Implementation Plan: Web Checkout

**Branch**: `001-web-checkout` (no branch created; work is on `main`) | **Date**: 2026-09-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-web-checkout/spec.md`, clarified 2026-09-07 (no
open values remain).

**Governing documents**: `.specify/memory/constitution.md` v1.0.0; `docs/adr/0001`–`0005`
(Accepted; ADR-001, ADR-002 and ADR-005 amended 2026-09-07 with the owner's explicit approval, see
**Decisions taken with the owner**). Precedence: constitution > ADRs > spec > this plan > tasks and
code.

## Summary

A self-service snack-bar kiosk in the browser: menu, cart, review, simulated payment, confirmation
with a counter reference, and defined behaviour for every failure and abandonment path. The server
is the price authority and recomputes every total; order submission is idempotent through a
client-generated key bound to a fingerprint of the intent, with the order row committed before the
simulated payment runs and only the inserting request allowed to run it. The cart lives only in the
browser; the interaction is tab-scoped, expires on inactivity, and nothing from it survives a reset.

Technical approach (details and alternatives in [research.md](research.md)): TypeScript end to
end. A Fastify 5 API on Node 24 (native type stripping, no build step) over PostgreSQL 18, with one
autocommit `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING` as the accept path and a
JSONB snapshot of the frozen order on the row. A React 19 + Vite 8 client with a hand-rolled pure
reducer for the interaction machine, wall-clock deadlines persisted in `sessionStorage`, and one
response-admission rule. Three compose services (`db`, `api`, `client` via nginx), one command.
Structured pino logs and in-process counters at `/api/metrics`. Vitest 4 against a real Postgres for
unit/integration; Playwright 1.63 at 1024×768 with touch for interface tests and for the two
operational acceptance scenarios.

## Technical Context

**Language/Version**: TypeScript ~6.0.2 on Node.js 24.20.0 (Active LTS). API runs `.ts` directly
via Node's native type stripping; `tsc --noEmit` is the type gate. Client is transpiled by Vite.

**Primary Dependencies**: Fastify 5.12.3, `pg` 8.23.0, pino 10.3.1 (API); React 19.2.8, Vite
8.2.2, `@vitejs/plugin-react` 6.1.1 (client). No ORM, no migration framework, no validation library
beyond Fastify's built-in Ajv, no state-machine library, no metrics client.

**Storage**: PostgreSQL 18.6 (`postgres:18.6`) in Docker Compose with a named volume mounted at
`/var/lib/postgresql`. Three tables (`menu_items`, `orders`, `schema_migrations`); the frozen order
is a `jsonb` snapshot on `orders`. Cart and interaction state live in the browser only
(`sessionStorage`, tab-scoped).

**Testing**: Vitest 4.1.11 (projects `api-unit`, `api-integration` against the compose Postgres in
a `webcheckout_test` database, `client-unit` with jsdom + Testing Library); `@playwright/test`
1.63.0 for interface tests (Chromium, 1024×768, `hasTouch`, `page.clock`, `page.route`) and for the
ADR-004 operational acceptance scenarios. Concurrency and the two post-commit exception windows are
tested in-process with injectable hooks against real Postgres commits; "at most one payment per
intent" is asserted on the simulator's call log and on `/api/metrics` deltas, never on row counts.

**Target Platform**: Chrome at a 1024×768 viewport, touch-first (OV-7, NFR-001). Server: Linux
containers (`node:24.20.0-bookworm-slim`, `nginx:1.30.4-alpine`), started by `docker compose up
--build` on a Unix machine with Docker.

**Project Type**: web application (API + browser client), one repository, npm workspaces `api`,
`client`, `e2e`, plus a plain `shared/` directory imported by relative path.

**Performance Goals**: a handful of orders per minute from one kiosk (ADR-004). A submission
resolves inside the client's 8 s network wait in normal operation; the waiting state is visible on
tap (NFR-003); every wait for a payment result ends at the client's `waitEndedAt`, at most 38 s
after send (SC-006). The server bounds its database steps but does not promise a handler-duration
bound; the client's bound is the guarantee (research R15).

**Constraints**: money is never trusted from the client (constitution I); intent recorded and
committed before payment (III); no interactive state outlives the interaction (IV); observability
bounded to structured logs and simple counters, no dashboards, no extra infrastructure (VI); one
setup command, restart preserves orders and does not duplicate the seed (X); no card data, no
provider credentials (ADR-001). Server-side time bounds on database steps: pool connect 5 s,
`statement_timeout` 5 s (research R15).

**Scale/Scope**: one kiosk, one customer at a time, no staff role, no second user. 10 screens
(`contracts/ui-states.md`), 6 API routes (`contracts/openapi.yaml`), 34 functional requirements, 9
user stories, all in scope; P3 orders the work and does not make User Story 9 optional.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | How the plan satisfies it | Pre-research | Post-design |
|---|---|---|---|---|
| I | Money is never trusted from the client | Client sends item ids, quantities, currency and `expectedTotalMinor`; no unit prices. Server recomputes from `menu_items` and requires exact equality; mismatch → 422 before any payment, current prices returned, no row (research R5 step 4, R7). Bounds enforced twice (schema + code) with strict Ajv (R8). The simulator selector is not money and is excluded from everything the server decides (R9; ADR-001 amended with the owner's approval). | PASS | PASS |
| II | Order submission is idempotent by construction | Client-generated key persisted before first send and frozen until a definitive outcome; server binds it to a fingerprint; `ON CONFLICT (idempotency_key) DO NOTHING` on a named unique constraint; replays return the recorded state and never re-validate or re-execute; a recorded decline stays a decline (R5, R7). Navigation, refresh and reset never create a second intent for an unresolved submission (R4, R10). | PASS | PASS |
| III | Write the intent durably before performing the action | Accept path is one autocommit INSERT; payment runs only after it returns a row; the outcome is recorded by a conditional UPDATE; an exception after commit leaves `pending_payment`, never `failed` (R5, R9). Both post-commit exception windows are tested (R14). The residual validation window is recorded in ADR-002, not claimed closed (R5). | PASS | PASS |
| IV | Interactive state does not outlive the interaction | Cart is memory-only; the interaction record is tab-scoped `sessionStorage` validated against persisted deadlines on boot, `pageshow` and visibility; anything expired is deleted before any response is admitted (R4). Orders, outcomes and logs are server-side and survive. Recovery by key within the interaction is supported (R10). | PASS | PASS |
| V | Failure paths are first-class | Every reachable state has a screen in `contracts/ui-states.md` (S0–S9 plus the warning overlay), and the four failure kinds are distinguished by the client classification rule in the contract description (2xx / rejected-before-payment / unknown). A client-side timeout is never evidence about the order (R10). | PASS | PASS |
| VI | If it can fail silently, it must be observable | pino NDJSON with request id, interaction id, key, order id and one `event` per failure path; in-process counters pre-registered at 0 at `/api/metrics`; best-effort beacon telemetry with no queue; nothing beyond logs and counters (R13). SC-007 is qualified, with the owner's approval, for failures whose cause is that the server was not reached. | PASS | PASS |
| VII | Scope is a decision, and omissions are deliberate | Out-of-scope list carried from ADR-001 into the spec; deliberate omissions recorded in research: no reference blocklist (R7), no automatic re-send (R10), no inspection endpoint (R9), no down migrations (R11). Possible future work generates no tasks. | PASS | PASS |
| VIII | Proportionality, with the trade-off stated | Every heavier-than-necessary choice is in **Complexity Tracking** below with the honest account of the lighter option; the default everywhere else is the lighter option (native type stripping, hand-rolled runner, hand-rolled reducer, built-in Ajv, `pg` directly, JSONB snapshot). | PASS | PASS |
| IX | Decisions are recorded | ADR-001..005 precede this plan; research.md records alternatives, versions with evidence, and change conditions; the amendments to ADR-001, ADR-002 and ADR-005 were approved explicitly by the owner and are marked in the ADRs with the date. | PASS | PASS |
| X | One setup command | `docker compose up --build` brings up `db`, `api`, `client`; migrations and seed run in the API before it listens; healthchecks gate startup order; named volume at the Postgres 18 path; seed is a converging upsert; both operational scenarios are automated (R11, R12, quickstart). Prerequisites named in the README. | PASS | PASS |

**Governance**: no principle is altered. Three ADRs and two spec statements were amended on the
owner's explicit decision during plan review; nothing was assumed accepted by silence.

**Gate result**: PASS on both evaluations. No unjustified violation; justified trade-offs follow.

## Project Structure

### Documentation (this feature)

```text
specs/001-web-checkout/
├── plan.md              # This file
├── spec.md              # Clarified specification
├── research.md          # Phase 0: decisions, alternatives, versions, gotchas, refuted claims
├── data-model.md        # Phase 1: server tables, client state, state machines, timers
├── quickstart.md        # Phase 1: run and validate end to end
├── contracts/
│   ├── openapi.yaml     # API contract (6 routes, error bodies, client classification rule)
│   └── ui-states.md     # Screen catalogue, transitions, admission rule, traceability
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
compose.yaml                       # db, api, client; healthchecks; named volume; ports
README.md                          # the one command, prerequisites, ports, test commands
package.json                       # npm workspaces: api, client, e2e; root scripts test / test:e2e / test:ops
.nvmrc                             # 24
shared/                            # plain directory, imported by relative path (Node will not strip .ts under node_modules)
├── constants.ts                   # MAX_QTY_PER_LINE, MAX_UNITS_PER_ORDER, MAX_TOTAL_MINOR, CURRENCY, REFERENCE_ALPHABET, timers
└── wire.ts                        # request/response types mirroring contracts/openapi.yaml

api/
├── Dockerfile                     # node:24.20.0-bookworm-slim; npm ci --omit=dev; CMD ["node","src/server.ts"]
├── package.json  tsconfig.json    # erasableSyntaxOnly, verbatimModuleSyntax, allowImportingTsExtensions, noEmit
├── migrations/
│   └── 0001_initial.sql           # menu_items, orders (jsonb snapshot, named constraints), schema_migrations
├── seed/
│   └── menu.ts                    # fixed lowercase UUIDs + slugs; one unavailable item
├── src/
│   ├── server.ts                  # boot: connect (retry ≤ 60 s) → migrate → seed → log → listen; SIGTERM → close
│   ├── app.ts                     # buildApp({ pool, simulator, hooks, logger, counters }) → Fastify instance
│   ├── config.ts                  # env: DATABASE_URL, PORT, SIMULATOR_DEFAULT_OUTCOME, SIMULATOR_CLIENT_HINT, SIMULATOR_LATENCY_MS
│   ├── db/
│   │   ├── pool.ts                # pg Pool with timeouts, statement_timeout, error listener
│   │   ├── migrate.ts             # hand-rolled runner: ordered files, one transaction, advisory lock
│   │   └── seed.ts                # converging upsert, returns { inserted, updated }
│   ├── domain/
│   │   ├── money.ts               # integer cents helpers, recompute total
│   │   ├── fingerprint.ts         # canonical JSON + SHA-256
│   │   ├── reference.ts           # 31-symbol alphabet, crypto.randomInt
│   │   └── validate.ts            # cross-field rules → reasons[]
│   ├── payment/
│   │   └── simulator.ts           # createSimulator({...}); execute / calls / callsFor / reset
│   ├── services/
│   │   └── orders.ts              # submit (R5 order of operations), lookupByKey
│   ├── routes/
│   │   ├── health.ts  menu.ts  orders.ts  events.ts  metrics.ts
│   ├── observability/
│   │   ├── logger.ts              # pino sync destination, base fields, childLoggerFactory
│   │   └── counters.ts            # createCounters(names) over Map
│   └── plugins/
│       └── errors.ts              # setErrorHandler / setNotFoundHandler → one JSON error shape
└── test/
    ├── unit/                      # money, fingerprint, reference, validate, simulator
    ├── integration/               # concurrency, replay, post-commit-windows, validation, reference, lookup, health
    └── helpers/                   # db (create/migrate/truncate/resetMenu, _test guard), app factory

client/
├── Dockerfile                     # build stage (node) → nginx:1.30.4-alpine with nginx.conf
├── nginx.conf                     # static + SPA fallback; location /api/ { proxy_pass http://api:3000; }
├── package.json  tsconfig.json  vite.config.ts  index.html
├── src/
│   ├── main.tsx  App.tsx          # screen switch on store phase
│   ├── machine/
│   │   ├── types.ts               # Interaction, Submission, Cart, events
│   │   ├── reducer.ts             # pure reduce(state, event); activity whitelist; admission rule
│   │   ├── deadlines.ts           # inactivity / wait / confirmation deadlines from persisted timestamps
│   │   ├── storage.ts             # sessionStorage read/write/validate/delete
│   │   ├── runtime.ts             # store, 250 ms ticker, POST race, polling, pageshow/visibility revalidate
│   │   └── uuid.ts                # randomUUID with getRandomValues fallback
│   ├── api/
│   │   ├── client.ts              # fetch wrappers with X-Interaction-Id, classification of responses
│   │   └── telemetry.ts           # emit(): sendBeacon string body, keepalive fetch fallback
│   ├── money/format.ts            # Intl.NumberFormat en-US USD from minor units
│   ├── screens/                   # Idle, Menu, Review, Payment, Waiting, Confirmed, Declined, Unresolved, Rejected, Error, InactivityWarning
│   └── styles.css                 # touch targets, touch-action, overscroll-behavior
└── test/                          # reducer, deadlines, storage, admission, runtime (fake timers, injected fetch), screens

e2e/
├── package.json  playwright.config.ts   # chromium 1024×768 hasTouch; workers 1; webServer = docker compose up
├── fixtures/db.ts                       # menu price/availability fixtures via pg on 127.0.0.1:${DB_PORT}
├── tests/
│   ├── us1-order-and-pay.spec.ts  us2-repeat-submission.spec.ts  us3-price-changed.spec.ts
│   ├── us4-unknown-outcome.spec.ts  us5-abandonment.spec.ts  us6-declined.spec.ts
│   ├── us7-unavailable.spec.ts  us8-unreachable.spec.ts  us9-late-responses.spec.ts
└── ops/
    └── acceptance.spec.ts               # compose project webcheckout-accept: empty→working; down/up preserves
```

**Structure Decision**: a web application split into `api/` and `client/` because the two halves
run in different processes with different toolchains (Node type stripping vs Vite), plus `e2e/` as
its own package because Playwright's dependencies should not enter either runtime image. `shared/`
is a plain directory rather than a workspace package because Node refuses to strip `.ts` under
`node_modules`; both packages import it by relative path and the Docker build contexts are the repo
root. The API layering (`routes` → `services` → `domain`/`db`/`payment`) exists so the order of
operations in research R5 lives in one function (`services/orders.ts#submit`) that the integration
tests exercise directly through `buildApp()`.

## Phase 0: Research (complete)

Output: [research.md](research.md). All Technical Context fields are resolved; no NEEDS
CLARIFICATION remains. Method and reconciliations are recorded there, including the refuted-claims
log.

## Phase 1: Design (complete)

Outputs: [data-model.md](data-model.md), [contracts/openapi.yaml](contracts/openapi.yaml),
[contracts/ui-states.md](contracts/ui-states.md), [quickstart.md](quickstart.md). The
post-design Constitution Check above passes.

## Decisions taken with the owner

Plan review, 2026-09-07. Each was decided explicitly; the full table is in research.md.

| # | Proposal | Decision | Applied to |
|---|---|---|---|
| 1 | Per-submission simulator outcome selector, server default as fallback, env-gated | Approved. Fallback if withdrawn: env default only, outcome changed by restarting the API; no override endpoint or other new mechanism | ADR-001 |
| 2 | `unresolved → confirmed \| declined` on a late definitive result (FR-034) | Already decided in Clarifications; ADR-005 reconciled, including monotonicity per intent and deadline preservation | ADR-005 |
| 3 | SC-007 qualified where the server was not reached (User Story 8 and the never-arrived cases in User Story 4) | Approved | spec SC-007 |
| 4 | The frozen submission's displayed lines are persisted client-side with the key | Approved | data-model.md |
| 5 | The residual validation window is recorded, not closed | Decided: no per-intent coordination or lock | ADR-002 |
| 6 | Keep the `beforeInsert` / `afterCommit` / `afterPayment` hooks | Decided: keep; describe the window each exercises | research R9, R14 |

## Complexity Tracking

Constitution VIII: every choice heavier than a lighter option that would have sufficed, with the
reason and the honest account of the lighter option. The Postgres-over-SQLite decision is recorded
in ADR-004 and not repeated.

| Heavier choice | Why needed | What the lighter option would have done well |
|---|---|---|
| nginx container serving the client and proxying `/api` | With the API serving its own static files, an API outage takes the screen down: a reload shows a Chrome error page, not S9, violating FR-026 in the live stack. nginx keeps the app loading during `docker compose stop api`, which is the live demonstration of User Story 8. ADR-004 also names startup ordering as demonstrated surface. | `@fastify/static` in the API container: one container fewer, same origin without a proxy, no resolver or trailing-slash traps, ~10 lines. Sufficient for every automated test (which fault-inject with `page.route`), not for the live outage demo. |
| Vitest 4.1.11 instead of `node:test` for the API | One runner and one `npm test` for the reviewer. The client's TSX cannot run under Node's type stripping, so `node:test` for the API would mean a second runner beside Vitest for the client. | `node:test` runs the whole API suite at zero dependencies: real Postgres, `Promise.all` concurrency, `mock.method` call counts, `--test-concurrency=1` for a shared database. |
| React 19 instead of Preact or vanilla TypeScript | Touch stability needs a reconciling renderer (a `render(state)` that replaces innerHTML re-creates the button between `pointerdown` and `click` and drops taps, breaking NFR-003). React over Preact: the create-vite `react-ts` template, plugin-react 6 and Testing Library's canonical adapter target it; Preact 11 is at rc.1. | Preact would do everything this client needs at a tenth of the payload. Vanilla TS would satisfy every FR in a few hundred lines at the cost of a hand-rolled keyed diff and the touch-stability bug class. Bundle size is irrelevant on a LAN kiosk. |
| Per-submission simulator selector on screen | The demo must show a decline and an unknown outcome at the kiosk without a second device or a restart; a hidden mechanism (magic totals) would be dishonest on a screen that promises honesty. Owner-approved (#1 above). | An env-only default is one variable and zero UI; it cannot change outcome without a restart, so a live demo of User Story 4 or 6 needs a restart between attempts. |
| Injectable hooks (`beforeInsert`, `afterCommit`, `afterPayment`) and a simulator call log in production code paths | `beforeInsert` is a barrier that makes the N-way same-key race deterministic rather than probabilistic (and detects serialisation by deadlocking). `afterCommit` and `afterPayment` exercise the two post-commit windows and assert the P1 invariant that an exception there leaves the row in `pending_payment`, never `failed`, and that a replay executes nothing. The call log, appended at entry, is what "observe the simulator's calls" (spec Verification) means. | A real process kill proves the same invariant with no production seams, at the cost of a child-process harness and no in-process counters after the kill. Counters alone cannot attribute calls to a key. Every hook is `{}` in production and unreachable over HTTP. |
| Seed as a converging upsert (`DO UPDATE … WHERE DISTINCT`) instead of `DO NOTHING` | The seed file is the menu's only source of truth (no admin); after fixtures mutate prices in a demo, a restart puts the menu back. One clause. | `DO NOTHING` satisfies ADR-004's "does not duplicate" exactly and is one clause shorter; it leaves fixture drift in place until `down -v`. |

## Risks and the tests that retire them

| Risk (named failure) | Retired by |
|---|---|
| Payment executed inside the insert transaction, or on a found-pending path (double charge) | `concurrency.test.ts`, `replay.test.ts`; code review of `services/orders.ts` against research R5 |
| Fingerprint instability turns a replay into a 409 (false status, then double charge) | `replay.test.ts` (reorder lines, change `simulation`, replay after simulated reload from persisted lines); the client handles a 409 by lookup, never by a rejection screen |
| A late result for a previous intent overwrites the live attempt, or restarts the confirmation timer | `client/test/reducer` (admission rule keyed on the submission's key; terminal not reapplied); `us9-late-responses.spec.ts` |
| A late decline deletes the interaction on the next validation (deadline regression) | `client/test/deadlines` (deadline preserved across `unresolved → declined`) |
| Stale interaction restored after tab restore or bfcache (stranger's order) | `client/test/deadlines`, `storage`; `us5-abandonment.spec.ts` on both navigation paths |
| Review total and submitted total diverge (charged an amount not shown) | `client/test/reducer` (single derived value); `us3-price-changed.spec.ts` |
| 0-row outcome UPDATE or post-commit exception reported as an outcome (false status) | `post-commit-windows.test.ts`; `us4-unknown-outcome.spec.ts` (500 after `route.fetch`) |
| Wrong volume path or socket-only healthcheck (restart loses orders / API starts too early) | `e2e/ops/acceptance.spec.ts`; startup log ordering |

## Next

`/speckit-analyze` once against these documents, then `/speckit-tasks`, then `/speckit-implement`
with P1 complete and working before anything else. Findings from here on are made during
implementation and recorded in `PROCESS.md`.
