# Paytime — Risks, Protected Areas, and Known Gaps

> Last updated: 2026-04-29  
> Sources: Multiple audit sessions and session handoff documents, April 2026

This document is a frank assessment of the risks, protected areas, and known gaps in Paytime as of April 2026. It is written so future developers can understand what is fragile, what must not be touched carelessly, and what is known to be incomplete.

---

## 1. Protected Areas — Do Not Modify Without Full Audit

These components are working correctly and are central to the system. Changes here carry the highest regression risk.

### 1.1 PayrollEngine (`backend/core/payroll-engine.js`)

**Risk: CRITICAL**

The engine is the sole PAYE/UIF/SDL calculation authority. Any change to:
- BRACKETS, PRIMARY_REBATE, SECONDARY_REBATE, TERTIARY_REBATE
- UIF_RATE, UIF_MONTHLY_CAP, SDL_RATE
- `calculateFromData()` or `calculateWithProRata()` calculation logic
- The output field contract (fields, order, naming)

...will affect ALL payroll calculations across ALL companies. Finalized payslips will no longer match what the engine produces if calculations change.

**Rules before touching the engine:**
1. Full audit of what is being changed and why
2. Regression tests with known good values
3. INCREMENT `ENGINE_VERSION` string
4. Document the change with a CHANGE IMPACT NOTE
5. Never remove or rename output fields
6. Never change field order in the return statement
7. Update tax year constant if updating default tables

### 1.2 Snapshot Immutability (`payroll_snapshots` table)

**Risk: HIGH**

Any code that updates a row in `payroll_snapshots` where `is_locked = true` corrupts the historical record. There is no automated guard at the database level — it is enforced in the application layer.

**Rules:**
- Never issue an `UPDATE payroll_snapshots SET ... WHERE is_locked = true`
- `POST /api/payroll/run` already guards against this — it skips finalized snapshots
- The unlock route (`/api/payroll/unlock`) should require super-admin permission and create an audit trail
- Any correction to a finalized payslip must create a new snapshot, not mutate the original

### 1.3 Multi-Tenant Isolation

**Risk: HIGH**

Every database query must include `.eq('company_id', companyId)`. Failure to do so could expose one company's payroll data to another company's users.

**Protected pattern — never remove or skip:**
```javascript
router.use(authenticateToken);
router.use(requireCompany);
// ...
.eq('company_id', companyId)  // Must be in every query
```

### 1.4 JWT Authentication

**Risk: HIGH**

`authenticateToken` middleware validates the JWT on every request. Do not create routes that bypass `authenticateToken`. Do not return sensitive payroll data from unauthenticated endpoints.

### 1.5 `PayrollDataService.fetchCalculationInputs()` — KV Fallback Path

**Risk: MEDIUM**

The KV fallback for `basic_salary` (if null on employees table) is a deprecated compatibility path. It must not be removed until all production employees have `basic_salary` populated on the `employees` table. Removing it prematurely would cause those employees to calculate with basic salary = 0.

---

## 2. Known Technical Gaps

These are documented issues that exist in production but are not immediately breaking the application.

### 2.1 Historical Import — Data Goes to KV, Not SQL

**Severity: HIGH — data loss risk**

`historical-import.html` writes imported records to `safeLocalStorage` (KV store), not to the `payroll_historical` SQL table. This means:
- Imported historical data is browser-session-local in practice
- The PAYE recon backend endpoint (`/api/payroll/recon/summary`) cannot see this data
- If the browser's localStorage is cleared, all imported historical data is gone
- The recon page falls back to `ReconService.buildPayrollTotals()` (localStorage aggregation), which masks the problem

**Consequences for companies that have used historical import:**
- Their reconciliation data appears correct in the current browser session
- It would disappear if they switch browsers or clear localStorage

**Fix required:** Rewrite the import commit phase in `historical-import.html` to call `DataAccess.saveHistoricalRecord()` for each row instead of writing to `safeLocalStorage`. See PAYTIME_ROADMAP.md.

### 2.2 Reports Page — Entirely localStorage-Based

**Severity: MEDIUM**

`reports.html` reads all data (employees, payruns, payroll config, payslip status) from `safeLocalStorage` via `ReconService`. It does not call any API endpoints for report data.

**Consequences:**
- Reports depend on browser session data being current
- If a user runs payroll on one device and generates a report on another, the data will differ
- Reports data would be lost if localStorage is cleared

**Fix required:** Rewrite `reports.html` to load data from API endpoints (snapshots, transactions) instead of localStorage. See PAYTIME_ROADMAP.md.

### 2.3 Voluntary Tax Over-Deduction — Persistence Unclear

**Severity: MEDIUM**

The engine supports voluntary over-deduction (`voluntary_overdeduction` output field). The frontend has UI for it. The exact persistence path for this configuration (where the value is stored per employee, how it's fetched by PayrollDataService) has not been audited.

**Risk:** If the configuration is stored in localStorage/KV instead of a proper column on `employees` or a dedicated table, it may not be reliably available across sessions.

**Action required:** Audit the `voluntary_overdeduction` frontend-to-backend flow before relying on it for compliance use.

### 2.4 IRP5 Code Mapping — Incomplete

**Severity: MEDIUM**

The `payroll_items` table has an `irp5_code` column. The UI in `payroll-items.html` allows entering IRP5 codes. The Sean AI integration (`sean-integration.js`) has a learning event capture mechanism.

**What is NOT built:**
- Systematic review of all payroll items for correct IRP5 code coverage
- Validation that every taxable earnings item has a populated IRP5 code
- The Sean approval workflow for propagating standard mappings across clients
- IRP5 / IT3(a) file generation (requires IRP5 codes to be correct)

**Consequence:** Payroll can run without IRP5 codes on items. When IRP5 file generation is built, items without codes will fail or produce incorrect files.

### 2.5 Employees Created Before April 2026 — Missing Columns

**Severity: LOW (self-resolving)**

The April 2026 schema migration added `basic_salary`, `medical_aid_members`, `tax_directive`, `job_title`, `payment_method`, `bank_name`, `account_holder`, `account_number`, `branch_code` columns to the `employees` table. Existing employees have null values for these new columns.

**Consequence:** Until an employee's record is saved via `employee-detail.html` (which writes all fields), the new columns remain null. The KV fallback handles `basic_salary` for now. Other fields (bank details, job title) would just be blank/missing in the UI.

This is self-resolving — as each employee's record is opened and saved once, the columns get populated.

### 2.6 pay-schedules.html and payruns.html — Status Unclear

**Severity: LOW**

`payruns.html` is a page that shows payroll run history. Its relationship to the current API-backed run history (`GET /api/payroll/history`) is unclear. It may be partially or fully replaced by `payroll-execution.html`'s run history view.

**Action required:** Audit `payruns.html` to determine if it is actively used, redundant, or deprecated. If redundant, mark it clearly in code comments; do not delete it without confirming it's unused.

---

## 3. Known Compliance Gaps

### 3.1 SARS Filing Not Built

Paytime calculates the correct amounts but does not generate any SARS submission files. As of April 2026:

- **EMP201** (monthly PAYE/UIF/SDL payment) — Data is available, file not generated
- **EMP501** (annual reconciliation) — Foundation data available via API; XML not generated
- **IRP5 / IT3(a)** (tax certificates to employees and SARS) — Not built
- **UIF return files** — Not built

This means accountants must manually capture Paytime's calculated figures into SARS eFiling or e@syFile. All the calculated data is correct; the automation is missing.

### 3.2 YTD Cumulative PAYE Method Not Implemented

The current engine uses a monthly calculation method (basic salary × 12 for annualisation). The SARS-preferred method for variable income employees is the YTD cumulative method.

`ytdData` parameter in the engine is present but always passed as `null` in the current code. This means employees with variable monthly income (commission-heavy) may have slightly incorrect PAYE on a month-by-month basis (though annual totals will reconcile correctly at year-end).

---

## 4. Regression-Risk Matrix

When making changes to the following areas, these are the things that can silently break:

| Change area | What can break |
|---|---|
| `payroll-engine.js` constants or calculation | All PAYE/UIF/SDL calculations. Finalized payslips no longer reproducible. |
| `PayrollDataService.normalizeCalculationInput()` | What inputs the engine receives. Silent wrong calculations. |
| `employees.js` PUT endpoint allowed fields | Fields that stop being saved. The April 2026 bug. |
| `polyfills.js` whitelist | Business data accidentally going back to native localStorage, or auth tokens accidentally going to KV. |
| `authenticateToken` or `requireCompany` middleware | Auth bypass or multi-tenant data leak. |
| `payroll-schema.js` migration | New columns with wrong defaults breaking existing rows. |
| `PayrollHistoryService.prepareSnapshot()` | Snapshot structure mismatch. History page breaks. |
| `payruns.js` finalization logic | Snapshots not being locked, or locked incorrectly. |

---

## 5. Rules for Future Work in Protected Areas

1. **Audit before changing** — read the code you're about to change fully before editing
2. **Check downstream consumers** — who reads what you're changing?
3. **Write a CHANGE IMPACT NOTE** before non-trivial changes
4. **Preserve existing required functionality** — don't remove a working feature while adding a new one
5. **Test with known good values** — for engine changes, calculate a payslip manually and verify
6. **Never skip the company_id filter** — ever
7. **Never make KV the primary storage for business data** — see PAYTIME_NO_LOCALSTORAGE_RULE.md

---

## Related Documents

- [PAYTIME_CAPABILITIES.md](PAYTIME_CAPABILITIES.md) — Full capability status
- [PAYTIME_NO_LOCALSTORAGE_RULE.md](PAYTIME_NO_LOCALSTORAGE_RULE.md) — localStorage hard rules
- [PAYTIME_ROADMAP.md](PAYTIME_ROADMAP.md) — What needs to be fixed and built
- [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md) — System structure
