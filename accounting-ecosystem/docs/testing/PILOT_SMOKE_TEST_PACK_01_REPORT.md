# Pilot Smoke Test Pack v01 — Implementation Report

> **Status:** Complete  
> **Date:** 2026-05  
> **Test Pack Version:** 01  
> **Module:** Lorenco Accounting

---

## 1. Summary

The Pilot Smoke Test Pack is a guided runtime QA system for Lorenco Accounting. It provides internal pilot testers with a structured, evidence-driven checklist for manually testing critical accounting workflows before releases or after significant changes.

This is **not automated browser testing** (Playwright/Cypress). It is a browser-based tool where a human tester works through each test item, records Pass/Fail/Blocked/Not Tested, captures notes and evidence references, and saves the result set to the database for regression tracking.

---

## 2. Files Created or Modified

### New Files

| File | Purpose |
|---|---|
| `database/migrations/057_pilot_smoke_tests.sql` | DB schema: two tables for storing QA run sessions and per-test results |
| `backend/modules/accounting/routes/pilot-smoke-tests.js` | API routes: templates, runs CRUD (GET/POST/PUT) |
| `frontend-accounting/pilot-smoke-tests.html` | Full QA checklist UI with status recording, summary, save, load, and export |
| `docs/future-build/PILOT_SMOKE_TESTING_ROADMAP.md` | Forward-planning document for Phases 2–9 |
| `docs/testing/PILOT_SMOKE_TEST_PACK_01_REPORT.md` | This file |

### Modified Files

| File | Change |
|---|---|
| `backend/modules/accounting/index.js` | Mounted `/pilot-smoke-tests` route under `/api/accounting/` |
| `backend/modules/accounting/middleware/auth.js` | Added `pilot_smoke_test.view` and `pilot_smoke_test.run` permissions |
| `frontend-accounting/js/navigation.js` | Added "QA" header and "Pilot Smoke Tests" link in Administration dropdown; active state detection for `pilot-smoke-tests.html` |

---

## 3. Test Pack Structure

### Version 01 — 23 Tests Across 6 Categories

| Category | Tests | Critical | High | Normal |
|---|---|---|---|---|
| Banking | 5 | 3 | 1 | 1 |
| VAT | 4 | 2 | 2 | 0 |
| AR / AP | 5 | 5 | 0 | 0 |
| Reports | 4 | 3 | 1 | 0 |
| Historical Comparatives | 3 | 1 | 2 | 0 |
| Security | 2 | 2 | 0 | 0 |
| **Total** | **23** | **16** | **6** | **1** |

### Full Test Item List

**Banking**
- `bank_import_statement` — Import bank statement (critical)
- `bank_allocate_transaction` — Allocate transaction (critical)
- `bank_reconcile_transaction` — Reconcile transaction (critical)
- `bank_unmatched_flow` — Unmatched transaction flow (high)
- `bank_rules_suggestion` — Bank rules suggestion (normal)

**VAT**
- `vat_generate_report` — Generate VAT report (critical)
- `vat_warnings` — VAT warnings displayed (high)
- `vat_period_selection` — Period selection (high)
- `vat_draft_finalized` — Draft / finalised behaviour (critical)

**AR / AP**
- `ar_create_customer_invoice` — Create customer invoice (critical)
- `ar_post_invoice` — Post invoice to GL (critical)
- `ar_record_payment` — Record customer payment (critical)
- `ap_create_supplier_invoice` — Create supplier invoice (critical)
- `ap_supplier_payment` — Supplier payment (critical)

**Reports**
- `report_trial_balance` — Trial Balance (critical)
- `report_pl` — Profit & Loss (critical)
- `report_balance_sheet` — Balance Sheet (critical)
- `report_control_recon` — Control Reconciliation (high)

**Historical Comparatives**
- `hist_save_comparative` — Save historical comparative (high)
- `hist_reload` — Reload saved comparative (high)
- `hist_finalize_protection` — Finalise protection enforced (critical)

**Security**
- `sec_company_switching` — Company switching (critical)
- `sec_role_restriction` — Role restriction checks (critical)

---

## 4. Database Storage Model

### Tables Created

**`pilot_smoke_test_runs`**
- One row per QA test session
- Columns: `id`, `company_id`, `tester_name`, `build_version`, `notes`, `total_count`, `passed_count`, `failed_count`, `blocked_count`, `not_tested_count`, `created_at`, `updated_at`
- Indexed by: `company_id`, `(company_id, created_at DESC)`

**`pilot_smoke_test_results`**
- One row per test item per run
- Columns: `id`, `run_id`, `company_id`, `category`, `test_key`, `test_name`, `severity`, `status`, `notes`, `screenshot_ref`, `error_text`, `updated_at`
- `UNIQUE (run_id, test_key)` — no duplicate results per run
- `CHECK (status IN ('pass', 'fail', 'blocked', 'not_tested'))`
- Indexed by: `run_id`, `company_id`

---

## 5. API Endpoints

All endpoints are mounted at `/api/accounting/pilot-smoke-tests/`.

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/templates` | `pilot_smoke_test.view` | Returns static test pack definition |
| `GET` | `/runs` | `pilot_smoke_test.view` | Lists last 30 runs for the current company |
| `POST` | `/runs` | `pilot_smoke_test.run` | Creates a new run + initialises all result rows |
| `GET` | `/runs/:id` | `pilot_smoke_test.view` | Returns a single run + all results |
| `PUT` | `/runs/:id` | `pilot_smoke_test.run` | Saves results + updates run header atomically |

**Company isolation:** All routes extract `companyId` from `req.user.companyId` (from the verified JWT). No cross-company data is accessible.

**Transaction safety:** `POST /runs` and `PUT /runs/:id` use `db.getClient()` with explicit `BEGIN/COMMIT/ROLLBACK` to ensure atomic writes.

---

## 6. Permission Roles

| Permission | Roles |
|---|---|
| `pilot_smoke_test.view` | admin, accountant, bookkeeper |
| `pilot_smoke_test.run` | admin, accountant, bookkeeper |

Viewers (`viewer` role) do not have access. This is intentional — smoke testing is a QA activity, not a read-only view.

---

## 7. Frontend Behaviour

### Key UX Flows

1. **New run:** Enter tester name + optional build version + optional notes → work through checklist → click Save Run
2. **Mark a test:** Four buttons per test — PASS, FAIL, BLOCKED, N/T. Clicking selects the status and highlights the button.
3. **Fail/Blocked requires notes:** A warning is shown and save is blocked until a note is entered for any Fail or Blocked item.
4. **Detail panel:** Fail/Blocked items auto-expand a detail panel with Notes, Screenshot Reference, and Error Text fields.
5. **Progress bar:** Updates in real-time as tests are marked.
6. **Summary strip:** Live counts of Pass/Fail/Blocked/Not Tested.
7. **Category summaries:** Each category header shows a mini summary of its test results.
8. **Collapsible categories:** Click any category header to collapse/expand that section.
9. **Save Run:** `POST /runs` to create, then `PUT /runs/:id` to write results. On subsequent saves, only `PUT /runs/:id` is called.
10. **Load previous run:** Opens a panel listing the 30 most recent runs. Clicking a run loads it into the UI.
11. **Export to Markdown:** Generates a formatted `.md` report and triggers a browser download. Works offline (no API call needed).
12. **New Run button:** Resets all state. Prompts confirmation if there are unsaved changes.

### Security / Storage Compliance

- **No business data in localStorage.** Test run data goes entirely through the API to the Supabase PostgreSQL database.
- The only localStorage usage is via the polyfills.js `_tok()` function for auth token retrieval — this is the approved auth pattern.
- Export to Markdown is a pure client-side Blob — no external data transfer.

---

## 8. Required Tests Before Release

The following manual tests should be performed on first deployment:

| # | Test | Expected |
|---|---|---|
| T01 | Load `/accounting/pilot-smoke-tests.html` | Page loads with checklist, 23 items visible |
| T02 | Mark a test as Pass | Button highlights green, progress updates |
| T03 | Mark a test as Fail without notes | Warning shown, Save Run blocked |
| T04 | Add note to Fail item, click Save Run | Run saved, Run ID appears in badge |
| T05 | Mark Blocked item, add blocker note | Detail panel shows, warning clears |
| T06 | Click "Load Previous Run" | Panel shows recent runs list |
| T07 | Load a previously saved run | All statuses and notes restore correctly |
| T08 | Click Export .md | Markdown file downloads with correct content |
| T09 | Click "New Run" with unsaved changes | Confirmation prompt shown |
| T10 | Access as `viewer` role | 403 returned from API, graceful error in UI |
| T11 | Switch company, load runs | Only runs for new company are shown |
| T12 | Check that no test run data is in localStorage | DevTools → Application → Storage = empty for business keys |

---

## 9. Remaining Risks and Known Limitations

| Risk | Severity | Notes |
|---|---|---|
| `057_pilot_smoke_tests.sql` migration must be applied | High | Run migration on Supabase before first access. Tables do not auto-create. |
| Test pack is hardcoded in `routes/pilot-smoke-tests.js` | Low | Intentional for v01. Future versions: DB-backed template versioning (see roadmap Phase 3). |
| No real-time screenshot upload | Low | Screenshot reference is a text field only (filename/path). Phase 2 feature. |
| No automated test execution | Low | Phase 5 (Playwright). All tests are manual. |
| Viewer role cannot access the page | Low | Intentional — smoke testing requires active participation, not read-only viewing. |
| If tester navigates away mid-run, unsaved state is lost | Medium | The `beforeunload` browser prompt can help, but a full autosave could be added in v02. |

---

## 10. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Pilot Smoke Test Pack
- Dependency: Supabase migration 057
- What was done now: Full implementation — backend, frontend, DB migration, nav, docs
- What still needs to be checked:
    1. Migration 057 must be applied to the production Supabase project
    2. First run should verify the 23 items render and save correctly
    3. Load Previous Run flow should be tested with a real saved run
- Risk if not checked: Page will 500 if tables don't exist yet
- Recommended next review point: After first pilot test session
```

---

*This report covers the complete v01 implementation. For planned future enhancements, see [PILOT_SMOKE_TESTING_ROADMAP.md](../future-build/PILOT_SMOKE_TESTING_ROADMAP.md).*
