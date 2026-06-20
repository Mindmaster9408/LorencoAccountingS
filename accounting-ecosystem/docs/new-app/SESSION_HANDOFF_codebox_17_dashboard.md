# Session Handoff — Codebox 17: Practice Dashboard Command Centre

**Date:** 2026-06-20
**Codebox:** 17 of ±80
**Module:** Lorenco Practice Management

---

## What Was Built

Codebox 17 has two parts:

**PATCH 17A:** Recurrence fields added to the engagement add/edit modal. Closes the open risk from Codebox 16 — users can now set `recurrence_type`, `recurrence_start_date`, `recurrence_end_date`, `recurrence_day`, `recurrence_month`, `recurrence_notes` via UI, which makes the Period Queue fully usable.

**Main 17B:** Replaced the basic 5-stat practice dashboard with a full operational command centre: 9 KPI cards, 4 risk panels, a team workload table, and a recent activity feed.

---

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/modules/practice/dashboard.js` | 4 new backend endpoints for the command centre |
| `accounting-ecosystem/backend/frontend-practice/js/dashboard.js` | Frontend IIFE module: auth, KPI, risk panels, workload, activity |
| `accounting-ecosystem/docs/new-app/17_practice_dashboard_command_center.md` | Architecture and test doc |
| `accounting-ecosystem/docs/new-app/SESSION_HANDOFF_codebox_17_dashboard.md` | This file |

---

## Files Modified

| File | What Changed |
|---|---|
| `backend/modules/practice/index.js` | Require + mount `dashboard.js` at `/dashboard` (before existing `/dashboard` GET) |
| `backend/modules/practice/engagements.js` | Added 6 recurrence fields to `sanitizeEngagementBody()` whitelist |
| `frontend-practice/client-detail.html` | Added "Recurrence Settings" section to engagement modal |
| `frontend-practice/js/client-detail.js` | Populate + save recurrence fields; added `toggleRecurrenceFields()`; exposed on window |
| `frontend-practice/index.html` | Full rewrite to command centre layout |
| `frontend-practice/css/practice.css` | Added dashboard-specific CSS classes |

---

## New API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/practice/dashboard/summary` | 9 KPI counts |
| GET | `/api/practice/dashboard/workload` | Per-team-member breakdown |
| GET | `/api/practice/dashboard/risk` | Top 10 items per risk category |
| GET | `/api/practice/dashboard/activity` | Last 50 events (3 sources) |

The legacy `GET /api/practice/dashboard` is preserved and unchanged.

---

## What Was Confirmed Working

- `sanitizeEngagementBody()` whitelist updated — recurrence fields pass through PUT/POST
- `toggleRecurrenceFields()` exposed on `window` so inline `onchange` handler in modal HTML can reach it
- Dashboard router mounted before the inline `/dashboard` GET handler so `/dashboard/summary` is never swallowed
- All 4 dashboard endpoints scope queries to `req.companyId` — no cross-tenant data
- Activity feed has a try/catch per-source — if `practice_billing_pack_events` is missing on an older DB, the other sources still load
- No migration required for 17B — all data comes from tables already created in migrations 057–067
- No localStorage or KV used for business data

---

## What Was NOT Changed

- `workflowService.createRunAndGenerateTasks()` — untouched
- `GET /api/practice/dashboard` legacy endpoint — preserved
- Any payroll module — zero cross-module risk
- Migration 067 — already applied; no new migration needed for 17B

---

## Testing Required

1. **PATCH 17A:** Open engagement edit modal → confirm Recurrence Settings section present. Set monthly recurrence → Save → Re-open → confirm values persisted. Confirm `📅 Periods` no longer fails with missing recurrence_type error for newly edited engagements.

2. **Main 17B:** Navigate to `/practice/` → confirm command centre loads (not old dashboard). All 9 KPIs show numbers. All 4 risk panels show items or empty state. Team workload table shows team members. Activity feed shows events.

3. **Multi-tenant:** Switch company → confirm all counts update to that company's data only.

---

## Open Risks / Follow-Ups

### 1. Recurrence end date not enforced by period engine
`recurrence_end_date` is now settable in the UI and stored in DB, but `buildPeriods()` in `engagement-periods.js` uses the `toDate` parameter — it does not clamp to `recurrence_end_date`. A future enhancement could warn the user if the requested date range exceeds `recurrence_end_date`. Currently safe because the user controls both independently.

### 2. Dashboard has no auto-refresh
The command centre loads data on page open only. The Refresh button does a full page reload. A future enhancement could add a 60-second auto-refresh or a "Last updated" timestamp.

### 3. Activity feed `created_by` is raw user ID
The activity feed shows `created_by` as a raw user ID string. A future enhancement could join to the users table to show a display name.

### 4. Workload table does not show `assigned_to` tasks
Tasks created without `preparer_team_member_id` (only `assigned_to` user ID) will not appear in the team workload breakdown. Both fields were in use historically. A future enhancement could cross-reference `assigned_to` with `users.id` to `practice_team_members.user_id`.

---

## Recommended Codebox 18

Now that the command centre exists and all operational objects are in place, Codebox 18 should build the **Compliance Calendar** — a calendar view of `practice_deadlines` showing SARS, CIPC, and other compliance due dates for the current month and next 3 months, with drag-reschedule and colour-coded urgency. This is the natural "see what's coming" complement to the command centre's "what's late" view.
