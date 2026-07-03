# Session Handoff — Codebox 62: Practice Secretarial Foundation

> Date: 2026-07-03
> Status: COMPLETE — migration 119 NOT yet applied to Supabase — not committed or pushed
> Codeboxes 60 (Learning Centre) and 61 (Client Success) are ALSO still uncommitted from prior session turns — all three are staged together for the next push.

---

## What Was Built

### An audit that reshaped the whole profile table before a line of it was written

Before designing migration 119, an audit of `practice_clients` and `practice_taxpayer_profiles` (per RULE A1 and the codebox's own "Audit first" instruction) found that half the spec's requested Secretarial Profile fields already exist:

- `practice_clients.registration_number`, `.vat_number`, `.coida_registration_number` — CIPC registration, VAT, and COIDA numbers
- `practice_taxpayer_profiles.income_tax_reference` — income tax number
- `practice_taxpayer_profiles.financial_year_end` — a proper per-client `DATE`, from an earlier out-of-session codebox (Codebox 25, Taxpayer Profile Foundation)

None of these were re-added to `practice_secretarial_profiles`. `getCorporateProfile()` cross-references them live instead. This meant the actual new-field list was shorter and more precise than the spec's literal listing suggested: company type, registration date, registered/postal address, company status, CIPC status, PAYE/SDL/UIF numbers (confirmed genuinely absent everywhere — only a boolean `paye_registered` flag exists, not the number), auditor, company secretary, financial officer. See `docs/new-app/62_secretarial_foundation.md` Architect Freedom #1-#3 for the full reasoning.

### The Timeline was built as a read, not a table

The spec's own Database section lists five tables, no separate timeline table — and the Timeline section's field list ("Director appointed, Director resigned, Share transfer, Annual return, Company detail change, Manager notes") maps exactly onto the append-only `practice_secretarial_events`' `event_type` enum. `GET /:clientId/timeline` reads that table directly. This avoided building a second table that would have duplicated the events log for no benefit.

### Two engine functions with two different weights, exported for two different consumers

`getCorporateProfile(cid, clientId)` is the full aggregation the spec's Secretarial Engine section describes — profile, directors, shareholders, annual returns, timeline, and computed `upcoming_statutory_actions`. `getGovernanceSummary(cid, clientId)` is a deliberately lighter, separate export built specifically so Client Success (Codebox 61) could show "outstanding annual returns / governance concerns" without pulling in the full profile payload or coupling to secretarial.js's complete response shape. This follows the same "match the weight of the read to what the consumer actually needs" judgment already applied to Planning Board's competency badge (Codebox 59) and at-risk-client badge (Codebox 61).

### Backend — `secretarial.js` (~17 endpoints)

Key judgment calls:

**No `DELETE` routes anywhere.** A resigned director, a transferred shareholder, and a submitted annual return are all historically meaningful states — the same append-and-correct convention already established for Client Success meetings/opportunities (Codebox 61) and Learning Centre plans (Codebox 60), applied here for the first time to directors/shareholders/returns specifically.

**Director `shareholding_pct` is kept even though it can drift from the Shareholders register.** This was a literal, explicit spec field (Directors section lists it separately from the entire Shareholders section) — not invented, and flagged clearly in the migration comments and docs so a future reader doesn't mistake it for an oversight or try to "fix" the apparent duplication.

**`cipc_status` is free text; `company_status` is a constrained enum.** CIPC's own status vocabulary is externally defined and not this app's to hard-code — the same reasoning already used for CPD category (Codebox 60). `company_status` is the app's own internal, constrained lifecycle state.

### Frontend — `secretarial.html` + `js/secretarial.js` (prefix `sec`)

- Summary cards (profiles, active companies, needs-attention count, active directors, returns overdue/pending/submitted)
- A client picker (backed by the pre-existing `GET /api/practice/clients`), supporting a `?client_id=` deep-link parameter
- Once a client is selected: 5 tabs — Corporate Profile (reused fields shown as clearly-labeled read-only cards above the editable secretarial-only form), Directors, Shareholders, Annual Returns, Timeline
- No chart library, no AI, matching every codebox this session

### Integrations

**Client Detail**: a new Section 22 ("Secretarial"), following the exact same hidden-until-loaded / lightweight-summary / "View All" link pattern as every other client-detail section (Taxpayer Profiles, Provisional Tax, etc.) — no inline CRUD, full editing only on `secretarial.html` itself.
**Planning Board**: `_buildTeamItemPool()` attaches an `annual_return_due` boolean per work item (same lightweight-direct-query pattern as the at-risk-client badge), rendered as a soft "📋 Annual Return Due" badge.
**Client Success**: `GET /:clientId` now includes a `governance` block from `getGovernanceSummary()`, wrapped in `.catch()` so a Secretarial failure can never break the Client Success detail view, rendered as a governance-concern line when applicable.

---

## Nothing Regressed

- `practice_clients` and `practice_taxpayer_profiles` — completely untouched; both are only read from, never written to, by this codebox.
- `client-success.js`'s existing ~20 endpoints, `calculateClientHealth()`, and all Codebox 61 behavior are unchanged — the only addition is one new `Promise.all` entry (governance summary, defensively wrapped) and one new response field.
- `planning-board.js`'s `_buildTeamItemPool()` — the existing `workQueue.buildActiveQueue()` reuse chain, cache invalidation, and the Codebox 61 `at_risk_client` flag are unchanged; `annual_return_due` is a new, additive field.
- `client-detail.html`/`js` — all 21 existing sections and their load functions are unchanged; Section 22 and `loadClientSecretarial()` are purely additive.
- `client-health.js`, `work-queue.js`, `capacity.js`, `delegation.js`, `skills-matrix.js`, `learning-centre.js`, `notifications.js` — completely untouched.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run, in order:
1. `117_practice_learning_centre.sql` (still pending)
2. `118_practice_client_success.sql` (still pending)
3. `119_practice_secretarial_foundation.sql`

Expected: "Success. No rows returned." for each.

No seeding step is required or provided — secretarial profiles, directors, shareholders, and annual returns all start empty and are created entirely by managers as needed. `practice_secretarial_profiles` rows are also created lazily on first `PUT /:clientId/profile` (via `_getOrInitProfile()`), so no bulk backfill is needed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migrations 117, 118, and 119 to Supabase
2. Navigate to `/practice/secretarial.html` — should show zeroed summary cards and an empty client picker prompt
3. Select a client → confirm the "Reused from Other Modules" card shows the client's registration/VAT/COIDA numbers if set on that client, and "—" for any that aren't; confirm Income Tax Number / Financial Year-End show "—" if the client has no taxpayer profile yet (not an error)
4. Fill in Corporate Profile fields (company type, status, addresses, PAYE/SDL/UIF, auditor, secretary, financial officer) → Save → confirm they persist on reload; confirm the Timeline tab shows a "Profile Created" event on first save
5. Add a director with a future appointment date → confirm it appears with status "Active"; click "Resign" → confirm status becomes "Resigned" with today's date auto-filled as resignation date, and the Timeline logs "Director Resigned"
6. Add a shareholder, then click "Mark Transferred" → confirm status becomes "Transferred" with today's date auto-filled, Timeline logs "Share Transferred"
7. Add an annual return with a due date in the past → confirm "Upcoming Statutory Actions" on the Corporate Profile tab shows it flagged OVERDUE; click "Mark Submitted" → confirm it disappears from upcoming actions and Timeline logs "Annual Return Submitted"
8. Add a manager note via the Timeline tab → confirm it appears immediately with the note text
9. As a non-manager, attempt to save the profile, add a director/shareholder/return, or add a note → confirm 403 on each; confirm all `GET` reads (profile, directors, shareholders, returns, timeline) still succeed
10. Go to `/practice/client-detail.html?id=<clientId>` for a client with secretarial data → confirm the new "Secretarial" section shows the company status, active director count, and next upcoming action; confirm "Open in Secretarial →" navigates to `/practice/secretarial.html?client_id=<clientId>` and the client is pre-selected automatically
11. For a client with NO secretarial profile yet, confirm Client Detail's Secretarial section shows the "No secretarial profile yet" fallback message with a working link
12. Go to `/practice/planning-board.html`, view items for a client with an annual return due within 60 days or overdue → confirm the "📋 Annual Return Due" badge appears and does not affect priority ordering; confirm it can appear alongside the "⚠ At-Risk Client" badge on the same item without visual collision
13. Go to `/practice/client-success.html`, open a client's detail with an overdue annual return → confirm a "⚠ Governance: N outstanding annual return(s)" line appears in the relationship health breakdown; confirm a client with zero active directors instead shows "No active directors on record"; confirm a client with neither issue shows no governance line at all
14. Log in as a different company → confirm zero cross-company secretarial profiles/directors/shareholders/annual returns/events visible
15. DevTools → Application → Storage → confirm no secretarial data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Planning Board's "Director change pending" and "Statutory reminder" warnings (both listed in the spec) were not built
- Confirmed now: This foundation codebox stores statutory information but has no concept of a pending CHANGE — there is no workflow state for "a director appointment is in progress." Only "Annual return due" (a real, available data point — practice_annual_returns rows with status pending/overdue) was integrated. Building a fake "pending" flag with no underlying process to drive it would have been exactly the kind of invented, unrequested feature this project's rules caution against.
- Not yet confirmed: The exact shape Codebox 63's statutory change workflow will take, and therefore what "pending" should mean for a Planning Board badge.
- Risk: None currently — a genuinely unspecified feature was correctly left unbuilt rather than guessed at.
- Recommended: When Codebox 63 (Practice Secretarial Workflows + Statutory Change Management) introduces workflow state for director/shareholder/detail changes, add the same lightweight-direct-query badge pattern already used for at-risk-client and annual-return-due to Planning Board's _buildTeamItemPool().
```

```
FOLLOW-UP NOTE
- Area: Director shareholding_pct (on practice_company_directors) can drift from a matching row in practice_company_shareholders
- Confirmed now: This is a literal, explicit field in the spec's Directors section, kept exactly as specified — not an accidental duplication. See docs/new-app/62_secretarial_foundation.md Architect Freedom #4.
- Not yet confirmed: Whether managers will find the two numbers drifting confusing in practice once real data accumulates, or whether a future codebox should compute director shareholding_pct FROM the shareholder register instead of storing it independently.
- Risk: Low — both fields are simple NUMERIC columns; reconciling or deriving one from the other later is a small, isolated change with no schema migration needed (shareholding_pct can simply stop being writable and become computed).
- Recommended: Revisit only if this becomes a real point of confusion in practice; do not preemptively "fix" a spec-literal field.
```

```
FOLLOW-UP NOTE
- Area: No document attachment/CIPC filing document storage for annual returns, director appointments, etc.
- Confirmed now: Explicitly out of scope per the spec's Future Enhancements section ("document generation" listed as NOT to build) and the Architecture Boundaries section ("document management... those systems remain owners"). document-requests.js already exists as the practice's general document-tracking module; Secretarial does not duplicate it.
- Not yet confirmed: Whether a future codebox should add a lightweight cross-reference (e.g. linking a practice_document_requests row to a specific annual_return_id) rather than leaving the two modules fully unconnected.
- Risk: Low — no functionality is broken; this is a discoverability/workflow convenience gap, not a data-integrity one.
- Recommended: Consider this as part of Codebox 63's workflow design, where a statutory change naturally has supporting documents (e.g. a signed resolution for a director appointment) that document-requests.js could track.
```
