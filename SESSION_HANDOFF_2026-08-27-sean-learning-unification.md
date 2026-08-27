# SESSION HANDOFF — 2026-08-27 — Sean Learning Engine Unification

## What this is

Started as "build a Bank Allocation Learning tab for SEVCO" (mirroring the
existing Paytime/IRP5 tab). User stopped mid-build to ask a bigger question:
across the whole Accounting app, where does Sean's learning actually live,
and should SEVCO be one real unified brain instead of another one-off tab?
Investigation found **three independent, non-integrated learning pipelines**
(`decision-engine.js` "the CORE BRAIN", `bank-learning.js`, `irp5-learning.js`)
that had each separately reimplemented event→pattern→confidence→proposal→
approve/reject. User's explicit instruction: do it properly, once, even if
it's the longer road — "ons doen dit 1 keer reg."

Full plan (context, approach, constraints) is preserved at
`C:\Users\ruanv\.claude\plans\delightful-dancing-pearl.md`.

## What was built

**New file: `backend/sean/learning-engine.js`** — `createLearningDomain(config)`,
the shared implementation of Learning Event Capture, Proposal Engine (pattern
aggregation + confidence + auto-propose), Approval Workflow, optional
Propagation Engine, optional Exception Reporter, and Stats — exactly the
components CLAUDE.md Rule B10/B11 already named as the intended reusable
model. Deliberately did NOT force one confidence formula or one schema onto
both domains — each keeps its own real, live-verified formula and tables via
config, since forcing unification there would have silently changed already-
live pattern confidence scores (Rule A2).

**`irp5-learning.js` and `bank-learning.js` rewritten as thin adapters** over
the shared engine — same exported function names/signatures/return shapes as
before. This means `backend/modules/payroll/routes/items.js` (the CRITICAL,
14-test-regression-gated file per `paytime.protected.json`) and
`backend/sean/irp5-routes.js` needed **zero changes** — confirmed via
`git diff --stat` showing items.js untouched. `sean-webapp/` (a separate,
actively-maintained Next.js app consuming the same `/api/sean/paytime/*`
routes) also needed zero changes for the same reason.

**Two real, confirmed-live bugs found and fixed while rewriting irp5-learning.js:**
1. `getExceptions()` selected a column `payroll_items_master.name` that
   doesn't exist (real column: `item_name`) — confirmed live, it threw
   `column payroll_items_master.name does not exist` on every call. SEVCO's
   "Exception Lookup" section has never worked. Fixed.
2. `propagateApproved()`'s log-row construction referenced `item.name`
   (should be `item.item_name`, the column actually selected) — every
   propagation log row's `payroll_item_name` has always been written as
   NULL. Fixed. Verified live: a test propagation now correctly logs the
   real item name.

**One real, confirmed-live bug found in `sevco.html`'s IRP5 stats:** the
frontend read `stats.totalEvents`/`pendingProposals`/`approvedProposals`/
`totalApplied`/`totalExceptions` — none of which `getStats()` has ever
returned (real fields: `totalLearningEvents`/`pendingApprovals`/
`patternsByStatus.approved`/`totalPropagations`, no exceptions-count field at
all). Confirmed via `sean-webapp/app/paytime/page.tsx`, which correctly reads
the REAL field names and works fine — proving the backend was right and only
`sevco.html` had it wrong. All six IRP5 stat cards have shown "—" since
SEVCO was built. Fixed by correcting the frontend's field reads (not the
backend, to avoid touching sean-webapp's working contract).

**A subtle design bug caught before it shipped:** the first version of
`learning-engine.js` assumed both domains' event tables carry a `source_app`
column and pre-normalized subject/suggestion columns matching the pattern
table's names. Neither is true for both — `sean_bank_learning_events` has no
`source_app` column at all (bank's event table is domain-dedicated, unlike
IRP5's genuinely-shared `sean_learning_events`), and IRP5's event table has
no pre-normalized columns (normalization happens at read-time, unlike bank's
which normalizes at insert-time). Caught via a live test showing
`totalEvents: 0` when 3 real events existed. Fixed by adding a
`eventTableHasSourceApp` config flag and splitting subject/suggestion
extraction into `getEventSubject(ev)`/`getEventSuggestion(ev)` callbacks
instead of assuming shared column names between event and pattern tables.

**SEVCO (`frontend-ecosystem/sevco.html`)** now has a tab bar: "Paytime IRP5
Learning" (existing, stats bug fixed) and "Bank Allocation Learning" (new —
stats/patterns/proposals sections, Approve/Reject wired to
`/api/sean/bank-learning/proposals/:id/authorize|reject`).

**`sean/routes.js`**: added `POST /bank-learning/analyze` (Super Admin,
manual re-analysis trigger — IRP5 already had this, bank didn't). The
`authorize`/`reject` routes' `req.user?.id` → `req.user?.userId` fix (from
earlier this session) is included — those routes had always 401'd since
`sean/routes.js` sits under the shared/global auth middleware (`userId`
only), unlike `modules/accounting/`'s own routes, which have a dedicated
bridge mapping `userId` → `id` specifically for that module (confirmed via
reading `modules/accounting/middleware/auth.js` — this is why an earlier fix
attempt to `bank.js` in this same session was reverted: that file IS under
the accounting bridge, so `req.user.id` was already correct there).

## Verification performed

- `node -c` on all 4 touched/new backend files — clean.
- `npx eslint` — 0 errors (8 pre-existing unrelated warnings in `routes.js`).
- Full server boot smoke test — no crash, "SEAN AI module — ACTIVE".
- Direct function-level tests against live Supabase (company 51 / real
  companies 38/3/7 for multi-client aggregation): bank stats/patterns/
  proposals/suggestAllocation all matched pre-refactor baseline exactly.
  IRP5 full cycle tested with synthetic, clearly-marked test rows (created
  and fully cleaned up afterward): record→analyze produces a pattern with
  the correct confidence math; approve flips pattern status; propagate
  correctly writes only to a NULL-code test item and logs `applied` with
  the now-fixed real item name; a second propagate test confirmed the
  safety rule holds — an existing different code is NEVER overwritten,
  logged as `skipped_exception` on both a pre-populated and a
  freshly-written conflicting item.
- Real HTTP-level test: started the server, logged in as the real master
  admin, selected company 51, hit all 5 relevant live endpoints
  (`/api/sean/bank-learning/stats|patterns|proposals`,
  `/api/sean/paytime/stats|patterns`) — all returned 200 with correctly
  shaped data, confirming the `requireSuperAdmin` auth chain still works
  end-to-end through real middleware, not just direct function calls.
- `git diff --stat` confirms `items.js` and `irp5-routes.js` have zero
  changes — the CRITICAL payroll regression gate in `paytime.protected.json`
  genuinely does not apply to this work.

## Follow-up note (explicitly out of scope, documented in the plan)

`decision-engine.js`'s `learn()` writes to the cross-company
`sean_global_patterns` table with **no Super Admin approval gate at all** —
unlike `bank-learning.js`/`irp5-learning.js`, which both correctly implement
Rule B2. Flagged, not fixed — `decision-engine.js` is live under
`/api/sean/suggest`, `/api/sean/learn`, `/api/sean/chat`, the Practice
module, Paytime chat, and the (orphaned but functional, no frontend anywhere)
`universal-importer`. A much larger blast radius than this session's scope.
Full follow-up note text is in the plan file.

## Not yet done

- User has not yet clicked through `sevco.html`'s new Bank Allocation tab in
  a real browser (all verification above is backend/API-level).
- The `decision-engine.js` governance gap above needs its own dedicated
  decision in a future session.
