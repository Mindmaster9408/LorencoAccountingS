# Session Handoff — 2026-11-10 — Sean auto-allocation (Phase 2)

Commit `01de216`. This follows on from Phase 1 (`ccf85a6`, see `SESSION_HANDOFF_2026-11-05.md`).

## Ruan's decisions (2026-11-10)
- Sean may post bank lines himself. The switch is per client and starts **OFF**.
- He runs automatically after **Bank Staging → Confirm**. There is also a "Let Sean Allocate Now" button.
- He never posts a line above **R5 000**.
- Ruan approved scrubbing client names from Sean's `bank_name` fields. That is done.

## When Sean posts by himself
A line is posted only when **all** of the following hold:
- It comes from the client's own history, and it is the exact same line.
- It was allocated 5+ times, and every time to the same account with the same VAT setting. A VAT setting that is no longer active blocks it.
- The type is `account`.
- The amount is at most R5 000.
- No bank rule or payroll match claims it.

Backtest result: 118 of 250 lines qualified, and all 118 were correct.

## What changed
| File | Purpose |
|---|---|
| `backend/modules/accounting/routes/bank.js` | The allocate handler moved into `allocateBankTransaction(req, id, body)`. This was a mechanical move with the same behaviour. New in this file: `seanAutoAllocate()`, `GET/PUT /sean-settings`, `POST /sean-auto-allocate`, and the `allocation_source` field (manual / bank_rule / payroll / sean_auto), which Undo clears. |
| `backend/modules/accounting/routes/bankStaging.js` | After Confirm, Sean runs in the background if the company has it on. |
| `backend/modules/accounting/services/bankRuleMatcher.js` (new) | One shared rule matcher for `/rules/suggest` and Sean. |
| `backend/sean/bank-allocation-engine.js` | Adds `autoEligible`, `AUTO_MIN_COUNT` = 5 and `AUTO_MAX_AMOUNT` = 5000. |
| `frontend-accounting/bank.html` | Adds the per-client switch (with a confirmation), "Let Sean Allocate Now", and a 🤖 Sean badge in the Reviewed tab. |
| `frontend-accounting/bank-staging.html` | The confirm message now says Sean is working. |
| `backend/config/migrations/175_sean_auto_allocate.sql` | **Run on 2026-11-10.** Adds `companies.sean_auto_allocate` and `bank_transactions.allocation_source`. It was renamed from 174 because another session has an uncommitted `174_local_ai_jobs.sql`. |

## Confirmed
End-to-end test in the TEST company (51), with data tagged "SEAN E2E MWASN0EB":
- 5 manual allocations through the refactored path all posted.
- With auto OFF, Sean did nothing.
- With auto ON, Sean posted exactly the 2 eligible lines. Their journals are posted, balanced, flagged `seanAutoAllocated`, and the audit log says "auto-allocated by Sean".
- The R6 000 line and the line with no history stayed open.
- The switch is back OFF.

Other checks:
- Lint: 0 errors.
- 28 new tests pass.
- The full suite is unchanged: the same 4 suites fail as before this change.

## Testing required (Ruan)
1. On a client with history (for example DroneDog), open Bank and tick "Sean posts the lines he is sure of after import".
2. Click "Let Sean Allocate Now", then check the 🤖 Sean lines in the Reviewed tab.
3. Undo one of them.
4. Import a statement and confirm it in Bank Staging. Sean's lines should then show up in Reviewed.

## Notes
- Local `.env` points `DATABASE_URL` at a Zeabur database. To run allocation scripts locally, set `ACCOUNTING_DATABASE_URL` to `SUPABASE_DB_URL`.
- The test lines in company 51 were left in place. Part H allows this.

```
FOLLOW-UP NOTE
- Area: Sean Phase 3
- Dependency: Ruan's live feedback on Phase 2
- What was done now: opt-in auto-post of strongly confirmed lines
- What still needs to be checked: invoice matching was deferred (only 4 AR / 1 AP invoices exist — clients work cashbook-style); Record Payment journals are not linked to bank lines (double-posting risk if both are used)
- Risk if not checked: low today (AR/AP barely used)
- Recommended next review point: when a client starts using AR/AP invoices
```

---

## Addendum — Sean's month-end review (commit `74da810`)
- `backend/sean/bank-review.js` (new, read-only) and `GET /api/accounting/bank/sean-review?bankAccountId=`. Bank page button: **🤖 Sean's Review**.
- Checks per bank account:
  - **balance_break:** checked day by day, so lines can be in any order within a day.
  - **gap:** more than 35 days with no lines.
  - **duplicate:** the same statement balance means "problem"; with no statement balance it is only a "check".
  - **outlier:** a line booked against the client's own habit (seen 4+ times, booked differently once).
  - **stale:** unallocated for more than 30 days.
  - **sean_auto:** Sean's own postings, listed for a quick look.
- Each finding has a "Show" link that filters the page to the date and switches to the right tab.
- On real data the review found:
  - DroneDog: a missing monthly statement (2025-05-12 → 06-18) and a balance break on 2026-09-01.
  - Two other clients: missing statements.
- 13 tests, all with fictional data.

**Integration point for the local LLM (Ollama, Ruan's other session):** lines with no client history get no suggestion today (about 14% in the backtest). A local-model guess could be added as one more source in `suggestAll()` in `bank-allocation-engine.js`. If so, it should have low confidence: never prefilled, never `autoEligible`. Nothing has been built for this.
