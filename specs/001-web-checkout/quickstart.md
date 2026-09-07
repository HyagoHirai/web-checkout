# Quickstart: Web Checkout

**Feature**: `specs/001-web-checkout/spec.md` | **Date**: 2026-09-07
Validation guide: how to bring the stack up and prove the feature works end to end. Contracts are
in `contracts/`; the data model in `data-model.md`; decisions in `research.md`.

## Prerequisites

Named plainly, per constitution X:

- **Docker Desktop**, or Docker Engine ≥ 25 with the Compose and Buildx plugins. This is the only
  prerequisite for running the app.
- For the test suites only: **Node.js 24** (`.nvmrc`), `npm ci` at the repo root, and
  `npx playwright install chromium` for the interface tests.
- Free ports: `8080` for the client (`CLIENT_PORT` to change), `127.0.0.1:54329` for the database
  (`DB_PORT` to change; a non-default host port so a local Postgres does not collide).

## One command

```bash
docker compose up --build
```

Then open <http://localhost:8080> in Chrome at 1024×768 (the OV-7 target; DevTools device toolbar
with a custom 1024×768 touch device reproduces the kiosk). Scripted form for CI and the acceptance
tests:

```bash
docker compose up --build -d --wait --wait-timeout 180
```

Expected on a clean machine: three services healthy (`db`, `api`, `client`); `docker compose logs
api` shows, in this order, `startup.migrations_applied`, `startup.seed_applied` with `inserted: N`,
`startup.simulator_configured`, `startup.listening`. Readiness:

```bash
curl -s localhost:8080/api/health
# {"status":"ok","migrations":"0001_initial","seed":"applied"}
```

## Walk the primary flow (User Story 1)

1. Idle screen → **Start**. The menu shows items with prices and at least one marked unavailable.
2. Add items, change quantities, set one to zero (it disappears), try an unavailable item (it cannot
   be added), try an eleventh of one item (refused with a reason).
3. **Review**: the complete order and its total.
4. **Confirm and pay** → simulated payment screen: says it is simulated, one **Pay** control, the
   terminal-answer selector on Approve.
5. **Pay** → waiting state appears immediately → confirmation with a 4-character reference.
6. Wait 15 s: the kiosk returns to idle by itself.

```bash
curl -s localhost:8080/api/metrics | jq .counters
# orders.accepted 1, payment.executed.success 1, payment.outcome_recorded 1
```

## Walk the failure paths

| Scenario | How to produce it live | Expected screen |
|---|---|---|
| Declined (US6) | Selector → Decline → Pay | "Payment declined", items still listed, **Try again** |
| Unknown outcome, order exists (US4 S7a) | Selector → No answer → Pay | The `202` arrives at once, polling runs 30 s, then "order received, payment not confirmed, reference XXXX, don't pay again" |
| Unknown outcome, nothing confirmed (US4 S7b) | `docker compose stop api` between Review and Pay, then Pay | Waiting 38 s, then "couldn't confirm whether your order went through, check at the counter"; no reference |
| Service unreachable before submission (US8) | `docker compose stop api`, tap Start or reload | "Something went wrong", **Try again** returns to a working kiosk after `docker compose start api` |
| Price changed so the total differs (US3) | With a cart open: `docker compose exec -T db psql -U checkout -d webcheckout -c "UPDATE menu_items SET price_minor = price_minor + 50 WHERE slug = 'coffee'"` then Pay | Rejected before payment, current prices and total shown, re-confirm accepted at the new total; `orders.validation_rejected.price_mismatch` +1, zero new orders |
| Item unavailable mid-order (US7) | `UPDATE menu_items SET available = false WHERE slug = 'coffee'` then Pay | Rejected before payment, the line flagged, rest preserved; payment blocked until the line is removed and re-confirmed |
| Double tap (US2) | Tap Pay twice fast | One confirmation; `payment.executed.*` +1, one order row |
| Refresh during submission (US2) | Pay with No answer, reload during the wait | Same waiting screen, same key; ends in S7a with the same reference |
| Abandonment (US5) | Stop touching for 75 s | Warning with **Continue**; at 90 s the screen clears; reload and back show nothing from before |
| Late result (FR-034) | Only reproducible in the interface tests (delayed `route.fulfill` after 38 s) | S7 updates to confirmation or decline |

Restore the menu after fixtures: `docker compose restart api` re-applies the seed and converges
prices and availability back to canonical (`startup.seed_applied inserted: 0 updated: 2`).

## Operational acceptance (ADR-004, constitution X)

```bash
docker compose down -v                              # empty environment
docker compose up --build -d --wait                 # scenario 1: from nothing to working
curl -s localhost:8080/api/health | jq .seed        # "applied"
# place an order in the browser, note the reference, then:
docker compose down                                 # no -v: containers gone, volume kept
docker compose up -d --wait                         # scenario 2: restart
curl -s localhost:8080/api/health | jq .seed        # "already-present"
docker compose exec -T db psql -U checkout -d webcheckout -c "SELECT reference, state FROM orders"
docker compose exec -T db psql -U checkout -d webcheckout -c "SELECT count(*) FROM menu_items"
```

The order is still there; the menu count is unchanged. Both scenarios are also automated in
`e2e/ops` under their own compose project name so they never touch the developer's stack.

## Automated verification

```bash
npm ci
npm test            # tsc --noEmit (api + client), Vitest: api-unit, api-integration (real Postgres), client-unit
npm run test:e2e    # Playwright: interface tests at 1024×768 with touch, against the compose stack
npm run test:ops    # Playwright ops project: the two ADR-004 scenarios
```

`api-integration` starts only the `db` service (`docker compose up -d --wait db`), creates
`webcheckout_test` if missing, migrates it, and truncates `orders` per test. What it proves and
where:

| Guarantee | Test | Evidence |
|---|---|---|
| At most one order per intent, exactly one where acceptance occurred, one payment, under N concurrent same-key POSTs (SC-002) | `api/test/integration/concurrency.test.ts` | one row; simulator `callsFor(key).length === 1`; all responses share `orderId` |
| Replay never re-validates or re-executes (FR-018, constitution II) | `replay.test.ts` | change price, replay → recorded state; count unchanged; replay with `simulation: declined` on a paid order → still `paid` |
| Key reuse with different content is rejected, existing order untouched (ADR-002) | `replay.test.ts` | 409; row unchanged |
| Record before action; an exception in either post-commit window leaves `pending_payment`, never `failed` (constitution III) | `post-commit-windows.test.ts` | `afterCommit` throws → row pending, 0 calls, 500; `afterPayment` throws → row pending, 1 call, 500; both: replay 202, count unchanged |
| Price authority over the total and bounds, server side (FR-006, FR-008, FR-009) | `validation.test.ts` | 422 with reasons; no row; key reusable; exactly-at-bound accepted, one beyond rejected; `"1250"` as a string → 400; two prices moving by equal and opposite amounts → accepted (the guarantee is over the total) |
| Reference alphabet and collision retry (FR-012) | `reference.test.ts` | no 0/O/1/I/L; forced collision → retry → distinct reference; 5 failures → 503 `reference_exhausted`, no row |
| Interface: every screen and transition in `contracts/ui-states.md` | `e2e/tests/*.spec.ts` | one spec per user story; `page.clock` drives 8/2/30/15/90/15 s; `page.route` produces lost response, 500, 404, late result; metrics deltas prove at-most-one |
| Nothing survives reset or expiry, on both back/forward paths (FR-028) | `e2e/tests/us5-abandonment.spec.ts` | bfcache-restored and fresh-load navigations both show idle |
| Stack from empty; restart preserves orders and does not duplicate seed (constitution X) | `e2e/ops/acceptance.spec.ts` | health `seed` transitions `applied` → `already-present`; order by key survives `down`/`up` |

## Observability check

```bash
docker compose logs api | grep -E '"event":"(order|payment|status|client)\.' | tail -20
curl -s localhost:8080/api/metrics
```

Every counter is pre-registered, so absent activity reads as `0`, never as a missing key. Counters
reset on API restart; `startedAt` in the response says when.
