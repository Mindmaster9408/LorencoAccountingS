# PAYTIME APP FULL AUDIT REPORT

**Generated:** 2026-04-20  
**Audit Scope:** Complete Paytime payroll application — frontend, backend, calculation engine, data flow, multi-tenant safety, compliance coverage  
**Codebase Location:** `accounting-ecosystem/frontend-payroll/` + `accounting-ecosystem/backend/modules/payroll/` + `accounting-ecosystem/backend/core/payroll-engine.js`

---

## 1. App Purpose

### What Paytime Is

Paytime is the payroll processing module within the Lorenco multi-application ecosystem. It handles the full payroll lifecycle for South African employers — from employee setup and payroll item configuration through to payslip generation, statutory calculation, and reconciliation reporting.

### Who Uses It

- **Business Owners / Payroll Administrators:** Run monthly payrolls, finalize payslips, generate reports
- **Accountants:** Review payroll runs, access reconciliation data, export for SARS compliance
- **Super Admins:** Full system access, tax configuration, system health
- **Restricted Paytime Users:** Can be scoped to see only specific employees or non-confidential employees

### Primary Workflow Outcomes

1. Process monthly payroll runs for one or multiple employees
2. Calculate PAYE / UIF / SDL in compliance with SARS requirements
3. Generate immutable, finalized payslips
4. Produce reconciliation data (PAYE / UIF / SDL per period and per employee)
5. Support net-to-gross reverse calculations
6. Import historical payroll data for prior periods
7. Track attendance and leave

### Role in the Wider Ecosystem

Paytime is one of several apps accessible from the Lorenco ECO Systum (central dashboard). It shares the same backend infrastructure (Express.js server, Supabase PostgreSQL database) as the Accounting app, POS app, and other modules. It integrates with the Sean AI layer for IRP5 code learning and bank transaction allocation suggestions. The payroll engine (`payroll-engine.js`) is the canonical calculation authority shared across the full system.

---

## 2. Frontend Structure

### All Pages — Complete Map

| File | Lines | Description |
|---|---|---|
| `login.html` | ~1,066 | Paytime-specific login page. Authenticates via JWT, redirects to company-selection |
| `company-selection.html` | ~652 | Multi-company picker. User sees companies they are linked to. Stores `companyId` in session |
| `company-dashboard.html` | ~1,094 | Company-level payroll dashboard. Shows KPIs: headcount, last payroll total, period status |
| `company-details.html` | ~1,112 | Company payroll configuration. PAYE/UIF/SDL/COID references, bank details, pay frequencies, payslip display name, directors list |
| `employee-management.html` | ~1,372 | Employee CRUD. Lists all employees for the company. Create, edit, deactivate. Hire/termination dates, salary, classification, employee number |
| `employee-detail.html` | ~3,187 | Per-employee payslip and payroll history view. Shows payslips by period, salary history, employment dates, bank details, notes |
| `payroll-items.html` | ~1,846 | Payroll items master list. Earnings and deductions configuration. IRP5 code assignment. Tax configuration panel for super-admins |
| `payroll-execution.html` | ~1,270 | Core payroll run page. Period selection, employee multi-select, run button, results display, finalization control |
| `payruns.html` | ~2,325 | Payroll run history. Lists past runs with expandable employee breakdown. Shows finalization status |
| `reports.html` | ~1,225 | Payroll reporting. Earnings summaries, statutory totals, per-employee breakdown |
| `paye-reconciliation.html` | ~1,210 | PAYE / UIF / SDL reconciliation by tax year and period. EMP501 foundation data |
| `attendance.html` | ~515 | Attendance management. Clock-in/out records, leave requests and balances |
| `historical-import.html` | ~2,160 | CSV import for historical payroll data (prior periods). Imports into `payroll_historical` table |
| `net-to-gross.html` | ~704 | Reverse calculator. User enters target net pay; app determines required gross salary |
| `super-admin-dashboard.html` | ~695 | System-wide admin view. Visible only to super-admins |
| `users.html` | ~610 | User access management. Create/edit Paytime users, set scopes |
| `index.html` | ~180 | Entry point / redirect hub |

### Navigation Structure

The app uses a shared `navigation.js` injected header with a company-context top bar. Within each page, navigation is handled by per-page menu items. The typical navigation flow:

```
Login → Company Selection → Company Dashboard
  ├── Employees (employee-management.html)
  │     └── Employee Detail (employee-detail.html)
  ├── Payroll Items (payroll-items.html)
  ├── Run Payroll (payroll-execution.html)
  ├── Pay Runs (payruns.html)
  ├── Attendance (attendance.html)
  ├── Reports (reports.html)
  ├── PAYE Reconciliation (paye-reconciliation.html)
  ├── Net-to-Gross (net-to-gross.html)
  ├── Historical Import (historical-import.html)
  └── Company Details (company-details.html)
```

### Key Frontend JavaScript Files

All located at `frontend-payroll/js/`:

| File | Purpose |
|---|---|
| `payroll-engine.js` | Mirror of backend PayrollEngine for client-side preview calculations (NOT authoritative — only used for preview) |
| `payroll-api.js` | API client: wraps `POST /run`, `POST /finalize`, `GET /history`, `GET /history/run/:id` |
| `data-access.js` | localStorage ↔ Supabase KV bridge. All `safeLocalStorage` calls redirect to cloud |
| `polyfills.js` | Monkey-patches `Storage.prototype` to intercept all localStorage calls |
| `audit.js` | Client-side audit trail buffer (rotating 1000-entry log, stored in cloud KV) |
| `auth.js` | JWT decode, session management, company list retrieval |
| `permissions.js` | Client-side role/permission mirror of backend matrix |
| `payroll-items-helper.js` | Payroll items CRUD and formatting utilities |
| `recon-service.js` | PAYE/UIF/SDL reconciliation aggregation and YTD support |
| `export-formats.js` | CSV/Excel export formatters |
| `banking-formats.js` | EFT payment file generation |
| `pdf-branding.js` | Payslip PDF generation with company logo/branding |
| `navigation.js` | Shared top-bar and nav injection |
| `theme-guard.js` | Dark/light theme enforcement |

---

## 3. Backend Structure

### Module Location

`accounting-ecosystem/backend/modules/payroll/`

### Route Files — Complete

| Route File | Mounted At | Purpose |
|---|---|---|
| `calculate.js` | `/api/payroll/calculate` | Single-employee calculation endpoint; returns result + optional snapshot |
| `payruns.js` | `/api/payroll/` (root) | Batch run (`POST /run`), finalize (`POST /finalize`), history (`GET /history`) |
| `employees.js` | `/api/payroll/employees` | Employee list, single fetch, salary update, employment dates, bank details, notes |
| `items.js` | `/api/payroll/items` | Payroll items master CRUD + IRP5 code management |
| `periods.js` | `/api/payroll/periods` | Payroll period CRUD |
| `transactions.js` | `/api/payroll/transactions` | Payslip listing by period/employee |
| `attendance.js` | `/api/payroll/attendance` | Attendance CRUD, leave management, leave balances |
| `recon.js` | `/api/payroll/recon` | PAYE/UIF/SDL reconciliation, tax year listing, EMP501 data |
| `kv.js` | `/api/payroll/kv` | Key-value store for Paytime page state (bridges frontend safeLocalStorage) |
| `unlock.js` | `/api/payroll/unlock` | Server-side payslip unlock/finalization workflow |
| `pay-schedules.js` | `/api/payroll/pay-schedules` | Multi-schedule definitions per company |
| `sean-integration.js` | (internal) | Sean AI integration hooks |

### Service Files

| Service | Purpose |
|---|---|
| `PayrollDataService.js` | Fetches and normalizes all inputs required for a calculation |
| `PayrollCalculationService.js` | Orchestrates the PayrollEngine; validates output; formats for API response |
| `PayrollHistoryService.js` | Prepares, saves, locks, and retrieves immutable payroll snapshots |
| `paytimeAccess.js` | Employee visibility scoping; permission middleware |

### Shared Core Engine

`accounting-ecosystem/backend/core/payroll-engine.js`  
This is the **single source of truth** for all payroll calculations. It is used by both the backend (Node.js `require()`) and the frontend (included as a `<script>` tag for preview-only calculations). The frontend copy is advisory only — all authoritative calculations run server-side.

---

## 4. Data Flow

### Overview

```
User Input (frontend form)
    ↓
API Request (JWT-authenticated, company-scoped)
    ↓
Backend Auth + Permission Middleware
    ↓
PayrollDataService.fetchCalculationInputs()
    ↓
PayrollCalculationService.calculate()  →  PayrollEngine (core)
    ↓
PayrollHistoryService.prepareSnapshot()
    ↓
Supabase DB INSERT (payroll_snapshots)
    ↓
Response to Frontend (gross, paye, uif, sdl, net, snapshot)
```

### Source of Truth by Data Category

| Data Category | Source of Truth | Risk Notes |
|---|---|---|
| Employees | `employees` table in Supabase | Some older records may have `salary` column instead of `basic_salary` — normalized in `PayrollDataService` |
| Payroll items master | `payroll_items` table | Edits do not retroactively affect finalized snapshots (correct) |
| Employee recurring items | `employee_payroll_items` table | Active flag controls inclusion |
| Period inputs (one-off) | `payroll_period_inputs` table | Soft-deleted via `is_deleted` flag |
| Overtime / short-time / multi-rate | Separate tables per type, period-scoped | All treated independently — not offset against each other |
| Payroll runs | `payroll_runs` table | Single record per run; contains totals summary |
| Payroll snapshots | `payroll_snapshots` table (JSONB) | Complete input + output; immutable once locked |
| Tax tables | In-engine defaults (code) + Supabase KV override | KV override via `tax_config` key in `payroll_kv_store_eco` |
| Company config | `companies` table | Payroll-specific fields embedded in main companies table |
| Historical imports | `payroll_historical` table | Separate from live payroll; merged in reconciliation reports |
| Attendance | `attendance` and `leave_records` tables | Leave balances tracked per employee per year |

### Data Fragmentation Risks

1. **Salary column name**: `employees.salary` vs `employees.basic_salary` — `PayrollDataService` normalizes both, but older data may have the legacy column populated only.
2. **Tax config dual-location**: Default tax tables are in the engine code; overrides go to Supabase KV. If KV `tax_config` key is corrupted or outdated, the engine silently falls back to code defaults.
3. **Voluntary tax config**: Stored in KV (`voluntaryTaxConfig_{companyId}_{employeeId}`), then read in `payroll-execution.html` and passed as `voluntary_configs` to the run API. No dedicated database table — lives in the KV store only.
4. **Historical imports vs live payroll**: Two separate tables (`payroll_historical` and `payroll_snapshots`). Reconciliation merges them. If a period has both live and historical data, there is no deduplication guard.

---

## 5. Employee Flow

### Employee Creation

1. User navigates to `employee-management.html`
2. Clicks "Add Employee" button → modal opens
3. Fills in: first name, last name, employee number, ID/passport number, hire date, email, phone, salary, payment frequency, classification (public/confidential/executive), is_director, is_contractor
4. Submits → `POST /api/payroll/employees` (or via shared employees route)
5. Record inserted into `employees` table with `company_id` scoping

**Legacy risk:** Some older employee records may have been created via a now-deprecated local-only flow that generated fake `emp-xxx` IDs. `employee-management.html` explicitly detects these and removes them locally during migration.

### Employee Storage

All employees stored in the shared `employees` table with a `company_id` foreign key. Payroll-specific fields:
- `basic_salary` (or legacy `salary`)
- `payment_frequency` (monthly/weekly/bi-weekly)
- `hire_date`, `termination_date` (drives pro-rata)
- `classification` (public/confidential/executive — controls visibility)
- `is_director`, `is_contractor` (affect statutory treatment)
- `id_number` (used for age calculation via SA ID number parsing)
- `tax_number` (SARS income tax reference — required for PAYE compliance)

### Employee Editing

- Salary updates: `PUT /api/payroll/employees/:id/salary` — audited change
- Employment dates: `PUT /api/payroll/employees/:id/employment-dates` — drives pro-rata
- Bank details: `PUT /api/payroll/employees/:id/bank-details` — for EFT file generation

### Employee Selection During Payroll

`payroll-execution.html` loads employees from API. User checks which employees to include in the run. Selected IDs are held in `state.selectedIds` (in-memory JavaScript Set — not persisted). The IDs are passed to `POST /api/payroll/run` as `employee_ids[]`.

### Employee Visibility Scoping

Controlled by `paytimeAccess.js`. Five-tier rule (first match wins):

1. `super_admin` / `business_owner` / `accountant` → see ALL employees
2. No `paytime_user_config` row for this user → see ALL (backward compatibility)
3. `employee_scope = 'selected'` → see ONLY employees in `paytime_employee_access` list
4. `employee_scope = 'all'` AND `can_view_confidential = false` → see only `classification = 'public'`
5. `employee_scope = 'all'` AND `can_view_confidential = true` → see ALL

### Active vs Inactive Employees

Employees with a `termination_date` in a past period are excluded from future payroll run selections. No hard delete of employee records — historical payslips remain intact in `payroll_snapshots`.

---

## 6. Payroll Item Flow

### What Payroll Items Are

Payroll items are the master definitions of earnings and deductions that appear on payslips. They are company-specific (scoped to `company_id`). Examples: Basic Salary, Travel Allowance, Pension Fund, Medical Aid, Bonus, Overtime.

### Item Types

| Type | Effect |
|---|---|
| `earning` | Adds to gross pay; taxable flag controls whether it increases taxable gross |
| `deduction` | Reduces net pay; does NOT reduce taxable gross unless specifically a pre-tax deduction |
| `company_contribution` | Employer-side contribution (SDL is an example); not deducted from employee net |

### IRP5 Code Assignment

Each payroll item can be assigned an IRP5 code (4–6 digit number, SARS-defined). This is critical for annual tax reporting. When an IRP5 code is created or changed on a payroll item, the system emits a fire-and-forget Sean learning event. Sean stores this as structured learned knowledge for future standardization proposals.

### Item Lifecycle

1. Created via `payroll-items.html` → `POST /api/payroll/items`
2. Assigned to employees as recurring items: `employee_payroll_items` table
3. One-off items added per period: `payroll_period_inputs` table
4. When payroll runs, `PayrollDataService.fetchRecurringPayrollItems()` fetches all active recurring items
5. `PayrollDataService.fetchPeriodInputs()` fetches all one-off items for the period
6. Both are passed to the engine as `regular_inputs` (recurring) and `currentInputs` (one-off)

### Payroll Item Editing Safety

Editing a payroll item's name, IRP5 code, or category does NOT retroactively affect finalized snapshots. The snapshot stores the complete input at time of calculation. Historical payslips remain reproducible even if item definitions change later.

### Taxability Rules in `calculateFromData()`

- `is_taxable = true` (earning): Added to `taxableGross` → increases PAYE base
- `is_taxable = false` (earning): Added to `nonTaxableIncome` → increases `gross` but NOT `taxableGross`
- `type = 'deduction'`: Collected into `deductions` → reduces `net` only

**Important note:** Pre-tax deductions (e.g., pension fund that reduces taxable income) are NOT currently separately handled by the engine. All deductions reduce net pay but not taxable gross.

---

## 7. Calculation Flow

### Architecture: Three-Service Pipeline

```
PayrollDataService          →  PayrollCalculationService  →  PayrollHistoryService
(fetch + normalize inputs)     (call engine, validate)       (snapshot, lock)
```

### The PayrollEngine (`backend/core/payroll-engine.js`)

**Version:** `2026-04-12-v1` | **Schema Version:** `1.0`

The engine is a pure calculation module — it takes normalized data objects and returns a deterministic result. It has no side effects and performs no database operations.

#### Engine Entry Points

| Method | Use Case |
|---|---|
| `calculateFromData()` | Full-month calculation. Accepts all payroll inputs, returns result object |
| `calculateWithProRata()` | Partial month (hire/termination). Pre-applies pro-rata factor to basic salary only, then calls `calculateFromData()` |
| `calculateNetToGross()` | Reverse calculation. Binary search (bisection) to find the basic salary that produces a target net pay |
| `calculateMonthlyPAYE_YTD()` | SARS run-to-date PAYE method. Uses accumulated taxable income across the tax year |

#### Calculation Steps Inside `calculateFromData()`

```
1. SELECT TAX TABLES
   getTablesForPeriod(period) → returns correct historical or current brackets

2. BUILD TAXABLE GROSS
   + basic_salary
   + taxable earnings (recurring + one-off)
   + overtime earnings (hourly_rate × hours × multiplier) — always taxable
   + multi-rate earnings (hours × rate) — always taxable
   - short-time deductions (hours_missed × hourly_rate) — earnings reduction

3. BUILD NON-TAXABLE INCOME
   + non-taxable earnings (is_taxable = false)

4. GROSS = taxableGross + nonTaxableIncome

5. CALCULATE PAYE
   If ytdData provided:
     → calculateMonthlyPAYE_YTD() (SARS accumulation method)
   Else:
     → calculateMonthlyPAYE() (simple annualization)
   → Subtract medical tax credits (Section 6A)
   → Apply tax directive override if present (flat rate %)
   → Maximum(result, 0) — never negative PAYE

6. VOLUNTARY TAX OVER-DEDUCTION
   Three scenarios:
   a. fixed: flat extra monthly amount, every period
   b. variable: extra amount only if period matches config.period
   c. bonus_spread: extra amount for period range [start_period, end_period]
   → Added to PAYE only — UIF/SDL unaffected

7. UIF = MIN(gross × 1%, R177.12)

8. SDL = gross × 1% (no cap)

9. DEDUCTIONS = sum of deduction-type items

10. NET = gross - (paye + voluntaryOverDeduction) - uif - deductions
    (SDL is employer-paid — included in totals but not deducted from employee net)

11. RETURN 13 LOCKED FIELDS:
    gross, taxableGross, paye, paye_base, voluntary_overdeduction,
    uif, sdl, deductions, net, negativeNetPay, medicalCredit,
    overtimeAmount, shortTimeAmount
```

#### Hourly Rate Calculation

```
hourlyRate = monthly_salary / (weekly_hours × 4.33)

Where weekly_hours = sum of enabled days × hours_per_day
  (partial-day entries use their specific partial_hours value)

Fallback: salary / 173.33 (standard divisor) if no work schedule defined
```

#### Pro-Rata Calculation (Hours-Based)

```
expectedHours = workday hours within full period
workedHours   = workday hours from max(hire_date, period_start) to min(term_date, period_end)
prorataFactor = workedHours / expectedHours

adjusted_basic_salary = basic_salary × prorataFactor

Pro-rata applies ONLY to basic salary.
Overtime, short-time, allowances, and deductions are NOT pro-rated.
```

#### Tax Year Resolution

SA tax year runs 1 March through last day of February.

```
period '2025-01' → tax year '2024/2025'
period '2025-03' → tax year '2025/2026'
period '2026-02' → tax year '2025/2026'
```

Historical tables are hardcoded for 2021/2022 through 2026/2027. The current year tables can be overridden via the Tax Configuration UI in `payroll-items.html` (stored in Supabase KV under key `tax_config`).

#### Output Contract (IMMUTABLE — no field removal ever)

```javascript
{
  gross:                    number  // total earnings (taxable + non-taxable)
  taxableGross:             number  // income subject to PAYE
  paye:                     number  // total PAYE withheld (includes voluntary)
  paye_base:                number  // PAYE before voluntary top-up
  voluntary_overdeduction:  number  // voluntary additional tax
  uif:                      number  // employee UIF contribution
  sdl:                      number  // SDL (employer levy, shown for payslip)
  deductions:               number  // other deductions (pension, medical, etc.)
  net:                      number  // take-home pay
  negativeNetPay:           boolean // true if net < 0
  medicalCredit:            number  // monthly medical tax credit
  overtimeAmount:           number  // OT earnings (itemized)
  shortTimeAmount:          number  // short-time earnings reduction (itemized)
  // Pro-rata runs add 3 more fields (additive only):
  prorataFactor:            number  // e.g. 0.6364 for 14/22 workdays
  expectedHoursInPeriod:    number
  workedHoursInPeriod:      number
}
```

### Frontend Calculation Engine

`frontend-payroll/js/payroll-engine.js` is a copy of the backend engine loaded in the browser for real-time preview calculations. **It is ADVISORY ONLY.** The authoritative result always comes from the server.

---

## 8. PAYE / UIF / SDL / Statutory Flow

### PAYE — Pay As You Earn

**Authority:** SARS Income Tax Act, Section 11  
**Method:** Annualization or SARS YTD run-to-date method

#### Simple Annualization (default)
```
monthly PAYE = (calculateAnnualPAYE(monthly_taxable × 12) / 12) - medical_credit
```

#### SARS YTD Run-to-Date Method (when ytdData provided)
```
accumulated_taxable = ytd_taxable_gross + current_month_taxable
annual_equivalent   = accumulated_taxable × (12 / months_elapsed)
ytd_liability       = calculateAnnualPAYE(annual_equivalent) × (months_elapsed/12) - (medical_credit × months_elapsed)
current_month_paye  = MAX(ytd_liability - ytd_paye_already_withheld, 0)
```

#### Tax Directive
If an employee has a tax directive (fixed rate%), PAYE = `monthly_taxable × (taxDirective / 100)`. YTD and bracket calculations are bypassed.

#### Age-Based Rebates (2026/2027)
- Primary rebate (R17,235): All employees
- Secondary rebate (R9,444): Age ≥ 65 (detected from SA ID number via `getAgeFromId()`)
- Tertiary rebate (R3,145): Age ≥ 75

#### Tax Brackets (2026/2027 — same as 2024/2025)

| Annual Taxable Income | Rate | Base Tax |
|---|---|---|
| R0 – R237,100 | 18% | R0 |
| R237,101 – R370,500 | 26% | R42,678 |
| R370,501 – R512,800 | 31% | R77,362 |
| R512,801 – R673,000 | 36% | R121,475 |
| R673,001 – R857,900 | 39% | R179,147 |
| R857,901 – R1,817,000 | 41% | R251,258 |
| R1,817,001+ | 45% | R644,489 |

### Medical Tax Credits (Section 6A/6B)

| Members | Monthly Credit (2026/2027) |
|---|---|
| 1 (main member only) | R364 |
| 2 (+ first dependent) | R728 |
| 3+ (+ additional each) | R728 + R246 × (n-2) |

### UIF — Unemployment Insurance Fund

- **Rate:** 1% employee contribution
- **Monthly Cap:** R177.12
- **Base:** Full gross (taxable + non-taxable)
- **Note:** Directors may be exempt from UIF — tracked via `is_director` flag but no engine enforcement yet

### SDL — Skills Development Levy

- **Rate:** 1% of gross payroll
- **Base:** Full gross (no cap)
- **Employer-paid:** NOT deducted from employee net pay
- **Note:** Small employers (annual payroll < R500,000) are exempt — not currently auto-enforced

### Tax Table Management

- **Defaults:** Hardcoded in engine for 2021/2022 through 2026/2027
- **Override:** Super-admin updates via Tax Configuration panel in `payroll-items.html` → saved to Supabase KV `tax_config`
- **Historical:** Always use hardcoded values (verified, immutable)

### Statutory Compliance Gaps

| Gap | Severity | Detail |
|---|---|---|
| EMP501 / IRP5 XML submission | High | Foundation data complete; SARS XML format not implemented |
| ETI (Employment Tax Incentive) | Medium | Table structure exists; not wired into PAYE calculation |
| SDL small employer exemption | Low | Always applied at 1%; no threshold check |
| Pre-tax deductions | Medium | All deductions reduce net only; pension/RA don't reduce taxable gross |
| COIDA / WorkCom contributions | Low | COID reference stored; no calculation |
| Director UIF exemption | Low | `is_director` flag exists; engine still applies UIF |

---

## 9. Payslip Flow

### How Payslips Are Generated

1. User runs payroll (`POST /api/payroll/run`) for selected employees
2. Backend processes each employee: data fetch → calculation → snapshot preparation
3. Each result stored as `payroll_snapshot` (JSONB blobs for input + output)
4. Frontend renders payslip preview cards from API response
5. Historical payslip view (`employee-detail.html`) always reads from stored snapshot — never recalculates

### Immutability

Once finalized (`POST /api/payroll/finalize`):
- `is_locked = true`
- `status = 'finalized'`
- Cannot be overwritten by re-run (409 Conflict)

A finalized payslip from March 2025 will return exactly the same numbers in 2030.

### Payslip Content

**Header:** Company name, logo, PAYE reference, employee name, employee number, ID number, hire date  
**Earnings:** Basic salary + each earning item + overtime = Total gross  
**Deductions:** PAYE + UIF + each deduction item = Total deductions  
**Employer costs:** SDL  
**Net Pay:** Gross − PAYE − UIF − deductions

### Payslip Export

`pdf-branding.js` generates PDFs with company branding. `banking-formats.js` generates EFT payment files from finalized runs.

---

## 10. Reporting Flow

### Available Reports

| Report | Location | Source |
|---|---|---|
| Payroll Summary (per period) | `reports.html` | `payroll_snapshots` or `payroll_transactions` |
| Employee Earnings Breakdown | `reports.html` | `payroll_snapshots` |
| PAYE Reconciliation by Period | `paye-reconciliation.html` | Merged: `payroll_transactions` + `payroll_historical` |
| EMP501 / IRP5 Foundation Data | `paye-reconciliation.html` | Merged: live payroll + historical imports, aggregated by IRP5 code |
| Attendance Summary | `attendance.html` | `attendance` table |
| Leave Records | `attendance.html` | `leave_records` + `leave_balances` |

### Reconciliation (`GET /api/payroll/recon/summary`)

Returns per-period totals for a tax year, merging:
1. Live payroll data from `payroll_transactions`
2. Historical imports from `payroll_historical`

### EMP501 / IRP5 Data (`GET /api/payroll/recon/emp501`)

Aggregates per-employee annual earnings broken down by IRP5 code. Produces the data foundation for EMP501 filing, but does not yet produce the SARS-required XML format.

### Reporting Risks

1. **Dual-source merging** (live + historical): No deduplication guard — if a period appears in both tables, totals may double-count
2. **No per-item report columns**: Reports show totals only; individual payroll item breakdowns are in the snapshot JSONB but not surfaced in UI
3. **IRP5 code completeness**: If payroll items lack IRP5 codes, EMP501 data will be incomplete

---

## 11. Company / Multi-Tenant Safety Review

### Company Scoping Mechanism

Every API request carries a JWT containing `companyId`. All payroll queries filter with `.eq('company_id', req.user.companyId)` at the route level.

### Database-Level Isolation

Every payroll table includes a `company_id` column. Tables: `payroll_runs`, `payroll_snapshots`, `payroll_items`, `employee_payroll_items`, `payroll_period_inputs`, `payroll_overtime`, `attendance`, etc.

### Multi-Tenant Risk Summary

| Risk | Severity | Assessment |
|---|---|---|
| Cross-company data leak via API | Low | company_id filter on every query; JWT enforced |
| Stale frontend state after company switch | Medium | Memory state may linger in JS variables; API calls are clean |
| KV store cross-contamination | Low | company_id in KV table schema |
| Shared payroll engine | None | Engine is stateless; no company data cached |

---

## 12. Permissions / User Access Review

### Backend Permission Middleware Stack

```
1. authenticateToken()         — validates JWT, sets req.user
2. requireCompany()            — ensures companyId in context
3. requirePermission()         — checks role against permission matrix
4. requirePaytimeModule()      — checks user has Paytime module access
5. paytimeAccess.getEmployeeFilter() — applies employee visibility scoping
6. paytimeAccess.canViewEmployee()   — per-employee gate check
```

### Role-Based Permissions

| Role | View | Run | Finalize | Admin |
|---|---|---|---|---|
| `super_admin` | ✓ | ✓ | ✓ | ✓ |
| `business_owner` | ✓ | ✓ | ✓ | Limited |
| `accountant` | ✓ | ✓ | Limited | — |
| `payroll_admin` | ✓ | ✓ | ✓ | — |
| `paytime_user` (custom) | Scoped | Scoped | — | — |

### Permission Gaps

| Gap | Severity | Detail |
|---|---|---|
| Voluntary tax config UI | Medium | No frontend UI; must set via KV store directly |
| Tax configuration access | Medium | Super-admin only; no role-based restriction below that |
| Historical import access | Low | Should require `PAYROLL.CREATE` minimum |
| Per-payslip access control | Low | No per-payslip permissions — employee visibility = all their payslips |

---

## 13. Integration Review

### Sean AI Integration

- IRP5 code create/update → fire-and-forget Sean learning event
- Sean stores `{ companyId, payrollItemName, irp5Code, previousCode }` as structured learning
- Sean can propose cross-client standardization (per Part B rules in CLAUDE.md)
- Non-blocking — payroll continues if Sean endpoint is down

### Accounting Integration

**Status: Not implemented.** Payroll journals (Dr: Salaries expense, Cr: PAYE payable, Cr: UIF payable, Cr: Salaries payable) are not currently posted to the accounting module after finalization. The accounting module has `JournalService` available as a future integration point.

### Shared Services

| Service | Shared With | Risk |
|---|---|---|
| `payroll-engine.js` | Any future module using payroll calculations | Single source of truth — changes affect all consumers |
| JWT/auth middleware | All apps in ecosystem | Token format change would break all apps |
| Supabase connection | All modules | Shared connection pool |
| KV store | Paytime only (company-scoped) | No cross-module contamination |
| Sean AI | Accounting (bank learning), Paytime (IRP5) | Shared Sean service; events are fire-and-forget |

---

## 14. Navigation / Usage Flow

### Full User Journey: Monthly Payroll Run

**Step 1: Login** → `login.html` → JWT issued → redirect to `company-selection.html`

**Step 2: Select Company** → `company-selection.html` → `companyId` stored in session → redirect to `company-dashboard.html`

**Step 3: Company Dashboard** → KPIs: headcount, last payroll gross, last run date, pending periods

**Step 4: Configure Payroll Items** → `payroll-items.html`
- Add/edit earnings and deductions with type, taxability, IRP5 code
- Super-admin: update tax tables via Tax Configuration panel

**Step 5: Set Up Employees** → `employee-management.html`
- Add new employee: name, ID, hire date, salary, classification
- Navigate to `employee-detail.html` for full history and item assignment

**Step 6: Employee Detail** → `employee-detail.html`
- View payslips for each period (from snapshots)
- Add/remove recurring payroll items
- Add one-off items for a period
- Add overtime / short-time / multi-rate entries
- View notes and salary history

**Step 7: Run Payroll** → `payroll-execution.html`
- Select pay period (YYYY-MM)
- Optionally filter by pay schedule
- Select employees → Run Payroll → `POST /api/payroll/run`
- View per-employee result cards (gross / PAYE / UIF / SDL / net)
- Finalize Payroll → `POST /api/payroll/finalize` → period locked

**Step 8: View Pay Runs** → `payruns.html`
- List of all past runs with finalization status
- Expandable per-employee breakdown

**Step 9: Generate Reports** → `reports.html`
- Period/tax year selection
- Payroll summary totals and per-employee breakdown
- Export to CSV or PDF

**Step 10: PAYE Reconciliation** → `paye-reconciliation.html`
- Tax year selection
- Period-by-period PAYE/UIF/SDL totals
- EMP501 foundation data per employee

### Other Journeys

**Net-to-Gross** (`net-to-gross.html`): Enter target net → binary search → required gross salary

**Attendance** (`attendance.html`): Record daily attendance, submit leave requests, view balances

**Historical Import** (`historical-import.html`): Upload CSV → import to `payroll_historical` → visible in recon reports

---

## 15. Risk Analysis

### Data Source / Architecture Risks

| Risk | Severity | Details |
|---|---|---|
| Voluntary tax config stored in KV only | High | Lives in KV store, not a DB table. No audit trail. Lost if KV is flushed. |
| Pre-tax deductions not implemented | High | Pension/RA contributions treated as normal deductions. PAYE may be over-calculated. |
| EMP501/IRP5 XML not implemented | High | Foundation data exists; SARS XML format for e@syFile not built. |
| Dual-source report data (live + historical) | Medium | No deduplication guard. Possible double-counting in recon. |
| SDL small employer exemption not enforced | Medium | Engine always applies SDL at 1%. |
| Director UIF exemption not enforced | Medium | `is_director` flag exists but engine still applies UIF. |
| ETI not wired into PAYE | Medium | Table structure exists; no calculation integration. |
| Historical import validation absent | Medium | No arithmetic checks on imported PAYE/UIF vs gross. |
| Tax config KV override without version | Low | Incorrect tables saved = all future runs use wrong tables until corrected. No rollback. |

### Calculation Risks

| Risk | Severity | Details |
|---|---|---|
| Frontend engine used for authoritative display | High (if violated) | Must never store frontend engine results as canonical records. |
| YTD PAYE requires prior period data | Medium | Missing prior periods → defaults to simple annualization silently. |
| Tax year boundary (Feb→Mar) | Low | `getTaxYearForPeriod()` handles correctly. Verify with regression tests. |
| Rounding in batch runs | Low | Each employee rounded before summing → minor cent-level discrepancies. |

### localStorage / State Risks

| Risk | Severity | Details |
|---|---|---|
| Voluntary tax configs in KV only | High | See above |
| Stale employee list in memory | Low | Add in one tab; payroll-execution in another tab won't show new employee |
| Legacy `emp-xxx` fake IDs | Low | Detection logic in employee-management handles cleanup |
| Monkey-patched Storage.prototype | Low | Third-party libs bypassing prototype chain may skip the KV intercept |

### Compliance / Operational Risks

| Risk | Severity | Details |
|---|---|---|
| No correction workflow for finalized periods | High | No UI or documented procedure. `unlock.js` exists server-side but is undocumented. |
| No payroll reversal mechanism | High | Reversing a finalized period requires manual database intervention. |
| UIF cap hardcoded | Medium | R177.12 in engine constants. Code update required when SARS changes ceiling. |
| Tax Number validation | Note | Currently deactivated for testing (2026-04-20). Re-activate before production use. See Section 16. |

---

## 16. Protected Areas

### Must Not Break

| Area | Why Critical | How to Protect |
|---|---|---|
| `PayrollEngine.calculateFromData()` | Core calculation — all payslips depend on it | Regression test suite. No field removal from output. Version must increment on any change. |
| `PayrollEngine.calculateWithProRata()` | Pro-rata payslips for hire/termination months | Verify with known test cases |
| Output contract (13 locked fields) | Finalized snapshots stored with these field names | NEVER remove or rename fields. ONLY add after last field. |
| `PayrollHistoryService.saveSnapshot()` | Snapshot persistence | Test JSONB roundtrip; verify is_locked prevents overwrite |
| Finalization guard (`is_locked` check) | Prevents double-running finalized periods | Must be first check in any run endpoint |
| `paytimeAccess` employee scoping | Employee visibility enforced on every query | Never bypass this filter |
| Company_id filtering on all DB queries | Multi-tenant isolation | Audit any new route for missing `.eq('company_id', ...)` |
| Historical tax tables (HISTORICAL_TABLES) | Prior-period recalculations use correct year tables | NEVER modify historical values once a period has been processed |
| Pro-rata: OT/short-time NOT pro-rated | Contractual and legal accuracy | Only `basic_salary` multiplied by factor |
| UIF cap application | SARS compliance | `MIN(gross × 1%, 177.12)` — never remove the cap |
| PAYE never negative | SARS requirement | `MAX(monthlyTax, 0)` — never remove this floor |

### Tax Number Validation — Deactivation Record

**Date deactivated:** 2026-04-20  
**Reason:** Testing purposes — allows adding employees without tax number  
**Status:** TEMPORARILY INACTIVE — must be re-activated before full production use

**Locations to re-activate when ready:**

#### Location 1 — `frontend-payroll/employee-management.html`

**HTML field** (around line 557–558):
```html
<!-- RE-ACTIVATE: change label back to class="required" and restore required attribute on input -->
<label>Tax Number</label>
<input type="text" id="tax_number" ... data-tax-required-inactive="true">
```

**JS validation** (around line 888–894):
```javascript
// RE-ACTIVATE: uncomment this block
/* TAX NUMBER REQUIRED — DEACTIVATED FOR TESTING (2026-04-20)
if (!taxNumber) {
    errorDiv.textContent = 'Tax number is required for PAYE compliance.';
    errorDiv.style.display = 'block';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Employee';
    return;
}
*/
```

#### Location 2 — `frontend-payroll/employee-detail.html`

**HTML field** (around line 926):
```html
<!-- RE-ACTIVATE: change label back to class="required" and restore required attribute on input -->
<label>Tax Number</label>
<input type="text" id="editTaxNumberInput" ... data-tax-required-inactive="true">
```

**JS validation** (around line 2880):
```javascript
// RE-ACTIVATE: uncomment this line
// TAX NUMBER REQUIRED — DEACTIVATED FOR TESTING (2026-04-20)
// if (!taxNum) { alert('Tax Number is required for all employees.'); return; }
```

**To re-activate:**
1. In both HTML files: change `data-tax-required-inactive="true"` back to `required`
2. In both HTML files: change label back to `class="required"`
3. In `employee-management.html`: uncomment the `/* ... */` JS block
4. In `employee-detail.html`: uncomment the `//` JS line

---

## 17. Recommended Focus Areas for Next Step

> These are audit observations ranked by impact. No implementation started.

### Priority 1 — Compliance Critical

1. **Pre-tax deduction support:** Implement pension/RA contributions as pre-tax deductions that reduce `taxableGross`. SARS compliance requirement for many SA employers.
2. **EMP501 / IRP5 XML export:** Foundation data is complete. Build SARS XML/CSV format for e@syFile submission. Required for annual tax filing.
3. **ETI integration:** Wire existing `employee_eti` table into PAYE calculation as a credit against employer PAYE liability.

### Priority 2 — Operational Integrity

4. **Voluntary tax config database migration:** Move from KV store to a dedicated `employee_voluntary_tax` table with audit trail and UI.
5. **Payroll correction workflow:** Document and implement the unlock → correct → re-finalize process.
6. **Historical import validation:** Add arithmetic checks on imported PAYE/UIF vs gross.

### Priority 3 — Compliance Completeness

7. **SDL exemption check:** Add optional `sdl_exempt` flag to company settings.
8. **Director UIF exemption:** Skip UIF when `is_director = true`.
9. **UIF cap configurable:** Move `UIF_MONTHLY_CAP` to `company_payroll_settings`.

### Priority 4 — Reporting Enhancement

10. **Per-item report columns:** Surface individual payroll item amounts in reports.
11. **Deduplication guard:** Detect periods in both `payroll_transactions` and `payroll_historical`.

### Priority 5 — Developer Safety

12. **Regression test expansion:** Add tests for pro-rata (mid-month hire/termination), voluntary tax (all 3 scenarios), medical credits (1/2/3+ members), YTD PAYE across Feb→Mar boundary.
13. **Frontend engine advisory enforcement:** Consider removing `calculateFromData()` from frontend bundle entirely to make backend authority non-negotiable.

---

*End of Paytime Full Audit Report.*  
*No code was changed as part of producing this document.*  
*See Section 16 for the Tax Number validation deactivation record.*
