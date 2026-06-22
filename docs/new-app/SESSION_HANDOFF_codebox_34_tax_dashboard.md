# Session Handoff — Codebox 34: Tax Work Dashboard + Tax Season Command Center

**Date:** 2026-06-22
**Codebox:** 34 of ±80
**App:** Lorenco Practice Management

---

## What Was Changed

### Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/modules/practice/tax-dashboard.js` | 5-endpoint read-only router aggregating all tax work |
| `accounting-ecosystem/backend/frontend-practice/tax-dashboard.html` | Dashboard page shell + CSS |
| `accounting-ecosystem/backend/frontend-practice/js/tax-dashboard.js` | Dashboard IIFE frontend JS |
| `docs/new-app/34_tax_work_dashboard.md` | Technical reference |
| `docs/new-app/SESSION_HANDOFF_codebox_34_tax_dashboard.md` | This file |

### Files Modified

| File | What Changed |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Added `taxDashboardRouter` require + `router.use('/tax-dashboard', ...)` mount before `/dashboard` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added `{ key: 'tax-dashboard', label: 'Tax Dashboard', href: '/practice/tax-dashboard.html' }` to PAGES array |

---

## Root Causes Fixed

None — greenfield feature adding a unified command-centre view over existing tax modules (CB23–CB33).

---

## What Was Confirmed (by audit)

- No migration needed — all 5 endpoints aggregate from existing tables (migrations 054–083)
- All 8 tax event tables confirmed: `practice_individual_tax_events`, `practice_individual_tax_calculation_events`, `practice_individual_tax_review_pack_events`, `practice_company_tax_events`, `practice_company_tax_calculation_events`, `practice_company_tax_review_pack_events`, `practice_provisional_tax_events`, `practice_compliance_pack_events`
- `practice_clients` Supabase embedded join confirmed: `clients:practice_clients!client_id(display_name, company_name)`
- `practice_team_members` join confirmed: `practice_team_members!responsible_team_member_id(display_name)`
- `/workload` reviewer attribution: review packs attributed to underlying return's `reviewer_team_member_id` (pack.reviewer_team_member_id not yet set by CB33 generate — see follow-up note in 34_tax_work_dashboard.md)
- Calc "extra warnings" threshold: `warning_flags.length > 2` (CB32 always writes `DRAFT_COMPANY_TAX_REVIEW_REQUIRED` + `COMPANY_TAX_RATE_REQUIRES_REVIEW` = 2 baseline; >2 = genuine data or calc issue)
- No localStorage/KV writes anywhere in tax-dashboard.js or tax-dashboard.html
- Router mounted BEFORE `/dashboard` and before fallthrough routes in index.js
- Nav entry placed after `company-tax`, before `tax-configs` in layout.js PAGES array
- Super user access automatic (no module gate added) — compliant with Rule F1

---

## What Was NOT Changed

- CB31–CB33 company tax routes, calculations, review packs — untouched
- CB23–CB30 individual tax routes — untouched
- CB17–CB22 provisional tax routes — untouched
- Paytime module — untouched
- No Zeabur config changes
- No zbpack.json created
- No new auth middleware or permission rules added

---

## Testing Checklist

1. Navigate to Practice → Tax Dashboard in nav bar
2. Verify summary KPI cards load with correct counts (cross-check against Company Tax and Individual Tax pages)
3. Verify Overdue Deadlines panel shows correct items (cross-check against Deadlines page)
4. Verify Blocked Returns panel: create a return with readiness_status = 'blocked' and confirm it appears
5. Verify Provisional Due ≤7d: create a provisional period with due_date within 7 days, status not_started → confirm it appears
6. Verify Workload table shows all active team members with correct owned-return counts
7. Verify combined returns list loads with all three types (Individual, Company, Provisional)
8. Filter by type = "Company Returns" → verify only company rows appear
9. Filter by year = 2026 → verify results are filtered
10. Filter by readiness = "blocked" → verify only blocked returns appear
11. Filter by team member → verify results scoped to that member
12. Verify pagination: if > 50 returns, Prev/Next buttons appear and work
13. Click "Open →" on an Individual return → verify individual-tax.html opens
14. Click "Open →" on a Company return → verify company-tax.html opens
15. Verify Recent Activity timeline shows events from multiple tables
16. Click Refresh button → verify all sections reload
17. Verify no localStorage/KV writes in browser DevTools → Application tab
18. Switch company via company selector → refresh → verify data updates for new company
19. Confirm no data from another company appears (multi-tenant safety)

---

## Open Risks

| Risk | Severity | Notes |
|---|---|---|
| `practice_compliance_pack_events` may not exist in DB | LOW | If CB15 migration hasn't run, /activity query for that table will silently return [] (Supabase handles gracefully) |
| `practice_deadlines` without `client_id` FK | LOW | Some deadlines may not have client_id set → client name shows '—'. No error. |
| Large practice with many returns | LOW | /returns fetches up to 400 rows per table before pagination — JS merge handles reasonably; limit set to 400 per table |
| Reviewer attribution for review packs | LOW | Uses underlying return's reviewer_team_member_id — correct for most workflows; see follow-up note |

---

## Recommended Codebox 35

**Tax Deadline Manager — Centralised SARS Deadlines per Client**

With the Tax Dashboard now showing overdue deadlines and provisional due dates, the natural next step is a dedicated deadline management interface where accountants can:
- View all deadlines per client, filterable by type/status/team member
- Mark deadlines as completed / submitted / missed
- Add custom deadlines per client
- Link deadlines to specific tax returns or provisional plans

This closes the loop between the command centre (view) and the operational data (edit).
