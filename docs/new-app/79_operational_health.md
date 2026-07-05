# Codebox 79 — Practice Operational Health Centre + System Readiness Monitor

> App: Lorenco Practice Management
> Status: Complete — migration 136 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Is the platform ready?" — a read-only monitor that audits every other Practice module for module health, configuration validity, migration readiness, automation health, role-link integrity, stale data, and broken cross-module references, then reduces the result to a deterministic production-readiness score and a fixed pilot-readiness checklist.

**This is NOT AI, NOT a new business module, NOT cron.** Every check runs only when a manager explicitly clicks "Run Health Check Now." The module never writes to any table outside its own two (`practice_health_check_runs`/`_events`) — it reads everything else, never mutates it.

## Mandatory Pre-Build Audit — Key Findings

No pre-existing health-check/readiness table exists anywhere. Unlike every prior codebox (which reused compute *functions*), this module reads dozens of existing tables directly — that IS its job — but never re-derives another module's own business logic or scoring:

- `alert-rules.js` exports `getRules()` (Codebox 53) — reused directly for the configuration-health check (confirms the central rules engine resolves without throwing for this company).
- `secretarial.js`'s profile pattern informed the practice-profile check, but the actual check reads `practice_profiles` (the firm's own identity row, migration `054_practice_profile.sql`) passively — never calls a get-or-init function that would create a row as a side effect of a read-only health check.
- `lib/team-access.js`'s `getMyTeamMember()` self-heal logic (this session's root-cause fix) is the **direct origin** of the role-link-integrity check. This module formalizes permanent, visible monitoring for the exact class of bug (`practice_team_members.user_id` left `NULL`) that caused the 2026-07-05 Planning Board access incident. The health check is **read-only** — it reports counts and candidate matches; it never writes a fix itself. Self-healing still only happens the moment the affected person next logs in and hits any manager-gated route, exactly as `lib/team-access.js` already does.
- `practice_kpi_snapshots`, `practice_automation_rules`/`runs` (Codebox 78), `practice_executive_reports` (Codebox 77), `practice_reminders`, `practice_notifications` (Codebox 54) are read directly for staleness/integration checks that no existing module currently tracks — this is the first place these thresholds are centralized, not a duplicate of anything.
- **Migration-directory finding (important, documented, not fixed here):** this app's migrations are split across two directories — `accounting-ecosystem/database/migrations/` (early ecosystem-wide + foundational practice tables, 054–056) and `accounting-ecosystem/backend/config/migrations/` (every Codebox from 46 [057] onward) — with independently-numbered, overlapping filenames (e.g. two different `054_...sql`/`055_...sql`/`056_...sql` files exist, one per directory). A migration-readiness check based on counting `.sql` files would be misleading. This module instead probes **live table existence** via the application's own Supabase client, which is accurate regardless of which directory created the table.

## Architect Freedom — Scope Decisions & Deviations

1. **A curated, representative anchor-table list (17 tables) is used for module health, not an exhaustive scan of ~150 tables** — spans every codebox era (foundation through Codebox 78), enough to catch a genuinely broken/missing table anywhere in the stack without an impractically long per-request check list.
2. **Category weights (`modules` 20%, `role_links` 20%, `migrations` 15%, `integrations` 15%, `configuration`/`automation`/`stale_data` 10% each) are a documented judgment call** — the spec asks for "production readiness scoring" without dictating a formula; `role_links` and `modules` are weighted highest because a broken table or an unlinked login account blocks real work, while stale data/automation warnings matter but rarely block launch on their own. Same convention as `partner-scorecards.js`'s `WEIGHTS` constant.
3. **The role-link check is entirely read-only** — it mirrors `lib/team-access.js`'s email-match logic to *report* auto-healable vs. needs-review counts, but never calls `.update()`. Fixing a role link stays exactly where it already lives: the Team page, or automatic self-heal on next login.
4. **Stale-data thresholds (KPI snapshot 35 days, notifications 30 days, executive reports 90 days, automation rules 60 days) are fixed, documented constants** — not configurable via `alert-rules.js`'s central rules engine, since these are meta-checks about the health centre's own data freshness assumptions, not a business rule a partner would tune per company.
5. **The stale-automation-rule check only flags rules that HAVE run before but not recently** — a genuinely manual-only rule with zero runs yet is not "stale," it's simply unused; flagging it would be a false positive against Codebox 78's own manual-only design.
6. **The pilot-readiness checklist is a fixed 8-item list, every item traceable to an already-computed category result** — no fresh calculation happens inside the checklist builder itself, so the checklist can never disagree with the category breakdown it's derived from.
7. **Every health-check run is persisted (no "dry run" concept exists here)** — unlike Codebox 78's automation engine, a health check has no side effects on anything outside its own two tables regardless of whether it's "tested" or "live," so there is nothing to simulate; every run is safe to record as a real snapshot.
8. **The N+1 query pattern in the first draft of the role-link check (re-fetching `user_company_access` inside a per-member loop) was caught and fixed before the file was even syntax-checked the first time** — the active-user-access list is now fetched once and reused across every unlinked member.

## Database — Migration 136

Two new tables: `practice_health_check_runs` (one snapshot per manager-initiated check, frozen category/findings/checklist results), `practice_health_check_events` (append-only, same convention as Codeboxes 76–78). No changes to any existing table.

## Backend — `operational-health.js`

### Health Engine — `computeOperationalHealth()`

Runs all 7 category checks in parallel (`Promise.all`), combines their weighted scores into an overall score/status, and derives the fixed pilot-readiness checklist from the already-computed category results. Returns `{ overallScore, overallStatus, categoryResults, findings, checklist }`.

### Category checks

- **Modules** — probes 17 anchor tables (`select('id', {head:true}).eq('company_id', cid).limit(1)`); any query error flags that table as unreachable.
- **Configuration** — `getRules()` resolves; a `practice_profiles` row exists; at least one active owner/partner team member exists.
- **Migrations** — probes 7 representative tables spanning foundation through Codebox 79 itself; a live existence check, never a file count.
- **Automation** — direct count queries (same pattern `management-dashboard.js` already uses for its own automation KPI block): active rules, failed runs (30 days), warned runs (30 days), rules awaiting approval.
- **Role Links** — unlinked active team members, split into auto-healable (single clean email match) vs. needs-review (zero/multiple matches); plus a reverse check for orphaned links (linked to a user who no longer has active company access).
- **Stale Data** — KPI snapshot recency, unread notification age, executive reports stuck in draft/generated, automation rules that have gone quiet.
- **Integrations** — soft-reference integrity for 3 team-member-linking columns across Notifications, Reminders, and Executive Actions; flags any row pointing to an inactive/missing team member.

## Scoring Logic

`overallScore = Σ(categoryScore × categoryWeight)`, weights sum to 1.00. `overallStatus`: `healthy` ≥ 90, `warning` ≥ 70, else `critical` — fixed, documented thresholds (no AI, no fuzzy logic).

## Pilot Readiness Checklist

8 fixed items, each a boolean derived from an already-computed category result: module tables reachable, migrations applied, an owner/partner exists, alert-rules resolve, no team members need role-link review, no broken cross-module references, automation has no recent failures, no critical stale-data findings.

## Integrations

- **Management Dashboard**: a new `operational_health` block in `computeSummary()` showing only the **latest stored run's** headline score/status/timestamp — never calls `computeOperationalHealth()` (a multi-table scan across 7 categories) from a dashboard load. A manager runs a fresh check from the Operational Health page itself.

## Frontend

`operational-health.html` + `js/operational-health.js` (prefix `oh`): a score hero (large overall score + status), a 7-category breakdown grid, 3 tabs (Pilot Readiness Checklist / Findings / Run History), and a run-detail modal showing every event for a given run. "Run Health Check Now" is manager-gated server-side and requires a native `confirm()` client-side before executing (it's a real, if lightweight, write — a new run record).

## localStorage Findings

Zero matches across the migration, `operational-health.js`, both new frontend files, and every edited file. Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`, verified line-by-line, same method as Codeboxes 77–78's audits. The one mutating route (`POST /run`) is manager-gated via `lib/team-access.js` — confirmed 1-for-1 by grep.

## Files Created

| File | Purpose |
| --- | --- |
| `accounting-ecosystem/backend/config/migrations/136_practice_operational_health.sql` | 2 tables: health check runs, append-only events |
| `accounting-ecosystem/backend/modules/practice/operational-health.js` | Router + `computeOperationalHealth()` engine (7 category checks) |
| `accounting-ecosystem/backend/frontend-practice/operational-health.html` | Operational Health UI |
| `accounting-ecosystem/backend/frontend-practice/js/operational-health.js` | Operational Health UI logic |
| `docs/new-app/79_operational_health.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_79_operational_health.md` | Handoff |

## Files Modified

| File | Change |
| --- | --- |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `operational-health.js` router at `/operational-health`, right after Automation |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Added `operational_health` block to `computeSummary()` (latest stored run only) |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Rendered the new KPI card |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added the "Operational Health" KPI grid container |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added the "Operational Health" nav entry |
