# How this was built

*A record of the process, written as it happened rather than reconstructed afterwards.*

---

## Before any tooling

The five ADRs in `docs/adr/` were written before Spec Kit was installed; the commit history shows
this. Scope (ADR-001) was decided first because it is the decision that shapes every other: happy
path plus deliberate failure handling, not a broader feature set. The questions asked of the brief
were the ones a cashier normally absorbs: what happens when the customer taps twice, walks away,
or the network drops mid-payment. Everything excluded is listed with a reason in ADR-001, and the
possible future directions are explicitly not requirements.

The things I was unsure about were the numbers (timers, bounds, currency, reference format,
target environment). They were left open in the specification as "values to be confirmed" rather
than guessed, and set in clarification.

---

## The workflow

Spec Kit 1.0.5 with the Claude Code integration, skills mode. Sequence on 2026-09-07:

1. `/speckit-constitution` from the owner's draft: ten principles and governance, v1.0.0.
2. `/speckit-specify` from the owner's specification: nine user stories, 34 functional
   requirements, seven open values carried as identifiers instead of guessed.
3. `/speckit-clarify`: five questions (timers; bounds; currency; reference format; late result on
   the unresolved screen), then three owner decisions outside the question loop (target
   environment, the "unreachable" reading, priority semantics).
4. `/speckit-plan`: eight research agents in parallel (runtime, client, Postgres, migrations and
   compose, testing, observability, money and identifiers, simulator), five adversarial verifiers
   that tried to refute the load-bearing claims, one completeness critic. The first run hit a
   session limit half-way; it was resumed and the cached results replayed.
5. Two owner review rounds on the plan and design artifacts, then `/speckit-tasks` (93 tasks),
   one `/speckit-analyze` pass, and `/speckit-implement`.

Implementation order followed the owner's instruction: P1 complete and working (US1 to US5)
before anything else, then US6 to US9, then the operational acceptance and this document.

---

## Where I overrode the tooling

| What was proposed | What I did instead | Why |
|---|---|---|
| The plan template's "assumption if silent: accepted" framing for owner decisions | Every proposal was decided explicitly; nothing took effect by silence | The constitution says the agent proposes and the owner decides. Silence is not a decision. |
| Vitest 5.0.0 as the single runner (testing research) | Vitest 4.1.11 | Published two days before the plan, with 33 breaking changes; a poor thing to pin for a reviewer-run repository. |
| Plain `INSERT` + catch `23505` + `ROLLBACK` + fresh `SELECT` (two researchers) | `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING` as one autocommit statement, then a separate `SELECT` | Verified against the Postgres 18 documentation and source: it blocks on an uncommitted competitor and never errors, so the aborted-transaction trap ADR-004 names never arises. |
| A multi-stage `tsc` build to `dist/` for the API image | Node 24 native type stripping, no build step | The lighter option; the two models are mutually exclusive because `.ts` import specifiers are not rewritten by `tsc`. |
| A runtime override endpoint as the fallback if the on-screen simulator selector were rejected | Env default only; outcome changed by restarting the API | Rejecting one mechanism does not approve a different new one (owner's correction). |
| The research claim that a second lookup "closes the write-window race" | Removed the claim; recorded the residual window in ADR-002 | A claim stronger than the mechanism. No lock added for a case needing a concurrent same-key replay and a menu change inside the same milliseconds. |
| A shared `.ts` workspace package for constants | A plain `shared/` directory imported by relative path | Node refuses to type-strip `.ts` under `node_modules`; a workspace symlink would go through it. |
| Cutting the test hooks in the submission service (proposed, then withdrawn by the owner) | Kept them; changed the language | They do not simulate a crash. They exercise a precise window and assert that an exception there leaves the row in `pending_payment`, never `failed`. That is a P1 invariant. |

---

## Where the AI got it wrong

Specific, because the point is what had to be noticed.

- **Deadline regression on a late decline.** The first design set the inactivity deadline on
  `unresolved → declined` from `lastActivityAt + 90 s`, which is earlier than the deadline in force
  on the unresolved screen. A decline arriving at 100 s would have deleted the interaction on the
  next tick. Caught in owner review by working the arithmetic (sentAt 0, unresolved valid to 128 s,
  decline at 100 s). Fixed by preserving the deadline in force across the transition; the exact
  counterexample is now a unit test.
- **Admission keyed on the interaction, not the intent.** The first admission rule compared the
  interaction id and the definiteness of the result. After a decline the customer stays in the
  same interaction and creates a second key, so a late result for the first key would have passed
  both checks and overwritten the live attempt. Caught in owner review. The rule now has five
  conditions and requires the idempotency key to match the current submission.
- **Two contradictory classifications of a 409.** One research section said "rejected before
  payment", another said "look it up and show the recorded state". Caught in owner review;
  replaced by one canonical four-category rule stated in the contract and applied by the client.
- **Seed comparison that could never report "unchanged".** `IS DISTINCT FROM` over whole rows
  included `updated_at`, which the proposed row takes from `now()`, so every restart would have
  reported an update. Caught in owner review. The comparison now names the canonical columns.
- **Re-sending the POST on reload.** The runtime keyed "send the POST" on entering the
  `submitted` phase, which a reload's RESUME also does. Caught by the runtime unit test for reload
  (two POSTs counted). The send is now keyed on the PAY event only.
- **Four research claims refuted by the verifiers**: sessionStorage is not cleared on tab close
  on desktop Chrome (session restore brings it back); Chrome does keep a page with an in-flight
  fetch in the back/forward cache and delivers the response after restore; Playwright's clock does
  fake `AbortSignal.timeout` since 1.59; mounting the Postgres 18 volume at the old path fails
  loudly rather than silently losing data. Each changed a design detail; all are logged in
  `research.md`.
- **Test arithmetic.** Three interface and integration tests failed on their own mistakes: tapping
  "+" nine times when eight reached the cap; a helper pricing from seed constants after the test
  had changed the database price; and asserting a telemetry delta before the held response had
  even been fetched. None was a product defect; all were found by running the tests.
- **The clock only ever moved continuously in my tests.** A third review, by another agent after
  implementation, found seven defects that all share one cause: every timing test advanced the
  clock tick by tick, so nothing exercised a clock that *jumped* while the app was suspended, or a
  reload in the middle of a flow. Concretely: (1) a `submitted` interaction had no inactivity
  deadline, so resuming it ten minutes later was allowed, and a late poll start granted a fresh 30 s
  wait; a `paid` for a long-dead session could then be admitted, which is exactly the stranger's-
  order failure the P1 stories exist to prevent. (2) Every revalidation on `pageshow` or
  visibility dispatched a hydration event that rebuilt state from scratch, so switching tabs
  emptied a live cart. (3) The test-database guard checked a constant, not the URL actually
  connected, and migrations and the seed ran before any guard. (4) A reload before Pay kept an
  unsent intent on the payment screen with an empty cart. (5) A decline after a reload showed the
  frozen items but Try again used the empty cart. (6) Storage validation checked fields, not the
  invariants between them. (7) `unknown_item` flagged nothing and Review again never re-fetched
  the menu. Fixed with one `normalize(interaction, now)` applied by RESUME, TICK and the admission
  rule; hydration by phase; a live-page revalidation that only applies the clock; a union-typed
  storage validator with a format version; a guard on `current_database()` before every write;
  and 20 new tests whose clock jumps rather than ticks.
- **My fix for the tab-switch defect created the next one.** Making a live page apply only the
  clock on `pageshow` meant a document restored from the back/forward cache never asked whether it
  was still the tab's current interaction. Another document in the same tab could reset and start a
  new interaction; going back restored the old cart. A fourth review caught it, and caught why my
  navigation tests had not: Playwright's default headless shell never restores from the bfcache and
  Playwright passes `--disable-back-forward-cache`, so every "back" in my tests was a fresh load.
  Fixed by comparing the in-memory record with the stored one byte for byte on `pageshow` and
  visibility; tested in a separate Playwright project on the full Chromium channel without the
  flag, asserting `pageshow.persisted === true`.
- **A 422 was presented as proof about the whole intent.** The client said "Nothing has been
  charged" and discarded the key on a rejection, while ADR-002 records that a concurrent request
  with the same key may still be accepted. The reviewer reproduced the double payment against a real
  Postgres with a barrier. The owner had ruled out a lock; the fix keeps the rejected key (it can
  never be re-sent), softens the copy to "this attempt was not accepted", and performs one lookup of
  the kept key when the customer confirms again, before a new key exists. That narrows the window
  from milliseconds to the customer's reaction time without coordination. It is still not a proof.
- **The last check released a new key on any answer that was not an outcome.** Round four's fix
  looked the rejected key up once more before a new intent, but treated a network failure, a 5xx
  and an unrecognised body the same as "not found" and let the customer pay again, contradicting
  FR-024. A fifth review reproduced the double payment against a real Postgres with a controlled
  transport failure. Categories are now handled explicitly: a recorded outcome is applied; only a
  `404` on that check permits a new intent (the one exception, made explicit in the contract,
  because FR-009's re-confirmation must be possible and the owner ruled out per-intent
  coordination); anything else keeps the key, shows "we could not check your previous attempt",
  and lets the customer retry.
- **The 404 exception was keyed on the status code, not on the recognised body.** Round five made
  a `404` on the last check the one answer that permits a new key, but any HTTP 404 qualified,
  including an HTML page from an intermediary. A sixth review reproduced the double payment with a
  crafted HTML 404. Only the API's own `not_found` body qualifies now; anything else keeps the key.
- **A check's identity was its screen and its object, and both could recur.** Leaving the review,
  editing, and returning restored exactly the state the guard compared, so an old check completing
  then could open the payment screen with an edited cart; and a check from an ended interaction
  could clear the next interaction's in-flight flag. Every check now carries an id; any activity
  event invalidates the active one; a completion whose id is no longer active touches nothing.
- **A menu refresh could finish after the customer had moved past it.** After Try again the
  refresh runs while the review is already shown; reaching the payment screen before it finished
  left an unsent intent that a now-unavailable item made unsendable, with Pay enabled but inert.
  A fresh menu now discards an unsent intent it invalidates and returns to the cart with the
  reason, or to the review when only prices moved.
- **The menu-failure screen said "nothing has been charged" while a rejected key was kept.** The
  rejection screen's copy had been corrected in round four; the error screen reached from Review
  again had not. The error screen now says the previous attempt has not been checked whenever a
  sent key with an unknown outcome is kept.
- **The kept-key rule kept declined keys too.** "Edit order" after a decline carried the failed key
  into editing; confirming again looked it up, found `failed`, and showed the old decline instead of
  a new payment. A key is now kept only while its outcome is unknown; a decline is terminal for that
  order and editing after it starts a new intent.
- **Polling followed the phase, not the key.** A restored document that adopted another attempt of
  the same interaction (K2 for K1) kept polling K1 and never started K2. Polling is now bound to the
  interaction/key pair and reconciled on every transition.
- **A check's continuation ignored where the customer had gone.** Two taps on Continue started two
  checks; the second, completing after the customer had gone back and edited the cart, opened the
  payment screen with a third key and no review. Now one check runs at a time, the control is
  disabled meanwhile, and a continuation is admitted only if the review screen it started from is
  still current and the kept key is the same object.
- **Bounds were checked on quantity changes only.** A re-pricing after a rejection could push a
  valid cart over $1,000.00 and the client would still freeze and send it (the server refused it).
  `canReview` now validates the whole cart.
- **A 409 recovery showed the conflicting attempt's total.** The confirmation used what this attempt
  sent, not what the server recorded. The recorded total now travels with the outcome.

---

## What changed after implementation started

| Document | What changed | What forced it |
|---|---|---|
| ADR-001 | Per-submission outcome selection on the simulated payment screen, with a server default | The demo must show a decline and an unknown outcome at the kiosk without a second device. Owner-approved. |
| ADR-002 | "The validation window" added under "Where this still breaks" | The research claimed a race was closed that the mechanism only narrows. |
| ADR-005 | `unresolved → confirmed \| declined` on a late result; monotonic per intent; deadline preserved | Clarification answer (FR-034) and the two review findings above. |
| spec.md FR-031 | "a network wait of up to 8 s" | Polling starts earlier on a network rejection or an early pending; the wording read as fixed. |
| spec.md SC-002, SC-003, FR-009, FR-010, SC-007 | Precision: at most one order per intent and exactly one where acceptance occurred; the guarantee is over the total; availability is checked at the validation point; SC-007 does not hold where the server was never reached | Owner review of the plan. |
| data-model.md | `text` with CHECK instead of `char(n)`; JSONB snapshot instead of an `order_items` table; interaction id from the header | Research: `char` pads and compares oddly; a JSONB snapshot makes the accept path one statement with no explicit transaction. |
| contracts/openapi.yaml | `202` for pending, strict UUID patterns, one event per telemetry POST, `503 reference_exhausted` | Research on response classification and beacon transport. |

Nothing changed in the code that contradicts a document; where the code taught something, the
document was amended first or in the same commit.

---

## A deliberate UI pass for the kiosk context

After the functional work was green, the owner reviewed the screens at the real target
(1024×768, touch) and asked for a presentation-only pass: no state machine, timer, request or
validation changes, and no test assertion about behaviour to move. Everything was checked at the
real size before and after, which mattered: at kiosk height the menu's "Review order" footer was
below the fold entirely, something the owner's taller screenshots had not shown.

What changed: every tappable control is at least 56×56 px (the `+`/`−` and Add controls were
about 40); cart lines are two rows so "Remove" no longer overflows the panel and is a quiet button
rather than the loudest text on the screen; menu cards put the name on top with room to wrap and
are a uniform height, with unavailable items listed last in a shorter card that carries no
button; the review, payment and processing screens centre their content instead of stranding it
in the top third; the idle screen is one grouped block slightly above the middle; "Review order"
sits under the total inside the order panel, which stays put while the menu scrolls; the payment
screen's hierarchy is title, amount, a one-line simulation notice, the selector as secondary, then
Pay; the processing screen lost a disabled "Paying…" button that offered no action; and the
default focus ring is suppressed for touch while keyboard focus stays visible.

One label misdescribed its action: the review screen's "Confirm and pay $X" opened another screen
with its own Pay button. It now reads "Continue to payment", and "Pay $X" is reserved for the
control that actually starts the operation. Five test selectors changed to match the two label
changes (four for the new label, one because the unavailable card no longer has an Add control to
assert as disabled; it now asserts that no Add control exists). No behavioural assertion moved.

Scope note: a production kiosk would show product photography, since that is what drives
selection. It is omitted here as asset work rather than engineering, and outside what the brief
asks for.

---

## What I threw away

- The `order_items` table from the first data model, in favour of a JSONB snapshot (recorded in
  data-model.md with the honest account of what the table would have done well).
- The `/internal/simulator/calls` inspection endpoint one researcher proposed for interface tests.
  Metrics deltas with a single Playwright worker are enough; an endpoint that exposes keys in a
  no-auth demo was not worth it.
- An automatic re-send of the POST on an early network rejection. Safe by construction, but a
  second send path with its own accounting inside the bounded wait. Polling to "not found" and an
  honest "check at the counter before ordering again" is one code path. The change condition is
  recorded in research R10.
- The stale-poll interface test as first written. The client cancels its own polls the instant a
  terminal state shows, so a stale poll cannot arrive that way; the test now delivers the stale view
  through the still-open POST, which is the path that can actually be late.

---

## What I'd do differently

- Run the adversarial verifiers on the *reconciled* research, not only on each researcher's own
  claims. The two review rounds found contradictions between researchers (three test runners, two
  insert mechanisms, two classifications of a 409) that a verifier pointed at the merged document
  would have found without an owner's time.
- Write the deadline and admission rules as tests before writing prose about them. Both defects the
  owner caught were arithmetic; a unit test with the numbers would have caught them in minutes.
- Start Docker before planning research that wants to observe Postgres live. One researcher had to
  reason from the manual and the source because the daemon was down; the claims held, but the
  observation should have come first.
- Budget the plan-research workflow for the session limit. It stalled at 5 of 14 agents and had to
  be resumed; the cache made that cheap, but it cost half an hour of wall clock.

---

## Review rounds

This set of documents went through two rounds of external review before any code was written.

**Round one** (on the first plan, research, data model and contracts) found: nginx chosen without
its reason recorded; four documents repeating a stale "silent data loss" story about the Postgres
volume path that the verifier had already corrected; three incompatible test-runner choices; two
incompatible TypeScript execution models; `format: uuid` in the contract versus a strict pattern in
the research; the interaction id in the body in one document and in a header in another. All
refinements, resolved by reconciliation.

**Round six** (the same external agent, on commit `8a9573a`) found one high and three medium
defects, all reproduced and fixed with regressions: an unrecognised 404 body releasing a new key;
check identity by screen and object rather than by id; a late menu refresh stranding an unsent
intent on the payment screen; error copy asserting no charge while a key was kept. Two minor
items were applied as well: a client event whose body fails to parse is now counted as rejected,
and the `404` exception was carried into its owning documents, ADR-002 and FR-024, dated and
marked for the owner to confirm.

**Round five** (the same external agent, on commit `1a5114e`) found two high and two medium
defects in the runtime, all reproduced: the last check releasing a new key on a transport failure;
declined keys kept into editing; polling not following the key on a restored document; an
abandoned check's continuation navigating. All four fixed with runtime and browser regressions.
The `404` exception in the last check is now an explicit, documented rule in the contract, the UI
contract and the research, rather than a divergence between them.

**Round four** (the same external agent, on commit `122aade`) found one critical, one high and two
medium defects, all reproduced: the bfcache restore of an ended interaction; a rejection treated as
proof about the whole intent; bounds not re-checked after a re-pricing; a 409 recovery showing the
wrong total. All fixed with regressions, the bfcache ones with `persisted === true` asserted. The
contract and UI contract now state what a 422 does and does not prove. One document conflict
remains for the owner: FR-009 says "No order MUST be created for a rejected submission", which
ADR-002 (higher precedence) qualifies to "by a rejected request"; the spec's sentence was not
edited by the agent.

**Round three** (by another agent, on the implemented code, after the owner's "no further
review round" on the documents) found the seven suspension-and-reload defects listed under "Where
the AI got it wrong". All reproduced; all are fixed with tests whose clock jumps. The reviewer's
minor items (polling cadence measured from the start of a poll, listeners removed on stop, HTTP
bodies validated before the reducer sees them, per-test app teardown) were applied as well.

**Round two** (on the corrected documents) found genuine defects, not refinements: the deadline
regression on a late decline; response admission keyed on the interaction rather than the intent;
a contradictory 409 classification; a seed comparison that could never report "unchanged"; and a
claim that a race was closed when it was only narrowed. The owner's instruction after that round
was to fix them, run one analysis pass, and build, because "each round found real things, but the
point of diminishing return is close". The analysis pass found nothing above MEDIUM. Everything
found after that is in the section above, found by tests during implementation, which is where it
belongs.
