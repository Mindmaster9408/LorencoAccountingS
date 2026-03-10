# Working Features Registry

**Purpose**: Track every confirmed-working feature across the ecosystem. Before any code change,
this registry is consulted to identify what might break and how to protect it.

**Process**:
1. User confirms a feature works → added here with its file dependencies
2. Before any fix/addition → check this registry for overlap with files being changed
3. If overlap found → either add a safety guard or explicitly test the working feature after the change
4. After a change lands → mark any affected feature as "re-verified" with the commit

---

## How to Read This

Each entry has:
- **Status**: ✅ Verified working | ⚠️ Working but fragile | ❌ Broken (tracked for fix)
- **Depends on**: Files/functions this feature relies on — touching these = risk
- **Break conditions**: Known ways this feature can be broken
- **Last verified**: Commit hash or date when last confirmed working

---

## Payroll App (`accounting-ecosystem/frontend-payroll/`)

### AUTH & SESSION

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| P1 | Login with username/email + password | | `js/auth.js` → `AUTH.login()`, `/api/auth/login` | Changing login field names, removing `username\|email` OR param | |
| P2 | Session persists after page reload | | `js/auth.js`, `safeLocalStorage('session')`, `safeLocalStorage('token')` | Moving session key out of `isLocalKey`, any KV routing of `session`/`token` | |
| P3 | SSO → opens correct app directly | | `js/auth.js` `sso_source` routing, `isLocalKey('sso_source')` | Changing `sso_source` key name, modifying SSO redirect logic | commit `680fa4c` |
| P4 | Switch Company carousel shows company names | | `js/auth.js` `company.name` normalization, all 9 HTML pages defensive fallback | Removing `.name` normalization in `AUTH.getCompanies()` or `AUTH.login()` | commit `8f97e68` |
| P5 | Selecting company in carousel loads that company's data | | `safeLocalStorage('selectedCompanyId')`, `safeLocalStorage('company')`, `isLocalKey` list | Moving `company`/`selectedCompanyId` out of `isLocalKey` → would route to KV and break | |

### EMPLOYEE MANAGEMENT

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| P6 | Employee list loads on payruns.html | | `safeLocalStorage('employees_{companyId}')` KV key, `DataAccess.getEmployees()` | Changing the KV key name, routing `employees_` key to native storage instead of KV | |
| P7 | Employee detail page loads (name, position, ID number, DOB) | | `employee-detail.html` `loadEmployee()` reads `employees_{companyId}` from KV, `renderEmployeeDetails()` | **NEVER call `DataAccess.getEmployeeById()` with string IDs** — backend rejects non-integer IDs → returns null → "Employee not found" redirect | commit `079930c` |
| P8 | basic salary displays and shows "Not set" hint when 0 | | `employee-detail.html` `renderPayroll()`, `payrollData.basic_salary`, basic salary row HTML | Re-adding `data-permission` attribute to the salary row container div | commit `99be3e7` |
| P9 | Basic salary edit modal opens (unlocked periods) | | `employee-detail.html` `editBasicSalary()`, `isPayrunLockedForPeriod()` | Adding `Permissions.require()` back inside `editBasicSalary()` — blocks users with null/wrong role | commit `079930c` |

### PAYRUN & PERIOD MANAGEMENT

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| P10 | Pay period selector populates correctly | | `employee-detail.html` `populatePeriods()`, `payruns_{companyId}` KV key | Changing period key format | |
| P11 | Payrun locked/finalized status persists | | `payslip_status_{companyId}_{empId}_{period}` KV key, `getPayslipStatusKey()`, `isPayrunLockedForPeriod()` | Changing status key format, moving to native localStorage | |
| P12 | Request Unlock — manager auth via login API | | `employee-detail.html` `verifyManagerAuth()` → `POST /api/auth/login`, removes both `payslip_status_*` AND `emp_historical_*` keys | Re-introducing `AUTH.findUserByEmail()` (does NOT exist), storing returned token (overwrites session) | commit `079930c` |
| P13 | Locked payslip shows frozen snapshot (not live recalc) | | `emp_historical_{companyId}_{empId}_{period}` KV key, `updatePayslipUI()` frozen path | Removing the historical snapshot save on finalize | |

### TAX & PAYROLL CALCULATIONS

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| P14 | PAYE calculated correctly for current period (2025/2026 tax year) | | `js/payroll-engine.js` `HISTORICAL_TABLES['2026']`, `calculateAnnualPAYE()`, `getTaxYearForPeriod()` | Changing bracket structure without updating all 5 years, hardcoding table index instead of using `getTablesForPeriod()` | commit `8f97e68` |
| P15 | Historical periods use correct historical tax tables | | `js/payroll-engine.js` `HISTORICAL_TABLES`, `getTaxYearForPeriod(periodStr)` | Adding a period format that doesn't match `YYYY-MM` pattern | commit `8f97e68` |
| P16 | UIF, SDL, rebates all calculated | | `js/payroll-engine.js` `calculateUIF()`, `calculateSDL()`, `calculateRebates()` | Changing `tables.REBATES` structure | |

### DATA LAYER

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| P17 | KV bridge routes business data to Supabase | | `js/data-access.js` `isLocalKey()`, `safeGet()`/`safeSet()` | Adding a business-data key to `isLocalKey` list → would store in localStorage only (lost on clear) | |
| P18 | Session/token/UI prefs stay in native localStorage | | `js/data-access.js` `isLocalKey()` list: `session`, `token`, `company`, `selectedCompanyId`, `cache_*`, `eco_*`, `availableCompanies`, `user`, `sso_source`, `language` | Removing any of these from `isLocalKey` list | |
| P19 | `safeLocalStorage` fallback to memory when storage disabled | | `shared/js/polyfills.js` `safeLocalStorage`, internal methods bound to `safeLocalStorage` (NOT `localStorage`) | Re-binding snapshot methods to `localStorage` instead of `safeLocalStorage` | |

---

## Point of Sale (`Point of Sale/`)

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| S1 | | | | | |

---

## Coaching App (`Coaching app/`)

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| C1 | | | | | |

---

## Admin Dashboard (`Admin dashboard/`)

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| A1 | | | | | |

---

## Payroll Standalone (`Payroll/`)

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| PY1 | | | | | |

---

## Impact Analysis Checklist (use before every change)

When modifying a file, find its row in "Depends on" above and check every feature that lists that file:

```
File being changed: _______________
Features that depend on this file:
  [ ] Feature #___: _______ — test: _______
  [ ] Feature #___: _______ — test: _______
Safe to proceed? [ ] Yes — no overlap  [ ] Yes — protected by: _______  [ ] No — rework needed
```

---

## Regression Rules (hard limits — NEVER break these)

1. **NEVER call `DataAccess.getEmployeeById()` with string IDs** — backend rejects them → null → redirect (P7)
2. **NEVER add `data-permission` to a container div that wraps salary/payroll display rows** — hides the whole row (P8)
3. **NEVER introduce `AUTH.findUserByEmail()`** — this method does not exist in auth.js (P12)
4. **NEVER store the unlock-flow login token** — it would overwrite the current user's session (P12)
5. **NEVER move `session`, `token`, `company`, `selectedCompanyId` out of `isLocalKey`** — breaks auth persistence (P18)
6. **NEVER store business data (payroll records, transactions, customer records) in localStorage** — browser clear destroys it (P17)
7. **NEVER bind safeLocalStorage snapshot methods to `localStorage`** — breaks fallback/memory mode (P19)
