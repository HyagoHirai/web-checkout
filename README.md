# Web Checkout

A self-service snack-bar kiosk: browse a menu, build an order, pay (simulated), get a reference to
quote at the counter. Built for a customer standing alone at a shared touchscreen, so every failure
path has a defined screen, no order is ever charged twice or at an amount that was not shown, and
nothing from one customer survives into the next interaction.

The reasoning lives in `docs/adr/` (five decision records written before any code) and the
specification, plan and design in `specs/001-web-checkout/`. `PROCESS.md` records how it was built.

## Run it

**Prerequisite**: Docker Desktop, or Docker Engine ≥ 25 with the Compose and Buildx plugins.
Nothing else is needed to run the app.

```bash
docker compose up --build
```

Then open <http://localhost:8080> in Chrome. The target is a 1024×768 touch screen; in Chrome
DevTools, the device toolbar with a custom 1024×768 touch device reproduces the kiosk.

What the one command does: starts PostgreSQL 18 with a named volume, starts the API (which
applies migrations and the seed before it listens), then starts nginx serving the client and
proxying `/api` to the API. Restarting (`docker compose down` then `up`, without `-v`) preserves
orders and does not duplicate the seed. `docker compose down -v` wipes the database.

| Setting | Default | Override |
|---|---|---|
| Client port | 8080 | `CLIENT_PORT=8090 docker compose up --build` |
| Database port (loopback only, for tests and fixtures) | 54329 | `DB_PORT=…` |
| Simulator default outcome when the screen sends none | `success` | `SIMULATOR_DEFAULT_OUTCOME=declined` |
| Honour the outcome chosen on the payment screen | `allow` | `SIMULATOR_CLIENT_HINT=ignore` |
| Simulated card-terminal latency | 1500 ms | `SIMULATOR_LATENCY_MS=0` |

Data lives in the `pgdata` volume mounted at `/var/lib/postgresql` (the PostgreSQL 18 image moved
its data directory; mounting the pre-18 path fails loudly on first start rather than silently).

## The simulated payment

The payment screen says it is simulated and collects no card details. It has one **Pay** control
and a secondary selector, "What should the card terminal answer?", with Approve (default), Decline
and No answer. That selector is a simulation control, not money: it never enters the intent
fingerprint, is never stored on the order, is read only by the request that inserted the order, and
is ignored on every replay. It exists so a decline and an unknown outcome can be shown at the kiosk
without a second device. The amount is always recomputed by the server from its own menu.

## Try the failure paths live

| Scenario | How |
|---|---|
| Declined | Selector → Decline → Pay |
| Unknown outcome, order recorded | Selector → No answer → Pay; after 30 s of polling the screen says to check at the counter with the reference |
| Unknown outcome, nothing recorded | `docker compose stop api` between Review and Pay, then Pay; after the wait, the screen says it could not confirm the order went through |
| Service unreachable | `docker compose stop api`, then tap Start or reload; `docker compose start api` and Try again |
| Price changed | With a cart open: `docker compose exec -T db psql -U checkout -d webcheckout -c "UPDATE menu_items SET price_minor = price_minor + 50 WHERE slug = 'coffee'"` then Pay |
| Item unavailable | `… SET available = false WHERE slug = 'coffee'` then Pay |
| Abandonment | Stop touching for 75 s: a warning; at 90 s the screen resets |

`docker compose restart api` re-applies the seed and puts the menu back after fixtures.

## Observability

Structured JSON logs on stdout (`docker compose logs api`) with a request id, the interaction id,
the idempotency key and one `event` per path that can fail. Simple in-process counters at
`GET /api/metrics`; every counter exists at 0, and they reset when the API restarts (`startedAt`
says when). No dashboards, no metrics backend. Client-originated events are best-effort beacons.

## Tests

Requires Node 24 (`.nvmrc`) and, for the interface tests, `npx playwright install chromium`.

```bash
npm ci
npm test            # type-check, API unit + integration (real Postgres via docker compose), client unit
npm run test:e2e    # Playwright at 1024×768 with touch, against the compose stack (starts it if needed)
npm run test:ops    # the two ADR-004 operational scenarios, in a separate compose project
```

The integration tests start only the `db` service and use a `webcheckout_test` database. The
interface tests place orders in the demo database; that is intended (the restart scenario needs
real orders). "At most one payment per intent" is asserted on the simulator's call log and on
`/api/metrics` deltas, never by counting rows.

## What is deliberately not here

Real payment processing, accounts, menu administration, fulfilment, cancellation after
confirmation, promotions, counted inventory, receipts and hardware, reconciliation of orders left
in an unknown state, any staff-facing interface (ADR-001). Orders left in `pending_payment` stay
there; the customer's route is the counter.

One residual window is recorded rather than closed: two concurrent requests with the same key and
a menu change landing between their validations can leave one told "rejected" while the other
created the order (ADR-002, "The validation window"). It needs both events inside the same few
milliseconds; no lock is added for it.

## Layout

```text
compose.yaml            one command for db, api, client
shared/                 constants and wire types both packages import by relative path
api/                    Fastify 5 on Node 24 (runs .ts directly), pg, pino; migrations/ and seed/
client/                 React 19 + Vite 8; a pure reducer state machine and a small runtime; nginx.conf
e2e/                    Playwright: tests/ (interface) and ops/ (operational acceptance)
docs/adr/               ADR-001..005
specs/001-web-checkout/ spec, plan, research, data model, contracts, quickstart, tasks
```
