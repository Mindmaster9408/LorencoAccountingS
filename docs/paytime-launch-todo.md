# Paytime — Launch Implementation TODO

**Owner**: Principal Engineer / Launch Lead
**Started**: 2026-03-10
**Purpose**: Structured action register for all confirmed Paytime launch requirements.
**Rule**: Before starting any item, cross-check `WORKING_FEATURES_REGISTRY.md` for affected files.

---

## Status Key
| Symbol | Meaning |
|--------|---------|
| 🔴 | Launch Critical — app cannot ship without this |
| 🟠 | High Priority — must be done soon after launch |
| 🟡 | Medium Priority — important but not a launch blocker |
| 🔵 | Architecture / Shared — affects multiple apps, must be done at ecosystem level |
| ⬛ | Needs Confirmation — business rule unclear |
| ✅ | Completed |
| 🚧 | In Progress |
| ⛔ | Blocked |

---

## SECTION 1 — Launch Critical 🔴

---

### PT-01 — PAYE Cumulative Tax Calculation (YTD)
**Status**: 🔴 Not Started
**Priority**: Launch Critical
**Description**:
PAYE must not be calculated in isolation for the current month only. SA tax law requires the
"run-to-date" method: PAYE is calculated on total YTD income, then the YTD PAYE already
withheld is subtracted to arrive at this month's PAYE deduction.

**Why it matters**: Incorrect PAYE means incorrect payslips, wrong IRP5 values, and potential
SARS non-compliance. Employees may be under- or over-taxed each month.

**What needs to be built**:
1. For each pay period being calculated, look back through all prior periods in the same SA
   tax year (March–February) for this employee.
2. Sum up: prior months' gross income (YTD gross) + prior months' PAYE already deducted
   (YTD PAYE).
3. Current month PAYE = `PAYE_on_(YTD_gross + this_month_gross) - YTD_PAYE_already_deducted`
4. Store YTD values per employee per tax year so the engine can read them back.

**Current state**: `PayrollEngine.calculateMonthlyPAYE()` simply does `annualPAYE / 12` — pure
monthly annualization, no YTD awareness at all.

**Affected files**:
- `accounting-ecosystem/frontend-payroll/js/payroll-engine.js` — add `calculateMonthlyPAYE_YTD()`
- `accounting-ecosystem/frontend-payroll/employee-detail.html` — pass YTD data into calculation
- `accounting-ecosystem/frontend-payroll/js/data-access.js` — YTD storage/retrieval

**Dependencies**: Requires finalized prior-period payslips to be readable (they are, via KV).

**Needs Confirmation**: ⬛ Confirm whether YTD should accumulate from finalized payslips only, or
also from draft/in-progress periods.

---

### PT-02 — Company Selection Must Show Payroll-Active Companies Only
**Status**: 🔴 Not Started
**Priority**: Launch Critical
**Description**:
The Paytime company selection screen must only show companies that:
1. Are active in the ecosystem (`is_active = true`)
2. Have `payroll` in their `modules_enabled` list (or the user has payroll access)

Currently `renderCompanies()` shows ALL companies the user has access to, regardless of
whether payroll is enabled for that company.

**Why it matters**: User sees companies they cannot use payroll for, creating confusion and
potential data isolation issues.

**Affected files**:
- `accounting-ecosystem/frontend-payroll/company-selection.html` — `renderCompanies()` function
- Filter: `company.modules_enabled && company.modules_enabled.includes('payroll')`
- Super admins: show all companies (they manage all modules)

**Dependencies**: `modules_enabled` array already returned from `/api/auth/login` and
`/api/auth/select-company` — no backend change needed.

**Note**: This is a Paytime-local fix. The ecosystem dashboard should handle its own filtering
separately.

---

### PT-03 — Company Details Shared Across All Apps
**Status**: 🔴 Not Started — Architecture Decision Required
**Priority**: Launch Critical (data correctness)
**Description**:
Company details (name, registration number, address, logo, etc.) must not be app-specific copies
that can drift apart. If updated in Ecosystem/ECO, it must reflect in Paytime, POS, etc.

**Why it matters**: Company name already caused bugs (blank names in carousel, different names
in different apps). Payslips with wrong company name are legally invalid in SA.

**Where it belongs**: 🔵 Ecosystem-level shared data — NOT a Paytime-local fix.

**Correct implementation**:
- Company master data lives in the `companies` table in Supabase (it already does)
- All apps must read from the same source — no local copies
- Paytime `company-details.html` should READ from `/api/companies/:id` and WRITE back to the
  same endpoint, not store a local copy in KV

**Current state**: Need to audit `company-details.html` to confirm whether it reads from API
or local KV.

**Affected files**:
- `accounting-ecosystem/frontend-payroll/company-details.html`
- Ecosystem company settings page (separate audit needed)

**Needs Confirmation**: ⬛ Can Paytime users edit company details, or is that ecosystem-admin only?

---

### PT-04 — Dashboard / Company Card Alignment UI Fix
**Status**: 🔴 Not Started (safe to start now)
**Priority**: Launch Critical (first impression / launch readiness)
**Description**:
The company selection dashboard layout has alignment issues. Cards vary in height due to
different content lengths and don't align cleanly into rows. The "Add Company" card is not
consistent in height with the other cards.

**Why it matters**: This is the first screen users see. Misaligned cards look broken.

**Fix approach**:
- Make all `.company-card` elements equal height within each row using CSS grid `align-items: stretch`
- Add `min-height` to cards so short-content cards match tall ones
- Pin the Select Company button to the card bottom with flexbox column + `margin-top: auto`
- Fix the container `max-width` and padding so cards don't stretch too wide on large screens

**Affected files**:
- `accounting-ecosystem/frontend-payroll/company-selection.html` — CSS only

---

## SECTION 2 — High Priority 🟠

---

### PT-05 — Sean Insights: Only Show When Activated for That Client + Module
**Status**: 🟠 Not Started
**Priority**: High
**Description**:
Sean Insights is an add-on. The SEAN Insights tab/button in Paytime must only be visible if
Sean is activated for that specific company under the payroll module from the superuser control
panel.

If Sean is not activated: the tab must be hidden, the button must not render.

**Why it matters**: Showing an add-on to users who haven't purchased it is a commercial and UX
problem.

**Implementation**:
- Check `company.modules_enabled` (or a dedicated `addons_enabled` field) for a `'sean_payroll'`
  or `'sean'` key
- Gate the SEAN tab in `payruns.html` behind this check
- This check must run after `selectCompany()` so the company context is available

**Where it belongs**: Paytime-local UI gating, but the activation flag itself must come from
the ecosystem/admin level.

**Affected files**:
- `accounting-ecosystem/frontend-payroll/payruns.html` — hide/show SEAN tab
- Admin/superuser control panel — add Sean activation toggle per company+module (separate work)

**Needs Confirmation**: ⬛ Is the activation flag stored as part of `modules_enabled` array, or
as a separate `addons_enabled` / `features` field? Backend schema check needed.

---

### PT-06 — Sean Background Learning (Cross-App)
**Status**: 🟠 Not Started — Architecture Planning Required
**Priority**: High (architecture must be defined before Sean features are extended)
**Description**:
Sean has two distinct parts:
1. **User-facing Sean Insights add-on**: visible only when activated (see PT-05)
2. **Background learning model**: learns from activity across ALL apps, even when the
   user-facing add-on is not visible

The background learning must continue regardless of whether the client has purchased the
Sean Insights add-on. It is an ecosystem-wide service.

**Why it matters**: If background learning is only enabled when the add-on is active, Sean
will have no data to learn from for that client, making the add-on valueless when they
eventually activate it.

**Where it belongs**: 🔵 Ecosystem-level shared service — NOT Paytime-only.

**Needs Confirmation**:
⬛ Where does Sean learning data get sent? Is there a `/api/sean/event` endpoint?
⬛ What events should be logged? (payroll runs, employee additions, period changes, etc.)
⬛ Is this already partially implemented in `sean-helper.js`?

---

### PT-07 — Standard Payroll Items Must Be Editable
**Status**: 🟠 Not Started
**Priority**: High
**Description**:
Standard/system payroll items must be editable by the business owner / accountant.
Currently the edit flow exists (`editItem()` in `payroll-items.html`) but it needs to be
confirmed that system/built-in items are not locked from editing.

**Why it matters**: Every business has unique naming, amounts, and IRP5 code assignments
for standard items like Basic Salary, Travel Allowance, etc.

**Affected files**:
- `accounting-ecosystem/frontend-payroll/payroll-items.html`

**Action needed**: Confirm whether `is_standard` or similar flag prevents editing.
If so, remove that restriction or make it configurable.

---

### PT-08 — IRP5 Code Required on Payroll Items + Optional Description
**Status**: 🟠 Not Started (UI already partially exists)
**Priority**: High
**Description**:
Every payroll item must carry an IRP5 code. The description is optional but supported.

**Current state**:
- `irp5_code` field exists in the add/edit modal (`payroll-items.html` line 702)
- IRP5 badge displayed on item cards
- BUT: IRP5 code is currently optional (no validation that it's present)

**What needs to change**:
1. Make IRP5 code **required** in the add/edit form — block save if missing
2. Show a clear label: "IRP5 Code (required)" vs "Description (optional)"
3. Add inline help: link to SARS IRP5 code reference table, or show common codes

**Affected files**:
- `accounting-ecosystem/frontend-payroll/payroll-items.html` — form validation + labels

---

### PT-09 — Sean Assist for IRP5 Item Mapping
**Status**: 🟠 Not Started — Depends on PT-05 (Sean activation) and PT-08 (IRP5 required)
**Priority**: High (but blocked by dependencies)
**Description**:
When Sean is active, the add/edit payroll item form gets a "Ask Sean" button:
- User describes what the item is in plain text
- Sean suggests the best matching IRP5 code and category

**Implementation note**: This must respect the Sean activation rule (PT-05) — the button
must not show if Sean is not active for this company.

**Affected files**:
- `accounting-ecosystem/frontend-payroll/payroll-items.html`
- `accounting-ecosystem/frontend-payroll/js/sean-helper.js`

**Dependencies**: PT-05 (Sean activation), PT-08 (IRP5 code field)

---

### PT-10 — Reports Export to PDF and Excel
**Status**: 🟠 Not Started
**Priority**: High
**Description**:
All reports in `reports.html` must be exportable to:
- PDF (jsPDF — already used for payslips)
- Excel/CSV (export to `.xlsx`)

**Affected files**:
- `accounting-ecosystem/frontend-payroll/reports.html`

**Dependencies**: jsPDF already included. SheetJS (`xlsx`) may need to be added.

---

## SECTION 3 — Medium Priority / Architecture 🟡🔵

---

### PT-11 — Historic Import: Add Employee if Not on System
**Status**: 🟡 Not Started
**Priority**: Medium
**Description**:
If a historic payslip import includes an employee whose ID/name is not found in
`employees_{companyId}`, the import must:
1. Flag the unrecognised employee
2. Give the user an option to create the employee on the fly during the import
3. Never silently skip or fail the import because of unrecognised employees

**Affected files**:
- `accounting-ecosystem/frontend-payroll/historical-import.html`

---

### PT-12 — Historic Import: Read Full Payslip, Not Just Gross
**Status**: 🟡 Not Started
**Priority**: Medium
**Description**:
The current import maps a `gross` column plus optional `deduction_*` columns.
A full historic payslip import must read:
- All income/allowance/benefit line items
- All deduction line items
- PAYE, UIF, SDL individually
- Employee details (position, ID number, bank details if available)
- Net pay

This allows the system to match imported items to existing payroll items and create
new items where needed.

**Affected files**:
- `accounting-ecosystem/frontend-payroll/historical-import.html`

---

### PT-13 — Historic Import: One Month at a Time, Large Batch Support
**Status**: 🟡 Not Started
**Priority**: Medium
**Description**:
- One import run = one payroll period (month) only
- Must support large monthly batches (5000+ payslips per month)
- UI must enforce single-period selection before upload
- Progress bar and chunked processing already exist (partial implementation)

**Affected files**:
- `accounting-ecosystem/frontend-payroll/historical-import.html`

**Needs Confirmation**: ⬛ Is there a current hard limit on file size / row count?

---

## SECTION 4 — Needs More Information ⬛

---

### PT-14 — Sean Background Learning Architecture
**Status**: ⬛ Needs Confirmation
See PT-06. Full architecture definition required before implementation.

Questions to resolve:
1. Where is Sean learning data persisted? (Supabase table? External ML service?)
2. What is the event schema?
3. Is there already a `sean_events` or similar table in the backend?
4. Who owns Sean's model — is it per-company, per-ecosystem, or global?

---

### PT-15 — Superuser Control Panel: Sean Activation Per Company+Module
**Status**: ⬛ Needs Confirmation
The superuser panel must have a toggle: "Enable Sean Insights for [company] — Payroll module".
This is referenced by PT-05 but the actual superuser UI is a separate app/feature.

Questions to resolve:
1. Where is the superuser control panel? (Admin Dashboard, Ecosystem admin tab?)
2. Does `modules_enabled` already support add-on flags, or do we need a new `addons` field?

---

## Implementation Order

Work through in this sequence, adjusting if user identifies new blockers:

```
Priority 1 (Start now — safe, no dependencies):
  PT-04  Dashboard card alignment (CSS only)
  PT-02  Filter company selection to payroll-active companies
  PT-08  Make IRP5 code required in payroll items form

Priority 2 (Core logic — start after Priority 1):
  PT-01  PAYE YTD cumulative calculation
  PT-07  Standard payroll items editable
  PT-05  Sean activation gate

Priority 3 (Depends on Priority 2):
  PT-09  Sean Assist for IRP5 (needs PT-05 + PT-08)
  PT-10  Reports PDF + Excel export
  PT-03  Company details shared data (needs architecture decision)

Priority 4 (Medium — once core is solid):
  PT-11  Historic import: unrecognised employees
  PT-12  Historic import: full payslip read
  PT-13  Historic import: large batch + one-month rule

Architecture/Confirmation needed:
  PT-06  Sean background learning
  PT-14  Sean architecture
  PT-15  Superuser Sean activation control
```

---

## Regression Safety

Before touching any file, check `WORKING_FEATURES_REGISTRY.md` for that file.
Confirmed working features that must not be broken:

| Feature | Files at risk |
|---------|--------------|
| Employee detail loads on both browsers | `employee-detail.html`, `js/auth.js` |
| Basic salary edit works | `employee-detail.html` |
| Calculate payslip works | `employee-detail.html`, `js/payroll-engine.js` |
| PDF download works | `employee-detail.html` |
| Pay run works | `payruns.html` |
| Finalize payslip works | `employee-detail.html`, `js/auth.js`, `js/permissions.js` |
| Session role persists after company select | `js/auth.js` `selectCompany()` |
| SSO routing | `js/auth.js` |
| Switch company carousel names | `js/auth.js`, all 9 HTML pages |
