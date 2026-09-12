# Web Checkout Constitution

*Non-negotiable principles for this project. The reasoning behind each is in `docs/adr/`.*

## Core Principles

### I. Money is never trusted from the client

Any value that determines what a customer is charged is verified server-side before it
is acted on. The client may state the total it displayed; the server independently
recomputes it and rejects mismatches.

The customer is never charged an amount they were not shown. A discrepancy is an
explicit, visible event — never a silent correction.

*See ADR-003.*

### II. Order submission is idempotent by construction

Repetitions of the same accepted intent create no additional orders and no additional
payment effects. They return that intent's recorded outcome, or report that it is still
pending.

Different intents are not deduplicated by content. The guarantee is a stable business
outcome, not an identical HTTP response. A recorded decline stays a decline.

An intent is frozen from first send until its outcome is known. Navigation, refresh and
reset do not create a second intent for the same unresolved submission.

*See ADR-002.*

### III. Write the intent durably before performing the action

Anything that moves money is recorded, and that record committed, before the external
effect is attempted. The acceptable failure is a record with no outcome; the
unacceptable failure is an outcome with no record.

*See ADR-002 and ADR-005.*

### IV. Interactive state does not outlive the interaction

This concerns the state a customer builds on screen. It does not concern submitted
orders, payment outcomes, or operational records, which must survive the customer
leaving.

After an explicit reset or an interaction expiry, no previous cart or result is restored
or associated with the new interaction — including via reload or browser history.
Recovering an in-flight operation by its identifier, within its own interaction, is
permitted and expected.

*See ADR-005.*

### V. Failure paths are first-class

In self-service there is no operator to intervene. Every failure path a customer can
reach has defined behaviour and something visible on screen.

Distinct failures are distinguished: a confirmed decline, an unknown outcome, a request
rejected before payment, and an unreachable service are four different things. What the
client knows is kept separate from what exists server-side — a timeout on the screen is
not evidence about the order.

*See ADR-001 and ADR-005.*

### VI. If it can fail silently, it must be observable

Nobody reports a failure on an unattended kiosk. Structured logs and simple counters on
the paths that can fail are part of the feature.

Scope is bounded to structured logs and simple counters — no dashboarding platform, no
additional infrastructure.

For an accepted intent, the durable order record is the primary evidence; logs
complement it and are not claimed to survive every failure mode. Client-originated
events are best-effort. A persistent client-side telemetry queue is not built — a scope
choice, not a claim that it would be impossible.

*See ADR-001.*

### VII. Scope is a decision, and omissions are deliberate

Depth over breadth. Anything deliberately excluded is written down with its reason.
Possible future work is not a requirement of this delivery and generates no tasks.

*See ADR-001.*

### VIII. Proportionality, with the trade-off stated

Solutions are sized to the problem. Where a heavier option is chosen over a lighter one
that would have sufficed, the reason is recorded — including an honest account of what
the lighter option would have done well.

*See ADR-004.*

### IX. Decisions are recorded

Architectural decisions are written as ADRs stating alternatives, accepted cost, and
conditions for change. Where a decision turns on competing criteria, a matrix makes them
and their weights visible.

Decisions are recorded before implementation wherever possible. Where implementation
reveals a constraint that changes a decision, the ADR is updated and the change approved
explicitly.

### X. One setup command

Cloning the repository and running a single documented command brings up the full
stack, including migrations and a reproducible seed. Restarting preserves orders and
does not duplicate seed data. Any prerequisite beyond that command is named plainly in
the README.

*See ADR-004.*

## Decision Records

Each principle above cites the ADR that holds its reasoning, alternatives, accepted cost
and conditions for change. The references resolve as follows:

| Reference | Title | File |
|---|---|---|
| ADR-001 | Scope | `docs/adr/0001-scope.md` |
| ADR-002 | Idempotent order submission | `docs/adr/0002-idempotent-order-submission.md` |
| ADR-003 | Price authority | `docs/adr/0003-price-authority.md` |
| ADR-004 | Persistence | `docs/adr/0004-persistence.md` |
| ADR-005 | Order lifecycle and abandonment | `docs/adr/0005-order-lifecycle-and-abandonment.md` |

## Governance

### Who decides

An agent may propose. The project owner decides. No change to a principle, an ADR or a
specification requirement takes effect on an agent's proposal alone.

### Precedence

Where documents disagree, precedence indicates *where to fix the conflict*: constitution
over ADRs, ADRs over the specification, the specification over the plan, the plan over
tasks and code. Precedence does not authorise dropping a product requirement because an
ADR happens not to mention it — a conflict is surfaced, not resolved by omission.

### Silent change is prohibited

Plan, tasks and code may not alter an approved decision. A conflict between a
principle, a requirement and an ADR is surfaced for explicit resolution. An agent
encountering a contradiction, or missing information it needs, reports the blockage
rather than inventing a resolution.

When a clarification answer changes a rule, the document that owns the rule is updated
— a note in a clarifications log does not substitute for amending the ADR.

### Amendment

Changes to this document increment the version and are noted below. Downstream
artifacts are re-checked against the amended version.

Versions follow MAJOR.MINOR.PATCH: MAJOR when a principle is removed or redefined,
MINOR when a principle or section is added or guidance is materially expanded, PATCH
for clarifications and wording that change no rule.

### Amendment log

1.0.0 — initial ratification, 2026-09-07.

**Version**: 1.0.0 | **Ratified**: 2026-09-07 | **Last Amended**: 2026-09-07
