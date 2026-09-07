# ADR-004 — Persistence

## Status

Accepted

## Context

Submitting an order needs to persist it. The brief says "file or DB, your call", so the choice is explicitly mine.

Two constraints shape it. Volume: a single kiosk at a snack bar counter — a handful of orders per minute at peak. And the submission instructions say a teammate must clone the repo and have it running on a Unix machine **without asking questions**; every piece of infrastructure is friction between the reviewer and a working app.

There is also a dependency: ADR-002 relies on a unique constraint on the idempotency key as the concurrency backstop. Whatever I choose has to express that.

## Decision

Postgres, running in Docker, with a compose file that brings up the database, the API and the client in a single command.

**SQLite meets the requirements of this exercise.** It handles the volume comfortably, enforces uniqueness constraints, provides real transactions with serialised writes, and requires no setup at all. It is a legitimate backend for a web application, and a central API using SQLite could serve multiple kiosks perfectly well — the limitation that matters is many machines accessing the same database file directly, which isn't this architecture. On proportionality alone, SQLite wins.

Postgres was chosen for the operational model I want the backend to demonstrate, and for an assumed evolution, accepting the additional cost explicitly:

**The operational surface is part of what's being built.** Migrations, a reproducible seed, a persistent volume, service startup dependencies, and behaviour across restarts are decisions this exercise should show me making. Postgres puts them in the open rather than making them implicit in a file.

**The assumed direction is more than one deployment.** If this grew into screens across locations reporting centrally, Postgres is where it lands. That's an assumption, not a certainty, and it is the assumption the decision rests on.

**The setup cost is paid once, by me.** A compose file that starts database, API and client turns the whole thing into one command — arguably less friction than a README explaining how to run two processes and a database separately.

If this were production code for a single kiosk with no expansion planned, SQLite would be the right call and Postgres would be over-engineering.

## Alternatives

**A — In-memory only.** No setup. Orders vanish on restart.

**B — Append to a JSON or JSONL file.** No dependency, human-readable, but append-safety is hand-rolled and querying means reading the whole file.

**C — SQLite.** A real database with no server to run. Transactions, constraints, serialised writes, zero setup.

**D — Postgres in Docker.** Adds a container to the reviewer's path; buys an operational surface this workload doesn't strictly need.

## Why the alternatives were rejected

**A — in-memory.** Losing orders on restart is indefensible for anything that takes money, even in a demo.

**B — flat file.** Rejected on relevance rather than capability. It would work at this volume, but hand-rolling append-safety and scanning a file to answer a query is a solved problem being re-solved badly, and it's further from how this gets built in practice.

**C — SQLite.** The genuine runner-up, and the right answer if proportionality were the only criterion. Rejected for the reasons above — not because it couldn't do the job. I'd have no argument against a reviewer who preferred it.

## Decision matrix

| Criterion | Weight | A — memory | B — file | C — SQLite | D — Postgres |
|---|---|---|---|---|---|
| Survives restart | High | No | Yes | Yes | Yes |
| Enforces uniqueness constraint (ADR-002) | High | No | No | Yes | Yes |
| Safe concurrent writes | High | n/a | Hand-rolled | Yes | Yes |
| Exercises operational decisions (migrations, seed, volume) | Medium | No | No | Partly | Yes |
| Setup friction for reviewer | Medium | None | None | None | Docker, one command |
| Proportionate to current volume | Low | — | Yes | Yes | Over-provisioned |

*Proportionality is deliberately the lowest-weighted criterion, and it is the only one Postgres loses on. That weighting is the actual decision — someone weighting it higher would correctly land on SQLite.*

## What "one command" has to include

The single-command requirement is not just process startup. It covers:

- Migrations applied automatically on a clean database
- A reproducible seed that does not duplicate on re-run
- Data persisted in a volume, surviving container restart
- Service startup ordering, so the API waits for a database that accepts connections — and does not serve traffic before schema and seed are ready

Two scenarios are verified as operational acceptance tests, not documented as README instructions:

- Starting from an empty environment produces a working stack
- Restarting preserves existing orders and does not duplicate the seed

## Constraint violations and transaction state

ADR-002 relies on catching a unique-constraint violation and translating it into the recorded outcome. That has a specific implication in Postgres: **an error aborts the transaction**, and the same transaction cannot simply continue querying afterwards.

The plan must choose deliberately between wrapping the insert in a savepoint and rolling back to it, using an upsert that reports the conflict without erroring, or running the recovery lookup in a fresh transaction. Discovering this during implementation and patching around it is the failure mode this note exists to prevent.

Related: under Read Committed, `INSERT … ON CONFLICT DO NOTHING` can fail to insert because of a row not visible in that statement's snapshot. The recovery lookup must account for that — "use an upsert" is not by itself a specification.

## What this costs

The reviewer needs Docker installed. That's a real assumption, and if it's wrong the app doesn't start. It's mitigated by the compose file covering the whole stack and stated plainly in the README — but it remains the one thing between a clean clone and a running app.

## When this decision would change

If the target were genuinely a single kiosk with no central reporting and no expansion, SQLite would be correct and Postgres would be dead weight. The decision rests on the assumed direction, and if that assumption is wrong, so is the choice.
