# SESSION HANDOFF — CODEBOX 07 — COMPLIANCE CALENDAR FOUNDATION

**Date:** June 2026  
**Status:** Complete — not committed or pushed

---

## Status

All codebox 07 tasks complete. No commits or pushes made. Ready for review and database migration.

---

## What Was Built

1. **Migration 058** — extends `practice_deadlines`, creates `practice_compliance_rules`, creates `practice_deadline_events`
2. **Enhanced backend deadline routes** — full compliance fields, soft-cancel, audit logging, status endpoint
3. **New compliance API routes** — calendar, rules CRUD, suggestions engine, deadline events
4. **Compliance Calendar page** — calendar + list toggle, filters, summary bar, deadline modal, rule modal, status modal
5. **Client Detail integration** — Compliance Suggestions section with "Load Suggestions" and "Create Deadline" per suggestion
6. **Nav updated** — Compliance and Workflows tabs added; Workflows page nav key fixed

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/058_practice_compliance_deadlines.sql` | Database migration |
| `backend/frontend-practice/compliance.html` | Compliance calendar page |
| `backend/frontend-practice/js/compliance.js` | All JS for compliance.html |
| `docs/CODEBOX-07-COMPLIANCE-CALENDAR.md` | Full codebox documentation |
| `docs/SESSION_HANDOFF_codebox_07_compliance.md` | This file |

---

## Files Modified

| File | What Changed |
|---|---|
| `backend/modules/practice/index.js` | Expanded enums; enhanced GET/POST/PUT /deadlines; new DELETE (soft-cancel); new PUT /deadlines/:id/status; GET /deadlines/:id; all compliance routes added |
| `backend/frontend-practice/js/layout.js` | Added Compliance + Workflows to PAGES nav array |
| `backend/frontend-practice/js/workflows.js` | Fixed `LAYOUT.init('tasks')` → `LAYOUT.init('workflows')` |
| `backend/frontend-practice/client-detail.html` | Added suggestion CSS, compliance suggestions section div, create-from-suggestion modal |
| `backend/frontend-practice/js/client-detail.js` | Added loadComplianceSuggestions, openSuggestionDeadlineModal, saveSuggestionDeadline, closeSuggestionModal; exposed globals; unhide suggestions section on load |

---

## Database Migration

**File:** `backend/config/migrations/058_practice_compliance_deadlines.sql`  
**Track:** `backend/config/migrations/` (was at 057, this is 058)  
**Run in:** Supabase SQL Editor

**Critical:** Run before deploying backend. The updated PUT /deadlines handler writes `submitted_at` which must exist as a column (added in 058).

**Safe to re-run:** All `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS`.

---

## API Endpoints

### Enhanced
- `GET /api/practice/deadlines` — now supports: compliance_area, deadline_type, responsible_team_member_id, search, page, limit, include_cancelled
- `POST /api/practice/deadlines` — now logs audit + deadline event; accepts all compliance fields
- `PUT /api/practice/deadlines/:id` — now logs audit + event; validates ownership; accepts all compliance fields; soft-cancel guard
- `DELETE /api/practice/deadlines/:id` — **NOW SOFT-CANCEL** (sets is_active=false, status='cancelled')

### New
- `GET /api/practice/deadlines/:id` — single deadline detail
- `PUT /api/practice/deadlines/:id/status` — safe status-only transition
- `GET /api/practice/deadlines/:id/events` — audit event log
- `GET /api/practice/compliance/calendar` — calendar events with date range + overdue flag
- `GET /api/practice/compliance/rules` — list rules
- `POST /api/practice/compliance/rules` — create rule
- `PUT /api/practice/compliance/rules/:id` — update rule
- `DELETE /api/practice/compliance/rules/:id` — soft-deactivate rule
- `GET /api/practice/compliance/suggestions/client/:clientId` — client-based suggestions

---

## Frontend URLs

| URL | Page |
|---|---|
| `/practice/compliance.html` | Compliance calendar (NEW) |
| `/practice/client-detail.html?id=:id` | Client profile — now has Compliance Suggestions section |
| `/practice/workflows.html` | Workflows — now correctly highlighted in nav |

---

## Suggestion Logic Notes

Suggestions are derived from client compliance flags. Mapping:

| Flag | Suggestions |
|---|---|
| `vat_registered` | VAT201 |
| `paye_registered` | EMP201 + EMP501 |
| `provisional_taxpayer` | IRP6 P1 + IRP6 P2 |
| `client_type = individual` | ITR12 |
| `client_type IN (company/cc/trust/partnership)` | ITR14 + Annual Financial Statements |
| `cipc_registered` | CIPC Annual Return + Beneficial Ownership |
| `uif_registered OR paye_registered` | Monthly Payroll Processing |

Nothing is auto-created. Each suggestion requires explicit user confirmation.

---

## Manual Test Steps

1. Apply migration 058 in Supabase SQL Editor
2. Restart the backend server
3. Open `/practice/compliance.html` — verify calendar loads, nav shows Compliance highlighted
4. Click Workflows tab — verify it highlights Workflows (not Tasks)
5. Create a new deadline via "+ New Deadline" button
6. Verify it appears on the calendar on the correct date
7. Toggle to List view — verify it appears
8. Click Status → change to Submitted — verify submission reference field appears
9. Open Edit on the deadline — change a field, save
10. Cancel the deadline via Edit modal — verify it disappears from active list
11. Open a client detail page — verify "Compliance Suggestions" section appears below Contact Persons
12. Click "Load Suggestions" — verify suggestions appear (client must have compliance flags set)
13. Click "+ Create Deadline" — verify modal pre-fills with suggestion data
14. Set a due date, click "Create Deadline" — verify deadline appears in compliance calendar
15. Verify browser DevTools → Application → Local Storage has no compliance business data

---

## Known Risks

1. **Migration 058 must be applied before backend restart** — `submitted_at` column must exist or the updated PUT handler will fail silently on Supabase (column writes are ignored for non-existent columns, but it's safer to apply migration first)
2. **`practice_workflow_runs` FK in migration** — safe only if migration 057 (workflow templates) was already applied
3. **Calendar "+N more" events have no click-through** — users can switch to List view to see all deadlines for a busy day
4. **Compliance rules are documentation only** — no automation hooks the rules into deadline generation yet

---

## Recommended Codebox 08

**Workflow-to-Deadline Linking**

Link workflow run generation to automatic deadline creation. When `POST /api/practice/workflows/generate` runs, it should:
1. Check if the workflow template has a `deadline_type` + `compliance_area` configured
2. If yes, create a linked `practice_deadlines` record with `workflow_run_id` set
3. The compliance calendar then shows which deadlines have workflow task coverage
4. No cron/automation needed — linking happens at manual generate time
