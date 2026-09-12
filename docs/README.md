# docs/

The owner's own documents, written before Spec Kit was installed.
`specs/001-web-checkout/` is what Spec Kit produced from them afterwards. When the two disagree,
the precedence in the constitution decides: constitution, then ADRs, then specification, then plan,
then tasks and code.

| Path | What it is |
|---|---|
| `adr/0001-scope.md` | Happy path plus deliberate failure handling; the three-outcome payment simulator; what is out of scope and why. |
| `adr/0002-idempotent-order-submission.md` | A client-generated key bound to a payload fingerprint; the request that inserts the row is the one that pays; "Where this still breaks" lists the residual windows. |
| `adr/0003-price-authority.md` | The server recomputes every amount; the guarantee is over the total; a rejection before payment is not a failure. |
| `adr/0004-persistence.md` | Postgres in Docker over SQLite, conceding that SQLite wins on proportionality; what "one command" has to include. |
| `adr/0005-order-lifecycle-and-abandonment.md` | Client-only cart, order created at submit, the interaction as the unit of state, four timers, late and out-of-order responses. |
| `specification.md` | The original specification, with the numbers left open as values to be confirmed. |
| `constitution-draft.md` | The draft the ratified constitution (`.specify/memory/constitution.md`) was compiled from. |

Every ADR has the same shape: status, context, decision, alternatives, why they were rejected, and
a decision matrix. ADR-003 and ADR-004 also state what the decision costs and when it would change;
ADR-002 lists where it still breaks.
Amendments made after the plan review and the code reviews are dated inside the ADR that owns them,
never in a separate log.
