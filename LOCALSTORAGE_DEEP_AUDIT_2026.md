# Paytime — Full localStorage Deep Audit
**Date:** 2026  
**Scope:** Every file in `accounting-ecosystem/frontend-payroll/` + `accounting-ecosystem/backend/`  
**Method:** Line-by-line grep of every JS and HTML file in the app

---

## HOW THE SYSTEM WORKS

Before reading findings, understand the architecture:

1. **`polyfills.js`** — Installed first on every page. Creates `window.safeLocalStorage` as an in-memory cache. Also monkey-patches `Storage.prototype.getItem/setItem/removeItem` so any raw `localStorage.*` call on the page is silently re-routed through `safeLocalStorage`.

2. **`data-access.js`** — Installs `installEcoPayrollLocalStorageBridge()`. This patches `safeLocalStorage.getItem/setItem/removeItem/key` to intercept all non-whitelisted keys and route them to the cloud KV table (`payroll_kv_store_eco`) via async XHR.

3. **Result:** Any page call — whether `safeLocalStorage.getItem(key)` or `localStorage.getItem(key)` — is intercepted. If the key is whitelisted (auth/session), it goes to native browser localStorage. Otherwise it goes to the cloud KV database table.

**Whitelisted keys (stay in native localStorage):**
`session`, `token`, `user`, `company`, `sso_source`, `eco_token`, `availableCompanies`, `selectedCompanyId`, `cache_*`

**Everything else → `payroll_kv_store_eco` table (cloud-backed KV).**

---

## SECTION 1 — WHITELISTED KEYS (Auth/Session — CORRECT)

These keys are intentionally in native localStorage. No cloud persistence needed. Correct behaviour.

| Key | Files | Notes |
|---|---|---|
| `session` | All pages | JWT session object — correct in native localStorage |
| `token` | All pages | JWT token — correct in native localStorage |
| `user` | company-dashboard, company-selection, login, index | User profile — correct |
| `company` | company-dashboard, company-selection, users.html | Active company — correct |
| `sso_source` | index.html, login.html | SSO redirect flag — correct |
| `eco_token` | company-dashboard, company-selection, users.html | Portal token — correct |
| `availableCompanies` | auth.js (lines 60, 231, 236, 244, 327) | Company list for session — correct |
| `selectedCompanyId` | paye-reconciliation.html line 557 | Company selector state — correct |
| `cache_*` | data-access.js (lines 69, 74) | Offline API response fallback — correct |

---

## SECTION 2 — KV-INTERCEPTED KEYS (Cloud KV — Acceptable, Not SQL)

These keys go to `payroll_kv_store_eco` table via the bridge. Data survives browser clears. **However: these are NOT in proper SQL tables** — they are a KV store. This means they lack relational integrity, audit trails, and cannot be queried or joined by the backend calculation engine.

### 2A — EMPLOYEE & PAYROLL SETUP

| Key Pattern | Files | Risk |
|---|---|---|
| `employees_${companyId}` | company-dashboard.html L787/907/923, attendance.js L27, payroll-engine.js L857 | LOW — employee list cache; SQL is source of truth via API |
| `emp_payroll_${companyId}_${empId}` | historical-import.html L695, payruns.html L1560, reports.html L342, payroll-engine.js L849, recon-service.js L192 | MEDIUM — employee payroll setup (basic salary, recurring items). Backend now reads this from SQL but KV is fallback |
| `payroll_items_${companyId}` | employee-detail.html L2238, historical-import.html L1361, payroll-items-helper.js L14 | MEDIUM — company-wide payroll item templates. Should match `employee_payroll_items` SQL table |
| `hidden_payroll_items_${companyId}` | employee-detail.html L2235, payroll-items.html L984/986 | LOW — UI visibility toggle for payroll items, not compliance-critical |
| `company_details_${companyId}` | banking-formats.js L171, export-formats.js L185, pdf-branding.js L306 | LOW — company details cache for PDF generation |
| `TAX_YEARS_KEY` | payroll-items.html L1681/1689 | LOW — cache of tax year list from API |
| `companies` | paye-reconciliation.html L568 | LOW — company list cache for super-admin view |

### 2B — PERIOD-SPECIFIC PAYROLL INPUTS

| Key Pattern | Files | Risk |
|---|---|---|
| `emp_overtime_${companyId}_${empId}_${period}` | payruns.html L1280/2224, attendance.js L723/735, payroll-engine.js L901, recon-service.js L132 | MEDIUM — overtime data. Backend reads from `payroll_overtime` SQL table. If payruns.html writes KV only, there is divergence |
| `emp_short_time_${companyId}_${empId}_${period}` | payruns.html L1283, attendance.js L741/752, payroll-engine.js L907 | MEDIUM — short-time data. Backend reads from `payroll_short_time` SQL table |
| `emp_multi_rate_${companyId}_${empId}_${period}` | payroll-engine.js L904 | MEDIUM — multi-rate data. Backend reads from `payroll_multi_rate` SQL table |
| `emp_current_${companyId}_${empId}_${period}` | payroll-engine.js L898 | MEDIUM — current period inputs. Backend reads from `payroll_period_inputs` SQL table |
| `payruns_${companyId}` | payruns.html L717/872/1466, historical-import.html L1939/1976, employee-detail.html L1777 | MEDIUM — pay run period list. Should match `payroll_periods` SQL table |

### 2C — PAYSLIP STATUS & APPROVAL

| Key Pattern | Files | Risk |
|---|---|---|
| `emp_payslip_status_${companyId}_${empId}_${period}` | employee-detail.html L1772/1842/1868, payruns.html L1572/1578, reports.html L346 | ⚠️ HIGH — payslip approval status (draft/approved/sent) lives in KV not SQL. Clearing the KV or multi-device use can cause status inconsistency |

### 2D — VOLUNTARY TAX CONFIGURATION

| Key Pattern | Files | Risk |
|---|---|---|
| `voluntaryTaxConfig_${companyId}_${empId}` | employee-detail.html L2968/2975/3006, payroll-execution.html L942, payroll-engine.js L877 | ⚠️ HIGH — voluntary tax directives (employee-specific tax overrides). Affects PAYE calculation. Lives in KV not SQL. If KV entry is missing, tax is calculated differently |

### 2E — ATTENDANCE

| Key Pattern | Files | Risk |
|---|---|---|
| `attendance_${companyId}_${empId}` (various) | attendance.js L195/251/253/325/544 | ⚠️ HIGH — all attendance records live in KV only. Backend attendance route exists (`/api/payroll/attendance`) but it's unclear if attendance.js writes to it |

### 2F — RECONCILIATION DATA (User-Entered)

| Key Pattern | Files | Risk |
|---|---|---|
| `paye_recon_sars_${companyId}` | recon-service.js L259/266/271 | ⚠️ HIGH — SARS-submitted EMP201 values entered by accountant for reconciliation. In KV only. Clearing KV loses these figures |
| `paye_recon_bank_${companyId}` | recon-service.js L282/289/294 | ⚠️ HIGH — bank transfer amounts entered by accountant for reconciliation. In KV only |
| `_finalKey()` → `paye_recon_final_${...}` | paye-reconciliation.html L421/426 | ⚠️ HIGH — finalized period reconciliation state. In KV only |

### 2G — TAX CONFIGURATION

| Key Pattern | Files | Risk |
|---|---|---|
| `tax_config` | payroll-engine.js (frontend) L159/160/192/198 | ⚠️ MEDIUM — frontend payroll engine reads/writes tax tables to KV. Backend calculate.js loads tax config from its own KV admin key (`__global__` or company-specific). Risk of mismatch if frontend KV `tax_config` differs from backend KV admin config |

### 2H — AUDIT LOG

| Key Pattern | Files | Risk |
|---|---|---|
| `audit_log_${companyId}` | audit.js L36/44, reports.html L785/817 | ❌ CRITICAL — audit trail lives in KV only. The `audit.js` comment says "keep last 1000 entries to prevent localStorage overflow". Audit data is compliance-critical and MUST be in SQL |

### 2I — REPORT HISTORY & NARRATIVES

| Key Pattern | Files | Risk |
|---|---|---|
| `report_history_${companyId}` | reports.html L369/377 | LOW — report generation log, not compliance-critical |
| `narrative_${companyId}_${empId}_${period}` | narrative-generator.js L407/412/418 | LOW — generated payslip narrative text, derivable |

### 2J — HISTORICAL IMPORT DATA (CRITICAL BUG)

| Key Pattern | Files | Risk |
|---|---|---|
| `emp_historical_${companyId}_${empId}_${period}` | historical-import.html L894/917/1528/1549/1686/1869/1892/1919, employee-detail.html L1845/1868/1870, payroll-engine.js L431/930 | ❌ CRITICAL — historical YTD import data (prior tax year payroll periods) written to KV only. Backend recon API (`recon.js`) reads from `payroll_historical` SQL table, not KV. PAYE reconciliation and YTD calculations from the API are BLIND to historical imports done via the UI |

---

## SECTION 3 — RAW `localStorage` CALLS (Polyfill Status)

These use `localStorage.xxx` directly instead of `safeLocalStorage.xxx`.

| File | Line | Key | Status |
|---|---|---|---|
| `js/auth.js` | 186 | `Object.keys(localStorage)` | **INTERCEPTED** — `polyfills.js` monkey-patches `Storage.prototype`, so `localStorage.getItem` IS routed through `safeLocalStorage`. The key iteration uses `Object.keys(localStorage)` which reads native keys; this is intentional (logout cleanup). ACCEPTABLE |
| `js/feature-flags.js` | 31 | `localStorage.getItem('token')`, `localStorage.getItem('eco_token')` | **INTERCEPTED** — polyfill monkey-patch routes through `safeLocalStorage`. Keys are whitelisted → native localStorage. ACCEPTABLE |
| `users.html` | 481 | `localStorage.getItem('token')`, `localStorage.getItem('eco_token')` | **INTERCEPTED** — same as above. ACCEPTABLE |
| `payroll-items.html` | 993, 995, 999 | `localStorage.getItem/_setItem(_sectionCollapseKey)` | **INTERCEPTED** — polyfill routes through `safeLocalStorage`. `_sectionCollapseKey` is a UI section collapse state — this goes to KV. LOW RISK but unnecessary KV churn for a UI preference |

**Key finding:** No true bypasses exist. The polyfill's `Storage.prototype` monkey-patch catches all raw `localStorage.*` calls. The only code that uses the raw native calls intentionally is `data-access.js` bridge internals (using `Storage.prototype.getItem.call(localStorage, 'token')`) which is correct.

---

## SECTION 4 — BACKEND MENTIONS

| File | Lines | Status |
|---|---|---|
| `backend/core/payroll-engine.js` | 230-264 | `safeLocalStorage` references are guarded with `typeof safeLocalStorage !== 'undefined'` — never executes on Node.js. SAFE |
| `backend/frontend-inventory/index.html` | 690 | `localStorage.getItem('token')` — inventory frontend, not Paytime. Different module. ACCEPTABLE |
| All other backend files | Various | Comments/migration descriptions only, no operational code |

**Backend verdict: No problematic localStorage usage in backend Node.js code.**

---

## SECTION 5 — RISK SUMMARY TABLE

| Risk Level | Key / Area | Root Problem | Impact |
|---|---|---|---|
| ❌ CRITICAL | `emp_historical_*` | Written to KV by historical-import.html; never written to `payroll_historical` SQL table | Backend recon API, YTD calculations from API, and IRP5 generation cannot see imported historical data |
| ❌ CRITICAL | `audit_log_${companyId}` | Audit trail in KV (max 1000 entries) | Compliance audit trail is not SQL-backed, not permanent, not queryable |
| ⚠️ HIGH | `paye_recon_sars_*` + `paye_recon_bank_*` | User-entered EMP201 and bank values in KV | Clearing KV loses reconciliation figures entered by accountant |
| ⚠️ HIGH | `_finalKey()` recon finalized state | Finalized period lock state in KV | Multi-device inconsistency; lost on KV clear |
| ⚠️ HIGH | `voluntaryTaxConfig_*` | Employee tax directives in KV | PAYE calculation affected if missing; no SQL record of directive |
| ⚠️ HIGH | `emp_payslip_status_*` | Payslip approval status in KV | Status lost on KV issues; multi-device inconsistency |
| ⚠️ HIGH | `attendance_*` | All attendance records in KV only | If attendance backend API is not being called, all attendance data is KV-only |
| ⚠️ MEDIUM | `emp_overtime_*`, `emp_short_time_*`, `emp_multi_rate_*`, `emp_current_*` | Period inputs in KV; backend reads from SQL tables | Divergence possible if payruns.html writes KV only without corresponding SQL write |
| ⚠️ MEDIUM | `tax_config` | Frontend engine reads/writes tax tables to KV | Risk of frontend/backend tax config mismatch if KV tax_config differs from backend admin KV config |
| ⚠️ MEDIUM | `payruns_${companyId}` | Pay run list in KV | Should match `payroll_periods` SQL table; divergence possible |
| LOW | `_sectionCollapseKey` | UI toggle state going to cloud KV | Unnecessary KV traffic for non-business data (should stay in native localStorage) |
| LOW | `report_history_*`, `narrative_*` | Non-compliance data in KV | Low risk, derivable |
| ✅ OK | All whitelisted keys | Correct native localStorage | No issues |
| ✅ OK | All `safeLocalStorage` for whitelisted keys | Goes to native localStorage via bridge | No issues |

---

## SECTION 6 — PRIORITISED REMEDIATION PLAN

### P1 — CRITICAL: Migrate `emp_historical_*` to SQL (historical-import.html)

**Problem:** `historical-import.html` writes all imported historical payroll data to `emp_historical_${companyId}_${empId}_${period}` KV keys. The backend `recon.js` reads from `payroll_historical` SQL table. These never connect.

**Fix:**
- `historical-import.html` must call `POST /api/payroll/historical` after building each `histData` object, writing to the `payroll_historical` table
- The existing KV write can remain as a local cache, but SQL must be the write-through target
- The backend `recon.js` already expects SQL data — once the import writes to SQL, PAYE recon becomes accurate

**Files to change:** `historical-import.html` (3 import functions: bulk, single, CSV), + a new backend route if `/api/payroll/historical` doesn't exist

---

### P2 — CRITICAL: Move Audit Log to SQL

**Problem:** `audit.js` writes audit events to `audit_log_${companyId}` KV (max 1000 entries). Reports page reads from same key. Compliance audit trails must be server-backed and permanent.

**Fix:**
- Create a backend endpoint `POST /api/payroll/audit-log`
- `audit.js` `logAction()` should call this endpoint asynchronously
- Keep KV write as fallback cache for `reports.html` display
- Backfill check: create `GET /api/payroll/audit-log/:companyId` for reports page

---

### P3 — HIGH: Move PAYE Recon Figures to SQL

**Problem:** `paye_recon_sars_*` and `paye_recon_bank_*` in KV hold user-entered EMP201 values and bank payments. These are compliance figures.

**Fix:**
- Backend already has `recon.js` route. Extend it with `GET/PUT /api/payroll/recon/submitted-values/:companyId`
- `recon-service.js` `saveSarsData()` / `saveBankData()` should call these endpoints
- The `_finalKey()` finalized state should also be server-backed

---

### P4 — HIGH: Move `voluntaryTaxConfig_*` to SQL

**Problem:** Voluntary tax directives (employee-specific PAYE percentage overrides) live in KV. They affect every PAYE calculation for that employee but aren't in SQL.

**Fix:**
- Add `voluntary_tax_config` column to `employees` table OR create `employee_tax_config` table
- Backend `/api/payroll/employees/:id/tax-config` endpoint (GET/PUT)
- `employee-detail.html` `saveTaxConfig()` should write to API
- `payroll-execution.html` reads these during batch execution — should read from API

---

### P5 — HIGH: Move `emp_payslip_status_*` to SQL

**Problem:** Payslip approval status (draft/approved/sent) is in KV. It drives UI display across multiple pages but is not server-backed.

**Fix:**
- Backend payroll snapshots table already exists with a `status` or `finalized` column
- Map `emp_payslip_status_*` to the snapshot record's status field
- `employee-detail.html` and `payruns.html` should read/write status via the snapshot API

---

### P6 — MEDIUM: Verify Period Input SQL Writes (payruns.html)

**Problem:** `payruns.html` writes overtime, status, and payroll data to KV keys. It's not confirmed whether these are also written to `payroll_overtime`, `payroll_short_time`, `payroll_period_inputs` SQL tables.

**Fix:**
- Audit `payruns.html` write functions specifically to confirm whether they call backend APIs alongside KV writes
- If KV-only: add API write-through to the relevant tables
- The backend `fetchPeriodInputs()` in `PayrollDataService.js` reads from these SQL tables — if payruns.html doesn't write to them, the backend calculation will not see period-specific inputs from the payruns UI

---

### P7 — LOW: Fix `_sectionCollapseKey` to Stay Native

**Problem:** `payroll-items.html` lines 993/995/999 use `localStorage.getItem/setItem(_sectionCollapseKey)`. The polyfill intercepts this and routes it to KV — which means a UI preference toggle is going to the cloud database on every click.

**Fix:** Use `window._nativeLS_setItem(_sectionCollapseKey, ...)` pattern or store in `sessionStorage` instead. This is pure UI state, not business data.

---

## SECTION 7 — KNOWN GOOD AREAS (No Changes Needed)

- All auth/session key handling (`session`, `token`, `user`, `company`) — correct
- `polyfills.js` architecture — sound. Monkey-patch correctly routes all localStorage calls
- `data-access.js` bridge — correct. Whitelists respected. Token reads use `Storage.prototype.getItem.call` correctly to bypass bridge for auth
- `payroll-engine.js` (backend) — `safeLocalStorage` guards are correct; never executes server-side
- `pdf-branding.js`, `banking-formats.js`, `export-formats.js` — read company details from KV as fallback. Acceptable
- `narrative-generator.js` — narrative cache in KV. Derivable data, low risk
- `payroll-api.js` — single `var ls = window.safeLocalStorage` reference for token. Correct
- `permissions.js` — reads `session` and `token` (whitelisted). Correct
- `sean-helper.js` — reads/removes `token` (whitelisted). Correct

---

## SECTION 8 — FILE-BY-FILE SUMMARY

| File | localStorage Usages | Status |
|---|---|---|
| `attendance.html` | session (×2) | ✅ OK |
| `company-dashboard.html` | session, token, user, company, eco_token, employees_* | ✅ OK (employees_* in KV) |
| `company-details.html` | session, availableCompanies, token | ✅ OK |
| `company-selection.html` | eco_token, token, user, company | ✅ OK |
| `employee-management.html` | session, token | ✅ OK |
| `employee-detail.html` | session, token, payslipStatus*, histKey*, payrollKey*, hidden_payroll_items_*, payroll_items_*, voluntaryTaxConfig*, notes*, attendance* | ⚠️ voluntaryTaxConfig + payslipStatus need SQL |
| `historical-import.html` | session, emp_payroll_*, emp_historical_*, payruns_*, payroll_items_*, logKey* | ❌ emp_historical_* CRITICAL — must write to SQL |
| `index.html` | sso_source, token, user, company | ✅ OK |
| `login.html` | sso_source, token, user, company | ✅ OK |
| `net-to-gross.html` | session | ✅ OK |
| `payroll-execution.html` | session, token, voluntaryTaxConfig_* | ⚠️ voluntaryTaxConfig needs SQL |
| `payroll-items.html` | session, hidden_payroll_items_*, _sectionCollapseKey (raw), payroll_items_*, TAX_YEARS_KEY, token | ⚠️ _sectionCollapseKey should not go to KV |
| `paye-reconciliation.html` | finalizedData*, selectedCompanyId, companies, token | ⚠️ finalizedData needs SQL |
| `payruns.html` | session, payruns_*, emp_overtime_*, emp_short_time_*, emp_payroll_*, statusKey* | ⚠️ Verify SQL write-through |
| `reports.html` | session, emp_payroll_*, emp_payslip_status_*, report_history_*, audit_log_* | ⚠️ audit_log CRITICAL, payslip_status needs SQL |
| `super-admin-dashboard.html` | token | ✅ OK |
| `users.html` | token, eco_token, company | ✅ OK |
| `js/attendance.js` | employees_*, attendance keys, emp_overtime_*, emp_short_time_* | ⚠️ Verify SQL write-through |
| `js/audit.js` | session, audit_log_* | ❌ audit_log needs SQL |
| `js/auth.js` | token, session, availableCompanies, `Object.keys(localStorage)` | ✅ OK |
| `js/banking-formats.js` | company_details_* | ✅ OK (cache) |
| `js/data-access.js` | Bridge implementation — all correct | ✅ OK |
| `js/export-formats.js` | company_details_* | ✅ OK (cache) |
| `js/feature-flags.js` | token, eco_token (raw localStorage) | ✅ OK (intercepted, whitelisted) |
| `js/narrative-generator.js` | narrative_* | ✅ OK (low risk cache) |
| `js/payroll-api.js` | safeLocalStorage for token | ✅ OK |
| `js/payroll-engine.js` | tax_config, emp_historical_*, emp_payroll_*, employees_*, voluntaryTaxConfig_*, emp_current_*, emp_overtime_*, emp_multi_rate_*, emp_short_time_* | ⚠️ Legacy KV-coupled wrapper. Backend uses SQL directly |
| `js/payroll-items-helper.js` | payroll_items_* | ✅ OK (KV cache) |
| `js/pdf-branding.js` | company_details_*, cache_company_*, session | ✅ OK |
| `js/permissions.js` | session, token | ✅ OK |
| `js/polyfills.js` | Bridge installer — all correct | ✅ OK |
| `js/recon-service.js` | emp_overtime_*, emp_payroll_*, paye_recon_sars_*, paye_recon_bank_* | ⚠️ paye_recon_sars/bank need SQL |
| `js/sean-helper.js` | token | ✅ OK |
| `js/update-check.js` | None | ✅ OK |

---

*Audit complete. All files in `frontend-payroll/` and `backend/` searched.*
