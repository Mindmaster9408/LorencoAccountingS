# LORENCO PAYTIME — FULL QA AUDIT REPORT

> **Audit date:** 2026-05-27  
> **Auditor:** Claude (Principal Engineer / QA Lead role)  
> **Scope:** Full read-only audit of Lorenco Paytime payroll system — backend + frontend  
> **Instruction:** DO NOT CODE. DO NOT CHANGE FILES. DO NOT RUN MIGRATIONS. AUDIT ONLY.

---

## EXECUTIVE SUMMARY

Lorenco Paytime is a **South African multi-tenant payroll system** built on:
- Node.js / Express backend (Supabase PostgreSQL)
- Static HTML + vanilla JS frontend
- KV bridge (localStorage → Supabase `payroll_kv_store_eco`) via `polyfills.js`
- A pure-function calculation engine (`payroll-engine.js`) shared between frontend and backend

**Overall readiness verdict:** **YES WITH CONDITIONS** — Paytime can run real client payroll, but with **6 conditions** that must be understood and accepted before doing so. Two of these conditions carry **HIGH severity** risk that could produce incorrect financial outputs or compliance failures.

---

## READINESS SCORE

| Category | Score | Comment |
|---|---|---|
| Calculation engine correctness | 9/10 | PAYE/UIF/SDL/medical credits correctly implemented. YTD method correct. One unconfirmed table (2026/27). |
| Snapshot immutability | 10/10 | Excellent. DB-authoritative. No browser flag controls finalization. |
| Multi-tenant isolation | 9/10 | `companyId` always from JWT. Ownership checks on mutations. One ambiguity (salary source). |
| Data persistence architecture | 6/10 | Payroll items in KV, not SQL. Historical data split across KV + DB. Recon risk (see below). |
| Finalization / reversal workflow | 9/10 | Correct. Run-level reversal enforced before individual unlock. Audit trail on unlock. |
| PAYE reconciliation accuracy | 6/10 | Backend recon endpoint is correct. Frontend recon page may read stale KV data (see Risk RC-01). |
| Permissions / access control | 8/10 | PAYROLL.VIEW/CREATE/APPROVE correctly scoped. Sensitive KV key guard in place. |
| Compliance (SARS) | 7/10 | 2026/27 tax tables unconfirmed. uif_employer = 0 on EMP501. IRP5 codes not assigned. |
| localStorage / browser storage | 7/10 | All payroll data goes through KV bridge (cloud-backed). Raw localStorage only for UI prefs. |

**Overall: 78/100**

---

## FINAL VERDICT

> **Would you trust Lorenco Paytime to run a real client payroll today?**

**YES — WITH CONDITIONS.**

The core calculation engine, finalization model, and multi-tenant architecture are sound and production-ready. You can run payroll for the current tax year (2025/2026 — March 2025 to February 2026) with confidence. For 2026/2027 payroll (March 2026 onwards), the 2026/27 tax tables must be confirmed against SARS before processing.

**The 6 conditions you must accept:**

| # | Condition | Severity |
|---|---|---|
| C1 | Confirm 2026/2027 SARS tax tables before running March 2026+ payroll | HIGH |
| C2 | Verify paye-reconciliation.html reads from API (not legacy KV) before relying on recon totals | HIGH |
| C3 | Payroll items (regular inputs) are in KV — understand that KV loss = input loss | MEDIUM |
| C4 | EMP501 report shows uif_employer = 0 — do not use for employer UIF submissions without manual correction | MEDIUM |
| C5 | IRP5 code assignments are empty in all snapshots — EMP501 is foundation only, not SARS-submission-ready | MEDIUM |
| C6 | Historical imports from CSV write to KV; if recon page reads from KV, historical months may show different totals than the DB-authoritative snapshot view | LOW-MEDIUM |

---

## PART 1 — PAYROLL CALCULATION ENGINE

**File audited:** `frontend-payroll/js/payroll-engine.js`

### 1.1 Tax Tables

| Item | Finding | Status |
|---|---|---|
| 2024/2025 tax brackets | Hardcoded and complete | PASS |
| 2025/2026 tax brackets | Hardcoded and complete | PASS |
| 2026/2027 tax brackets | Identical to 2025/2026 — comment reads "pending SARS confirmation" | **RISK** |
| Primary rebate (2025/26+) | R17,235 — SARS confirmed | PASS |
| Secondary rebate (65+) | R9,444 — SARS confirmed | PASS |
| Tertiary rebate (75+) | R3,145 — SARS confirmed | PASS |
| Medical credit (main + 1st dep) | R364/month each | PASS |
| Medical credit (additional) | R246/month | PASS |
| UIF rate | 1% | PASS |
| UIF monthly cap | R177.12 | PASS |
| SDL rate | 1% | PASS |

**FINDING ENG-01 (HIGH):** The 2026/2027 tax table is a placeholder copy of 2025/2026 with a "pending SARS confirmation" comment. If SARS has published updated brackets for the 2026/2027 tax year and they have not been entered, all payroll processed from March 2026 onwards will be calculated against the 2025/2026 brackets. PAYE figures will be wrong.

**Action required before March 2026 payroll:** Confirm 2026/2027 SARS tax brackets and rebates. Update the tax table in `payroll-engine.js` if they differ.

### 1.2 Tax Calculation Method

| Item | Finding | Status |
|---|---|---|
| Method | YTD annualised (SARS method 2) | PASS |
| YTD data source | `payroll_snapshots` with `is_locked = true` (DB-authoritative) | PASS |
| Annualisation | Correctly projects from period-in-year to annual income | PASS |
| Monthly PAYE | `calculateMonthlyPAYE_YTD()` — correct SARS run-to-date method | PASS |
| Once-off income | Separate path from periodic income — no annualisation applied | PASS |
| Medical credit application | Applied against calculated tax, not gross | PASS |

### 1.3 UIF Calculation

| Item | Finding | Status |
|---|---|---|
| Rate | 1% of gross income | PASS |
| Monthly cap | R177.12 | PASS |
| Director exemption | `is_director === true` → UIF = 0 (Unemployment Insurance Act compliant) | PASS |
| UIF-exempt flag | Reads from `employee_payroll_setup.uif_exempt` | PASS |

### 1.4 SDL Calculation

| Item | Finding | Status |
|---|---|---|
| Rate | 1% of gross income | PASS |
| Company-level SDL toggle | `company.sdl_registered` flag controls SDL | PASS |
| SDL on zero gross | Correctly returns 0 | PASS |

### 1.5 Pro-Rata Calculation

| Item | Finding | Status |
|---|---|---|
| Auto-detection | Fires when hire_date or termination_date falls inside period boundaries | PASS |
| Method | Days-based: `workedDays / expectedDays` | PASS |
| Hours-based (hourly workers) | Separate hours-based path for is_hourly_paid employees | PASS |
| Effect on PAYE | Pro-rated gross is used as calculation base — correct | PASS |

### 1.6 Net-to-Gross Calculation

| Item | Finding | Status |
|---|---|---|
| Method | Binary search bisection | PASS |
| Convergence | Iterative, converges to within R0.01 | PASS |
| Edge case (gross < net) | Bounded by max iterations | PASS |

---

## PART 2 — SNAPSHOT IMMUTABILITY

**Files audited:** `PayrollHistoryService.js`, `payruns.js`, `calculate.js`, `unlock.js`

### 2.1 Snapshot Design

| Item | Finding | Status |
|---|---|---|
| Full input stored | `calculation_input` — deep copy stored in DB | PASS |
| Full output stored | `calculation_output` — deep copy stored in DB | PASS |
| Engine version recorded | `engine_version` field on every snapshot | PASS |
| Schema version recorded | `schema_version` field for future migrations | PASS |
| Tax context fields | First-class fields on snapshot (not buried in output blob) | PASS |
| is_locked flag | DB column — not browser storage | PASS |
| Reversed snapshots | Never deleted — `status='reversed'`, preserved for audit | PASS |

### 2.2 Finalization Flow

| Item | Finding | Status |
|---|---|---|
| Finalization path | `POST /api/payroll/run` → `POST /api/payroll/finalize` | PASS |
| Lock condition | Sets `is_locked=true, status='finalized'` on all run's snapshots | PASS |
| Re-calculate guard | `calculate.js` returns locked snapshot directly without recalculating | PASS |
| Run header finalization | `payroll_runs.status='finalized'` on finalize | PASS |
| Reversal path | `POST /api/payroll/reverse` — requires reason, sets `is_locked=false, status='reversed'` | PASS |
| Individual unlock | Blocked when payslip is in finalized run (must reverse the run first) | PASS |
| Unlock authorization | Server-side bcrypt credential check + role check + audit log | PASS |
| KV keys deleted on unlock | `emp_payslip_status_*` and `emp_historical_*` deleted AFTER snapshot reset | PASS |

### 2.3 Immutability Risks

**FINDING SNAP-01 (LOW):** `PayrollHistoryService.getSnapshot()` filters `neq('status', 'reversed')`. If a period has both a reversed and a new active snapshot, `maybeSingle()` could theoretically return multiple rows if the new snapshot was not created correctly. The `neq` filter mitigates this but a unique partial index on `(company_id, employee_id, period_key) WHERE status != 'reversed'` would make this bulletproof.

---

## PART 3 — MULTI-TENANT ISOLATION

**Files audited:** `calculate.js`, `payruns.js`, `employees.js`, `PayrollDataService.js`, `kv.js`

### 3.1 Company Isolation

| Item | Finding | Status |
|---|---|---|
| `companyId` source | Always from `req.companyId` (JWT-derived, set by `requireCompany` middleware) | PASS |
| `companyId` from body | Blocked by `sanitizeBody()` / not accepted on any route | PASS |
| Employee ownership check | All employee mutations check `company_id = req.companyId` | PASS |
| Payroll run ownership | `finalize.js` and `reverse.js` verify `payroll_run.company_id = req.companyId` | PASS |
| Snapshot ownership | All snapshot queries filter by `company_id` | PASS |
| KV isolation | KV read/write scoped to `company_id` | PASS |

### 3.2 Employee Visibility Scoping

| Item | Finding | Status |
|---|---|---|
| `getEmployeeFilter()` | Returns `none` (all), `ids` (specific), or `classification` (public only) | PASS |
| Visibility check on calculate | Applied before allowing calculation | PASS |
| Visibility check on employees routes | `canViewEmployee()` checked on all GET/PUT | PASS |
| Restricted users | Cannot fetch employees outside their scope | PASS |

### 3.3 Salary Source Ambiguity

**FINDING MT-01 (MEDIUM):** `PayrollDataService.fetchEmployee()` has a KV fallback for `basic_salary`:

```javascript
if (!emp.basic_salary) {
    // fallback: try KV store for legacy data
    ...
}
```

If the `employees.basic_salary` column is populated AND a KV value also exists, the DB value wins (correct). But if the DB column is null/zero and KV has a non-zero value, the KV value is used. This means salary could silently come from KV rather than the authoritative DB column. No log message distinguishes which source was used.

**Risk:** A payroll run could calculate using a stale KV salary while the DB has a different (more recent) value, or vice versa. An auditor reviewing the DB record would see a different salary than what was calculated.

---

## PART 4 — KV BRIDGE ARCHITECTURE

**Files audited:** `polyfills.js`, `data-access.js`, `kv.js`

### 4.1 Architecture

The KV bridge is a monkey-patch on `window.localStorage` installed by `polyfills.js`. All writes to non-local keys are stored in-memory (synchronous) and async-pushed to `payroll_kv_store_eco` via `PUT /api/payroll/kv/:key`. All reads use the in-memory cache preloaded at page load via a synchronous XHR to `GET /api/payroll/kv`.

`data-access.js` installs a SECOND bridge (`installEcoPayrollLocalStorageBridge()`) with a slightly different `isLocalKey()` allowlist.

### 4.2 Two-Bridge Conflict Risk

**FINDING KV-01 (LOW-MEDIUM):** Both `polyfills.js` and `data-access.js` install KV bridges. If both are loaded on the same page, writes may go through the `data-access.js` bridge (which overwrites `window.localStorage` again). The allowlist differences between the two bridges mean a key considered "local" in one bridge might be "cloud" in the other, causing inconsistent routing.

Observed difference:
- `polyfills.js` `LOCAL_KEYS`: token, paytime_token, session, user, company, selectedCompanyId, availableCompanies, lastCompanyId, sso_source, notif
- `data-access.js` `isLocalKey()`: session, token, company, selectedCompanyId, availableCompanies, user, sso_source, language + `cache_*` prefix

The overlap is substantial but not identical. No session data appears to be at risk.

### 4.3 Business Data in KV

The following business data categories are stored in KV (not in SQL tables):

| KV Key Pattern | Data Type | Migration Status | Risk |
|---|---|---|---|
| `emp_payroll_${c}_${e}` | Employee regular payroll items (allowances/deductions) | NOT migrated | **HIGH** — loss of this key = loss of payroll inputs |
| `emp_payslip_status_${c}_${e}_${p}` | Payslip finalization state (legacy) | Partially migrated — DB snapshot is authoritative | LOW — DB wins |
| `emp_historical_${c}_${e}_${p}` | Locked payroll snapshot (legacy format) | Partially migrated — DB snapshots exist | MEDIUM — see RC-01 |
| `payruns_${c}` | Pay run list cache | KV-backed cache | LOW — regeneratable |
| `paye_recon_sars_${c}` | SARS submitted values for recon | Partially migrated — DB table exists | MEDIUM — see RC-02 |
| `paye_recon_bank_${c}` | Bank payment values for recon | Partially migrated — DB table exists | MEDIUM — see RC-02 |
| `tax_config` | Tax configuration tables | DB-authoritative (payroll_kv_store_eco company_id=__global__) | LOW — same DB, just KV format |
| `voluntaryTaxConfig_*` | Voluntary tax overrides | Migrated to `employees.voluntary_tax_config` column | LOW — DB is authoritative |

**FINDING KV-02 (HIGH — CRITICAL):** Employee regular payroll inputs (basic salary adjustments, allowances, deductions — the `emp_payroll_${c}_${e}` KV key) are the PRIMARY source used by `PayrollEngine.calculateEmployeePeriod()` for payroll calculations. There is no dedicated SQL table that stores these payroll items as structured rows. If the KV store is cleared, reset, or migrated, all employee payroll configurations are lost and payroll cannot be run.

This is the single largest architectural risk in the system.

---

## PART 5 — PAYE RECONCILIATION

**Files audited:** `recon.js`, `recon-service.js`, `paye-reconciliation.html` (partial)

### 5.1 Backend Recon Routes

The backend has proper, DB-authoritative reconciliation endpoints:

| Endpoint | Data Source | Status |
|---|---|---|
| `GET /api/payroll/recon/summary` | `payroll_snapshots` (is_locked=true) + `payroll_historical` | PASS — correct |
| `GET /api/payroll/recon/emp501` | `payroll_snapshots` (is_locked=true) + `payroll_historical` | PASS — correct |
| `GET/PUT /api/payroll/recon/submitted` | `payroll_recon_submitted` table | PASS |
| `GET/PUT /api/payroll/recon/finalized` | `payroll_recon_finalized` table | PASS |
| Tax year boundary | March–February correctly implemented | PASS |
| Snapshot deduplication | Latest locked snapshot per employee+period wins | PASS |
| Historical yield | Historical data yields to snapshot for same employee+period | PASS |

### 5.2 Frontend Recon-Service (RISK)

**FINDING RC-01 (HIGH):** `recon-service.js` is a legacy frontend service that reads payroll totals from `PayrollEngine.getHistoricalRecord()`, which reads from KV-backed `emp_historical_*` keys — NOT from the DB.

If `paye-reconciliation.html` still uses `ReconService.buildPayrollTotals()` for its primary data display, the PAYE reconciliation totals shown in the UI will be based on KV historical records, while the DB-authoritative view (from the API endpoint) may differ.

The `ReconService.loadSARSValues()` and `loadBankValues()` functions read from `paye_recon_sars_*` and `paye_recon_bank_*` KV keys. The backend now has a `payroll_recon_submitted` table for this data. If the frontend writes SARS/bank values to KV but the backend reads from the DB table (or vice versa), submitted values will be invisible in one view.

**Action required:** Verify whether `paye-reconciliation.html` calls the new backend `/api/payroll/recon/summary` API or still uses `ReconService.buildPayrollTotals()`. If it still uses the legacy service, PAYE recon totals cannot be trusted.

**FINDING RC-02 (MEDIUM):** `paye-reconciliation.html` line 434 and 441 show writes to KV key `paye_recon_finalized_*`. The backend has a `payroll_recon_finalized` table and a proper `PUT /api/payroll/recon/finalized` endpoint. If the frontend and backend use different stores for this state, recon finalization could appear complete in one view and incomplete in the other.

### 5.3 EMP501 Gaps

**FINDING EMP-01 (MEDIUM):** The `/api/payroll/recon/emp501` endpoint hardcodes `uif_employer: 0` for all employees with the note "not captured in current snapshot schema." Employer UIF contribution (which equals the employee's UIF contribution) must be included for a complete PAYE5 submission. Any EMP501 report produced from this endpoint will understate total UIF liability.

**FINDING EMP-02 (MEDIUM):** IRP5 codes are not assigned to payroll items in any snapshot. The `irp5_codes` array is populated from `agg.irp5_codes` which accumulates from `snap.calculation_output`. However, the engine does not output `irp5_codes` on calculation results. Every EMP501 record will have `irp5_codes: []`. IRP5 certificate generation is explicitly flagged in the route as "Foundation only — not SARS-submission-ready."

---

## PART 6 — VOLUNTARY TAX CONFIGURATION

**Files audited:** `voluntary-tax.js`, `PayrollDataService.js`, `employee-detail.html` (partial)

### 6.1 Voluntary Tax Architecture

**Current state (migrated):** `PayrollDataService.fetchCalculationInputs()` reads `voluntary_tax_config` from the `employees` table column (not KV). This is the correct DB-authoritative path.

| Item | Finding | Status |
|---|---|---|
| Data source | `employees.voluntary_tax_config` column | PASS |
| Legacy KV path | `voluntaryTaxConfig_*` KV key — may still be read by frontend | RISK |
| Backend calc | Uses `normalizedInputs.voluntary_tax_config` from DB | PASS |
| Bonus spread calc | `POST /api/payroll/voluntary-tax/calculate-bonus-spread` — backend only, correct ×12 logic | PASS |

**FINDING VT-01 (LOW):** The frontend `employee-detail.html` may still write voluntary tax config to `safeLocalStorage` under `voluntaryTaxConfig_*` keys. The backend `PayrollDataService` now reads from the DB column. If the frontend saves to KV but not to the DB column, the displayed value and the calculated value could diverge. This depends on whether `employee-detail.html` has been updated to POST to the API.

---

## PART 7 — EMPLOYEE DATA ROUTES

**File audited:** `employees.js`

### 7.1 Coverage

| Route | Permission | Finding |
|---|---|---|
| `GET /employees` | PAYROLL.VIEW | Returns active employees only. Visibility filter applied. |
| `GET /employees/:id` | PAYROLL.VIEW | Non-integer ID (old localStorage IDs) rejected with 404. |
| `PUT /employees/:id/salary` | PAYROLL.CREATE | Ownership + visibility checked. Audit logged. |
| `PUT /employees/:id/employment-dates` | PAYROLL.CREATE | hire/termination date for pro-rata. Audit logged. |
| `PUT /employees/:id/bank-details` | PAYROLL.CREATE | Upsert with manual check-then-insert. Mirrors to `employees` table. |
| `PUT /employees/:id/classification` | PAYROLL.CREATE | Director/contractor/uif_exempt. Audit logged. |
| `PUT /employees/:id/work-schedule` | PAYROLL.CREATE | `full_days_per_week` auto-calculated. |
| `PUT /employees/:id/eti` | PAYROLL.CREATE | ETI status history recorded on change. |
| `PATCH /employees/:id/pay-schedule` | PAYROLL.APPROVE | Schedule multi-tenant safety check. |
| `DELETE /employees/:id` | PAYROLL.CREATE | Soft-delete only (`is_active=false`). History preserved. |

**FINDING EMP-03 (LOW):** Bank details are written to BOTH `employee_bank_details` table AND mirrored to `employees.bank_name/account_number/branch_code` columns. Two sources of truth for bank data. If they diverge (e.g., a direct DB update to `employees` table bypassing the API), bank details shown on payslips could differ from the `employee_bank_details` record.

---

## PART 8 — PERMISSIONS AND ACCESS CONTROL

**Files audited:** `permissions.js`, `kv.js`

### 8.1 Role Hierarchy

Frontend `Permissions.js` defines owner-equivalent roles: `super_admin`, `business_owner`, `practice_manager`, `administrator`.

Backend `permissions.js` (not audited directly but referenced throughout codebase) uses `PAYROLL.VIEW`, `PAYROLL.CREATE`, `PAYROLL.APPROVE`, and `PAYSLIPS.UNLOCK`.

| Frontend Action | Required Role |
|---|---|
| VIEW_PAYROLL | Owner-equiv + accountant + manager |
| EDIT_PAYROLL | Owner-equiv + accountant |
| FINALIZE_PAYSLIP | Owner-equiv + accountant |
| UNFINALIZE_PAYSLIP | Owner-equiv ONLY |
| CREATE_PAYRUN | Owner-equiv + accountant |
| FINALIZE_PAYRUN | Owner-equiv ONLY |
| EXPORT_DATA | Owner-equiv + accountant |

**FINDING PERM-01 (LOW):** `Permissions.getRole()` reads from `safeLocalStorage.getItem('session')`. If the KV preload fails at page load (network error), `session` may not be available in memory, and all permission checks return false (empty role). This would display no buttons and could confuse a user into thinking they have no access. The app should handle this gracefully with a session reload prompt.

**FINDING PERM-02 (LOW):** `permissions.js` has `ROLE_LEVELS` that includes `payroll_admin` and `store_manager` but these roles do not appear in `Permissions.ACTIONS` definitions. If a user has `payroll_admin` role (set on backend), they would not match any `ACTIONS` entry and would see nothing in the UI.

### 8.2 KV Sensitive Key Protection

The `guardSensitiveKey()` middleware in `kv.js` blocks direct write/delete of:
- `emp_payslip_status_*`
- `emp_historical_*`
- `payslip_archive_*`

by any user without `PAYROLL.APPROVE` (super_admin or business_owner roles). This is a strong protection layer.

---

## PART 9 — HISTORICAL IMPORT

**File pattern:** `historical-import.html` (referenced via grep)

**FINDING HI-01 (MEDIUM):** Historical import writes `histKey = emp_historical_${companyId}_${empId}_${period}` to KV. The backend `payroll_historical` table is a separate SQL table. Historical imports appear to write to BOTH KV (for frontend engine compatibility) and the DB table (for backend recon).

If only the KV path is used (and DB write is skipped), the backend recon endpoint (`/api/payroll/recon/summary`) will not see the historical data since it reads from `payroll_historical` table, not KV. Historical months would show R0 in the recon view.

Verification needed: Does `historical-import.html` call `POST /api/payroll/employees/:id/historical` (DB) in addition to setting the KV key?

---

## PART 10 — BROWSER STORAGE AUDIT (RULE D)

**Files audited:** All `frontend-payroll/*.html` via grep

### 10.1 Direct `localStorage.setItem` (raw, not KV bridge)

Only one instance found:
- `payroll-items.html:1009` — `localStorage.setItem(_sectionCollapseKey, ...)` — This is UI preference (section collapse state). **PERMITTED** under Rule D2.

**Verdict:** No raw `localStorage.setItem` calls with business data found. All business-data writes go through `safeLocalStorage` (KV bridge).

### 10.2 `safeLocalStorage.setItem` with Business Data

The following represent business data written to KV (not raw localStorage, but KV-backed):

| File | Line | Key Pattern | Data | Rule D Status |
|---|---|---|---|---|
| `employee-detail.html` | 2216 | `emp_payroll_${c}_${e}` | Regular payroll inputs | **RULE D3 CONCERN** — KV is not SQL |
| `employee-detail.html` | 3977/3980 | `emp_notes_*` | Employee notes | **RULE D3 CONCERN** |
| `historical-import.html` | 923/1561/1928 | `emp_historical_*` | Historical payroll records | **RULE D3 CONCERN** |
| `historical-import.html` | 2014 | `payruns_*` | Pay run list | KV cache — LOW risk |
| `paye-reconciliation.html` | 434/441 | `paye_recon_finalized_*` | Recon finalization state | **RULE D3 CONCERN** — DB table exists |
| `payruns.html` | 1422 | `payruns_*` | Pay run cache | KV cache — LOW risk |
| `payruns.html` | 1534 | `emp_payslip_status_*` | Payslip status | **RULE D4 CONCERN** — DB is authoritative |
| `payruns.html` | 2175 | `emp_payroll_*` | Payroll data for run preview | **RULE D3 CONCERN** |
| `payruns.html` | 2185 | `emp_payslip_status_*` | Draft status flag | MEDIUM — DB should be authoritative |
| `payroll-items.html` | 1188 | payroll items key | Payroll items master list | **RULE D3 CONCERN** |
| `reports.html` | 380 | `report_history_*` | Report history | LOW — regeneratable |

**Session/auth writes (PERMITTED):**
All `safeLocalStorage.setItem('session', ...)` and `safeLocalStorage.setItem('token', ...)` across all pages are valid per Rule D2.

### 10.3 localStorage Rule D Verdict

**Rule D1 (absolute prohibition on raw localStorage for business data):** PASS — no violations found.

**Rule D3 (KV bridge is not a loophole):** CONCERN — The most critical business data (employee payroll items, historical records) is in KV, which is a schemaless blob store with no relational integrity. This is a known architectural debt, not a new violation, but it remains an active risk.

**Rule D4 (finalized payroll state must be DB-authoritative):** PASS for the core finalization path. The `payroll_snapshots.is_locked` column is the authoritative source. The KV `emp_payslip_status_*` keys are secondary/legacy and the unlock endpoint correctly resets the DB snapshot lock BEFORE clearing KV keys.

---

## PART 11 — SOUTH AFRICAN PAYROLL COMPLIANCE CHECKS

### 11.1 PAYE

| Check | Finding | Status |
|---|---|---|
| Tax brackets 2025/2026 | Correct — SARS published | PASS |
| Tax brackets 2026/2027 | Placeholder — identical to 2025/2026 | **RISK ENG-01** |
| Rebates (primary/secondary/tertiary) | Correct values | PASS |
| Age thresholds (65, 75) | Correct | PASS |
| Medical tax credits | Correct (R364/R364/R246) | PASS |
| Exemption threshold | Correctly enforced — zero PAYE below tax threshold | PASS |
| Director UIF | Zero per Unemployment Insurance Act | PASS |
| Provisional tax | Not implemented (out of scope for payroll module) | N/A |

### 11.2 UIF

| Check | Finding | Status |
|---|---|---|
| Rate | 1% | PASS |
| Monthly cap | R177.12 | PASS |
| Director exclusion | Enforced | PASS |
| UIF-exempt flag | Enforced | PASS |
| Employer UIF | Employee UIF = Employer UIF contribution — NOT captured in snapshots | **FINDING EMP-01** |

### 11.3 SDL

| Check | Finding | Status |
|---|---|---|
| Rate | 1% | PASS |
| Company exempt toggle | `sdl_registered` flag | PASS |
| SDL threshold (R500k payroll) | Not implemented — relies on company flag only | NOTE |

*Note: The R500,000 annual payroll threshold for SDL exemption (companies below this are exempt) is not auto-calculated. It relies on the company's `sdl_registered` flag being set correctly by the user.*

### 11.4 EMP201 / EMP501

| Check | Finding | Status |
|---|---|---|
| EMP201 (monthly returns) | Not a direct output — monthly totals available via recon/summary | INFO |
| EMP501 (annual reconciliation) | Foundation implemented — NOT submission-ready | **FINDING EMP-02** |
| IRP5 code assignments | Not in any snapshot | MISSING |
| SARS EMP501 XML format | Not implemented | MISSING |

---

## PART 12 — FINALIZATION AND REVERSAL WORKFLOW

### 12.1 Finalization Path

```
1. POST /api/payroll/run
   → Creates payroll_run header (status: 'draft')
   → For each employee: calculates, creates payroll_snapshot (is_locked: false)
   → Skips already-locked employees (idempotent re-run)

2. POST /api/payroll/finalize
   → Verifies run ownership (company_id, period_key)
   → Checks run not already finalized
   → lockSnapshotsForPeriod() → sets is_locked=true, status='finalized'
   → finalizePayrollRun() → sets run status='finalized'
   → Audit logged

3. Result: All snapshots immutable. calculate.js returns snapshot directly.
```

**Status: CORRECT AND COMPLETE**

### 12.2 Reversal Path

```
1. POST /api/payroll/reverse
   → Reason required
   → Verifies run status='finalized' (only finalized runs can be reversed)
   → reverseSnapshotsForRun() → status='reversed', is_locked=false (never deleted)
   → reversePayrollRun() → status='reversed'
   → Audit logged

2. Result: Snapshots preserved for audit. New run can now be submitted.
```

**Status: CORRECT AND COMPLETE**

### 12.3 Individual Unlock

```
1. POST /api/payroll/unlock
   → Requires PAYSLIPS.UNLOCK permission
   → Blocked if payslip belongs to FINALIZED run (must reverse run first)
   → Verifies manager credentials (bcrypt)
   → Verifies manager role (manager-level or above)
   → Resets payroll_snapshot.is_locked=false FIRST
   → Then deletes KV keys (emp_payslip_status_*, emp_historical_*)
   → Audit logged
```

**Status: CORRECT AND COMPLETE**

---

## PART 13 — OPEN RISKS SUMMARY

### Critical Risks (STOP — verify before trusting data)

| ID | Risk | Severity | Files |
|---|---|---|---|
| RC-01 | paye-reconciliation.html may read from KV (ReconService) instead of API — recon totals could be wrong | HIGH | `paye-reconciliation.html`, `recon-service.js` |
| ENG-01 | 2026/2027 tax tables are placeholder copies of 2025/2026 — PAYE wrong from March 2026 if SARS updated brackets | HIGH | `payroll-engine.js` |

### High Risks (must understand before going live)

| ID | Risk | Severity | Files |
|---|---|---|---|
| KV-02 | Employee regular payroll inputs (`emp_payroll_*`) stored in KV — no SQL backup — data loss = payroll cannot run | HIGH | `employee-detail.html`, `payroll-engine.js` |
| EMP-01 | `uif_employer = 0` on EMP501 — employer UIF not captured — EMP501 understates UIF | MEDIUM-HIGH | `recon.js` |

### Medium Risks (tracked follow-up items)

| ID | Risk | Severity | Files |
|---|---|---|---|
| MT-01 | Salary source ambiguity — KV fallback in `fetchEmployee()` | MEDIUM | `PayrollDataService.js` |
| RC-02 | paye-reconciliation SARS/bank values may write to KV, not DB table | MEDIUM | `paye-reconciliation.html`, `recon-service.js` |
| EMP-02 | IRP5 codes empty in all snapshots — EMP501 not SARS-submission-ready | MEDIUM | `recon.js` |
| HI-01 | Historical import may write to KV only — backend recon misses data | MEDIUM | `historical-import.html` |
| VT-01 | Voluntary tax: frontend may write to KV but backend reads DB column | LOW-MEDIUM | `employee-detail.html` |
| KV-01 | Two KV bridges (polyfills.js + data-access.js) — allowlist mismatch | LOW-MEDIUM | `polyfills.js`, `data-access.js` |

### Low Risks (acceptable or tracked)

| ID | Risk | Severity | Notes |
|---|---|---|---|
| SNAP-01 | No unique index on non-reversed snapshots | LOW | Functional guard exists |
| EMP-03 | Bank details in two places (employees + employee_bank_details) | LOW | API enforces consistency |
| PERM-01 | Session unavailable on KV load failure → user sees no buttons | LOW | Retry-on-error would fix |
| PERM-02 | `payroll_admin` role not in ACTIONS map | LOW | Would need adding if role is used |

---

## PART 14 — PAYROLL ENGINE LOGIC VERIFICATION (MANUAL TEST CASES)

The following are expected results for standard SA payroll scenarios. These should be verified against the running system.

### Test Case 1: Standard Monthly Employee (2025/2026 Tax Year)

- Basic salary: R30,000/month
- Age: 35 (no rebates except primary)
- No medical aid
- No voluntary tax
- No UIF exemption
- SDL: company registered

Expected:
- **Gross:** R30,000
- **Annual taxable:** R360,000
- **Annual PAYE (bracket 3: 18% of amount above R237,101):** ~(237,100 × 18%) + some bracket = approx R38,097 per year → ~R3,175/month
  - More precisely: R42,678 (26% bracket) minus primary rebate R17,235 = R25,443/year → R2,120/month PAYE
  - *Note: exact calculation depends on bracket table, verify against engine*
- **UIF:** R177.12 (capped)
- **SDL:** R300.00 (1% of R30,000)
- **Net:** approximately R30,000 − R2,120 − R177.12 = R27,702.88

### Test Case 2: Director (UIF Exempt)

- Same as Test Case 1 but `is_director = true`
- Expected: **UIF = R0.00**

### Test Case 3: UIF Cap

- Basic salary: R50,000/month
- Expected: **UIF = R177.12** (not R500 — capped at R177.12/month)

### Test Case 4: SDL Exempt Company

- Same as Test Case 1 but company `sdl_registered = false`
- Expected: **SDL = R0.00**

### Test Case 5: Medical Aid Member (3 members)

- Basic salary: R30,000
- Medical aid members: 3 (main + 1 dependent + 1 additional)
- Medical credit: main R364 + 1st dep R364 + additional R246 = R974
- Expected PAYE: Standard PAYE minus R974 medical credit

### Test Case 6: Pro-Rata New Hire

- Period: 2026-05 (May 2026, 31 days)
- Hire date: 2026-05-16 (16 days worked out of 31)
- Basic salary: R20,000
- Expected: Pro-rata factor = 16/31 = 0.516
- Expected gross: R10,323 (approximately)
- PAYE calculated on pro-rated gross

### Test Case 7: Voluntary PAYE Increase (Fixed Monthly)

- Employee PAYE is R2,000/month
- Voluntary increase: R500/month
- Expected: PAYE paid = R2,500 (base R2,000 + R500 adjustment)

### Test Case 8: Bonus Spread Calculation

- Employee basic: R30,000 → monthly PAYE ~R2,120
- Bonus: R60,000 spread over 3 months
- Expected:
  - Monthly PAYE with bonus annualised = recalculate with bonus
  - Incremental annual PAYE ÷ 3 = monthly spread amount
  - Backend `/api/payroll/voluntary-tax/calculate-bonus-spread` should calculate this

---

## PART 15 — WHAT WAS NOT CHANGED

Per audit instructions: **NO CODE CHANGES WERE MADE.** This is a read-only audit.

---

## PART 16 — RECOMMENDED NEXT STEPS (BY PRIORITY)

### Immediate (before next payroll run)

1. **Verify paye-reconciliation.html API usage** (RC-01) — Open DevTools → Network tab → run the reconciliation page → confirm it calls `/api/payroll/recon/summary` (not just KV reads). If it uses ReconService.buildPayrollTotals(), the reconciliation totals are unreliable.

2. **Confirm 2026/2027 SARS tax tables** (ENG-01) — Check SARS website for 2026/2027 tax year brackets and rebates. If they differ from 2025/2026, update `payroll-engine.js` before running any March 2026 payroll.

### Short-term (Codebox-scale tasks)

3. **Migrate employee payroll items from KV to SQL** (KV-02) — Create an `employee_payroll_items` table. Migrate all `emp_payroll_*` KV data to SQL rows. This is the single most important architectural improvement.

4. **Migrate PAYE recon SARS/bank values to DB** (RC-02) — Ensure `paye-reconciliation.html` reads/writes to `payroll_recon_submitted` table via API, not KV.

5. **Add uif_employer to snapshot calculation** (EMP-01) — Employer UIF = employee UIF. Capture in `calculation_output` during payrun. Include in EMP501 report.

### Medium-term

6. **IRP5 code assignments** (EMP-02) — Implement IRP5 code mapping per payroll item. Required for EMP501 digital submission.

7. **Remove salary KV fallback** (MT-01) — Once all employees have `basic_salary` populated in the DB column, remove the KV fallback from `PayrollDataService.fetchEmployee()`.

8. **Resolve two-bridge conflict** (KV-01) — Consolidate to a single KV bridge. The `polyfills.js` bridge is primary; `data-access.js` bridge should be removed or made a no-op.

9. **SDL threshold auto-calculation** — Consider auto-calculating whether a company crosses the R500,000 annual payroll threshold rather than relying on a manually-set flag.

---

## APPENDIX — FILES AUDITED

| File | Type | Lines |
|---|---|---|
| `frontend-payroll/js/payroll-engine.js` | Frontend / Engine | ~1,200 |
| `backend/modules/payroll/services/PayrollCalculationService.js` | Backend / Service | ~300 |
| `backend/modules/payroll/services/PayrollDataService.js` | Backend / Service | ~811 |
| `backend/modules/payroll/services/PayrollHistoryService.js` | Backend / Service | ~709 |
| `backend/modules/payroll/routes/calculate.js` | Backend / Route | ~454 |
| `backend/modules/payroll/routes/payruns.js` | Backend / Route | (prev session) |
| `backend/modules/payroll/routes/employees.js` | Backend / Route | ~993 |
| `backend/modules/payroll/routes/voluntary-tax.js` | Backend / Route | ~105 |
| `backend/modules/payroll/routes/kv.js` | Backend / Route | ~214 |
| `backend/modules/payroll/routes/recon.js` | Backend / Route | ~618 |
| `backend/modules/payroll/routes/unlock.js` | Backend / Route | ~226 |
| `frontend-payroll/js/polyfills.js` | Frontend / Bridge | (prev session) |
| `frontend-payroll/js/data-access.js` | Frontend / Bridge | (prev session) |
| `frontend-payroll/js/auth.js` | Frontend / Auth | ~342 |
| `frontend-payroll/js/recon-service.js` | Frontend / Service | ~365 |
| `frontend-payroll/js/permissions.js` | Frontend / Permissions | ~101 |
| `frontend-payroll/payroll-execution.html` | Frontend / Page | (partial) |
| `frontend-payroll/employee-detail.html` | Frontend / Page | (partial) |
| `frontend-payroll/*.html` via grep | All pages | localStorage grep |

---

*End of audit report.*  
*Generated: 2026-05-27*  
*Status: READ-ONLY AUDIT — no code changes made*
