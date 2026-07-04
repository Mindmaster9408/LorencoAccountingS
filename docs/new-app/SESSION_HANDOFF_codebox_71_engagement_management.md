# Session Handoff — Codebox 71: Practice Engagement Management + Engagement Letter Foundation

> Date: 2026-07-03
> Status: COMPLETE — migration 128 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### A pre-build audit that changed the entire approach

The spec explicitly required auditing for an existing engagement system before building anything. That audit (dispatched to a research subagent) found a **complete, live engagement system already in production**: `practice_service_catalog`, `practice_client_engagements`, `practice_client_engagement_events` (migration 065, Codebox 15), `practice_engagement_periods` (migration 067, Codebox 16), and a 638-line router `engagements.js` mounted at the practice router's root. This codebox was built entirely as an **enhancement layer** on top of that system, per explicit instruction — not a single line of `engagements.js` was touched.

### The one fact that shaped every design decision: a live functional dependency

`engagements.js`'s `generate-workflow`/`generation-preview` endpoints gate on the legacy `status` column being exactly `'active'` — confirmed by reading the actual router code (lines 481, 502), not assumed. This is a real, live cross-module dependency, not just a naming convention. It meant the new, richer `engagement_status` (10 values) couldn't simply coexist with the old `status` (4 values) the way Codebox 68 let `current_lifecycle_status` coexist with `company_status` — this module had to actively keep `status` in sync for the transitions where a clean equivalent exists (active/paused/ended/cancelled), while still leaving it alone for the five statuses that have no clean legacy equivalent (draft/proposed/under_review/renewal_due/renewed). This distinction — when to sync vs. when to let two models diverge — is the single most important design decision in this codebox, and it's documented in three places (migration header, router header, and this handoff) so a future session never has to re-derive it.

### A second, subtler edge case found and handled: pre-existing engagements after the ALTER

Every engagement created before this migration (or via the still-untouched `engagements.js` router) will get `engagement_status = 'draft'` from the new column's own DEFAULT — even though its real, legacy `status` might already be `'active'`. If this module's own "is this engagement active" logic checked only the new column, every pre-existing engagement in the practice would suddenly look inactive to the new work-coverage-gap detector and client engagement profile — a real, silent regression that would have been easy to miss. `_isEffectivelyActive()` checks both columns (new OR legacy) specifically to prevent this.

### Two gates, both blocking, both auditable, neither silent

Risk acceptance and engagement-letter status both gate `activate` (risk also gates `resume`). The risk gate supports an audited inline override (`override_risk_reason` on the same activate/resume call) so a manager doesn't need two round trips for a decision they've already made; the letter gate has no override shortcut at all — the only way through is to actually resolve the letter (sign or waive it, both of which are themselves audited actions requiring evidence of a real decision). The letter gate was also deliberately read more broadly than the spec's literal trigger text ("if required") to close an obvious loophole (a letter that's been drafted or sent but never signed shouldn't unblock activation just because its status moved off the literal string "required").

### Backend — `engagement-management.js` (~25 endpoints)

Mounted at its own dedicated prefix (`/engagement-management`), never at the practice router's root where the existing engagement routers live — this was a deliberate, low-risk choice explicitly favored by the spec's own instruction ("prefer compatibility over rewrite... mounted separately").

### Frontend — `engagement-management.html` + `js/engagement-management.js` (prefix `em`)

Company-wide "All Engagements" list (filterable by status/risk) plus a client-picker-first "Client Profile" tab (active services, possible gaps, due-for-review/renewal-due/missing-letters/high-risk counts), and an Engagement Detail modal with Scope/Risk/Letters/Events sub-tabs and a fully status-driven action bar.

### Integrations

**Client Onboarding**: read-only status/readiness panel — no starter engagement is ever auto-created (the spec's own "do not guess service scope" instruction ruled that out; a starter engagement needs a name and service category, neither of which can be inferred from an entity type).
**Client Success**: an engagement summary panel added to the existing client detail modal.
**Management Dashboard**: a new KPI section with all four spec-named KPIs, including a cheap company-wide approximation of "clients with work but no engagement" (comparing clients with any tax/secretarial/time-entry record against clients with any active engagement — not the fully-typed per-service-line gap detection the client profile performs, which would be too expensive to run for every client on every dashboard load).
**Planning Board**: a new `engagement_risk_unaccepted` badge, following the exact same lightweight direct-query pattern established for every other Planning Board badge this session.

---

## Nothing Regressed

- `engagements.js` and `engagement-periods.js` — **zero lines changed**. Every one of their 16 + 7 endpoints, `fetchEngagement()`, `logEngagementEvent()`, `ENGAGEMENT_STATUSES`, and their live generate-workflow gate all behave exactly as before.
- `practice_service_catalog`, `practice_client_engagement_events`, `practice_engagement_periods` — completely untouched; not read from or written to by this codebox at all.
- `practice_client_engagements` — every existing column, every existing row, every existing value is preserved; the ALTER only adds new nullable-or-defaulted columns, none of which changes the meaning of any existing column.
- `client-onboarding.js`, `client-success.js` — every existing endpoint/render path is unchanged; the new engagement panels are additive fetches wrapped in their own error handling, never blocking the rest of the page if they fail.
- `management-dashboard.js`'s `computeSummary()` — every existing key is unchanged; `engagement_management` is a new, additive key.
- `planning-board.js`'s `_buildTeamItemPool()` — every existing flag is unchanged; `engagement_risk_unaccepted` is a new, additive field.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep.
- All files verified present on disk immediately after writing.
- A copy-paste artifact (a stray SQL-style `--` comment inside the JS router's header, which would have been a syntax error) was caught and fixed during self-review before `node --check` was even run.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`128_practice_engagement_management_letters.sql`

Expected: "Success. No rows returned." This migration ALTERs an existing, live table (`practice_client_engagements`) — all changes are `ADD COLUMN IF NOT EXISTS`, so it is safe to re-run and will not affect any existing row's existing column values. Every existing engagement will pick up `engagement_status = 'draft'` (the new column's default) and `risk_level = 'low'`/`engagement_letter_status = 'not_required'` (their defaults) immediately after this migration runs — see the Testing section below for how to reconcile pre-existing active engagements.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 128 to Supabase
2. **First**, check any pre-existing engagements created via the OLD `/practice/services.html`-adjacent flow (if any exist in this environment) — confirm their `engagement_status` shows as `'draft'` but their legacy `status` is still whatever it was before (likely `'active'`); confirm `/practice/engagement-management.html`'s "All Engagements" list still surfaces them correctly (via `_isEffectivelyActive()`'s OR logic) rather than treating them as inactive
3. Navigate to `/practice/engagement-management.html` — should show zeroed summary cards (or non-zero if step 2 found pre-existing data)
4. Create a new engagement (draft status) for a client — confirm the legacy `status` column is explicitly set to `'paused'` at creation (not silently defaulting to `'active'`)
5. Click Propose → confirm `engagement_status` becomes `proposed`
6. Set `risk_level = high` on that engagement (via PUT), then attempt Activate → confirm 422 with `requires_risk_acceptance: true`
7. Call Accept Risk with a reason → confirm `risk_accepted_by`/`risk_accepted_at`/`risk_acceptance_reason` are set, then Activate succeeds — confirm the legacy `status` column becomes `'active'`
8. Go to `/practice/services.html` (or wherever the OLD engagements.js frontend lives) and attempt Generate Workflow on this now-active engagement → confirm it works (proving the legacy `status` sync actually satisfies the live cross-module dependency)
9. Create an engagement letter, mark it Sent, then attempt to Activate a DIFFERENT engagement whose `engagement_letter_status` is still `required` → confirm 422 with `requires_letter_resolution: true`
10. Waive that engagement's letter requirement with a reason → confirm activation now succeeds
11. Complete the full lifecycle on one engagement: Activate → Start Review → Complete Review → Mark Renewal Due → Renew → End (with a reason) → confirm each transition's event appears in the Events tab and the legacy `status` column updates only where expected (active/paused/ended/cancelled transitions)
12. On the Client Profile tab, pick a client with a tax profile but no active tax-type engagement → confirm a `possible_gap` appears
13. Go to `/practice/client-success.html`, open a client with active engagements → confirm the new Engagements panel shows correctly
14. Go to `/practice/client-onboarding.html` for a client with no engagements yet → confirm the Engagement Status panel shows "no active engagements" messaging, and confirm NO starter engagement was auto-created
15. Go to `/practice/management-dashboard.html` → confirm the new "Engagement Management" KPI section shows counts matching the Engagement Management page
16. Go to `/practice/planning-board.html` for a client with a high-risk, unaccepted engagement → confirm the "🛑 Risk Not Accepted" badge appears
17. As a non-manager, attempt any write endpoint (create/update/any lifecycle action/any letter action) → confirm 403 on each; confirm all `GET` reads still succeed
18. Log in as a different company → confirm zero cross-company engagements/letters/events visible
19. DevTools → Application → Storage → confirm no engagement data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Pre-existing engagements (created via the legacy engagements.js router before this migration) start with engagement_status='draft' by default, which does not reflect their true, already-active state.
- Confirmed now: _isEffectivelyActive() checks the legacy `status` column too, so these engagements are correctly treated as active by every read-path in this module (client profile, work-coverage gaps, dashboard KPIs, Planning Board badge).
- Not yet confirmed: Whether the practice wants a one-time backfill (a manual, reviewed script — NOT part of this migration) to set engagement_status='active' explicitly on every pre-existing engagement whose legacy status is already 'active', so the new richer field reflects reality without relying on the OR-fallback indefinitely.
- Risk: Low — the OR-fallback is correct and permanent, not a stopgap; a backfill would only be a cosmetic/data-quality improvement, not a functional necessity.
- Recommended next review point: If the practice wants engagement_status to be the sole source of truth for reporting/filtering (e.g. filtering "All Engagements" by engagement_status=active should show every truly-active engagement), a reviewed backfill script would achieve that. Until then, the "All Engagements" list's own filter dropdown filters on engagement_status directly, which WILL miss pre-existing active-via-legacy-status-only engagements — a real, small UX gap worth noting.
```

```
FOLLOW-UP NOTE
- Area: "Clients with work but no engagement" KPI on Management Dashboard is a cheaper, coarser approximation than the client-level possible_gap detection
- Confirmed now: The dashboard KPI checks "any tax/secretarial/time-entry record vs. zero active engagements of ANY type," while the client profile's possible_gap detection checks per-service-line (tax work needs a TAX-type engagement specifically, not just any engagement).
- Not yet confirmed: Whether partners reviewing the dashboard KPI will expect it to match the more precise per-client gap count exactly.
- Risk: Low — the dashboard number will always be less than or equal to the sum of true per-service-line gaps (a client with an accounting engagement but no tax engagement won't show in the coarse dashboard count, but WOULD show as a gap on their own Client Profile page). This is a conservative undercount, not an overcount, so it will never cause false alarm — just potential under-alarm.
- Recommended: If partners want dashboard-level precision to match, the KPI would need to run the full per-client gap detection for every client company-wide, which is a real performance tradeoff to weigh against the current cheap approximation.
```
