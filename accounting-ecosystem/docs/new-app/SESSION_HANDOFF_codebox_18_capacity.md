# Session Handoff — Codebox 18: Capacity Planning + Resource Allocation Foundation

**Date:** 2026-06-20  
**Codebox:** 18 of ±80  
**Module:** Lorenco Practice Management  

---

## What Was Built

**Codebox 18** adds practice-wide capacity visibility: who is overloaded, who has bandwidth, which clients carry the most work, and where structural gaps exist (unassigned tasks, missing owners, unmeasured workload).

No AI, no automation, no payroll integration. Transparent hour-based utilization from the database.

---

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/068_practice_capacity_planning.sql` | Adds capacity fields to `practice_team_members`, adds `estimated_hours` to `practice_tasks` |
| `accounting-ecosystem/backend/modules/practice/capacity.js` | 4 new API endpoints: summary, team, clients, risks |
| `accounting-ecosystem/backend/frontend-practice/capacity.html` | Full capacity page with KPIs, team table, client table, risk panels, settings modal |
| `accounting-ecosystem/backend/frontend-practice/js/capacity.js` | Frontend IIFE module for capacity page |
| `accounting-ecosystem/docs/new-app/18_capacity_planning_resource_allocation.md` | Architecture and test doc |
| `accounting-ecosystem/docs/new-app/SESSION_HANDOFF_codebox_18_capacity.md` | This file |

---

## Files Modified

| File | What Changed |
|---|---|
| `backend/modules/practice/index.js` | Require + mount `capacity.js` router; add `PUT /team/:id/capacity`; add `estimated_hours` to task create + task update |
| `frontend-practice/js/layout.js` | Added 13th nav tab: `{ key: 'capacity', label: 'Capacity', href: '/practice/capacity.html' }` |
| `frontend-practice/js/team.js` | Added Capacity column to team table; added "Capacity →" link per row |
| `frontend-practice/index.html` | Added `📊 Capacity` quick-action button |
| `frontend-practice/css/practice.css` | Added capacity-specific CSS: utilization bar, status badges, risk panels, cap-table, btn-xs |

---

## New API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/practice/capacity/summary` | 8 practice-wide KPIs |
| GET | `/api/practice/capacity/team` | Per-member capacity breakdown |
| GET | `/api/practice/capacity/clients` | Per-client workload |
| GET | `/api/practice/capacity/risks` | 7 risk signal lists |
| PUT | `/api/practice/team/:id/capacity` | Update a member's capacity settings |

All existing team and task endpoints are unchanged. The capacity endpoint is entirely additive.

---

## Migration — MUST RUN BEFORE TESTING

```sql
-- Run in Supabase SQL Editor (see full file at):
-- accounting-ecosystem/backend/config/migrations/068_practice_capacity_planning.sql

ALTER TABLE practice_team_members ADD COLUMN IF NOT EXISTS weekly_capacity_hours NUMERIC(12,2) NULL;
ALTER TABLE practice_team_members ADD COLUMN IF NOT EXISTS daily_capacity_hours NUMERIC(12,2) NULL;
ALTER TABLE practice_team_members ADD COLUMN IF NOT EXISTS capacity_notes TEXT NULL;
ALTER TABLE practice_team_members ADD COLUMN IF NOT EXISTS capacity_is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE practice_tasks ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(8,2) NULL;
```

The migration is idempotent (`IF NOT EXISTS` everywhere). Safe to re-run.

---

## What Was Confirmed Working (Design Audit)

- All 5 new endpoints scope every Supabase query to `req.companyId` from JWT — no cross-tenant risk
- `buildTeamCapacity()` shared helper used by both `/summary` and `/team` — no duplicated query logic
- `PUT /team/:id/capacity` validates team member ownership before updating
- `estimated_hours` added to task create (destructure + insert) and task update (allowed whitelist) — additive only, no existing logic changed
- `GET /api/practice/team` uses `select('*')` so new capacity columns are automatically included after migration
- No `localStorage` or KV used for capacity or task data anywhere in the new code
- Auth token check in `capacity.js` init() uses `localStorage.getItem('practice_token') || localStorage.getItem('token')` — same pattern as all other practice pages
- `PUT /team/:id/capacity` does NOT touch `sanitizeTeamBody()` — it is its own dedicated endpoint with its own whitelist, preventing capacity fields from being clobbered by general profile edits

---

## What Was NOT Changed

- `sanitizeTeamBody()` — unchanged, does not include capacity fields (intentional: capacity has its own endpoint)
- `workflowService.createRunAndGenerateTasks()` — untouched
- `practice_workflow_runs.estimated_hours` — already existed from migration 057; not touched
- `practice_client_engagements.estimated_hours_per_period` — already existed from migration 065; not touched
- Any payroll module — zero cross-module risk
- All existing team routes (GET, POST, PUT /team/:id, DELETE, reactivate) — unchanged

---

## Testing Required

### Migration
1. Run `068_practice_capacity_planning.sql` in Supabase SQL Editor
2. Confirm: `\d practice_team_members` shows `weekly_capacity_hours`, `daily_capacity_hours`, `capacity_notes`, `capacity_is_active`
3. Confirm: `\d practice_tasks` shows `estimated_hours`

### API
4. `GET /api/practice/capacity/summary` → returns 8 fields, all numeric or null
5. `GET /api/practice/capacity/team` → returns `team` array; all members have `capacity_status` field
6. `GET /api/practice/capacity/clients` → returns `clients` array
7. `GET /api/practice/capacity/risks` → returns 7 risk keys; each is an array
8. `PUT /api/practice/team/1/capacity` with `{ weekly_capacity_hours: 40 }` → 200; re-GET confirms
9. `PUT /api/practice/team/:id/capacity` with wrong company → 404

### Task estimated_hours
10. `POST /api/practice/tasks` with `estimated_hours: 2.5` → confirm stored
11. `PUT /api/practice/tasks/:id` with `estimated_hours: 4` → confirm stored
12. Tasks without `estimated_hours` in create body → `null` stored (not an error)

### Frontend
13. Navigate to `/practice/capacity.html` → KPIs load, team table loads, clients load, risks load
14. Click "Set Capacity" for a member → modal opens pre-filled; save → team table reloads
15. Blank `weekly_capacity_hours` in modal → saves null; member shows "No Capacity Set" in risks
16. Team page → Capacity column shows "Not set" for members without capacity
17. Dashboard → "📊 Capacity" quick-action navigates correctly
18. Nav → "Capacity" tab is active-highlighted on capacity page

### Multi-tenant
19. Switch company → all capacity endpoints return that company's data only

### Storage compliance
20. Confirm: no `localStorage.setItem` or `safeLocalStorage.setItem` in `capacity.js` or `capacity.html` for business data

---

## Open Risks / Follow-Up Notes

### 1. Utilization excludes workflow run hours
`practice_workflow_runs.estimated_hours` is NOT included in per-member utilization (only `practice_tasks.estimated_hours` is). This is intentional for now — workflow runs are per-client, not per-member (no `preparer_team_member_id` on workflow runs). A future codebox could add `assigned_to_team_member_id` on workflow runs.

### 2. Tasks without `preparer_team_member_id`
Historical tasks may have been assigned via `assigned_to` (a user ID) rather than `preparer_team_member_id` (a team member ID). These tasks appear in the "Unassigned Work" risk panel. Reconciliation is a manual process.

### 3. No capacity history
All capacity data is point-in-time. No historical utilization tracking. Track in a future enhancement.

### 4. No time-logged vs estimated comparison
`practice_time_entries` could show actual vs estimated hours. Planned for a future codebox.

---

## Recommended Codebox 19

**Client Risk Scoring** — assign a numeric risk score to each client based on overdue deadlines, stalled workflows, missing compliance fields, unstarted periods, and missing owners. Outputs a sortable risk score on the Clients page and as a dedicated API endpoint.

This builds naturally on Codebox 18 (which identified many of the risk signal categories now per-member) and extends the same patterns to per-client scoring.
