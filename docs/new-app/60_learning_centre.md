# Codebox 60 — Practice Learning, Development & Training Centre

> App: Lorenco Practice Management
> Status: Complete — migration 117 not yet applied to Supabase — nothing committed or pushed

## Purpose

Answers "how do we grow this person?" — structured development plans, goals, learning activities, mentorship, and CPD tracking, complementing the Skills Matrix (Codebox 59). Managers see "how is this person developing?"; employees see "what should I focus on next?"

**NOT AI coaching. NOT automatic development plans. NOT an LMS. NOT external learning provider integration. NOT employee performance reviews.** Fully manager-controlled, exactly like the Skills Matrix before it.

## Architect Freedom — Scope Decisions & Deviations

1. **`practice_learning_progress` is a history table, not the live state.** The spec lists it as a distinct table from `practice_learning_plans.overall_progress`, which was read literally: `overall_progress` on the plan row is a cached snapshot of the *current* computed value (rewritten by `calculateLearningProgress()` on every goal/activity write), while `practice_learning_progress` rows are point-in-time captures a manager explicitly takes (`POST /progress/:plan_id/snapshot`) — giving a genuine trend-over-time record distinct from "what's true right now." This mirrors the same "frozen snapshot, separate from live state" pattern used for KPI History (Codebox 51) and Resource Forecast snapshots (Codebox 57).
2. **Plan closure reuses the existing `status` enum's `cancelled` value rather than adding an `is_active` column.** Unlike Codebox 59's `practice_team_certifications` (where `is_active` was added specifically because `status` already meant something else and reusing it would have been dishonest), `practice_learning_plans.status` doesn't yet have a value that means "closed/archived" the way `cancelled` naturally does — so `DELETE /plans/:id` sets `status='cancelled'` directly, with no redundant second flag needed. This is a case-by-case judgment, not a blanket rule: Codebox 59 needed a second flag because its status column's values didn't include a generic "hide this" state; this table's does.
3. **CPD `category` is deliberately free text, not linked to `practice_skill_categories`.** CPD categories are typically defined by an external professional body (SAICA, SAIT, etc.) using their own taxonomy — forcing CPD entries into the internal Skills Matrix category structure would have been a false equivalence between two genuinely different classification systems. `practice_cpd_records.is_active` was added following Codebox 59's established precedent (a `status` column already carries real lifecycle meaning — recorded/verified/expired — so a separate soft-delete flag was needed for the same reason as `practice_team_certifications`).
4. **The Skills Matrix integration surfaces suggestions via a direct read, not a shared helper.** `GET /suggested-goals/:team_member_id` queries `practice_team_skills` directly (the same `target_level > current_level` filter already used by the Skills Matrix's own Training Needs tab) rather than requiring `skills-matrix.js` and calling a dedicated export — there's no scoring or business logic to reuse here, just a plain filter, matching the same reasoning already applied to Planning Board's competency badges in Codebox 59. A manager can turn a suggestion into a real goal with one click, or ignore it entirely — nothing is created automatically.
5. **The Delegation "In Development"/"Mentored" badge is deliberately not skill-specific.** `getDevelopmentBadge(cid, teamMemberId, skillId)` accepts an optional `skillId` to prefer a plan whose goals target that exact skill, but Delegation's advisory calls it with `skillId = null` — resolving `MODULE_SKILL_MAP`'s `skill_key` to an actual `skill_id` would need an extra lookup query for a badge that's already a soft, non-blocking hint rather than a precise measurement (unlike the competency *level* comparison next to it, which genuinely does need per-skill precision because it's the number a manager is weighing a real decision against).
6. **`calculateLearningProgress()`'s per-goal formula has an explicit, three-tier fallback, each tier documented in code comments directly above the function** — completed status wins outright (100%), then competency-level ratio (`current/target`) if the goal is skill-linked, then activity-hours ratio (`completed/planned`) if it has logged activities, then 0 if none of the above apply. Every tier is a plain arithmetic operation on already-stored fields; nothing is invented or estimated. The function always rewrites the plan's cached `overall_progress` as a side effect, called from every goal/activity CRUD path that touches that plan — never left to drift.
7. **CPD hours accumulated in the progress helper's output are practice-wide for the team member, not scoped to the specific plan.** CPD is a personal professional development requirement independent of any one internal development plan (a person's CPD hours count toward their professional body's requirements regardless of which internal plan, if any, prompted them) — scoping CPD to a single plan would have under-counted a real, externally-meaningful number for no benefit.

## Database — Migration 117

Six tables exactly as named in the spec: `practice_learning_plans`, `practice_learning_goals`, `practice_learning_activities`, `practice_learning_progress`, `practice_cpd_records`, `practice_learning_events`. Full field-by-field rationale in the migration's own comments.

## Backend — `learning-centre.js`

### Endpoints (~24)

`GET /summary`, full CRUD for `/plans`, `/goals` (filtered by `learning_plan_id`), `/activities` (filtered by `goal_id`), `/cpd`, plus `GET /progress/:plan_id`, `POST /progress/:plan_id/snapshot`, `GET /progress/:plan_id/history`, `GET /suggested-goals/:team_member_id`, `GET /events`. All writes manager-gated; reads scoped manager-or-self-or-mentor (a mentor can see the plan they're mentoring, even though it isn't "their own").

### Learning Engine

Standard CRUD with one behavioural rule threaded through every goal/activity write: after any `POST`/`PUT`/`DELETE` on a goal or activity, `_recalc()` calls `calculateLearningProgress()` for the owning plan and writes the fresh `overall_progress` back — swallowing any recalculation error so a progress-cache failure never blocks the actual CRUD operation that triggered it.

### Progress Helper — `calculateLearningProgress()`

Returns plan-level overall progress, per-goal progress breakdown (with a human-readable `reason` string for each), goals completed/remaining, hours planned/completed/remaining, and CPD hours accumulated — exactly the 5 things the spec's Progress Engine section asks for. See Architect Freedom #6 for the exact per-goal formula.

## Integrations

- **Skills Matrix** — `GET /suggested-goals/:team_member_id` surfaces every skill where `target_level > current_level` as a clickable suggestion in the Create Plan modal; a manager may act on it or ignore it entirely.
- **Delegation** — `getDevelopmentBadge()` is called from `delegation.js`'s existing competency advisory (Codebox 59), adding an "In Development" or "Mentored" badge next to the new owner's competency figures. Badge only — never affects whether a delegation can be created.

## Frontend

`learning-centre.html` + `js/learning-centre.js` (prefix `lc`): summary cards, a 3-tab layout (Learning Plans / CPD / History). The Learning Plans tab lists every plan with a progress bar; opening one shows its full goal list (each with nested activities, add-goal/add-activity actions, and a one-click "Mark Complete"), a "Capture Progress Snapshot" button, and a cancel action. The Create Plan modal shows Skills Matrix suggestions live as a team member is selected. CPD tab manages records with expiry visibility. No chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `learning-centre.js`, both new frontend files, and every edited file (`delegation.js`, `index.js`, `layout.js`, `js/delegation.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. Personal data (plans, goals, activities, CPD, progress) is further scoped manager-or-self-or-mentor, matching the privacy boundary established across Codeboxes 58–59.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/117_practice_learning_centre.sql` | 6 tables |
| `accounting-ecosystem/backend/modules/practice/learning-centre.js` | Router + `calculateLearningProgress()` + `getDevelopmentBadge()` |
| `accounting-ecosystem/backend/frontend-practice/learning-centre.html` | Learning Centre UI |
| `accounting-ecosystem/backend/frontend-practice/js/learning-centre.js` | Learning Centre UI logic |
| `docs/new-app/60_learning_centre.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_60_learning_centre.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/delegation.js` | Requires `learning-centre.js`; added `new_owner_development_badge` to the existing competency advisory |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `learning-centre` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Learning Centre" nav entry, placed after Skills Matrix per spec |
| `accounting-ecosystem/backend/frontend-practice/js/delegation.js` | Renders the development badge in the advisory box |
