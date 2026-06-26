# Codebox 38 — Tax Season Progress Reporting + Partner Summary

> Module: Practice Management — Tax Reports
> Status: Complete
> Routes mounted at: `/api/practice/tax-reports`

---

## Purpose

Read-only reporting dashboard for the active tax season. Aggregates data across individual returns, company returns, provisional tax plans, compliance packs, review packs, document requests, deadlines, and bulk operations into seven report types.

**Not:** Tax calculation, SARS/eFiling integration, AI, or automated scheduling.

---

## Database

### Migration 087 — `practice_tax_reporting_snapshots` (optional)

Table for saving report snapshots for historical comparison. The Tax Reports module works fully without it — only the `POST /snapshots` endpoint requires it.

Run once in Supabase SQL Editor:
```
accounting-ecosystem/backend/config/migrations/087_practice_tax_reporting_snapshots.sql
```

Expected result: `Success. No rows returned`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER | PK, auto |
| company_id | INTEGER | Multi-tenant scope |
| report_name | TEXT | User-defined label |
| report_type | TEXT | CHECK constraint — 6 valid values |
| tax_year | INTEGER | Optional filter context |
| filters | JSONB | Filter params at snapshot time |
| report_data | JSONB | Full report output |
| generated_at | TIMESTAMPTZ | Auto NOW() |
| generated_by | INTEGER | FK to users.id |
| notes | TEXT | Optional notes |

Valid `report_type` values: `tax_season_progress`, `partner_summary`, `document_outstanding`, `review_bottleneck`, `bulk_operation_summary`, `risk_summary`

---

## Backend — `tax-reports.js`

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/practice/tax-reports/progress` | Overall progress percentage + bucket counts |
| GET | `/api/practice/tax-reports/status-breakdown` | Per-entity status and readiness breakdowns |
| GET | `/api/practice/tax-reports/document-outstanding` | Outstanding doc requests by client, category, team member |
| GET | `/api/practice/tax-reports/review-bottlenecks` | Items waiting review, by reviewer, oldest items, rejected packs |
| GET | `/api/practice/tax-reports/partner-summary` | Per-team-member workload summary |
| GET | `/api/practice/tax-reports/bulk-operation-summary` | Recent bulk operations with item outcome counts |
| GET | `/api/practice/tax-reports/risk-summary` | Overdue deadlines, blocked returns, missing review packs, high-risk clients |
| POST | `/api/practice/tax-reports/snapshots` | Save a report snapshot (requires migration 087) |

### Shared query filters (GET endpoints except `/bulk-operation-summary`)

| Param | Type | Description |
|---|---|---|
| tax_year | integer | Filter returns/packs to this year |
| client_type | string | Filter to clients of this type (resolves client IDs via DB) |
| responsible_team_member_id | integer | Filter to returns/plans by responsible member |
| reviewer_team_member_id | integer | Filter to returns/packs by reviewer |

### Progress buckets

Items across all 6 entity types are counted into:

| Bucket | Logic |
|---|---|
| completed | status IN (completed, submitted, approved) |
| reviewed | status = reviewed |
| ready_for_review | status = ready_for_review |
| in_progress | all other non-cancelled statuses |
| blocked | readiness_status = blocked (returns only) |
| cancelled | status = cancelled |

`progress_percentage = (completed + reviewed) / total * 100`

### Partner Summary — PostgREST limitation

PostgREST has no GROUP BY. All rows with `responsible_team_member_id` are fetched; aggregation is done in Node.js.

- Returns, provisional plans: grouped by `responsible_team_member_id`
- Compliance packs: grouped by `owner_team_member_id`
- Outstanding docs: grouped via client's `responsible_team_member_id` (client lookup)
- Open actions: grouped via client's `responsible_team_member_id`
- Overdue deadlines: grouped via client's `responsible_team_member_id`
- Review packs: not included in partner summary (reviewer-based, not responsible-based)

### Risk Summary — high-risk client detection

A client is high-risk if it appears in 2 or more of these categories:
- Has overdue deadlines
- Has a blocked return (readiness_status = blocked)
- Has a return ready_for_review with no review pack generated
- Has outstanding document requests
- Has open tax work actions

### Multi-tenant safety

All queries scope by `req.companyId` from JWT. No `company_id` accepted from request body or query string.

---

## Frontend

### `tax-reports.html`

Seven reporting sections:
1. Tax Season Progress — progress bar + stat cards
2. Status Breakdown — per-entity status distribution cards
3. Outstanding Documents — by client (top 20) + by category
4. Review Bottlenecks — by reviewer, oldest waiting items, rejected packs
5. Partner/Team Summary — per-member workload table
6. Risk Summary — risk stat cards + detail tables
7. Bulk Operation Summary — recent operations with outcome counts

Filter bar: Tax Year, Client Type, Responsible, Reviewer — all applied on "Apply Filters" / "Refresh All" click.

### `js/tax-reports.js`

IIFE pattern. All public functions exported to `window.*`.

| Function | Exported | Purpose |
|---|---|---|
| `trrRefresh()` | ✓ | Trigger all 7 section loads |

All section loads are independent; one failure does not block others.

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/087_practice_tax_reporting_snapshots.sql` | Optional snapshot table |
| `backend/modules/practice/tax-reports.js` | Backend router — 8 endpoints |
| `backend/frontend-practice/tax-reports.html` | Report page HTML |
| `backend/frontend-practice/js/tax-reports.js` | Frontend IIFE |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Mounted `taxReportsRouter` at `/tax-reports` |
| `backend/frontend-practice/js/layout.js` | Added `tax-reports` nav entry |
| `backend/frontend-practice/tax-dashboard.html` | Added "Tax Reports" quick link in header |
