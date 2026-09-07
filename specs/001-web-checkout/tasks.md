# Tasks: Web Checkout

**Input**: Design documents from `specs/001-web-checkout/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/openapi.yaml,
contracts/ui-states.md, quickstart.md
**Tests**: Required. The spec's Verification section and SC-008 make automated tests part of the
delivery: acceptance scenarios and failure behaviours, concurrency and persistence against a real
database, "at most one payment" observed on the simulator's calls.
**Organization**: by user story, in the spec's priority order. P3 orders the work; it does not make
User Story 9 optional (owner decision, spec Clarifications).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1..US9 from spec.md
- Paths are repository-relative. Layout per plan.md: `api/`, `client/`, `e2e/`, `shared/`.

## Conventions that every task follows

- API sources are `.ts` run by Node 24 type stripping: erasable syntax only, relative imports carry
  `.ts`, `import type` for types (research R2).
- Money is integer cents; UUIDs are lowercase hyphenated; the bounds and alphabet come from
  `shared/constants.ts`, never re-declared.
- Every server failure path logs one `event` and increments one pre-registered counter
  (research R13 catalogue).
- Order of operations in `api/src/services/orders.ts` is research R5's list, verbatim.
- The client's admission rule and deadline rules are research R4's, verbatim; stated identically
  in data-model.md and contracts/ui-states.md.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: repository skeleton, toolchain pins, one-command stack.

- [X] T001 Create root `package.json` (npm workspaces `api`, `client`, `e2e`; scripts `test`, `test:e2e`, `test:ops`, `typecheck`), `.nvmrc` (`24`), `.gitignore`, `.dockerignore` at repo root
- [X] T002 [P] Create `shared/constants.ts` (MAX_QTY_PER_LINE 10, MAX_UNITS_PER_ORDER 50, MAX_TOTAL_MINOR 100000, CURRENCY 'USD', REFERENCE_ALPHABET, timers NETWORK_WAIT_MS 8000, POLL_INTERVAL_MS 2000, POLL_MAX_MS 30000, CONFIRMATION_MS 15000, INACTIVITY_MS 90000, WARNING_MS 15000) and `shared/wire.ts` (types mirroring contracts/openapi.yaml: MenuItem, OrderLine, OrderSubmission, OrderStatus, ValidationRejection, IntentMismatch, ApiError, ClientEvent, UUID_PATTERN)
- [X] T003 [P] Create `api/package.json` (fastify 5.12.3, pg 8.23.0, pino 10.3.1; dev: typescript ~6.0.2, @types/node 24.13.3, @types/pg 8.23.1, vitest 4.1.11; scripts `dev`, `start`, `typecheck`, `test`) and `api/tsconfig.json` (module nodenext, erasableSyntaxOnly, verbatimModuleSyntax, allowImportingTsExtensions, noEmit, types ["node"], strict)
- [X] T004 [P] Create `client/package.json` (react 19.2.8, react-dom 19.2.8; dev: vite 8.2.2, @vitejs/plugin-react 6.1.1, typescript ~6.0.2, vitest 4.1.11, jsdom 30.0.1, @testing-library/react 16.3.3, @testing-library/jest-dom 7.0.1, @testing-library/user-event 14.6.7, @types/react 19.2.18, @types/react-dom 19.2.7), `client/tsconfig.json` (module esnext, moduleResolution bundler, jsx react-jsx, strict), `client/vite.config.ts` (plugin-react; `server.fs.allow` includes `../shared`; `test` block with jsdom and `test/setup.ts`), `client/index.html` (viewport meta, `<div id="root">`)
- [X] T005 [P] Create `e2e/package.json` (@playwright/test 1.63.0, pg 8.23.0, typescript ~6.0.2) and `e2e/playwright.config.ts` (projects `kiosk` and `ops`; kiosk: chromium, viewport 1024×768, hasTouch true, isMobile false, workers 1, fullyParallel false, baseURL http://localhost:8080, webServer `docker compose up --build` with url `/api/health`, reuseExistingServer true, gracefulShutdown SIGTERM 30 s; ops: no webServer, testDir `ops`)
- [X] T006 [P] Create `api/Dockerfile` (node:24.20.0-bookworm-slim; WORKDIR /app; copy root package.json + package-lock.json + api/package.json; `npm ci -w api --omit=dev`; copy `shared/` and `api/`; USER node; EXPOSE 3000; `CMD ["node","api/src/server.ts"]`) with build context = repo root
- [X] T007 [P] Create `client/Dockerfile` (stage 1 node:24.20.0-bookworm-slim: `npm ci -w client`, copy `shared/` + `client/`, `npm run build -w client`; stage 2 nginx:1.30.4-alpine: copy `client/dist` to `/usr/share/nginx/html`, copy `client/nginx.conf` to `/etc/nginx/conf.d/default.conf`) and `client/nginx.conf` (listen 80; root; `location / { try_files $uri /index.html; }`; `location /api/ { proxy_pass http://api:3000; proxy_http_version 1.1; }` with NO trailing slash on proxy_pass; index.html served without no-store)
- [X] T008 Create `compose.yaml` per research R12: services `db` (postgres:18.6, POSTGRES_USER checkout, POSTGRES_PASSWORD checkout, POSTGRES_DB webcheckout, volume `pgdata:/var/lib/postgresql`, healthcheck `pg_isready -h 127.0.0.1 -U $$POSTGRES_USER -d $$POSTGRES_DB` interval 2s retries 15, ports `127.0.0.1:${DB_PORT:-54329}:5432`), `api` (build context `.` dockerfile `api/Dockerfile`, env DATABASE_URL, PORT 3000, SIMULATOR_DEFAULT_OUTCOME success, SIMULATOR_CLIENT_HINT allow, SIMULATOR_LATENCY_MS 1500, LOG_LEVEL info; `depends_on: db: {condition: service_healthy, restart: true}`; healthcheck `node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"` interval 2s start_period 20s retries 15; init true; restart unless-stopped), `client` (build context `.` dockerfile `client/Dockerfile`, ports `${CLIENT_PORT:-8080}:80`, `depends_on: api: {condition: service_healthy, restart: true}`); named volume `pgdata`; no `version:` key
- [X] T009 Create `README.md`: the one command, prerequisites (Docker Desktop or Engine ≥ 25 with Compose + Buildx; Node 24 for tests only; `npx playwright install chromium`), ports and the two env overrides, where data lives (`/var/lib/postgresql` on the 18.x image), test commands, the simulator selector and env vars, counters reset on restart, the residual validation window (ADR-002)

**Checkpoint**: `npm ci` at root succeeds; `docker compose config` validates.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: everything every story needs: schema, runner, seed, pool, logging, counters, error
shape, app factory, boot, simulator, domain modules, the client machine core.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

### API foundation

- [X] T010 Create `api/migrations/0001_initial.sql` per data-model.md: `menu_items` (id uuid PK default gen_random_uuid(), slug text UNIQUE NOT NULL, name, price_minor integer CHECK > 0, currency text CHECK = 'USD' DEFAULT 'USD', available boolean DEFAULT true, sort_order integer, updated_at timestamptz DEFAULT now()); `orders` (id uuid PK, idempotency_key uuid NOT NULL CONSTRAINT orders_idempotency_key_key UNIQUE, fingerprint text NOT NULL, interaction_id uuid NOT NULL, reference text NOT NULL CONSTRAINT orders_reference_key UNIQUE CHECK (reference ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$'), state text CHECK IN ('pending_payment','paid','failed'), currency text CHECK = 'USD', total_minor integer CHECK (> 0 AND <= 100000), snapshot jsonb NOT NULL, created_at timestamptz DEFAULT now(), outcome_recorded_at timestamptz NULL); no BEGIN/COMMIT in the file
- [X] T011 [P] Create `api/src/config.ts`: read DATABASE_URL, PORT (3000), SIMULATOR_DEFAULT_OUTCOME (success|declined|inconclusive, default success), SIMULATOR_CLIENT_HINT (allow|ignore, default allow), SIMULATOR_LATENCY_MS (0), LOG_LEVEL (info); validate and fail fast with a clear message
- [X] T012 [P] Create `api/src/observability/logger.ts`: pino 10.3.1 with `pino.destination({ fd: 1, sync: true })`, base `{ service: 'checkout-api' }`, pid/hostname removed, numeric level, ISO time; export `createLogger(level)`
- [X] T013 [P] Create `api/src/observability/counters.ts`: `createCounters(names: readonly string[])` over a `Map<string, number>` pre-registered at 0, `inc(name)` (throws on unknown name), `snapshot()`; export `COUNTER_NAMES` with the full research R13 catalogue (orders.accepted, orders.replayed.paid|failed|pending_payment, orders.validation_rejected.<reason> for each reason in the contract, orders.intent_mismatch, payment.executed.success|declined|inconclusive, payment.outcome_recorded, payment.outcome_record_failed, payment.post_commit_exception, order_reference.collision, order_reference.exhausted, status_lookup.paid|failed|pending_payment|not_found, client_event.<each name>, client_event.rejected, server.unhandled_error)
- [X] T014 Create `api/src/db/pool.ts`: `createPool(databaseUrl)` with max 10, connectionTimeoutMillis 5000, idleTimeoutMillis 30000, `options: '-c statement_timeout=5000'`, `pool.on('error')` logging `db.pool_error`; export `waitForDatabase(pool, logger, maxMs = 60000)` retrying `SELECT 1` on ECONNREFUSED / 57P03 with 1 s backoff
- [X] T015 Create `api/src/db/migrate.ts` per research R11: list `api/migrations/*.sql` matching `^\d{4}_[a-z0-9_]+\.sql$` sorted bytewise; in one transaction: `SELECT pg_advisory_xact_lock(1)`, `CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`, fail fast if a recorded version is not on disk, apply each pending file with parameter-less `client.query(text)`, insert its version; return `{ applied: string[], latest: string }`; log `migration.failed` with file and SQLSTATE before rethrowing
- [X] T016 Create `api/seed/menu.ts` (a `MENU` array of ~8 items with fixed lowercase UUIDs, slugs, names, prices in cents, sort_order; exactly one `available: false`) and `api/src/db/seed.ts`: one `INSERT … ON CONFLICT (slug) DO UPDATE SET name, price_minor, currency, available, sort_order, updated_at = now() WHERE (menu_items.name, menu_items.price_minor, menu_items.currency, menu_items.available, menu_items.sort_order) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.price_minor, EXCLUDED.currency, EXCLUDED.available, EXCLUDED.sort_order) RETURNING (xmax = 0) AS inserted` using UNNEST arrays; return `{ inserted, updated }`
- [X] T017 [P] Create `api/src/domain/money.ts` (`lineTotal`, `orderTotal`, `withinBounds` using shared constants) and `api/src/domain/fingerprint.ts` (canonical JSON `{ currency, expectedTotalMinor, lines: [{ itemId, quantity }] }` with lines sorted by code-point `itemId`, SHA-256 hex via `node:crypto` `hash`)
- [X] T018 [P] Create `api/src/domain/reference.ts`: `generateReference()` using `crypto.randomInt(31)` over `REFERENCE_ALPHABET`; `MAX_REFERENCE_ATTEMPTS = 5`
- [X] T019 [P] Create `api/src/domain/validate.ts`: `validateSubmission(body, menuRows)` → `{ ok: true, snapshot, totalMinor } | { ok: false, reasons[], affectedItemIds[], currentItems[], currentTotalMinor? }` covering duplicate_item, unknown_item, item_unavailable, quantity_out_of_bounds, units_out_of_bounds (sum > 50), total_out_of_bounds, currency_unsupported, price_mismatch (recomputed total ≠ expectedTotalMinor); all reasons collected, not first-fail
- [X] T020 [P] Create `api/src/payment/simulator.ts` per research R9: `createSimulator({ defaultOutcome, latencyMs, acceptClientHint })` → `{ execute({ orderId, idempotencyKey, totalMinor, requestedOutcome }), calls(), callsFor(key), reset() }`; call record appended at entry with `{ orderId, idempotencyKey, totalMinor, requestedOutcome, effectiveOutcome, source: 'request'|'default', at }`; array capped at 1000; latency via `setTimeout` promise; returns `{ kind: 'success'|'declined'|'inconclusive' }`
- [X] T021 [P] Create `api/src/plugins/errors.ts`: `setErrorHandler` producing `{ error, requestId, interactionId? }` for 400 (validation → `bad_request`, body parse → `bad_request`), 404 `not_found`, 500 `internal` (logs `server.unhandled_error` with err and increments the counter; 4xx logs `request.rejected` without stack); `setNotFoundHandler`; `onSend` hook setting `cache-control: no-store` and `x-request-id`
- [X] T022 Create `api/src/app.ts`: `buildApp({ pool, simulator, hooks = {}, logger, counters, config })` → Fastify with `loggerInstance`, `genReqId: randomUUID`, `requestIdHeader: false`, `logController` disabling request logging for `/api/health` and `/api/metrics`, `ajv.customOptions { coerceTypes: false, removeAdditional: false, useDefaults: false }`, `childLoggerFactory` binding `interactionId` from a validated `x-interaction-id` header; decorate `pool`, `simulator`, `counters`, `hooks`, `startedAt`; register errors plugin then routes; `onClose → pool.end()`
- [X] T023 [P] Create `api/src/routes/health.ts` (`GET /api/health` → 200 `{ status, migrations, seed }` from app-decorated boot info when `SELECT 1` succeeds, else 503) and `api/src/routes/metrics.ts` (`GET /api/metrics` → `{ startedAt, uptimeSeconds, counters }`)
- [X] T024 [P] Create `api/src/routes/menu.ts`: `GET /api/menu` → `{ currency, items }` ordered by sort_order, mapping `price_minor` → `priceMinor`
- [X] T025 Create `api/src/server.ts`: load config → logger → pool → `waitForDatabase` → `migrate` (log `startup.migrations_applied`) → `seed` (log `startup.seed_applied { inserted, updated }`) → create simulator (log `startup.simulator_configured { defaultOutcome, acceptClientHint, latencyMs }`) → `buildApp` → `listen({ port, host: '0.0.0.0' })` → log `startup.listening`; on any failure log `startup.failed` and `process.exit(1)`; SIGTERM/SIGINT → `app.close()` then exit 0
- [X] T026 Create `api/test/helpers/db.ts` (connect to `DATABASE_URL_TEST` defaulting to `postgres://checkout:checkout@127.0.0.1:54329/webcheckout_test`; `ensureTestDatabase()` creating it via the maintenance DB if missing; `migrateAndSeed(pool)`; `truncateOrders(pool)` and `resetMenu(pool)` both guarded by `current_database() LIKE '%\_test'`) and `api/test/helpers/app.ts` (`makeTestApp({ simulatorOptions, hooks })` returning `{ app, simulator, counters, pool }`; `submit(app, body, headers)` helper POSTing with a fresh interaction id; `menuItems(pool)`)
- [X] T027 Create `api/vitest.config.ts` (projects `api-unit` include `test/unit/**`, `api-integration` include `test/integration/**` with `globalSetup: test/global-setup.ts`, `fileParallelism: false`, `testTimeout: 20000`) and `api/test/global-setup.ts` (`docker compose up -d --wait db` from repo root, `ensureTestDatabase`, `migrateAndSeed`)
- [X] T028 [P] Unit tests in `api/test/unit/`: `money.test.ts` (bounds exactly at 10/50/100000 pass, one beyond fails), `fingerprint.test.ts` (line order irrelevant; `simulation` and interaction id irrelevant; any quantity change changes it), `reference.test.ts` (alphabet excludes 0 O 1 I L; length 4; distribution sanity), `validate.test.ts` (each reason; multiple reasons collected; equal-and-opposite price moves keep the total and pass), `simulator.test.ts` (record appended at entry even when latency; `acceptClientHint: 'ignore'` uses default; `callsFor`), `counters.test.ts` (unknown name throws; pre-registered zeros)

### Client foundation

- [X] T029 [P] Create `client/src/machine/types.ts` per data-model.md: `Interaction` (id, startedAt, lastActivityAt, phase, resolvedAt, deadlineAt, submission), `Submission` (idempotencyKey, lines[], expectedTotalMinor, sentAt, pollStartedAt, knownState, reference, simulation), `Cart` (lines, flagged), `Menu`, and the event union: START, MENU_LOADED, MENU_FAILED, ADD_ITEM, SET_QTY, REMOVE_ITEM, GO_REVIEW, GO_PAYMENT, BACK_TO_CART, SET_SIMULATION, PAY, POST_RESULT, POLL_RESULT, POLL_START, TICK, CONTINUE, START_NEW_ORDER, RESUME, plus a `now` on every event
- [X] T030 [P] Create `client/src/machine/uuid.ts`: `newUuid()` = `crypto.randomUUID()` when present, else v4 from `crypto.getRandomValues` with version/variant bits, lowercase
- [X] T031 [P] Create `client/src/machine/deadlines.ts` per research R4 / data-model: `waitEndedAt(sub)`, `inactivityDeadline(state)` implementing the phase table (building/declined: `lastActivityAt + 90 s`; unresolved: `max(lastActivityAt, waitEndedAt) + 90 s`; declined-from-unresolved: `deadlineAt`; confirmed: `resolvedAt + 15 s`; submitted: none), `warningAt(state)` (deadline − 15 s), `isExpired(state, now)`
- [X] T032 [P] Create `client/src/machine/storage.ts`: `save(interaction)`, `load()`, `clear()` over `sessionStorage` key `webcheckout.interaction`, every access in try/catch; `load()` validates shape and returns null on any doubt
- [X] T033 Create `client/src/machine/reducer.ts`: pure `reduce(state, event)` over phases idle/building/submitted/confirmed/declined/unresolved; activity whitelist (ADD_ITEM, SET_QTY, REMOVE_ITEM, GO_REVIEW, GO_PAYMENT, BACK_TO_CART, SET_SIMULATION, PAY, CONTINUE) stamps `lastActivityAt` and clears `deadlineAt`; cart rules (qty 1..10, sum ≤ 50, total ≤ 100000, unavailable cannot be added, qty 0 removes); GO_PAYMENT generates a key and persists the frozen lines + expectedTotalMinor; BACK_TO_CART before send discards the key; PAY sets `sentAt`; the five-condition admission rule for POST_RESULT/POLL_RESULT keyed on `interactionId` and `idempotencyKey` from the event; `unresolved → declined` carries `deadlineAt = inactivityDeadline(prev)`; terminal results not reapplied; RESUME/TICK expiry → idle with storage cleared; START_NEW_ORDER → idle
- [X] T034 Create `client/src/machine/runtime.ts`: module-level store (`getState`, `subscribe`, `dispatch`) with write-through to storage on every transition; 250 ms ticker dispatching TICK; `revalidate()` on boot, `pageshow` (both persisted values) and `visibilitychange → visible`, run synchronously before any queued response is admitted; POST race: `fetch` never aborted, closure captures `{ interactionId, idempotencyKey }` and dispatches POST_RESULT with the classified result; polling loop by key every 2 s from `pollStartedAt` until `waitEndedAt` with per-poll `AbortSignal.timeout(2000)` and a polls-only `AbortController` cancelled on terminal/interaction end; confirmation auto-idle at `resolvedAt + 15 s`
- [X] T035 [P] Create `client/src/api/client.ts`: `fetchMenu()`, `postOrder(submission, interactionId)`, `lookupByKey(key, interactionId)` with `X-Interaction-Id`; `classify(response|error)` implementing the four-category canonical rule from contracts/openapi.yaml (known outcome / intent conflict / rejected / unknown), never by status family alone
- [X] T036 [P] Create `client/src/api/telemetry.ts`: `emit(name, detail?)` → `navigator.sendBeacon('/api/events', JSON.stringify(...))` string body; fallback `fetch` keepalive with `content-type: text/plain;charset=UTF-8`; never awaited, try/catch, no queue
- [X] T037 [P] Create `client/src/money/format.ts` (module-level `Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`, `formatMinor(minor)`) and `client/src/styles.css` (touch targets ≥ 64 px, `touch-action: manipulation`, `user-select: none` on controls, `html { overscroll-behavior: none }`, 1024×768 layout, high contrast, large type)
- [X] T038 Create `client/src/main.tsx` (StrictMode, mount, `runtime.boot()`) and `client/src/App.tsx` (`useSyncExternalStore` over the runtime; switch on phase/screen to render the screen components; render `InactivityWarning` overlay when `now ≥ warningAt` and the timer runs)
- [X] T039 Create `client/test/setup.ts` (jest-dom) and `client/test/helpers.ts` (state builders, fake `fetch`, `advance(ms)` with `vi.useFakeTimers`)
- [X] T040 Create `api/src/routes/events.ts`: inside its own plugin scope `addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 4096 }, getDefaultJsonParser('ignore','ignore'))`; `POST /api/events` with the `ClientEvent` schema (closed, enum names, UUID patterns, bounded detail) → log `client.event_received`, `counters.inc('client_event.<name>')`, 204; schema failure → 400 counted as `client_event.rejected`

**Checkpoint**: `npm run typecheck` passes for api and client; `docker compose up --build` reaches
three healthy services, `/api/health` returns `seed: applied`, `/api/menu` lists the seed; unit
tests pass.

---

## Phase 3: User Story 1 - Order and pay at the kiosk (Priority: P1) 🎯 MVP

**Goal**: idle → menu → cart → review → simulated payment → confirmation with reference → idle,
with the server as price authority and the accept path idempotent by construction.

**Independent Test**: from idle, add two available items, adjust a quantity, review, confirm with
Approve, see a 4-character reference, wait 15 s, see idle. `payment.executed.success` +1.

### Tests for User Story 1

- [X] T041 [P] [US1] Integration test `api/test/integration/submit-happy.test.ts`: POST accepted → 201 `paid`, `replay: false`, reference matches the alphabet, `interactionId` echoed; row `paid` with `outcome_recorded_at` set; snapshot holds names, unit prices, line totals; `orders.accepted` and `payment.executed.success` +1; `GET /api/menu` shape; `GET /api/health` shape
- [X] T042 [P] [US1] Integration test `api/test/integration/validation.test.ts` (US1 bounds part): quantity 11 → 422 `quantity_out_of_bounds`; 51 units → `units_out_of_bounds`; total 100001 → `total_out_of_bounds`; empty lines → 400 (schema); unavailable item → `item_unavailable` with `currentItems`; `"1250"` as string → 400; exactly 10 / 50 / 100000 accepted; no row on any rejection and the key remains usable
- [X] T043 [P] [US1] Reducer tests `client/test/reducer.test.ts` (US1 part): add/adjust/remove, qty 0 removes, unavailable not added, 11th refused, 51st unit refused, total cap; GO_REVIEW blocked on empty cart; GO_PAYMENT generates a key and freezes lines; expectedTotalMinor equals the review total from the same cart
- [X] T044 [P] [US1] Interface test `e2e/tests/us1-order-and-pay.spec.ts`: the full flow at 1024×768 with `locator.tap()`; reference visible and matches `^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$`; `page.clock` `runFor(15000)` → idle; metrics delta `payment.executed.success` = 1

### Implementation for User Story 1

- [X] T045 [US1] Create `api/src/services/orders.ts`: `submit({ body, interactionId, requestedOutcome })` implementing research R5 steps 1–8 exactly (fingerprint → SELECT by key → validate → on failure SELECT once more → `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING` with reference retry on `err.constraint === 'orders_reference_key'` up to 5 then `reference_exhausted` → owner path: `hooks.afterCommit?.()`, `simulator.execute`, `hooks.afterPayment?.()`, conditional UPDATE, 0-row → `payment.outcome_record_failed` + throw) and `lookupByKey(key)`; response mapping 201/202/200/409/422/503 with `replay`; every branch logs its event and increments its counter
- [X] T046 [US1] Create `api/src/routes/orders.ts`: `POST /api/orders` with the `OrderSubmission` JSON schema (additionalProperties false, UUID patterns, bounds, `simulation.outcome` enum, `X-Interaction-Id` header required) calling `submit`; `GET /api/orders/by-key/:idempotencyKey` (pattern-validated param, header required) → `OrderStatus` or 404 `not_found`; register both in `app.ts`
- [X] T047 [P] [US1] Create `client/src/screens/Idle.tsx` (S0: invitation, Start) and `client/src/screens/Menu.tsx` (S1: items with price/availability, add disabled when unavailable, cart with +/−/remove, running total, flagged lines, Review disabled on empty or flagged, Start new order)
- [X] T048 [P] [US1] Create `client/src/screens/Review.tsx` (S2: full order and total, Confirm and pay, Back, Start new order) and `client/src/screens/Payment.tsx` (S3: "Simulated payment" heading and copy, total, Approve/Decline/No answer selector defaulting to Approve, primary Pay, Back before send, Start new order)
- [X] T049 [P] [US1] Create `client/src/screens/Waiting.tsx` (S4: in-progress state, Pay not tappable, Start new order only) and `client/src/screens/Confirmed.tsx` (S5: success, reference large, total, "quote this at the counter", Done)
- [X] T050 [US1] Wire START → `fetchMenu` → MENU_LOADED in `client/src/machine/runtime.ts`; PAY → `postOrder` with the frozen submission and `simulation`; classified `paid` → confirmed with `resolvedAt`; `resolvedAt + 15 s` → idle and storage cleared

**Checkpoint**: User Story 1 works in the compose stack and its four test files pass.

---

## Phase 4: User Story 2 - Submitting more than once creates one order (Priority: P1)

**Goal**: double tap, refresh during submission, back or Start new order during an unknown
outcome, and two genuine orders with the same items: at most one order per intent, exactly one
where acceptance occurred, the simulator called at most once per intent.

**Independent Test**: N concurrent same-key POSTs → one row, one simulator call; reload during
submission → same key, same status; a separate order with identical items → both accepted.

### Tests for User Story 2

- [X] T051 [P] [US2] Integration test `api/test/integration/concurrency.test.ts`: `beforeInsert` barrier holding 8 injected POSTs (pool max 10) released together → exactly one row, `callsFor(key).length === 1`, every response carries the same `orderId`, statuses one 201 and seven 200/202, states in {paid, pending_payment}; `beforeInsert` placed before pool acquisition
- [X] T052 [P] [US2] Integration test `api/test/integration/replay.test.ts`: replay same key+content → 200 `replay: true` with recorded state, count unchanged; replay with `simulation: declined` on a paid order → still paid; replay after the menu price changed → recorded values, not re-validated; replay after item made unavailable → still served; same key different quantity → 409, row unchanged; different key identical items → new order; replay with lines reordered → 200 (fingerprint stable)
- [X] T053 [P] [US2] Reducer/runtime tests `client/test/runtime.test.ts` (US2 part): PAY sends once; a second PAY while submitted is a no-op; RESUME in `submitted` re-reads the key and starts polling without re-POSTing; BACK_TO_CART while submitted/unresolved is refused; START_NEW_ORDER while submitted ends the interaction without a new POST; GO_PAYMENT after a decline generates a new key
- [X] T054 [P] [US2] Interface test `e2e/tests/us2-repeat-submission.spec.ts`: double tap via `page.touchscreen.tap` twice → one confirmation, POST count 1, metrics delta 1; reload mid-wait (No answer) → same waiting screen, later S7a with the same reference, metrics delta 1; Start new order during unknown → idle, no second POST; two separate identical orders → two references

### Implementation for User Story 2

- [X] T055 [US2] In `client/src/machine/reducer.ts` and `runtime.ts`: freeze the key at PAY; persist `sentAt`; refuse BACK_TO_CART in submitted/unresolved; START_NEW_ORDER from any phase clears storage and never re-sends; RESUME in `submitted` restores the frozen submission and resumes the wait from persisted timestamps
- [X] T056 [US2] In `api/src/services/orders.ts`: confirm the `beforeInsert` hook call site precedes `pool` acquisition; add `payment.executed` log with `source`; ensure the losing path never reads `simulation`

**Checkpoint**: US1 and US2 pass together; the concurrency test is deterministic across 10 runs.

---

## Phase 5: User Story 3 - Never charged an amount that was not shown (Priority: P1)

**Goal**: a total mismatch is rejected before payment with current prices and total shown; no
order; re-confirm at the new total is accepted. The guarantee is over the total (ADR-003).

**Independent Test**: change a price so the total differs, confirm → 422 `price_mismatch` with
`currentTotalMinor`, zero rows; re-confirm → accepted at the new total. Equal-and-opposite moves →
accepted.

### Tests for User Story 3

- [X] T057 [P] [US3] Integration test `api/test/integration/validation.test.ts` (US3 part): price changed → 422 `price_mismatch` with `currentTotalMinor` and `currentItems`; no row; key reusable; two prices moved by equal and opposite amounts → 201 accepted; counters `orders.validation_rejected.price_mismatch`
- [X] T058 [P] [US3] Reducer test `client/test/reducer.test.ts` (US3 part): a rejected submission with `currentItems` re-prices the cart, clears the key, and the next GO_PAYMENT produces a new key and a new expectedTotalMinor equal to the re-priced review total
- [X] T059 [P] [US3] Interface test `e2e/tests/us3-price-changed.spec.ts`: pg fixture raises a price after the cart is built → S8 shows current price and new total → Review again → confirm → accepted at the new total; metrics: `price_mismatch` +1, `orders.accepted` +1; fixture restored in teardown

### Implementation for User Story 3

- [X] T060 [US3] Create `client/src/screens/Rejected.tsx` (S8: reason copy per `reasons[]`, current prices and total for price_mismatch, flagged lines for item_unavailable, plain reason for bounds/unknown; Review again; Start new order) and wire the `rejected` classification → S8 in `reducer.ts`; on Review again re-fetch the menu, re-price the cart, discard the key, emit `rejection_shown`
- [X] T061 [US3] Create `e2e/fixtures/db.ts`: `withMenuChange({ slug, priceMinor?, available? })` via `pg` on `127.0.0.1:${DB_PORT:-54329}`, restoring the original row in teardown

**Checkpoint**: US1–US3 pass.

---

## Phase 6: User Story 4 - Outcome unknown: honest about what is known (Priority: P1)

**Goal**: inconclusive, lost response, 500, failed lookup, and never-arrived submissions all end
on an honest unresolved screen (S7a/S7b) with no way to pay again; a late definitive result is
applied; exceptions after commit leave `pending_payment`.

**Independent Test**: No answer → 202 → polling 30 s → S7a with reference; `route.abort()` on the
POST → polling to 404 → S7b without reference; late `paid` on S7 → S5.

### Tests for User Story 4

- [X] T062 [P] [US4] Integration test `api/test/integration/post-commit-windows.test.ts`: `afterCommit` throws → 500, row `pending_payment` from a separate connection, 0 simulator calls, `payment.post_commit_exception` +1, replay → 202 count unchanged; `afterPayment` throws → 500, row pending, 1 call, replay 202 count unchanged; inconclusive → 202 `pending_payment`, row pending, 1 call; outcome UPDATE on a row forced to `paid` beforehand → 0 rows → 500 and `payment.outcome_record_failed` +1
- [X] T063 [P] [US4] Integration test `api/test/integration/lookup.test.ts`: by-key 200 for each state with `interactionId` echoed from the request header; unknown key → 404 `not_found` and `status_lookup.not_found` +1; malformed key → 400
- [X] T064 [P] [US4] Runtime tests `client/test/runtime.test.ts` (US4 part) with fake timers and injected fetch: no response → POLL_START at 8 s → polls every 2 s → unresolved at 38 s; network rejection at 1 s → polling starts at 1 s and ends at 31 s; `202` at 0.5 s → polling from 0.5 s to 30.5 s; `404` polls keep `knownState: none`; a `pending` poll sets `knownState: pending` and reference; late `paid` from the still-open POST after unresolved → confirmed; a generic 500 → unknown, never declined; polling stops on terminal
- [X] T065 [P] [US4] Deadline tests `client/test/deadlines.test.ts`: unresolved deadline `max(lastActivityAt, waitEndedAt) + 90 s`; the review's counterexample (sentAt 0, lastActivityAt 0, late decline at 100 s) keeps the interaction valid until 128 s; a repeated `paid` does not move `resolvedAt`
- [X] T066 [P] [US4] Interface test `e2e/tests/us4-unknown-outcome.spec.ts`: No answer → S7a with reference, no pay-again control, inactivity resumes and idle follows; `route.abort()` → S7b without reference; `route.fetch()` then `abort('connectionreset')` → polling finds the order → S7a; `route.fetch()` then `fulfill 500` → unknown → S7a; `route.fetch()` then delayed fulfill after 40 s of clock → S7 → S5; `unresolved_shown` event observed via `client_event.unresolved_shown` delta

### Implementation for User Story 4

- [X] T067 [US4] Create `client/src/screens/Unresolved.tsx` (S7a and S7b wordings from contracts/ui-states.md; the NFR-004 exception stated; Start new order only) and wire polling, `knownState`, S7a/S7b selection, `unresolved_shown`/`late_result_applied` emission and FR-034 transitions in `reducer.ts`/`runtime.ts`
- [X] T068 [US4] In `api/src/services/orders.ts`: wrap the post-commit window so any exception logs `payment.post_commit_exception`, leaves the row untouched, and rethrows to a 500; never map an exception to `failed`

**Checkpoint**: US1–US4 pass. P1 core is complete except US5.

---

## Phase 7: User Story 5 - Shared device: nothing survives a reset or expiry (Priority: P1)

**Goal**: inactivity warning at 75 s, reset at 90 s; nothing from a previous interaction is shown
after reset, expiry, reload or back/forward; abandoned carts create nothing; submitted orders
continue server-side.

**Independent Test**: build a cart, wait 75 s → warning, 90 s → idle; reload and go back → idle;
zero orders for the abandoned cart.

### Tests for User Story 5

- [X] T069 [P] [US5] Reducer/deadline tests `client/test/reducer.test.ts` and `client/test/storage.test.ts` (US5 part): only whitelisted events stamp activity (TICK, POLL_RESULT, MENU_LOADED do not); CONTINUE counts; expiry → idle and `clear()`; a record older than its deadline is rejected on `load()`; a restored `submitted` record continues from persisted `sentAt`; entering unresolved stamps nothing
- [X] T070 [P] [US5] Interface test `e2e/tests/us5-abandonment.spec.ts`: `page.clock` to 75 s → warning visible; Continue → warning gone and timer restarted; to 90 s → idle; reload → idle; `goto('about:blank')` then `goBack()` → idle (both restore paths asserted via `pageshow`); abandoned cart → `orders.accepted` delta 0; No answer then Start new order → order still `pending_payment` by key

### Implementation for User Story 5

- [X] T071 [US5] Create `client/src/screens/InactivityWarning.tsx` (overlay: reset imminent, Continue, Start new order) and wire the 250 ms ticker's warning/expiry evaluation in `runtime.ts` and `App.tsx`; suspend while `submitted`; resume on unresolved with the R4 formula; emit `interaction_expired`
- [X] T072 [US5] In `client/src/machine/runtime.ts`: register `pageshow` and `visibilitychange` listeners calling `revalidate()` synchronously; never register `unload`; `pagehide` only flushes nothing (no queue)

**Checkpoint**: all five P1 stories pass in unit, integration and interface tests. **P1 complete.**

---

## Phase 8: User Story 6 - Payment declined (Priority: P2)

**Goal**: a definitive decline is shown clearly with the items intact; confirming again is a new
order; the declined order stays failed.

**Independent Test**: Decline → S6 with items; Try again with Approve → a second, distinct order;
the first remains `failed`.

### Tests for User Story 6

- [X] T073 [P] [US6] Integration test `api/test/integration/submit-declined.test.ts`: declined → 201 `failed`, row `failed`, `payment.executed.declined` +1; replay → 200 `failed`; a new key with the same lines → new order
- [X] T074 [P] [US6] Reducer tests `client/test/reducer.test.ts` (US6 part): `failed` → declined with cart intact; GO_PAYMENT from declined → new key; after a reload in submitted, `failed` renders the persisted lines
- [X] T075 [P] [US6] Interface test `e2e/tests/us6-declined.spec.ts`: Decline → S6 lists the items → Try again with Approve → S5 with a different reference; metrics: declined +1, success +1

### Implementation for User Story 6

- [X] T076 [US6] Create `client/src/screens/Declined.tsx` (S6: plain decline copy, items from the frozen submission, Try again → S2 with a new key, Edit order → S1, Start new order) and wire `failed` → declined in `reducer.ts`

---

## Phase 9: User Story 7 - An item becomes unavailable mid-order (Priority: P2)

**Goal**: at validation, an unavailable item rejects the submission before payment; the line is
flagged, the rest preserved; payment is blocked until the customer acts and re-confirms.

**Independent Test**: fixture flips availability → S8 → the line is flagged in S1 → remove →
re-confirm → accepted with the remaining items.

### Tests for User Story 7

- [X] T077 [P] [US7] Integration test `api/test/integration/validation.test.ts` (US7 part): unavailable → 422 `item_unavailable` with `affectedItemIds` and `currentItems`; combined with price_mismatch both reasons returned; accepted order replayed after the item became unavailable → served
- [X] T078 [P] [US7] Reducer tests `client/test/reducer.test.ts` (US7 part): `item_unavailable` flags the line; GO_REVIEW blocked while flagged; REMOVE_ITEM clears the flag; removing the last flagged line leaves an empty cart and GO_REVIEW stays blocked
- [X] T079 [P] [US7] Interface test `e2e/tests/us7-unavailable.spec.ts`: fixture sets `available = false` after the cart is built → Pay → S8 → S1 with the line flagged and Review disabled → remove → review → pay → accepted with the remaining total

### Implementation for User Story 7

- [X] T080 [US7] In `client/src/screens/Menu.tsx` and `reducer.ts`: flagged-line rendering and the Review guard; S8 "Review again" for `item_unavailable` returns to S1

---

## Phase 10: User Story 8 - The system is unreachable or errors (Priority: P2)

**Goal**: before any submission, an unreachable service shows plain language and a way back.

**Independent Test**: stop the API, tap Start → S9 with Try again; start the API, Try again → menu.

### Tests for User Story 8

- [X] T081 [P] [US8] Runtime test `client/test/runtime.test.ts` (US8 part): MENU_FAILED → error screen; Try again re-fetches; a failure after PAY never reaches the error screen (classified unknown)
- [X] T082 [P] [US8] Interface test `e2e/tests/us8-unreachable.spec.ts`: `route.abort()` on `/api/menu` → S9 → un-route → Try again → S1; reload during the routed outage still renders the app (nginx serves it) and shows S9; `service_unreachable` event delta once the API is reachable

### Implementation for User Story 8

- [X] T083 [US8] Create `client/src/screens/Error.tsx` (S9: plain copy, "nothing has been charged" only for pre-submission failures, Try again, Start new order) and wire MENU_FAILED, POST 400 and 503 `reference_exhausted` → S9 in `reducer.ts`; emit `service_unreachable` on the recovery action

---

## Phase 11: User Story 9 - Late responses never leak or regress (Priority: P3, not optional)

**Goal**: a response for a concluded interaction never appears later; a stale response never
regresses a final result; a late result for a previous intent never touches the live one.

**Independent Test**: delay a response until after a reset → new interaction untouched; deliver a
stale `pending` after `paid` → still `paid`; late K1 `paid` after a K2 decline → K2's screen stays.

### Tests for User Story 9

- [X] T084 [P] [US9] Reducer tests `client/test/admission.test.ts`: each of the five admission conditions rejects independently (expired interaction; foreign interactionId; foreign idempotencyKey after a decline created K2; illegal transition from confirmed/declined; repeated terminal does not reset `resolvedAt`); S7b → S7a on first pending; discarded responses emit the right event name
- [X] T085 [P] [US9] Interface test `e2e/tests/us9-late-responses.spec.ts`: gated `route.fulfill` released after Start new order → new interaction unchanged and `foreign_response_discarded` +1; stale `pending_payment` fulfilled after S5 → S5 unchanged and `stale_response_discarded` +1; K1 `paid` released after a K2 decline → S6 unchanged

### Implementation for User Story 9

- [X] T086 [US9] Verify `client/src/machine/reducer.ts` admission rule against `client/test/admission.test.ts`; add `stale_response_discarded` / `foreign_response_discarded` emission in `runtime.ts`

---

## Phase 12: Polish & Cross-Cutting Concerns

- [X] T087 [P] Ops acceptance `e2e/ops/acceptance.spec.ts`: project `webcheckout-accept` with `CLIENT_PORT=8081 DB_PORT=54330`; `down -v` → `up --build --wait` → health `seed: applied` → POST an order → `down` (no -v) → `up --wait` → health `seed: already-present` → order by key still returned → `menu_items` count unchanged; `down -v --remove-orphans` in afterAll
- [X] T088 [P] Integration test `api/test/integration/reference.test.ts`: forced collision via a pre-inserted reference and a stubbed generator → retry produces a distinct reference and `order_reference.collision` +1; five forced collisions → 503 `reference_exhausted`, no row, key reusable
- [X] T089 [P] Integration test `api/test/integration/health-and-events.test.ts`: `/api/health` 503 when the pool is unreachable; `/api/events` 204 for a valid `text/plain` JSON body, 400 for an unknown name counted as `client_event.rejected`; `/api/metrics` shape with every catalogue key present at 0 on a fresh app
- [X] T090 Startup log ordering: assert in `api/test/integration/startup.test.ts` that `server.ts`'s boot function (extracted as `boot()` callable without `listen`) logs migrations → seed → simulator before returning, and that a second run logs `seed_applied inserted: 0 updated: 0`
- [X] T091 Run `quickstart.md` end to end against the compose stack; fix anything it exposes; record deviations in `PROCESS.md`
- [X] T092 Fill `PROCESS.md` sections with what actually happened during implementation: overrides, what the AI got wrong, what changed after implementation started, what was thrown away
- [X] T093 Final `npm run typecheck && npm test && npm run test:e2e && npm run test:ops` green; README commands verified on a clean clone (`git clone` into a temp dir, `docker compose up --build`)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** → **Foundational (Phase 2)** → user stories in priority order → **Polish**.
- Foundational blocks every story: schema, app factory, simulator, domain modules, the client
  machine core.

### User Story Dependencies

- **US1** depends on Foundational only. It delivers the orders service with the full idempotent
  accept path (research R5), because the constitution requires idempotency by construction.
- **US2** adds the repetition tests and the client-side freezing/recovery rules on top of US1.
- **US3** adds the rejection screen (S8) and price-mismatch tests; needs US1's service.
- **US4** adds polling, the unresolved screen, post-commit-window tests and FR-034; needs US1.
- **US5** adds inactivity, warning, reset/expiry, bfcache revalidation; needs the machine core.
- **US6**, **US7**, **US8** each add one screen and tests on top of US1/US3.
- **US9** tests the admission rule that Foundational + US4 implement; needs US4 and US6 (K2 case).

### Within Each Story

Tests first (they fail), then implementation until they pass; server before client where both
change; story complete and its checkpoint green before the next priority.

### Parallel Opportunities

- Phase 1: T002–T007 in parallel after T001.
- Phase 2: T011–T013, T017–T021, T023–T024 in parallel; T029–T032, T035–T037 in parallel.
- Every story's test tasks are parallel with each other; screens within a story are parallel.

---

## Parallel Example: User Story 1

```bash
Task: "Integration test api/test/integration/submit-happy.test.ts"
Task: "Integration test api/test/integration/validation.test.ts (US1 part)"
Task: "Reducer tests client/test/reducer.test.ts (US1 part)"
Task: "Interface test e2e/tests/us1-order-and-pay.spec.ts"
# then, in parallel:
Task: "Screens Idle.tsx + Menu.tsx"
Task: "Screens Review.tsx + Payment.tsx"
Task: "Screens Waiting.tsx + Confirmed.tsx"
```

---

## Implementation Strategy

### P1 first, complete and working (owner instruction)

1. Phase 1 and Phase 2.
2. US1 → checkpoint green → US2 → US3 → US4 → US5. All five are P1; P1 is complete only when all
   five checkpoints are green in unit, integration and interface tests and the compose stack
   demonstrates them live.
3. Then US6, US7, US8, then US9 (P3 orders it last; it is not optional).
4. Polish: ops acceptance, quickstart run, PROCESS.md, clean-clone check.

### Notes

- Commit after each phase checkpoint.
- Anything discovered from here on is discovered in implementation and recorded in `PROCESS.md`.
