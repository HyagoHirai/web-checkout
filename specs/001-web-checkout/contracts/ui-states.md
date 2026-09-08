# UI Contract: Screens and Transitions

**Feature**: `specs/001-web-checkout/spec.md` | **Date**: 2026-09-07
**Viewport**: Chrome, 1024×768, touch-first (NFR-001, OV-7)

This contract names every screen the customer can reach, what it must show, the actions it offers,
and which requirements it satisfies. It is the checklist for the interface tests. No screen is
optional; a state without a screen is a constitution V violation.

Conventions for every screen:

- **Every screen states what to do next** (NFR-002).
- **Every tap that starts something slow changes the screen immediately** and stays changed until
  the action resolves (NFR-003). "Slow" means anything that awaits the network.
- **"Start new order" is reachable from every screen except idle** (FR-019). It ends the
  interaction. It never retries, never cancels a submitted order, never carries items forward.
- **Every error screen has at least one action that returns the kiosk to a working state** (NFR-004).
- **Nothing depends on keyboard, hover or right-click**; touch targets are sized for a standing
  customer (NFR-001).
- **The inactivity warning** can overlay any screen while the inactivity timer is running
  (FR-027); it is not shown during the bounded wait, when the timer is suspended (FR-031).

## Screen catalogue

### S0 Idle

- Shows: an invitation to start. Nothing from any previous interaction (FR-028).
- Actions: **Start** → S1, creating a new interaction.
- Satisfies: US1 scenario 1, US5 scenario 3.

### S1 Menu and cart

- Shows: every menu item with name, price in USD, and availability (FR-001); the cart with
  quantities and the running total (FR-002); flagged items, if any, marked as unavailable and
  requiring action (FR-010).
- Data: the menu is fetched on entering from S0 and on returning from S8; the cart is priced from
  that fetch and nothing else. The review total and the submitted `expectedTotalMinor` are one
  derived value from this cart state (FR-008). If the fetch fails → S9.
- Actions: add (disabled for unavailable items, FR-003); increase/decrease quantity (0 removes,
  FR-004; 10 is the ceiling, FR-006); remove; **Review** (disabled when the cart is empty, FR-005,
  or when any line is flagged, FR-010); **Start new order**.
- Guards: adding beyond 50 units in the order or a total beyond $1,000.00 is refused with a visible
  reason (FR-006).
- Satisfies: US1 scenarios 2–5, 9; US7.

### S2 Review

- Shows: the complete order and its total, exactly the total that will be submitted (FR-007,
  FR-008).
- Actions: **Confirm and pay** → S3; **Back** → S1 (cart intact); **Start new order**.
- Satisfies: US1 scenario 6.

### S3 Simulated payment

- Shows: heading "Simulated payment"; the total; the statement "This kiosk does not take real
  cards and nothing will be charged. Choose what the card terminal should answer, then tap Pay."
  (FR-011, ADR-001); one primary **Pay $X.XX** control; a visually secondary, clearly labelled
  three-way selector "What should the card terminal answer?" — Approve (default) / Decline /
  No answer (research R9; ADR-001 amended with the owner's approval). The selector is a
  simulation control, not money: it is sent as `simulation.outcome`, never fingerprinted, ignored
  on replay.
- Actions: **Pay** → S4 immediately (NFR-003); **Back** → S1 while no submission has been sent (this
  discards the key; re-entering payment generates a new one, ADR-002); **Start new order**.
- Guards: on entering S3 a fresh idempotency key is generated and persisted before anything is sent.
- Satisfies: US1 scenario 7 (start).

### S4 Waiting

- Shows: a clear in-progress state; the Pay control is no longer tappable. No timer countdown is
  required, but the screen must not look frozen.
- Behaviour: the POST is sent once and never aborted; the control is disabled on the first tap, so
  a second tap does nothing and the client never re-sends on its own (FR-014). Polling by key
  every 2 s starts at the earliest of 8 s without a response, a network rejection, or a `202
  pending_payment`, and lasts at most 30 s (FR-031, research R10). The inactivity timer is
  suspended. Refresh returns to this screen with the same key and the persisted frozen submission
  (FR-016).
- Transitions follow the canonical classification in `openapi.yaml` (four categories; never the
  HTTP family alone): known business outcome `paid` → S5, `failed` → S6, `pending_payment` → keep
  polling; conflict with an existing intent (`409 intent_mismatch`) → lookup by key and show the
  recorded state (S5/S6/S7a), never a rejection for an order that may be paid; request rejected
  (`422 validation_rejected` → S8; `400` or `503 reference_exhausted` → S9 "could not place your
  order, try again"; nothing was created, key not consumed); unknown outcome (anything else) → keep
  waiting until the bound, then S7 (FR-024).
- Actions: **Start new order** only (FR-017). Back is not offered while the outcome is unknown.
- Satisfies: US2 scenarios 1–3; US4 scenario 4.

### S5 Confirmed

- Shows: success, the order reference in its 4-character form, the **recorded** total (the order
  the server holds, which after a 409 lookup or a kept-key check may differ from what this attempt
  sent), and "quote this at the counter" (FR-012).
- Behaviour: returns to S0 after 15 s without any action (FR-013). The interaction ends. A repeated
  `paid` for the same intent does not restart the 15 s.
- Actions: **Done** → S0 (optional early exit).
- Satisfies: US1 scenarios 7–8.

### S6 Declined

- Shows: that payment was declined, in plain words, with the items still listed (FR-020). After a
  reload in `submitted` that ends here, the items come from the persisted frozen submission (names,
  prices, quantities as displayed at send).
- Actions: **Try again** → S2 with the cart intact; this is a new intent with a new key (FR-021),
  validated afresh by the server like any new submission. **Edit order** → S1. **Start new order**.
- Satisfies: US6.

### S7 Unresolved (two wordings, FR-023)

- **S7a — order known to exist** (`knownState` is `pending`): "Your order was received but payment
  couldn't be confirmed. Please check at the counter with reference XXXX. Don't pay again."
- **S7b — nothing confirmed** (`knownState` is `none`): "We couldn't confirm whether your order went
  through. Please check at the counter before ordering again." No reference; no promise that the
  counter will find anything.
- Both: state that the purchase may need help at the counter while the kiosk itself recovers
  (NFR-004 exception). Neither offers any way to pay again (FR-022). The inactivity timer resumes on
  entry (FR-031): the deadline is `max(lastActivityAt, sentAt + 38 s) + 90 s`, computed from
  persisted timestamps; entering this screen stamps no activity. Emits `unresolved_shown`.
- Behaviour: a late definitive result for the **same intent** moves to S5 or S6 (FR-034). Into S6
  the deadline in force is preserved: the response is not activity and never moves the deadline
  backward (research R4). A late `pending` on S7b upgrades the wording to S7a; never the reverse
  (FR-033). A late result for a previous intent (an earlier key in this interaction) is discarded.
- Actions: **Start new order** → S0. Inactivity → S0.
- Satisfies: US4 scenarios 1–3, 5–6; US5 scenario 6.

### S8 Rejected before payment

- Shows: why the submission was refused, before any payment (FR-009, FR-010):
  - **Price changed**: the current price of each affected item and the new total; the cart is
    updated to current prices for display.
  - **Item unavailable**: the affected line flagged in the cart; the rest preserved.
  - **Out of bounds / empty / unknown item**: the reason in plain words (the client should have
    prevented these; the screen exists because the server enforces them independently, FR-006).
- Actions: **Review again** → re-fetch the menu, re-price the whole cart, then S2 (price change) or
  S1 (unavailable, to act on the flagged line); **Start new order**.
- Copy states that *this attempt* was not accepted. It does not assert that nothing was charged:
  this request created nothing, but under ADR-002's residual validation window a concurrent
  request with the same key may still be accepted. The rejected key is therefore **kept**, can
  never be re-sent, and is looked up once more when the customer confirms again (before a new key
  is generated), one check at a time with the Continue control disabled meanwhile. Found paid → S5
  with the recorded total; found declined → S6; found pending → S7a; `404` → a new intent and key
  (the explicit exception in the contract's classification); network failure, 5xx or an
  unrecognised body → S9 "we could not check your previous attempt", key kept, Try again re-checks.
  A declined key is never kept: Edit order after S6 starts a new intent. Emits `rejection_shown`.
- A re-pricing can push a previously valid cart over a bound (FR-006); S1's Review control stays
  disabled with the reason until the order is reduced.
- Satisfies: US3, US7 scenarios 1–2.

### S9 Something went wrong

- Shows: a plain-language statement that something went wrong and that nothing has been charged
  when that is known (pre-submission failures only, US8). Never used for a failure after send; those
  are S7 (FR-024, FR-025).
- Actions: **Try again** (repeat the failed read, e.g. reload the menu); **Start new order**.
- Satisfies: US8 scenarios 1–2. Also the target for a `400` or a `503 reference_exhausted` on POST,
  where nothing was created and the key is not consumed: the copy says the order could not be placed
  and offers **Try again** → S2 (a new key) and Start new order. Emits `service_unreachable` when
  reached from a network failure; best-effort, it lands if the API is back.

### Overlay: Inactivity warning

- Appears 75 s after the last qualifying interaction, on any screen where the timer runs (FR-027).
- Shows: that the screen will reset shortly; **Continue** (counts as activity); **Start new order**.
- At 90 s: clears everything and returns to S0. From S4 the timer is suspended, so the overlay
  cannot appear there; it can appear on S7.
- Satisfies: US5 scenarios 1–2.

## Qualifying interactions (ADR-005)

Count as activity: any tap that changes the cart, navigates between screens, interacts with the
payment screen, or presses Continue. Do not count: polling responses, late responses, timer ticks,
pointer movement without a tap, focus changes.

## Response admission rule (US9)

Stated identically in research R4 and `data-model.md`. A response event is applied to the screen
only if all five hold:

1. The interaction is valid: its deadline, computed from persisted timestamps, has not passed.
2. The `interactionId` captured in the request closure equals the current interaction's id
   (FR-032). A network error carries no body, so the closure, not the body, is the source of
   attribution.
3. The `idempotencyKey` captured in the request closure equals the current submission's key.
   Monotonicity is per intent: after a decline the customer creates K2 in the same interaction, and
   a late K1 result must not touch it.
4. The transition is legal for the current phase: `submitted → confirmed|declined|unresolved`,
   `unresolved → confirmed|declined`, `unresolved(S7b) → unresolved(S7a)` on a first `pending`.
   Nothing leaves `confirmed` or `declined` on a response (FR-033).
5. A terminal result is not reapplied: a repeated `paid` does not restart the 15 s display; a
   repeated `failed` is a no-op.

Anything else is discarded and emitted as `stale_response_discarded` or
`foreign_response_discarded`, best-effort. `revalidate()` runs synchronously on `pageshow` and
`visibilitychange → visible` before any queued response is admitted, so a response buffered while
the page was in the back/forward cache cannot reach an expired interaction (research R4).

## Traceability

| Requirement | Screens |
|---|---|
| FR-001..007 | S1, S2 |
| FR-008, FR-009 | S2, S8 |
| FR-010 | S1, S8 |
| FR-011, FR-012, FR-013 | S3, S5 |
| FR-014..019 | S4, overlay, every screen ("Start new order") |
| FR-020, FR-021 | S6 |
| FR-022..025 | S4, S7 |
| FR-026 | S9 |
| FR-027..031 | overlay, S4, S7 |
| FR-032..034 | admission rule, S7 |
| NFR-001..005 | conventions above |
