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

## Ecosystem Dashboard (`accounting-ecosystem/frontend-ecosystem/`)

### PERMISSION ARCHITECTURE

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| EC1 | First-user of a new company always gets `business_owner` role | ✅ Fixed | `auth.js` POST /api/auth/register — `ownerRole = 'business_owner'` always | Re-introducing ternary that reads `account_type` for the role assignment | March 12 2026 |
| EC2 | Per-user app access gate (3-tier) | ✅ Implemented | `module-check.js` `requireModule()` Tier 3, `user_app_access` table (migration 009) | Removing the Tier 3 block from `requireModule`, or not running migration 009 | March 12 2026 |
| EC3 | SSO launch blocked if user lacks app access | ✅ Implemented | `auth.js` POST /api/auth/sso-launch, `user_app_access` query before jwt.sign | Removing the app-gate block added above the `jwt.sign` call | March 12 2026 |
| EC4 | Accountant can SSO into client company without direct membership | ✅ Implemented | `auth.js` sso-launch eco_client chain: practice membership → eco_clients → client_company_id | Removing the eco_client fallback block, or changing `.maybeSingle()` back to `.single()` (throws on null) | March 12 2026 |
| EC5 | Per-user client visibility filter | ✅ Implemented | `eco-clients.js` GET / per-user filter, `user_client_access` table (migration 010) | Removing the filter block, or not running migration 010 | March 12 2026 |
| EC6 | `GET /api/users` returns `apps[]` and `clients[]` per user | ✅ Implemented | `users.js` Promise.all([accessResult, appAccessResult, clientAccessResult]) | Removing clientAccessResult from the parallel query, or removing `clients:` from the map | March 12 2026 |
| EC7 | `PUT /api/users/:id/client-access` replaces client grants | ✅ Implemented | `users.js` PUT /:id/client-access route | Reordering routes so DELETE /:id/company-access is registered before this (it won't be reached) | March 12 2026 |
| EC8 | Dashboard: app chips + client chips shown per user in Team tab | ✅ Implemented | `dashboard.html` `loadPracticeUsers()` — `appChips` var, `clientChips` var | Removing `clients` from the users API response, changing the JSON key from `clients` to anything else | March 12 2026 |
| EC9 | Dashboard: "Apps" button opens prompt to change app access | ✅ Implemented | `dashboard.html` `changeUserApps()` → PUT /api/users/:id `{ apps }` | Changing the PUT body key from `apps` to another name | March 12 2026 |
| EC10 | Dashboard: "Clients" button opens modal to restrict client visibility | ✅ Implemented | `dashboard.html` `changeUserClients()` + `saveUserClients()` → PUT /api/users/:id/client-access | Changing the endpoint path, or removing `eco_client_id` from `user_client_access` table | March 12 2026 |
| EC11 | Client Management section hidden from low-privilege roles | ✅ Implemented | `dashboard.html` `CLIENT_MGMT_ROLES` check — visible to `business_owner`, `super_admin`, `store_manager`, `accountant` | Adding new roles to the ecosystem without adding them to `CLIENT_MGMT_ROLES` if visibility is intended | March 12 2026 |

---

## Paytime Payroll — Employee Tax Numbers (`accounting-ecosystem/frontend-payroll/`)

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| PT1 | Tax number required on Add/Edit Employee (company-dashboard) | ✅ Fixed | `company-dashboard.html` `#tax_number` input (`required`), `saveEmployee()` collects it, `editEmployee()` populates it | Removing the `required` attribute from the input, or removing `tax_number` from the `newEmployee` object | March 12 2026 |
| PT2 | UIF number on Add/Edit Employee (company-dashboard) | ✅ Added | `company-dashboard.html` `#uif_number` input, `saveEmployee()`, `editEmployee()` | Removing the field | March 12 2026 |
| PT3 | Tax number required on Add/Edit Employee (employee-management) | ✅ Already existed | `employee-management.html` `#tax_number` input, `required` attribute | Removing `required` | — |
| PT4 | UIF number on Add/Edit Employee (employee-management) | ✅ Added | `employee-management.html` `#uif_number` input, `editEmployee()`, `saveEmployee()` | Removing the field | March 12 2026 |
| PT5 | Backend rejects employee creation without tax_number | ✅ Fixed | `employees.js` POST — `if (!tax_number) return 400` after `full_name` check | Removing or reordering the validation block | March 12 2026 |

---

## Admin Panel (`accounting-ecosystem/frontend-ecosystem/admin.html`)

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| AD1 | Super-admin auth guard (redirect non-super-admins) | ✅ Implemented | `admin.html` `resolveIsSuperAdmin()` checks `eco_super_admin` localStorage + JWT `isSuperAdmin` claim | Removing the boot guard, or not setting `eco_super_admin` in super-admin login flow | commit `07ad526` |
| AD2 | Client cards grouped by managing accounting firm | ✅ Implemented | `admin.html` `renderGrid()` groups by `company_id`, `companyMap` from `/api/companies` | Renaming `company_id` field on eco_clients, or API not returning company list | commit `07ad526` |
| AD3 | Standard Package status badge on each card | ✅ Implemented | `admin.html` `buildCard()` `pkgHtml` section, `eco_clients.package_name`, `eco_clients.is_active` | Removing `package_name` column (migration 008 required) | commit `07ad526` |
| AD4 | SEAN AI addon toggle per client | ✅ Implemented | `admin.html` `toggleAddon()` → PUT `/api/eco-clients/:id` with `{ addons }` → backend syncs to `companies.modules_enabled` | Migration 008 not run (no `addons` column), or removing Sean sync block in `eco-clients.js` PUT handler | commit `07ad526` |
| AD5 | Paytime billing section (active employees, last billed, diff, Mark as Billed) | ✅ Implemented | `admin.html` `buildBillingSection()`, `/api/eco-clients/payroll-billing-summary` endpoint, `eco_clients.last_billed_*` columns | Migration 008 not run, or billing-summary route registered after `/:id` (would be intercepted) | commit `07ad526` |
| AD6 | formatDate not defined error (fixed) | ✅ Fixed | `admin.html` inline polyfill fallback block after `js/polyfills.js` script tag | Removing the inline fallback and polyfills.js path not resolving | commit `07ad526` |

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
| P6 | Employee list loads on payruns.html | ✅ Verified | `safeLocalStorage('employees_{companyId}')` KV key, `DataAccess.getEmployees()` | Changing the KV key name, routing `employees_` key to native storage instead of KV | commit `079930c` |
| P7 | Employee detail page loads (name, position, ID number, DOB) | ✅ Verified both browsers | `employee-detail.html` `loadEmployee()` reads `employees_{companyId}` from KV, `renderEmployeeDetails()` | **NEVER call `DataAccess.getEmployeeById()` with string IDs** — backend rejects non-integer IDs → returns null → "Employee not found" redirect | commit `079930c` |
| P8 | basic salary displays and shows "Not set" hint when 0 | ✅ Verified | `employee-detail.html` `renderPayroll()`, `payrollData.basic_salary`, basic salary row HTML | Re-adding `data-permission` attribute to the salary row container div | commit `99be3e7` |
| P9 | Basic salary edit modal opens (unlocked periods) | ✅ Verified | `employee-detail.html` `editBasicSalary()`, `isPayrunLockedForPeriod()` | Adding `Permissions.require()` back inside `editBasicSalary()` — blocks users with null/wrong role | commit `079930c` |

### PAYRUN & PERIOD MANAGEMENT

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| P10 | Pay period selector populates correctly | ✅ Verified | `employee-detail.html` `populatePeriods()`, `payruns_{companyId}` KV key | Changing period key format | commit `079930c` |
| P11 | Payrun locked/finalized status persists | ✅ Verified | `payslip_status_{companyId}_{empId}_{period}` KV key, `getPayslipStatusKey()`, `isPayrunLockedForPeriod()` | Changing status key format, moving to native localStorage | commit `278368e` |
| P12 | Request Unlock — manager auth via login API | ✅ Fixed | `employee-detail.html` `verifyManagerAuth()` → `POST /api/auth/login`, removes both `payslip_status_*` AND `emp_historical_*` keys | Re-introducing `AUTH.findUserByEmail()` (does NOT exist), storing returned token (overwrites session) | commit `079930c` |
| P20 | Calculate Payslip works | ✅ Verified | `employee-detail.html` `calculatePayslip()`, `js/payroll-engine.js` | Breaking payroll-engine ACTIONS/BRACKETS structure | commit `079930c` |
| P21 | Payslip PDF download works | ✅ Verified | `employee-detail.html` `downloadPayslipPDF()` | Removing jsPDF script include, changing PDF element IDs | commit `079930c` |
| P22 | Pay run works | ✅ Verified | `payruns.html`, `payruns_{companyId}` KV key | Changing period/status key format | commit `079930c` |
| P23 | Finalize Payslip button visible and clickable | ✅ Verified | `employee-detail.html` `updatePayslipUI()` — button rendered WITHOUT `data-permission` attr | **NEVER add `data-permission` to Finalize/Unfinalize buttons** rendered in `updatePayslipUI()` — `enforceUI()` will silently hide them. Permission already enforced inside `finalizePayslip()` | commit `278368e` |
| P24 | Finalize permission works after company selection | ✅ Verified | `js/auth.js` `selectCompany()` reads `result.role` from `/api/auth/select-company` and writes to session | `selectCompany()` not updating `session.role` leaves it null → all `Permissions.require()` calls fail | commit `383d91d` || P25 | Sean AI tab gated by company addon (PT-05) | ⚠️ Needs DB migration first | `payruns.html` `#sean-tab-btn` hidden by default; `js/auth.js` `selectCompany()` stores `session.modules_enabled`; `/api/auth/select-company` returns `company.modules_enabled`; `eco_clients.addons` synced to `companies.modules_enabled` via eco-clients PUT | Removing `modules_enabled` from `select-company` response, changing `session.modules_enabled` key name, or running without migration 008 | commit `07ad526` |
### TAX & PAYROLL CALCULATIONS

| # | Feature | Status | Depends on | Break conditions | Last verified |
|---|---------|--------|------------|-----------------|---------------|
| P14 | PAYE calculated correctly for current period (2025/2026 tax year) | ✅ Verified | `js/payroll-engine.js` `HISTORICAL_TABLES['2026']`, `calculateAnnualPAYE()`, `getTaxYearForPeriod()` | Changing bracket structure without updating all 5 years, hardcoding table index instead of using `getTablesForPeriod()` | commit `8f97e68` |
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
8. **NEVER add `data-permission` to Finalize/Unfinalize buttons** rendered dynamically in `updatePayslipUI()` — `enforceUI()` runs immediately after and silently hides elements it can't verify. Permission is already enforced inside `finalizePayslip()` and `unfinalizePayslip()` via `Permissions.require()` (P23)
9. **`selectCompany()` in auth.js MUST update `session.role`** from `result.role` — the backend returns the correct role for the selected company; if not written to session, ALL `Permissions.require()` calls fail silently (P24)
10. **NEVER reorder routes in `eco-clients.js`** such that `/:id` appears before `/payroll-billing-summary` or `/employee-counts` — the parameterised route intercepts named sub-paths (AD5)
11. **Migration 008 MUST be run on Supabase before deploying** the admin panel or Paytime Sean gate — `addons`, `package_name`, `last_billed_*` columns don't exist without it (AD4, AD5)
12. **Migration 009 MUST be run before user app-restriction features are used** — `user_app_access` table must exist for Tier 3 gate and SSO gate to work (EC2, EC3)
13. **Migration 010 MUST be run before client-restriction features are used** — `user_client_access` table must exist for `PUT /api/users/:id/client-access` and eco-clients filter (EC5, EC7)
14. **NEVER remove `clients:` from the `users.js` GET / map result** — dashboard `loadPracticeUsers` depends on it to render client chips (EC6, EC8)
15. **NEVER use `.single()` in the SSO accountant cross-company chain** — if the user has no direct company access, the result is null and `.single()` throws; use `.maybeSingle()` (EC4)
16. **NEVER remove tax_number required validation from `POST /api/employees`** — employees without tax numbers break PAYE compliance (PT5)
