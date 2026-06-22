# Codebox 34 — Tax Work Dashboard: Tax Season Command Center

**App:** Lorenco Practice Management
**Date:** 2026-06-22
**Status:** Implemented

---

## Purpose

A unified, read-only command centre that aggregates all tax work across the practice module:
individual returns, company returns, provisional plans, calculations, review packs,
compliance deadlines, and document requests — into one scrollable dashboard page.

**No AI scoring. No SARS/eFiling. No provisional tax automation. No cron jobs.**
All data is sourced directly from existing SQL tables via transparent COUNT and SELECT queries.

---

## What Was Built

### Backend (`tax-dashboard.js`)

Standalone router mounted at `/api/practice/tax-dashboard`.
All 5 endpoints are read-only GET — no mutations, no audit events written.

| Endpoint | Purpose |
|---|---|
| `GET /summary` | 12 KPI counts for command-centre header cards |
| `GET /workload` | Per-team-member breakdown of tax items owned/assigned |
| `GET /risk` | Risk lists: overdue deadlines, blocked returns, warning flags, prov. due, rejected packs |
| `GET /activity` | Merged timeline of latest events from all 8 tax event tables |
| `GET /returns` | Combined paginated list of individual returns + company returns + provisional plans |

### /summary

12 parallel COUNT queries — all transparent, no heuristics:

| KPI | Source |
|---|---|
| individual_returns_total | `practice_individual_tax_returns` WHERE status ≠ cancelled |
| individual_returns_ready | ... WHERE readiness_status = 'ready' AND status NOT IN (completed, cancelled, submitted) |
| individual_returns_review_pending | `practice_individual_tax_review_packs` WHERE pack_status = 'ready_for_review' |
| company_returns_total | `practice_company_tax_returns` WHERE status ≠ cancelled |
| company_returns_ready | ... WHERE readiness_status = 'ready' AND status NOT IN (completed, cancelled) |
| company_returns_review_pending | `practice_company_tax_review_packs` WHERE pack_status = 'ready_for_review' |
| provisional_plans_total | `practice_provisional_tax_plans` WHERE status ≠ cancelled |
| provisional_due_soon | `practice_provisional_tax_periods` WHERE status IN (not_started, in_progress) AND due_date BETWEEN today and today+14 |
| tax_deadlines_overdue | `practice_deadlines` WHERE status NOT IN (completed, submitted, missed, cancelled) AND due_date < today |
| documents_outstanding | `practice_document_requests` WHERE request_status IN (requested, reminder_sent, partially_received) |
| review_packs_pending | Sum of individual + company review packs in ready_for_review |
| draft_calculations_pending_review | Individual + company calcs in ready_for_review status |

### /workload

Bulk-fetches all active team members and all non-cancelled tax items, aggregates in JS:

| Column | Source |
|---|---|
| individual_returns_owned | `practice_individual_tax_returns.responsible_team_member_id` |
| company_returns_owned | `practice_company_tax_returns.responsible_team_member_id` |
| provisional_plans_owned | `practice_provisional_tax_plans.responsible_team_member_id` |
| review_packs_pending | Packs in ready_for_review, attributed to the underlying return's `reviewer_team_member_id` |
| overdue_tax_deadlines | `practice_deadlines` WHERE overdue AND `responsible_team_member_id` |
| outstanding_documents | `practice_document_requests` outstanding, attributed to `assigned_team_member_id` |
| total_tax_items | Sum of all above columns |

### /risk

| Risk Signal | Source |
|---|---|
| overdue_tax_deadlines | `practice_deadlines` — with client name, days overdue |
| returns_with_blocked_readiness | Individual + company returns WHERE readiness_status = 'blocked' |
| calculations_with_extra_warnings | Calcs with warning_flags.length > 2 (default 2 = DRAFT + RATE; extras = real issues) |
| provisional_plans_near_due | Periods due within 7 days, not yet submitted |
| tax_clients_missing_documents | Unique client count with outstanding document requests |
| review_packs_rejected | Count of rejected packs (individual + company) |

### /activity

Fetches latest 8 events from each of 8 event tables in parallel, merges, sorts by `created_at` DESC, returns top 30:

- `practice_individual_tax_events`
- `practice_individual_tax_calculation_events`
- `practice_individual_tax_review_pack_events`
- `practice_company_tax_events`
- `practice_company_tax_calculation_events`
- `practice_company_tax_review_pack_events`
- `practice_provisional_tax_events`
- `practice_compliance_pack_events`

Each entry: `{ source, event_type, created_at }`

### /returns (Combined List)

Fetches from all 3 return tables in parallel, enriches with latest calc + pack status, merges in JS, filters, sorts, paginates.

**DB-level filters (applied before merge):**
`tax_year`, `status`, `readiness_status`, `assigned_team_member_id` (OR condition on responsible + reviewer)

**Return-type filter:** if `return_type` is specified, only that table is fetched.

**JS-side filter (after merge):**
`review_status` — matches `latest_review_pack_status` or `latest_calculation_status`

**Sort:** tax_year DESC → client_name ASC

**Enrichment per row:**
- `latest_calculation_status` — from latest non-cancelled individual/company calc
- `latest_review_pack_status` — from latest non-cancelled individual/company review pack
- `warning_flags_count` — from latest calc's warning_flags array
- `next_due_date` — for provisional plans: earliest of period_1/period_2/topup due dates

**Pagination:** page + limit query params, max 200 per page, default 50.

**Note:** `outstanding_documents_count` is excluded per-row (requires N+1 query). Aggregate count is shown in /summary and /risk only.

---

## Frontend (`tax-dashboard.html` + `js/tax-dashboard.js`)

### Page Structure

Single scrollable page (no tabs — this is a command centre overview, not a detail view).

1. **Section header** — title, subtitle, Refresh button
2. **Action KPI row** — 6 cards: Overdue Deadlines (urgent), Review Packs Pending, Calcs Pending Review, Docs Outstanding, Provisional Due ≤14d, Returns Ready
3. **Totals KPI row** — 6 cards: Ind. Total, Co. Total, Prov. Total, Ind. Ready, Co. Ready, Packs in Review
4. **Two-column risk section** — Left: Overdue Deadlines panel, Blocked Returns panel, Rejected Packs panel. Right: Provisional Due ≤7d panel, Calcs with Extra Warnings panel
5. **Workload table** — one row per active team member; columns: Ind, Co, Prov, Review Packs, Overdue, Docs, Total
6. **All Tax Work list** — filter bar + paginated combined list with type/status/readiness/review/member filters
7. **Recent Activity timeline** — latest 30 events from all event tables

### JS Architecture

IIFE. No global state pollution. Exports via `window.tdX = ...` only for onclick handlers.

Load sequence:
- On init: `_loadTeamMembersForFilter()` (populates team member select)
- `tdRefreshAll()`: fires `_loadSummary()` + `_loadRisk()` + `_loadWorkload()` + `_loadActivity()` in parallel (via `Promise.all`), then `_loadReturns()` independently
- `tdApplyFilters()`: resets to page 1, re-calls `_loadReturns()`
- `tdPrevPage()` / `tdNextPage()`: increments page, re-calls `_loadReturns()`

All fetches use `PracticeAPI.fetch()` — ensures JWT auth header is included.

### No Browser Storage

Zero `localStorage`, `sessionStorage`, or KV writes. All data rendered directly from API responses.

---

## Mount / Nav

**Router mount (`index.js`):**
```js
const taxDashboardRouter = require('./tax-dashboard');
router.use('/tax-dashboard', taxDashboardRouter);
```
Mounted before `/dashboard` and before generic fallthrough routes.

**Nav entry (`layout.js`):**
```js
{ key: 'tax-dashboard', label: 'Tax Dashboard', href: '/practice/tax-dashboard.html' }
```
Added after `company-tax`, before `tax-configs`.

---

## No Migration Required

All queries aggregate from existing tables created in migrations 054–083. No new tables created.

---

## Multi-Tenant Safety

- Every DB query scoped by `req.companyId` (from JWT via `authenticateToken` + `requireCompany`)
- No raw SQL — all via Supabase JS client with `.eq('company_id', cid)` on every query
- No cross-company data possible in any response

---

## Known Limitations / Follow-up Notes

```
FOLLOW-UP NOTE
- Area: /returns — outstanding_documents_count per row
- What was done: Aggregate outstanding docs count shown in /summary and /risk only
- Not per-row: Would require N+1 document_requests queries per return — not practical for 100+ rows
- Risk: Low — dashboard shows aggregate; accountant navigates to Documents module for detail
- Recommended: Add document count to each return's page individually

FOLLOW-UP NOTE
- Area: /workload — review_packs_pending attribution
- What was done: Packs attributed to the return's reviewer_team_member_id
- Not yet: reviewer_team_member_id on review packs themselves (083 has the column, not yet set by generate endpoint)
- Risk: Low — reviewer attribution via return is a reasonable proxy
- Recommended: When a reviewer assignment UI is added to review packs in CB35+, update workload to use pack.reviewer_team_member_id as primary, fall back to return.reviewer_team_member_id

FOLLOW-UP NOTE
- Area: /returns — deep linking to specific return
- What was done: "Open →" link navigates to the type-specific page (individual-tax.html, company-tax.html, provisional-tax.html)
- Not yet: Return ID passed as query param for deep-linking into specific return modal
- Risk: Low — user must find their return on the destination page
- Recommended: Pass returnId as ?id=X query param once those pages support reading it on load
```
