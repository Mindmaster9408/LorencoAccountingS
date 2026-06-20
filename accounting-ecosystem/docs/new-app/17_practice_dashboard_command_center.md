# Codebox 17 — Practice Dashboard Operational Command Centre

**Date:** 2026-06-20
**Module:** Lorenco Practice Management
**Status:** Complete

---

## Purpose

Codebox 17 closes two gaps left after Codebox 16:

1. **PATCH 17A** — Exposes recurrence fields (`recurrence_type`, `recurrence_start_date`, `recurrence_end_date`, `recurrence_day`, `recurrence_month`, `recurrence_notes`) in the engagement add/edit modal so users can actually set up period queue recurrence from the UI.

2. **Main 17B** — Replaces the basic `/practice/` dashboard (5 stat cards) with a full operational command centre showing live KPIs, risk panels, team workload, and a recent activity feed.

---

## PATCH 17A — Recurrence Fields in Engagement Modal

### Problem

Migration 067 (Codebox 16) added recurrence columns to `practice_client_engagements`, and the backend period generation engine reads them. But the engagement add/edit modal had no fields for them, so users had no way to set `recurrence_type` from the UI — making the Period Queue unusable for most users.

### Solution

Added a "Recurrence Settings" section to the engagement modal (below the Notes field, above form-actions):

| Field | HTML ID | Type |
|---|---|---|
| Recurrence Type | `eeRecurrenceType` | select (monthly/quarterly/annual/once_off/ad_hoc) |
| Recurrence Start Date | `eeRecurrenceStartDate` | date |
| Recurrence End Date | `eeRecurrenceEndDate` | date |
| Start Day of Month (1–28) | `eeRecurrenceDay` | number — shown for monthly + annual |
| Fiscal Year Start Month (1–12) | `eeRecurrenceMonth` | number — shown for annual only |
| Recurrence Notes | `eeRecurrenceNotes` | textarea |

### Conditional visibility

`toggleRecurrenceFields()` runs on `eeRecurrenceType` change and on modal open:

| Type | Day field shown | Month field shown |
|---|---|---|
| monthly | ✅ | ❌ |
| quarterly | ❌ | ❌ |
| annual | ✅ | ✅ |
| once_off | ❌ | ❌ |
| ad_hoc | ❌ | ❌ |

### Files changed (PATCH 17A)

| File | Change |
|---|---|
| `frontend-practice/client-detail.html` | Added recurrence section to `#engagementModal` |
| `frontend-practice/js/client-detail.js` | Populate fields in `_openEngagementModal()`; send fields in `saveEngagement()` body; added `toggleRecurrenceFields()`; exposed on `window` |
| `backend/modules/practice/engagements.js` | Added 6 recurrence fields to `sanitizeEngagementBody()` whitelist |

---

## Main 17B — Practice Command Centre Dashboard

### Architecture

```
GET /api/practice/dashboard/summary  → 9 KPI counts
GET /api/practice/dashboard/workload → per-member breakdown
GET /api/practice/dashboard/risk     → top 10 items per risk category
GET /api/practice/dashboard/activity → last 50 events (3 sources)
```

All 4 endpoints are in a separate router `dashboard.js`, mounted at `router.use('/dashboard', dashboardRouter)` in `index.js` — before the inline `GET /dashboard` legacy route, so `/dashboard/summary` is never swallowed by the legacy handler.

The legacy `GET /api/practice/dashboard` endpoint is **preserved unchanged** for backward compatibility.

### KPI Cards (9 total)

| KPI | Source table | What it counts |
|---|---|---|
| Active Clients | `practice_clients` | `is_active = true` |
| Active Engagements | `practice_client_engagements` | `status = 'active'` |
| Overdue Deadlines | `practice_deadlines` | `due_date < today`, status not resolved |
| Due This Week | `practice_deadlines` | `due_date` in next 7 days, status not resolved |
| In Review Queue | `practice_tasks` | `review_status IN ('pending','in_review')`, not completed/cancelled |
| Pending Approval | `practice_tasks` | `approval_status = 'pending'`, not completed/cancelled |
| Active Workflows | `practice_workflow_runs` | `status IN ('pending','in_progress')` |
| Billing Packs WIP | `practice_billing_packs` | `status IN ('draft','reviewed')` |
| Periods Pending | `practice_engagement_periods` | `status IN ('queued','ready')` |

**No AI scoring. No heuristics.** KPI colour (green/amber/red) is set by simple count thresholds in `dashboard.js`:
- Overdue > 0 → red
- Due this week > 0 → amber
- Review queue > 5 → red, > 0 → amber
- Approval pending > 5 → red, > 0 → amber
- Billing/Periods > 0 → amber

### Risk Panels (4 panels × 2 rows)

| Panel | Content |
|---|---|
| 🔴 Overdue Deadlines | Top 10 deadlines past due, oldest first, with client name + days overdue |
| 🟡 Due This Week | Top 10 deadlines due in 7 days, with days-until count |
| 🔵 Review & Approval Queue | Combined top 10 tasks in review or pending approval |
| 💰 Billing & Periods WIP | Top 10 billing packs in draft/reviewed + queued periods |

Each panel header shows a live count badge that updates after `/risk` loads.

### Team Workload Table

Single parallel batch of 4 queries (team members + tasks + deadlines + engagements) aggregated in JS — no N+1 per-member queries.

| Column | Source |
|---|---|
| Active Tasks | `preparer_team_member_id` on `practice_tasks` where status not completed/cancelled |
| Review Queue | `reviewer_team_member_id` on `practice_tasks` where `review_status IN ('pending','in_review')` |
| Deadlines Owned | `responsible_team_member_id` on `practice_deadlines` where status not resolved |
| Engagements | `responsible_team_member_id` on `practice_client_engagements` where `status = 'active'` |

Workload rows sorted descending by total pressure (active tasks + review tasks + deadlines).

Colour coding: > 10 active tasks → red; > 5 → amber; otherwise muted.

### Recent Activity Feed

Three parallel queries (capped at 25, 15, 15) from:
- `practice_client_engagement_events` — workflow generation, period events
- `practice_deadline_events` — status transitions
- `practice_billing_pack_events` — pack lifecycle

Merged, sorted chronologically, trimmed to 50, with relative timestamps ("5m ago", "2d ago") and source icons.

### Files created (17B)

| File | Purpose |
|---|---|
| `backend/modules/practice/dashboard.js` | 4 backend endpoints |
| `frontend-practice/js/dashboard.js` | IIFE page module: auth, KPI load, risk panels, workload, activity |
| `docs/new-app/17_practice_dashboard_command_center.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_17_dashboard.md` | Session handoff |

### Files modified (17B)

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Require + mount `dashboard.js` router |
| `frontend-practice/index.html` | Full rewrite to command centre layout |
| `frontend-practice/css/practice.css` | Added KPI grid, dash-panel, risk-row, workload-table, activity-feed CSS classes |

---

## Multi-Tenant Safety

Every endpoint in `dashboard.js` uses `req.companyId` (sourced from JWT in `authenticateToken` middleware). No `company_id` is ever read from the request body or query string.

---

## localStorage / KV Audit

Clean. No business data written to browser storage.
- `localStorage.getItem('token')` / `localStorage.getItem('practice_token')` → auth tokens (Rule D2 permitted)
- `localStorage.getItem('company')` → display name badge only (not business data)

---

## What Was NOT Changed

- `workflowService.createRunAndGenerateTasks()` — untouched
- Any payroll module — zero cross-module impact
- `GET /api/practice/dashboard` legacy endpoint — preserved unchanged
- Migration 067 — already applied; no new migration needed

---

## Manual Tests

### PATCH 17A

1. Open any active engagement → click Edit → scroll down → confirm "Recurrence Settings" section appears below Notes.
2. Select "Monthly" → confirm "Start Day of Month" appears, fiscal month stays hidden.
3. Select "Annual" → confirm both Day and Month fields appear.
4. Select "Once-off" → confirm both Day and Month fields are hidden.
5. Set recurrence_type = "monthly", start date, end date, day = 1 → Save Engagement.
6. Re-open the same engagement → confirm recurrence fields are pre-populated.
7. Click "📅 Periods" → enter date range → Preview → should now return periods (no longer errors on missing recurrence_type).

### Main 17B

1. Navigate to `/practice/` → confirm command centre layout loads (not the old 5-stat dashboard).
2. All 9 KPI cards load with counts within ~1 second.
3. All 4 risk panels load items or "empty" state — no error banners.
4. Team workload table shows active team members with counts.
5. Activity feed shows recent events in reverse chronological order.
6. Refresh button triggers full page reload.
7. Quick action buttons link to correct pages.
8. Switch to a different company → confirm all counts reset to that company's data (multi-tenant check).

---

## Remaining Risks

| Risk | Status |
|---|---|
| `practice_deadline_events` table may not exist on older DB | If the query returns a 42P01 error, the activity feed gracefully degrades (error caught in try/catch; other panels still load) |
| `practice_billing_pack_events` table must exist | Introduced in an earlier billing migration — confirm with Supabase before deploying |
| `practice_engagement_periods` table required | Added in migration 067 (Codebox 16) — must be applied before 17B works |
| No pagination on risk panels | Top 10 per panel — click through to the full page for complete list |
