# Codebox 18 — Capacity Planning + Resource Allocation Foundation

**Module:** Lorenco Practice Management  
**Date:** 2026-06-20  
**Migrations applied:** 068  
**Status:** Complete

---

## Purpose

Provides practice-wide capacity visibility: how many hours each team member is allocated vs their weekly capacity, which clients carry the most work, and which structural gaps (unassigned tasks, missing owners, no capacity set) need attention.

**What this is NOT:**
- No AI allocation or auto-assignment
- No payroll integration
- No cron automation
- No localStorage for business data

All data is computed transparently from the database on each page load.

---

## Database Changes (Migration 068)

### `practice_team_members` — new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `weekly_capacity_hours` | NUMERIC(12,2) | NULL | Member's available hours per week |
| `daily_capacity_hours` | NUMERIC(12,2) | NULL | Optional — daily breakout |
| `capacity_notes` | TEXT | NULL | Free text (e.g. "Mon–Wed only") |
| `capacity_is_active` | BOOLEAN | true | Whether member is included in capacity calculations |

### `practice_tasks` — new column

| Column | Type | Default | Purpose |
|---|---|---|---|
| `estimated_hours` | NUMERIC(8,2) | NULL | How long this task is expected to take |

---

## Capacity Calculation Rules

```
allocated_task_hours = SUM(task.estimated_hours)
  WHERE preparer_team_member_id = member.id
    AND status NOT IN (completed, cancelled)
    AND estimated_hours IS NOT NULL

utilization_percentage = (allocated_task_hours / weekly_capacity_hours) × 100
```

### Status thresholds

| Status | Condition |
|---|---|
| `unknown` | No `weekly_capacity_hours` set (null or 0) |
| `underutilized` | utilization < 50% |
| `normal` | 50% ≤ utilization ≤ 85% |
| `high` | 85% < utilization ≤ 100% |
| `overloaded` | utilization > 100% |

Tasks with `estimated_hours = null` contribute 0 to the numerator and are flagged separately in the `/risks` endpoint as "Tasks Without Estimated Hours".

---

## Backend (New)

### File: `accounting-ecosystem/backend/modules/practice/capacity.js`

Mounted at `/api/practice/capacity/` in `index.js`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/practice/capacity/summary` | GET | 8 KPI aggregates for the practice |
| `/api/practice/capacity/team` | GET | Per-member capacity breakdown, sorted by severity |
| `/api/practice/capacity/clients` | GET | Per-client workload (tasks, hours, workflows, deadlines, periods) |
| `/api/practice/capacity/risks` | GET | 7 risk signal lists |

All endpoints:
- Scope every query to `req.companyId` (from JWT)
- Return empty arrays/nulls rather than errors when no data
- Wrap in try/catch and return `500` with a generic message on unexpected errors

### Shared helper: `buildTeamCapacity(cid)`

Used by both `/summary` and `/team` to avoid duplicating the per-member aggregation logic. Runs 5 parallel Supabase queries and joins them in JS:

1. `practice_team_members` — capacity fields
2. `practice_tasks` — open tasks with `estimated_hours` + preparer/reviewer
3. `practice_deadlines` — open deadlines with `responsible_team_member_id`
4. `practice_client_engagements` — active engagements with owner
5. `practice_engagement_periods` — queued/ready periods joined to engagement's responsible member

Returns an array sorted by status severity (overloaded → high → normal → underutilized → unknown).

### Risk signals (`/risks`)

| Signal | What it flags |
|---|---|
| `overloaded_team_members` | Members with utilization > 100% |
| `members_no_capacity_set` | Members with active tasks but no capacity set |
| `clients_with_unassigned_work` | Tasks with no `preparer_team_member_id` |
| `engagements_without_owner` | Active engagements with no `responsible_team_member_id` |
| `deadlines_without_owner` | Open deadlines with no `responsible_team_member_id` |
| `queued_periods_without_template` | Queued periods whose engagement has no `workflow_template_id` |
| `tasks_without_estimated_hours` | Open tasks with `estimated_hours = null` (unmeasured workload) |

---

## Backend Changes (Existing Files)

### `index.js`

1. **Require + mount**: `const capacityRouter = require('./capacity')` + `router.use('/capacity', capacityRouter)`
2. **New endpoint**: `PUT /team/:id/capacity` — updates only `weekly_capacity_hours`, `daily_capacity_hours`, `capacity_notes`, `capacity_is_active`. Validates ownership against `req.companyId`. Audit logs as `team_capacity_updated`.
3. **Task create**: destructures and inserts `estimated_hours` (nullable NUMERIC)
4. **Task update**: `estimated_hours` added to the `allowed` whitelist array

---

## Frontend (New)

### `capacity.html`

Full capacity page with:
- 8 KPI cards (total capacity, allocated hours, utilization %, overloaded count, underutilized count, reviews pending, overdue deadlines, queued periods)
- Team Capacity Table (9 columns: Name, Role, Weekly Cap, Utilization bar + badge, Tasks, Reviews, Deadlines, Periods, Set Capacity button)
- Client Workload Table (7 columns)
- 7 Risk Panels in a responsive grid
- Capacity Settings Modal (weekly hours, daily hours, notes, active toggle)

### `js/capacity.js`

IIFE module. Auth-gated. Calls 3 endpoints in parallel on init (`summary`, `team`, `clients`), then `risks` separately. On save (PUT), reloads summary + team only (not full page).

### `layout.js` change

Added `{ key: 'capacity', label: 'Capacity', href: '/practice/capacity.html' }` as the 13th nav tab, after Period Queue.

---

## Frontend Changes (Existing Files)

### `team.html` / `team.js`

- Added "Capacity" column to team table showing `weekly_capacity_hours` (or "Not set" in muted text)
- Added "Capacity →" link button per row navigating to `/practice/capacity.html`

Since `GET /api/practice/team` uses `select('*')`, the new capacity columns are returned automatically after migration 068.

### `index.html`

Added `📊 Capacity` to the quick-action buttons row.

### `practice.css`

Added all capacity-specific CSS: `.util-bar-*`, `.cap-badge.*`, `.risk-panel`, `.risk-count.*`, `.risk-item`, `.cap-table`, `.btn-xs`, `.risk-panels` grid.

---

## Multi-Tenant Safety

Every query in `capacity.js` uses `.eq('company_id', cid)` where `cid = req.companyId` from the authenticated JWT. No cross-company data access is possible.

---

## Storage Compliance (Rule D)

No business data is written to `localStorage`, `sessionStorage`, `indexedDB`, or the KV bridge. The only `localStorage` access is for `practice_token` / `token` (auth) in the IIFE's `init()`.

---

## Testing Checklist

- [ ] Run migration 068 in Supabase SQL Editor — confirm no errors
- [ ] `GET /api/practice/capacity/summary` returns 8 fields, all scoped to the logged-in company
- [ ] `GET /api/practice/capacity/team` returns array sorted by severity; empty array for company with no members
- [ ] `GET /api/practice/capacity/clients` returns array per active client
- [ ] `GET /api/practice/capacity/risks` returns 7 keys; all empty arrays when no risks
- [ ] `PUT /api/practice/team/:id/capacity` — sets weekly hours; re-fetch confirms change; wrong company ID returns 404
- [ ] Navigate to `/practice/capacity.html` — all 3 sections load; no stuck spinners
- [ ] "Set Capacity" modal opens, saves, and reloads the team table
- [ ] Team page shows Capacity column: "Not set" before migration, hours after setting
- [ ] Dashboard quick-action "Capacity" navigates to capacity page
- [ ] Nav tab "Capacity" is highlighted when on capacity page
- [ ] Task create via `POST /api/practice/tasks` with `estimated_hours: 2.5` — confirm stored
- [ ] Task update via `PUT /api/practice/tasks/:id` with `estimated_hours: 4` — confirm stored
- [ ] Company switch → capacity page reloads with correct company data
- [ ] No payroll module affected — zero side effects

---

## Known Gaps / Follow-Up Notes

### 1. Utilization is task-hours only
Workflow run `estimated_hours` (from migration 057) is NOT included in utilization. The capacity page is driven by `practice_tasks` only. Workflow hours are visible per-client but not per-member. A future enhancement could add workflow hours to member utilization.

### 2. Reviewer workload limited
`review_pending_count` shows tasks where this member is the reviewer AND `review_status IN (pending, in_review)`. It does NOT show the estimated hours of those reviews (there is no "review time" field on tasks). A future enhancement could add a `review_estimated_hours` field.

### 3. No historical capacity tracking
All capacity data is point-in-time. There is no history of utilization over time. A future enhancement could add a `practice_capacity_snapshots` table to track weekly utilization snapshots.

### 4. No time-logged-hours vs estimated comparison
`practice_time_entries` exists and could be joined to show actual hours vs estimated hours per member per week. This would give "accuracy of estimates" visibility. Planned for a future codebox.

---

## Recommended Codebox 19

**Client Risk Scoring** — assign a structured risk score to each client based on:
- Overdue deadlines (weighted by how overdue)
- Unstarted upcoming periods
- Missing owner on engagements
- Stalled workflows (no update in X days)
- Missing tax reference numbers or key compliance fields

Outputs a sortable risk score per client visible on the Clients page and as a new `/api/practice/clients/risk-scores` endpoint.
