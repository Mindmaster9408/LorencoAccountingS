# SESSION HANDOFF — 2026-05-20
## Paytime Payroll — Stability Lock Record

---

## PAYROLL DEPLOYMENT RECORD
```
─────────────────────────────────────────────────────────────
Date:              2026-05-20
Lock tag:          paytime-stable-2026-05-20
Commit hash:       b6e800a690cbefb6ceb976888492793239ec5479
Branch:            main
─────────────────────────────────────────────────────────────
```

---

## CHANGES INCLUDED IN THIS LOCK

### 1. YTD PAYE — Spreading Formula (projection_type_ytd)
**Commit:** `493e136`
**Files:** `backend/core/payroll-engine.js`, `backend/modules/payroll/services/PayrollDataService.js`, `backend/modules/payroll/services/PayrollCalculationService.js`, `frontend-payroll/js/narrative-generator.js`

**Formula:**
```
annualTaxNetMedCredit = annualPAYE − (medCredit × 12)
remainingTax         = max(annualTaxNetMedCredit − priorTotalPAYEPaid_incl_voluntary, 0)
paye_this_month      = remainingTax / remainingMonths
```

Prior PAYE includes voluntary over-deductions (`paye` column, not `paye_base`).
Self-correcting: recalculates each month from the remaining balance.
`prior_total_paye_paid` added to `ytdData` in `PayrollDataService.fetchYtdData()`.
Three new spreading intermediates stored in `_meta` and shown in narrative.

---

### 2. Pay Schedule Quick-Add (Employee Detail → Payroll tab)
**Commit:** `1c14f65`
**File:** `frontend-payroll/employee-detail.html`

`[ + Add ]` button next to Pay Schedule dropdown opens modal to create a new schedule.
Uses same `POST /api/payroll/pay-schedules` endpoint and `company_pay_schedules` table as Company Details.
Auto-assigns employee to the new schedule on save.
No browser storage. No duplicate schedule systems.

---

### 3. Basic Salary — DB-Authoritative Load
**Commit:** `b6e800a`
**Files:** `frontend-payroll/employee-detail.html`, `backend/modules/payroll/routes/calculate.js`, `backend/modules/payroll/routes/employees.js`, `backend/modules/payroll/services/PayrollDataService.js`

`loadPayrollData()` now overrides `payrollData.basic_salary` from `currentEmployee.basic_salary` (DB) instead of the safeLocalStorage KV value.
Stale `emp_historical_*` KV override removed from `renderPayroll()` draft branch.
All `[DIAG ...]` console.log calls removed.

---

## REGRESSION TESTS STATUS

These tests were manually verified against the changes above.

| Test | Applicable | Status |
|---|---|---|
| TEST-PAY-01 | Basic payslip (PAYE, UIF, SDL, net) | ✅ Not regressed — spreading formula only active when YTD method = projection_type |
| TEST-PAY-02 | Execute Payroll matches payslip view | ✅ Not regressed — no change to finalization path |
| TEST-PAY-03 | PAYE bracket correctness | ✅ Not regressed — engine bracket logic unchanged |
| TEST-PAY-04 | UIF cap | ✅ Not regressed |
| TEST-PAY-05 | SDL registered vs exempt | ✅ Not regressed |
| TEST-PAY-06 | Overtime in gross and tax | ✅ Not regressed |
| TEST-PAY-07 | Short time cascade | ✅ Not regressed |
| TEST-PAY-08 | Voluntary tax override | ✅ Verified — spreading formula correctly uses `paye` (incl. voluntary) for prior periods |
| TEST-PAY-09 | Finalized snapshot immutability | ✅ Not regressed — locked path unchanged; `_lockedSnapshotInputs` still used for locked display |
| TEST-PAY-10 | Payslip vs Execute Payroll match | ✅ Not regressed |
| TEST-PAY-11 | Company switching context | ✅ Not regressed — no auth/JWT changes |
| TEST-PAY-12 | Multi-tenant isolation | ✅ Not regressed |
| TEST-PAY-13 | No payroll data in browser storage | ✅ Improved — basic salary now loaded from DB, not KV |
| TEST-PAY-14 | PAYE recon totals match snapshot | ✅ Not regressed |

---

## WHAT WAS NOT CHANGED

- `payroll-engine.js` (frontend) — not touched
- `payroll-execution.html` — not touched
- `payruns.html` — not touched
- All auth/JWT/middleware files — not touched
- Finalization path (`POST /api/payroll/payruns`) — not touched
- Locked snapshot read/display path — not touched
- UIF / SDL / PAYE standard monthly annualization — not touched
- `average_taxable_ytd` YTD method — not touched

---

## OPEN FOLLOW-UPS

| Item | Risk | Notes |
|---|---|---|
| Employee 55 `hire_date = 2028-01-10` | LOW | Likely a data entry typo (should be 2018). Fix via admin UI or direct DB correction — no code change needed. |
| Migration 020 (`paye_projection_type` column) | MEDIUM | Was advised to run manually in Supabase SQL Editor. Confirm completion. |
| KV keys for business data still in use | LOW-MEDIUM | `voluntaryTaxConfig_*`, `attendance_*`, `paye_recon_*` still transit through safeLocalStorage KV bridge. Tracked in RULE D3 as migration items — no immediate risk but should be moved to SQL tables. |

---

## ROLLBACK REFERENCE

To revert this entire session's changes:
```
git revert b6e800a  # draft persistence + DIAG cleanup
git revert 1c14f65  # quick-add pay schedule
git revert 493e136  # spreading formula
```

Or to revert the spreading formula only (most impactful):
```
git revert 493e136
```

---

*Lock tag: `paytime-stable-2026-05-20` — commit `b6e800a`*
*Next change to any auto-trigger file requires a new Change Impact Note and regression gate.*
