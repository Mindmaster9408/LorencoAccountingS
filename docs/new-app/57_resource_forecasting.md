# Codebox 57 — Practice Resource Forecasting + Future Capacity Planning

> App: Lorenco Practice Management
> Status: Complete — migration 114 not yet applied to Supabase — nothing committed or pushed

## Purpose

Answers "will we have enough people and hours next month?" — deterministic, explainable, forward-looking capacity projection across a 4/6/8/12-week window. Shows which weeks are overloaded, which team members will run out of capacity, which deadlines create pressure, and which clients will consume the most capacity.

**NOT AI. NOT automatic scheduling. NOT calendar sync. NOT leave management. NOT hiring recommendations.** No work is ever automatically moved — this module only projects and reports.

## Architect Freedom — Scope Decisions & Deviations

1. **Third-generation reuse — the entire forecast is built on two prior codeboxes' engines, never a fourth re-implementation of source aggregation.** `resource-forecasting.js` calls `planning-board.js`'s `buildTeamItemPool()` (itself built on `work-queue.js`'s `buildActiveQueue()`, itself built on 11 source fetchers) and `capacity.js`'s `buildTeamCapacity()`. This is the same reuse chain established in Codebox 56 (capacity.js → planning-board.js, work-queue.js → planning-board.js), extended one more level (planning-board.js → resource-forecasting.js). The result: there is still exactly one utilization formula, one priority/waiting-on-me/others rule set, and now one "which team member does this item belong to" resolution, in the entire codebase — directly satisfying "no duplicated source data."
2. **Two small, additive extensions to `work-queue.js`'s item shape were required and made carefully.** Forecasting needs per-item hour estimates and stable client identifiers that the existing item shape didn't carry:
   - `known_hours` was added to `_fetchTasks`'s returned item (the *only* source table with a real `estimated_hours` column) — `null` when the task itself has no estimate, never a guessed number.
   - `client_id` was added to all 10 fetchers' returned items (previously only `client_name` was exposed) — every fetcher was already querying `client_id` as part of its `practice_clients:client_id(...)` embed, so this is exposing already-fetched data, not a new query.
   Both changes are purely additive (new object keys) and don't alter any existing field's value or any query's filter/ordering — Work Hub and Planning Board's existing rendering is unaffected since they simply ignore keys they don't use.
3. **Load estimation is a pure, deterministic function of `(source_module, role, known_hours)`** — see `_estimateHours()`. The full placeholder table from the spec is implemented exactly and documented in code comments directly above the function: task placeholder 1h / review item 0.5h / document follow-up 0.25h / deadline admin item 0.5h, extended with two source types the spec didn't explicitly cover (compliance packs, tax returns) using the same "production work = 1h, review work = 0.5h" logic already established for tasks. Every item's `confidence` field (`actual_estimate` / `default_placeholder` / `unknown`) is set alongside its hours, never silently — the frontend visibly labels placeholder-derived numbers (`*` suffix + amber color) so a manager never mistakes a placeholder for a real estimate.
4. **Overdue items are pulled forward into week 0, not excluded or silently dropped.** An item due before the forecast's start date still represents real, unfinished work — excluding it would understate week 1's true pressure. Items due after the forecast window, or with no due date at all (many source types have none), are marked `week_bucket: null` ("unscheduled") and reported as a distinct count rather than guessed into an arbitrary week — this is what "no hidden logic" requires: every item's week placement (or lack of one) is traceable to its actual due date.
5. **The Deadline Forecast is a direct query, not the item pool** — identical reasoning to Codebox 56's Deadline Timeline. `buildTeamItemPool()` only returns items with a resolved team-member assignee; an unowned deadline needs to be visible to forecasting precisely because it's unowned work that will still land on someone. `GET /deadlines` (and the internal `_computeDeadlineForecast` used by snapshots) queries `practice_deadlines` directly, spanning the full forecast window.
6. **Client pressure banding and deadline risk banding are simple, documented threshold rules**, not scores requiring their own engine: `pressure_status` is `critical` if a client has any overdue item or >30 forecast hours, `high` if >15h, `medium` if >5h, else `normal`. `risk_level` on a forecast deadline is `critical` if overdue or `priority='urgent'`, `high` if `priority='high'`, else `normal`. Both are pure functions of already-known fields — no new inputs, no hidden weighting.
7. **`forecast_viewed` events are logged only when opening a saved snapshot**, not on every live `GET /forecast` call. The spec lists `forecast_viewed` as one of only 3 event types with no explicit trigger rule; logging it on every live-forecast poll (which the frontend calls on every filter change) would spam the audit table with low-value entries. Viewing a specific saved snapshot — a deliberate "look at this historical record" action — is the meaningful, auditable event; `board_opened`-style noise was deliberately avoided here (unlike Codebox 56's Planning Board, which does log `board_opened` — see Follow-Up Notes for the reasoning gap this creates).

## Database — Migration 114

- **`practice_resource_forecast_snapshots`** — frozen forecast output (`forecast_data`/`summary_data` JSONB), the same "compute once, freeze, never recalculate on read" pattern as Codebox 51's KPI snapshots and Codebox 52's partner review packs. `forecast_weeks` is constrained to the spec's allowed values (4/6/8/12). Soft-archived via `status`, never hard-deleted.
- **`practice_resource_forecast_events`** — append-only, the exact 3 spec event types.

## Backend — `resource-forecasting.js`

### Endpoints (11, matching the spec exactly)

`GET /summary`, `GET /forecast` (query: `start_date`, `weeks`, `team_member_id`), `GET /team`, `GET /clients`, `GET /deadlines`, `POST /snapshots`, `GET /snapshots`, `GET /snapshots/:id`, `DELETE /snapshots/:id` (soft archive), `GET /snapshots/:id/events`.

### Forecast Engine Logic

`_buildWeeklyForecast(cid, weekStart, weeks, teamMemberId)`:
1. Calls `_buildEstimatedPool(cid)` — wraps `planningBoard.buildTeamItemPool(cid)`, attaching `estimated_hours`/`confidence` (via `_estimateHours`) and a `pressure_category` (via `_pressureCategory`) to every item.
2. Optionally filters to one team member.
3. Calls `_assignWeekBucket()` to tag every item with a 0-based week index (or `null` for unscheduled).
4. For each of the N weeks, sums `estimated_hours` into `allocated_hours`, sums by `pressure_category` into the 6 spec pressure fields (`deadline_pressure`, `review_pressure`, `tax_pressure`, `qms_pressure`, `risk_pressure`, `document_pressure`), computes `capacity_gap = allocated_hours - capacity_hours`, `utilization_percentage`, and bands `status` using the spec's exact thresholds (`_capacityStatus`): `<50% under_capacity`, `50–85% normal`, `85–100% high`, `100–120% over_capacity`, `>120% critical`.

### Load Estimation Logic

See Architect Freedom #3 for the full placeholder table. `_estimateHours(item)` always prefers `item.known_hours` (real task estimates) and falls back to the documented placeholder for every other source, tagging `confidence` accordingly.

### Team Forecast Logic

`GET /team` merges `capacity.buildTeamCapacity()` (weekly capacity, active flag) with the week-bucketed item pool, producing per-member `forecast_weeks[]` (capacity/allocated/utilization/status per week), `total_capacity`/`total_allocated`/`capacity_gap` across the whole window, `overloaded_weeks`/`critical_weeks` counts, and an overall `status` banded from total utilization — sorted worst-first (critical → over_capacity → high → normal → under_capacity → unknown).

### Client / Deadline Forecast Logic

`GET /clients` groups week-bucketed pool items by `client_id` (falling back to a `client_name`-keyed group for the few source types with no `client_id`, e.g. QMS findings), summing hours and counting by category (deadlines/tax/documents/risk), then bands `pressure_status` per Architect Freedom #6. `GET /deadlines` queries `practice_deadlines` directly across the full forecast window (see Architect Freedom #5), independent of the item pool, so unowned deadlines are never invisible to a manager planning ahead.

## Frontend

`resource-forecasting.html` + `js/resource-forecasting.js` (prefix `rf`): a filter bar (start date / weeks / team member), 6 summary cards, a horizontally-scrollable **Weekly Forecast Board** — one column per week, a two-bar comparison (grey = capacity, colored-by-status = allocated) sized relative to the largest value in view, with utilization % and status label directly beneath, designed to answer "do we have enough capacity?" at a glance within the spec's 30-second usability bar. Below that: a Team Forecast table (sorted worst-status-first, one-click "Open Queue" per member), a Client Pressure table, and a Deadline Pressure table (placeholder-hour entries marked with `*` and amber coloring). "💾 Save Snapshot" freezes the current filtered view; a Saved Snapshots table lists/opens/archives past snapshots. No chart library — pure CSS bars, consistent with every other codebox this session.

## Integrations

- **Planning Board** → "📈 Open Resource Forecast →" link added to its info banner.
- **Capacity** → "📈 Forecast Capacity →" link added to its page header.
- **Management Dashboard** → "📈 Resource Forecast" quick action added (spec marked this integration optional; included for workflow completeness alongside the Planning Board and Work Queue links already there).

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `resource-forecasting.js`, both frontend files, and every edited file (`work-queue.js`, `planning-board.js`, `index.js`, `layout.js`, `capacity.html`, `planning-board.html`, `management-dashboard.html`). Confirmed via grep.

## Multi-Tenant Safety

Every endpoint scopes its queries to `company_id` and requires the caller's own team-member role to be manager-level (`_requireManager`, resolved fresh from `req.user.userId` on every request). The underlying pool cache (in `planning-board.js`) and capacity computation are both scoped per `company_id`, so no cross-tenant data can leak into a forecast.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/114_practice_resource_forecasting.sql` | 2 tables |
| `accounting-ecosystem/backend/modules/practice/resource-forecasting.js` | Router + forecast engine |
| `accounting-ecosystem/backend/frontend-practice/resource-forecasting.html` | Forecast UI |
| `accounting-ecosystem/backend/frontend-practice/js/resource-forecasting.js` | Forecast UI logic |
| `docs/new-app/57_resource_forecasting.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_57_resource_forecasting.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/work-queue.js` | Added `known_hours` to the tasks fetcher; added `client_id` to all 10 fetchers' item output |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | Exported the previously-internal `_buildTeamItemPool` as `buildTeamItemPool` |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `resource-forecasting` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Resource Forecast" nav entry |
| `accounting-ecosystem/backend/frontend-practice/planning-board.html` | Added "Open Resource Forecast" link |
| `accounting-ecosystem/backend/frontend-practice/capacity.html` | Added "Forecast Capacity" link |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added "Resource Forecast" quick action |
