# Session Handoff — Codebox 67: Secretarial Statutory Calendar + Compliance Scheduler

> Date: 2026-07-03
> Status: COMPLETE — migration 123 NOT yet applied to Supabase — not committed or pushed
> Codeboxes 60-65 are ALSO still uncommitted from prior session turns — all seven are staged together for the next push.
> Note: Codebox 66 (Secretarial Document Checklist + Governance Evidence Requests) was skipped by the user's own request sequence — this codebox picks up at 67 as instructed, no assumption made about 66 having been built.

---

## What Was Built

### An audit of the actual `practice_deadlines` schema, not an assumption about it

Before writing migration 123, the spec's central instruction — "reuse existing Practice Deadlines... if an equivalent deadline already exists, link, never duplicate" — required knowing exactly what `practice_deadlines` already looks like. Reading migrations 007 (original 3-column table), 011, and 058 (both extending it) confirmed it already has `deadline_type`, `compliance_area`, `due_date`, `status`, `reminder_date`, and more. `_resolveOrCreateDeadline()` in `secretarial-calendar.js` matches on `(client_id, deadline_type, due_date)` before ever inserting — the single choke point every schedule-generating path passes through, whether from automatic recurrence or a manually-added schedule entry.

### Categories computed live, never stored — the same discipline applied a sixth time this session

A schedule row's `status` column only ever holds three real lifecycle states a manager sets (`pending`/`completed`/`cancelled`). Everything temporal — `upcoming`/`due_today`/`overdue`/`blocked`/`waiting`/`future` — is derived fresh by `buildStatutoryCalendar()` on every read from `due_date`, `warning_date`, `grace_end_date`, and live dependency resolution. This mirrors BO readiness (Codebox 65), Client Success cadence (Codebox 61), and Learning Centre progress (Codebox 60) — a now well-established pattern in this codebase: store only what a human actually decided, compute everything time-dependent fresh.

### `blocked` vs. `waiting` — resolving a genuine ambiguity in the spec's wording

Both are listed as distinct scheduler output buckets, both triggered by "an unsatisfied dependency," with no further distinction given. Rather than treat them as redundant synonyms, they were implemented to mean genuinely different things: `blocked` = the dependency is unsatisfied AND the item is actually due or overdue (real, current pressure); `waiting` = the dependency is unsatisfied but the item is still comfortably in the future (a known future gate, not yet urgent). This makes both buckets independently useful instead of one being a dead code path.

### Dependency resolution reuses Codebox 65's BO engine instead of guessing at BO readiness a second time

`_isDependencySatisfied()` for `depends_on_type = 'bo_review'` calls `beneficialOwnership.getBeneficialOwnershipProfile()` and checks `readiness.status === 'ready'` — the exact same readiness computation the Beneficial Ownership page itself shows, never re-implemented. `evidence_complete` and `governance_complete` dependency types have no automatic check available (Codebox 66, which might have built exactly this evidence-tracking capability, was not present in this session) — these honestly report "requires manager confirmation" rather than a fabricated pass/fail, and can only be satisfied via an explicit, audited manager override.

### Two different cost tradeoffs for two different call frequencies, both deliberate

Planning Board renders statutory badges on every work item across every board load — here, cheap approximate direct queries were used (same reasoning as Codebox 65's BO badge), explicitly trading precision for not calling the full scheduler N times per page render. Management Dashboard calls `buildStatutoryCalendar()` directly and only once per dashboard load — there the correctness of the authoritative computation was worth the one-time cost, and the spec's own priority ordering (Dashboard visibility ranked #5, a real deliverable) supported that choice. Both decisions are documented explicitly rather than left for a future reader to wonder why the two integrations don't behave identically.

### Backend — `secretarial-calendar.js` (~20 endpoints)

**Recurrence generation is idempotent**, checking existing `period_label`s before inserting (backed by a DB-level unique constraint as a safety net) — a manager can click "Generate Schedule" repeatedly as time passes and new occurrences become due, without duplicating what's already there or needing a destructive regenerate-everything flow.

**Anchor dates are read live from existing cross-referenced data, never duplicated onto the obligation.** `registration_date` comes from `practice_secretarial_profiles` (Codebox 62); `financial_year_end` comes from `practice_taxpayer_profiles` (Codebox 62's own established cross-reference, tracing back to Codebox 25). No obligation row stores its own copy of either.

### Frontend — `secretarial-calendar.html` + `js/secretarial-calendar.js` (prefix `sc`)

- A company-wide page (not client-picker-first), matching the spec's framing — "one statutory calendar... for every client"
- Summary cards, 6 tabs (Calendar / Upcoming / Overdue / Blocked / Completed / Templates)
- **A real display bug was caught and fixed during self-review**: the Templates tab initially rendered raw numeric `client_id` values instead of client names. Fixed by loading the client name lookup once (already needed for the Create Obligation dropdown) and reusing it in the obligations table render, sequencing `scLoadObligations()` to run only after that lookup is populated.
- No chart library, no AI, no graph visualization

### Integrations

**Management Dashboard**: a new "Statutory Compliance" KPI section (overdue/due-today/upcoming/blocked), backed by a direct `buildStatutoryCalendar()` call.
**Planning Board**: `statutory_workload_upcoming`/`statutory_workload_blocked` badges via cheap, approximate direct queries.
**Secretarial page**: a "Statutory Compliance" panel per client (counts + next few items + blocked callout) plus a deep link into the full calendar.

---

## Nothing Regressed

- `beneficial-ownership.js`'s existing ~26 endpoints and `getBeneficialOwnershipProfile()` (Codebox 65) are unchanged — `secretarial-calendar.js` only calls the already-exported function, read-only.
- `practice_deadlines` (migrations 007/011/058) — read and selectively inserted into via the resolve-or-create helper; no existing row is ever updated or deleted by this codebox.
- `management-dashboard.js`'s `computeSummary()` — every existing key (including `beneficial_ownership` from Codebox 65) is unchanged; `statutory_compliance` is a new, additive key wrapped in its own try/catch so a scheduler failure can never break the rest of the dashboard.
- `planning-board.js`'s `_buildTeamItemPool()` — the existing at-risk-client, annual-return-due, pending-statutory-change, and BO-readiness-concern flags (Codeboxes 61-65) are unchanged; `statutory_workload_upcoming`/`statutory_workload_blocked` are new, additive fields.
- `secretarial.html`/`js` — the existing Corporate Profile/Directors/Shareholders/Annual Returns/Timeline/Statutory Changes/Governance/Beneficial Ownership panels are unchanged; the new "Statutory Compliance" panel is purely additive.
- `secretarial.js` (Codebox 62), `secretarial-workflows.js` (Codebox 63), `secretarial-governance.js` (Codebox 64) — completely untouched; this codebox does not require or call into any of them.
- `client-health.js`, `client-success.js`, `work-queue.js`, `capacity.js`, `delegation.js`, `skills-matrix.js`, `learning-centre.js`, `notifications.js` — completely untouched.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run, in order:
1. `117_practice_learning_centre.sql` (still pending)
2. `118_practice_client_success.sql` (still pending)
3. `119_practice_secretarial_foundation.sql` (still pending)
4. `120_practice_secretarial_workflows.sql` (still pending)
5. `121_practice_secretarial_resolutions_minutes.sql` (still pending)
6. `122_practice_secretarial_beneficial_ownership.sql` (still pending)
7. `123_practice_secretarial_calendar.sql`

Expected: "Success. No rows returned." for each.

No seeding step is required or provided — obligations, schedule entries, dependencies, and events all start empty and are created entirely by managers as needed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migrations 117 through 123 to Supabase
2. Navigate to `/practice/secretarial-calendar.html` — should show zeroed summary cards and empty tabs
3. On the Templates tab, create an obligation: `obligation_type: annual_return`, `frequency: annual`, `anchor: registration_date`, for a client with a registration date on file in Secretarial → click "Generate Schedule" → confirm a schedule entry appears with the correct due date (registration date's anniversary, at or after today)
4. Confirm a NEW row also appears in `practice_deadlines` (check `/practice/deadlines.html` or the DB) with `deadline_type: cipc_annual_return` — this proves the sync created rather than skipped
5. Create a SECOND obligation for the same client that would resolve to the SAME due date/deadline_type (e.g. by manually adding a schedule entry via `POST /schedule` with a matching due_date) → confirm `practice_deadlines` gets no duplicate row — the existing one is linked instead
6. Click "Generate Schedule" again on the same obligation → confirm no duplicate schedule rows are created (idempotent)
7. Create a `financial_year_end_review` obligation with `anchor: financial_year_end` for a client with NO taxpayer profile on file → click "Generate Schedule" → confirm a clear message explains the anchor date couldn't be resolved, and no schedule rows are created
8. Add a dependency to a schedule entry with `depends_on_type: bo_review` for a client whose BO readiness is NOT "ready" → confirm the item shows as "Blocked" (if due/overdue) or "Waiting" (if still in the future) on the Calendar tab
9. Override that dependency with a reason → confirm the item's category becomes normal (upcoming/due_today/overdue based on its date) again
10. Mark a schedule entry "Complete" → confirm it moves to the Completed tab with a timestamp, and confirm an event was logged
11. Go to `/practice/management-dashboard.html` → confirm the new "Statutory Compliance" KPI section shows counts matching the calendar page
12. Go to `/practice/planning-board.html` for a client with an upcoming/blocked statutory item → confirm the "📅 Statutory Due Soon" / "📅 Statutory Blocked" badge appears
13. Go to `/practice/secretarial.html`, select a client with schedule entries → confirm the "Statutory Compliance" panel shows matching counts and a few upcoming/overdue items
14. As a non-manager, attempt to create/edit any obligation/schedule/dependency, or override a dependency → confirm 403 on each; confirm all `GET` reads still succeed
15. Log in as a different company → confirm zero cross-company obligations/schedule/dependencies/events visible
16. DevTools → Application → Storage → confirm no statutory calendar data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: 'evidence_complete' and 'governance_complete' dependency types have no automatic satisfaction check — always require manager override
- Confirmed now: Codebox 66 (Secretarial Document Checklist + Governance Evidence Requests), which was the natural home for an "evidence complete" concept, was not built in this session (the user's own instructions jumped from Codebox 65 to Codebox 67). Rather than invent a fake automatic check against non-existent evidence-tracking infrastructure, these dependency types honestly report "requires manager confirmation."
- Not yet confirmed: Whether a future Codebox 66 (or equivalent) should retroactively wire these two dependency types into whatever evidence/checklist system it builds.
- Risk: None currently — the behavior is safe-by-default (never fakes satisfaction); a manager override is always available in the meantime.
- Recommended: When a document/evidence checklist module is eventually built, revisit _isDependencySatisfied() in secretarial-calendar.js and add real checks for these two types, following the same reuse pattern already established for 'bo_review'.
```

```
FOLLOW-UP NOTE
- Area: Client Detail's Secretarial section (Section 22, extended across Codeboxes 62-65) was NOT extended to show statutory calendar data in this pass
- Confirmed now: The spec's Secretarial Integration section only explicitly asks for the Secretarial page (not Client Detail) to show "Upcoming obligations, Compliance readiness" — Client Detail integration wasn't named for this codebox the way it was for 62-65. Scoped out deliberately rather than assumed.
- Not yet confirmed: Whether a future codebox should add a "Latest statutory obligations" line to Client Detail's Section 22, matching the pattern already used there for changes/governance/BO.
- Risk: None — Client Detail's existing Secretarial section is unaffected; this is a discoverability gap, not a functional one, and the Secretarial page itself (one click away) shows this data per-client already.
- Recommended: If requested, this is a small, low-risk addition following the exact template already used 3 times in client-detail.js for Codeboxes 63-65.
```

```
FOLLOW-UP NOTE
- Area: Planning Board's statutory badges use an approximation (plain date/dependency-existence filters), not the exact buildStatutoryCalendar() categorization
- Confirmed now: Deliberate cost tradeoff — see docs/new-app/67_secretarial_calendar.md Architect Freedom #9. "Blocked" specifically is approximated as "has any non-overridden dependency AND is due within 30 days," which is close to but not identical to the scheduler's own due/overdue distinction for the blocked category.
- Not yet confirmed: Whether this approximation ever meaningfully diverges from the authoritative calendar in practice (e.g. flagging something as blocked-ish that the real scheduler would call waiting, or vice versa).
- Risk: Low — the badge is explicitly informational/non-blocking (never affects priority ordering), and the authoritative view is one click away on the Statutory Calendar page itself.
- Recommended: Monitor for confusion in practice; if it becomes a real problem, consider a lightweight cached/batch version of buildStatutoryCalendar() computed once per company per Planning Board load rather than per-client-per-badge.
```
