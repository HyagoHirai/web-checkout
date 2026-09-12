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
- **The rejection branches skipped the monotonicity guard the outcome branch had.** A polling
  answer had already told the client that K1 existed (`pending`), and a 422 for one request that
  arrived later still moved the screen to "rejected" and, because the kept-key rule only kept keys
  with no known outcome, dropped exactly the key whose acceptance was known. A seventh review
  reproduced the double payment with real API, database and a held response. Rejections, 400s and
  503s are now admitted only while nothing is known about the intent; once any response has
  established that it exists, a later rejection of one request is stale.
- **A menu failure outside `building` left the loading flag stuck.** The runtime starts a refresh
  only on the flag's false-to-true edge, so after one failure during `submitted` no later "Try
  again" refreshed the menu. The flag now clears on every failure; only a building interaction
  shows the error screen for it.
- **The ops script inherited the global webServer.** With the demo URL down, `npm run test:ops`
  would have run `docker compose up --build` on the demo stack, reseeding it, before touching its
  own project. The script now disables the webServer, the config detects an ops-only invocation,
  and an ops test asserts that no webServer is configured.
- **Decrements were bounded like increments.** A cart pushed over the total cap by a re-pricing
  could not be reduced one step at a time because each intermediate total was still over the cap.
  Only increments are bounded now.
- **Limits were explained in a tooltip.** At 50 units every Add was disabled with a `title` and
  the panel still said "Review your order to pay." The order panel now names the limit reached, and
  a card at its per-item maximum shows "Max 10".
- **The pool's error counter was never wired on the production path.** `main()` created the pool
  before the app's counters existed. One counters instance is now shared, and a startup test emits a
  pool error and reads it back from the metrics endpoint.
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

A second, smaller pass fixed containment rather than layout: a grid item's default minimum width
is its content, so the "+ Add" button could force a card wider than its column, clipping the button
and truncating names, with a horizontal scrollbar below the target width and, with a longer name
or another system font, potentially at it. Cards now shrink below their content, names wrap, the
price/Add row wraps the button under the price when there is no room, and the page never scrolls
horizontally. "Remove" was also moved onto the price's right edge (its own padding had inset it),
away from the "+" the finger is already working. Checked at 1024×768 before and after: nothing else
shifted; no test selector changed.

Scope note: a production kiosk would show product photography, since that is what drives
selection. It is omitted here as asset work rather than engineering, and outside what the brief
asks for.

---

## A maintainability pass

After the functional reviews, a separate review looked only at separation of responsibility,
duplication and readability, and the owner asked for its first two tiers. Behaviour-preserving, with
the suites as the net. What moved: the pure cart rules out of the reducer into `machine/cart.ts`
(with a named union for the block reasons, so the copy table is checked by the compiler); the
five-condition admission rule into `machine/admission.ts`, so it mirrors the one rule stated in the
research, the data model and the UI contract; the submission helpers into `machine/submission.ts`,
including the single definition of a retained submission that the reducer, the runtime and the
error screen had each spelled out for themselves. The reducer keeps its one switch and gained two
named blocks, hydration and menu update. The runtime's continue-to-payment flow became a named
function beside the other lifecycle functions instead of a 37-line action. `Menu` became a layout
over `MenuItemCard` and `CartPanel`, with the copy decisions named. `loadMenu` moved from a route
into `db/`, taking a pool. Outcome and rejection lists are `as const` in `shared/wire.ts` with the
types derived, as the client event names already were. An unused deadline helper and two comments
describing behaviour that later rounds had changed were removed.

The tests were reorganised by subject: files and describe blocks had been named after review
rounds and findings, which meant a maintainer had to know the history to find a rule's coverage.
That history is here, not in test names. Two titles promised more than their assertions: one said
it refused a 51st unit and stopped at 24, one said a late paid was applied and only checked that
nothing polled. The first now has the case it claimed; the second says what it checks.

One thing learned while verifying: the two Playwright projects must not run concurrently against
one stack, because both assert deltas on the API's single set of counters. The root script runs
them in sequence; running them in parallel by hand produced one spurious failure that a solo rerun
cleared.

A small flow change followed the owner's use of the kiosk: on the declined screen, "Try again"
returned to the review, which is the same content minus the warning and read as if nothing had
happened, with payment still three taps away. It now goes straight to the payment screen with a
fresh key: the customer already reviewed the order, the decline was about payment, and the outcome
selector they need is there. "Edit order" still returns to the menu. This stays within
`declined → building` (ADR-005; the unsent payment screen is part of building, ADR-002), so no
document changed beyond the UI contract's S6 line. Implementing it showed that one event had been
carrying two different transitions, the rejected path back to the review and the declined path
onward, so they became two events, `TRY_AGAIN` and `RETRY_PAYMENT`.

A full external code review on 2026-09-09 (kept in `docs/reviews/`) found no new defect in
submission, idempotency, persistence or admission, and two items to fix before delivery. One was a
test that could not be stable by design: the stale-response browser test asserted that a
best-effort beacon had been counted by the server, which telemetry never promises (constitution
VI), and it flaked once in three runs. All five browser assertions of that kind now observe the
browser emitting the event and leave delivery to the API integration test, which already proves
it. The other was a real FR-006 gap: with two items at their per-item maximum and an expensive
item stopped by the total, every Add was disabled and no monetary reason appeared, because the
order-level rule demanded that every item be blocked by the total. The rule now considers only the
items that could still grow, and the card names a total block on the item itself, which is the
common case. The reviewer's other four items (a fixed 50 ms sleep in the validation-window test,
modal focus on the inactivity warning, three unused money helpers, two lagging comments) are
deferred, as the review itself proposed.

## A readability pass

While reading the code to answer his own questions about it, the owner found that some functions
were hard to follow: `afterTransition` in the runtime read as a run of unrelated `if`s, and locals
named `pi`, `ni`, `sub`, `fp`, `i`, `a`, `r` had to be decoded by scrolling back to their
declaration. His question was whether that counts in a take-home. It does, and more than in
production code: the reviewer reads cold, with limited time, and readability is usually an explicit
criterion. The line drawn for the pass was behaviour: renames, named conditions and pure
extractions are covered by the suites; adding layers or abstractions would not make the code easier
to read at this size, and was not done.

What changed, on 2026-09-09. Every abbreviated local in `client/src/machine`, `client/src/api`, the
two screens that iterate the cart, and the API's service, server, config and plugins now carries
its full name (`interaction`, `submission`, `fingerprint`, `response`, `candidate`, `value`).
`afterTransition` names each transition it reacts to (`interactionEnded`, `expiredByClock`,
`menuRequested`) and hands the three screen-telemetry events to `emitTransitionTelemetry`, so the
behavioural effects and the observability are read separately. The duplicated "start polling if
the 8 s wait is over" check in `tickOnce` and `revalidate` is one `startPollingIfDue`. In the
reducer, `applyResponse` is now a dispatcher over the response category: the outcome transitions
live in `applyOutcome`, the 422 handling in `applyRejection`, and the cart arithmetic that the
422 case had inlined (merging the server's current items into the menu, flagging unavailable and
unknown items) moved to `cart.ts` as `menuWithCurrentItems` and `flagRejectedItems`, with unit
tests of their own. In the API, `submit` reads as the seven numbered steps of research R5 with
the 422 body in `rejectionOf` and the post-commit window in `executePayment`; the step comments
were corrected while there (the record step is 7, not 8, and the payment is step 6 alone).

Verification: typecheck, the client and API suites, and the two browser projects in sequence,
before and after the last round of renames. In between, four independent reviewer agents compared
HEAD with the working tree function by function, and two further agents tried to refute each of
their 26 claims. None was a behaviour change. The confirmed claims were abbreviations the pass
had missed (`opts`, `res`, `err`, a `q` in a props signature, a `type Response` alias that
shadowed the DOM type) and two weak assertions in the new cart tests, all applied. Three
pre-existing gaps they surfaced are left as they are: no test pins the detail or key of the
`interaction_expired`, `rejection_shown` and `stale_response_discarded` events, and the
reload-then-422 path is exercised in the browser, not through the reducer alone. Nothing exported
changed its name and no existing test assertion changed.

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

Two rounds of external review on the documents before any code was written, then five on the
code as it was corrected. In the order they happened:

**Round one** (on the first plan, research, data model and contracts) found: nginx chosen without
its reason recorded; four documents repeating a stale "silent data loss" story about the Postgres
volume path that the verifier had already corrected; three incompatible test-runner choices; two
incompatible TypeScript execution models; `format: uuid` in the contract versus a strict pattern in
the research; the interaction id in the body in one document and in a header in another. All
refinements, resolved by reconciliation.

**Round two** (on the corrected documents) found genuine defects, not refinements: the deadline
regression on a late decline; response admission keyed on the interaction rather than the intent;
a contradictory 409 classification; a seed comparison that could never report "unchanged"; and a
claim that a race was closed when it was only narrowed. The owner's instruction after that round
was to fix them, run one analysis pass, and build, because "each round found real things, but the
point of diminishing return is close". The analysis pass found nothing above MEDIUM. What the
tests found during implementation is in "Where the AI got it wrong", which is where it belongs;
the rounds below are what reviewers found in the implemented code afterwards.

**Round three** (by another agent, on the implemented code, after the owner's "no further
review round" on the documents) found the seven suspension-and-reload defects listed under "Where
the AI got it wrong". All reproduced; all are fixed with tests whose clock jumps. The reviewer's
minor items (polling cadence measured from the start of a poll, listeners removed on stop, HTTP
bodies validated before the reducer sees them, per-test app teardown) were applied as well.

**Round four** (the external agent from rounds one and two, on commit `6ad0456`) found one critical, one high and two
medium defects, all reproduced: the bfcache restore of an ended interaction; a rejection treated as
proof about the whole intent; bounds not re-checked after a re-pricing; a 409 recovery showing the
wrong total. All fixed with regressions, the bfcache ones with `persisted === true` asserted. The
contract and UI contract now state what a 422 does and does not prove. One document conflict
remains for the owner: FR-009 says "No order MUST be created for a rejected submission", which
ADR-002 (higher precedence) qualifies to "by a rejected request"; the spec's sentence was not
edited by the agent.

**Round five** (the same external agent, on commit `58b423b`) found two high and two medium
defects in the runtime, all reproduced: the last check releasing a new key on a transport failure;
declined keys kept into editing; polling not following the key on a restored document; an
abandoned check's continuation navigating. All four fixed with runtime and browser regressions.
The `404` exception in the last check is now an explicit, documented rule in the contract, the UI
contract and the research, rather than a divergence between them.

**Round six** (the same external agent, on commit `f5bc5d4`) found one high and three medium
defects, all reproduced and fixed with regressions: an unrecognised 404 body releasing a new key;
check identity by screen and object rather than by id; a late menu refresh stranding an unsent
intent on the payment screen; error copy asserting no charge while a key was kept. Two minor
items were applied as well: a client event whose body fails to parse is now counted as rejected,
and the `404` exception was carried into its owning documents, ADR-002 and FR-024, dated and
marked for the owner to confirm.

**Round seven** (the same external agent, on the whole implementation at `dff2fb1`) found one
high defect (a late rejection erasing a known acceptance), four medium ones (a stuck menu-loading
flag; the ops script able to start the demo stack; bounded decrements; limits explained only in a
tooltip) and one low (the pool error counter unwired in production). All reproduced and fixed with
regressions; the UI contract's unresolved deadline and the OpenAPI `OrderLine` schema were aligned
with the code. The two items that had waited for the owner were then decided on 2026-09-08: the
404-at-re-confirmation exception confirmed with its narrow scope, and FR-009 reworded from "no
order for a rejected submission" to "no order is created by a rejected request", the owner naming
the earlier wording as the same overreach as the "closes the write-window race" claim: a statement
about the intent when the mechanism only guarantees something about the request. At the owner's
instruction ADR-002's "Where this still breaks" now also records that the re-confirmation check
narrows the window rather than closing it, so the exception cannot read as a fix.
