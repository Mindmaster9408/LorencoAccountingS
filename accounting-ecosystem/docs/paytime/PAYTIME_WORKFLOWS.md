# Paytime — Workflows

> Last updated: 2026-04-29  
> This document describes the end-to-end operational workflows for running Paytime payroll.

---

## 1. Initial Company Setup

Before any payroll can be run, a company must be set up.

### Steps

1. **Company is created in the ecosystem** (by a super-admin or account admin)
2. **Navigate to Company Details (`company-details.html`)**
   - Enter PAYE reference number
   - Enter UIF reference number
   - Enter SDL reference number (if applicable)
   - Set SDL registered: Yes/No
   - Set UIF registered: Yes/No
   - Set pay frequency (Monthly recommended)
   - Set company bank details for EFT payment files
3. **Configure payroll items (`payroll-items.html`)**
   - Create the earnings and deduction items the company uses (commission, overtime bonus, medical aid deduction, etc.)
   - Assign IRP5 codes to each item
   - Set tax treatment (pre-tax vs net-only) per item

### Tax Tables (Infinite Legacy super-admin only)

Tax tables are managed centrally for all companies by Infinite Legacy. Individual companies do not configure tax brackets. If the current year's SARS tables have changed from the engine defaults:

1. Super-admin navigates to Payroll Items → Tax Configuration
2. Enters the new brackets, rebates, and levy rates
3. Saves — applies to all companies immediately via the `__global__` KV store key

---

## 2. Adding a New Employee

1. **Navigate to Employees (`employee-management.html`)**
2. **Click Add Employee**
   - Enter: first name, last name, employee number, ID or passport number, tax number (required)
   - Enter: hire date (`date_appointed`)
   - Enter: job title, payment method (EFT/cash/cheque)
3. **Save** — creates the employee record in the `employees` table
4. **Navigate to Employee Detail (`employee-detail.html`)** for the new employee
5. **Set payroll details:**
   - Basic salary
   - Medical aid members (count)
   - Tax directive (if applicable — fixed SARS-issued rate)
6. **Set bank details:**
   - Bank name, account holder, account number, branch code
7. **Save** — writes all payroll detail and bank info to the `employees` table and `employee_bank_details` table
8. **Assign recurring payroll items:**
   - If the employee has a recurring commission, allowance, or deduction, assign the relevant payroll items from the company's payroll items list
9. **(Optional) Set custom work schedule:**
   - If the employee doesn't work standard Mon–Fri 8h, configure their work schedule

### Important Notes

- All of the above saves go to SQL tables via API endpoints — not to localStorage
- After April 2026, `basic_salary`, `medical_aid_members`, `tax_directive`, `job_title`, `payment_method`, and bank fields are all columns on the `employees` table
- Existing employees in production before the April 2026 deploy may have null values for these new columns until their records are saved again via employee-detail.html

---

## 3. Running Monthly Payroll

### Prerequisites

- Company is set up (payroll settings, SDL/UIF flags configured)
- Employees are set up with basic salary filled in
- Payroll items assigned as needed
- Tax tables are current (Infinite Legacy admin)

### Steps

1. **Navigate to Run Payroll (`payroll-execution.html`)**
2. **Select the period** (e.g., `2026-04` for April 2026)
   - The period record is auto-created if it doesn't exist
3. **Select employees to include**
   - Can select all or individual employees
4. **(Optional) Enter pro-rata dates**
   - If any employee joined or left mid-period, enter their `start_date` and/or `end_date`
   - The engine will pro-rate their basic salary automatically
5. **Click Run Payroll**
   - `POST /api/payroll/run` is called
   - For each selected employee:
     - `PayrollDataService.fetchCalculationInputs()` assembles inputs from DB
     - `PayrollCalculationService.calculate()` runs the engine
     - A draft snapshot is created/replaced in `payroll_snapshots`
   - Results are displayed: processed employees and any errors
6. **Review results**
   - Check gross, PAYE, UIF, SDL, and net for each employee
   - If any values look wrong, check employee setup (salary, tax directive, medical members)
7. **Re-run if needed**
   - Re-running replaces draft snapshots
   - Finalized snapshots are protected — they cannot be replaced
8. **Finalize the period**
   - Once satisfied with all results, click Finalize
   - `POST /api/payroll/finalize` locks all draft snapshots for the period
   - Finalized snapshots cannot be changed or replaced

### What If an Employee Was Missed?

If a finalized snapshot exists for the period and an employee was missed:
- The only safe option is to create a correction run for that employee
- The correction workflow is not yet built (see PAYTIME_ROADMAP.md)
- Current workaround: contact Infinite Legacy admin to unlock the snapshot (via `/api/payroll/unlock`), re-run for the missed employee, re-finalize

---

## 4. Generating and Distributing Payslips

1. **Navigate to Pay Runs (`payruns.html`)** or **Employee Detail (`employee-detail.html`)**
2. **Find the relevant period** and employee
3. **Click Generate Payslip** — triggers client-side PDF generation via `js/pdf-branding.js`
4. **The PDF includes:**
   - Company name, logo, and branding
   - Employee name, employee number, ID number
   - Period (e.g., April 2026)
   - Gross earnings breakdown (basic, overtime, allowances)
   - Deductions (PAYE, UIF, medical aid, etc.)
   - Net pay
   - Tax year reference
5. **Distribute** the PDF to the employee (download, email, print)

**Note:** Payslip values are taken from the snapshot's `calculation_output`. They are not recalculated at generation time.

---

## 5. PAYE Reconciliation

### Purpose

At the end of each tax year (and periodically during the year), accountants need to reconcile:
- Total PAYE paid to SARS vs calculated PAYE per employee per period
- Total UIF paid vs calculated UIF
- Total SDL paid vs calculated SDL

### Steps

1. **Navigate to PAYE Reconciliation (`paye-reconciliation.html`)**
2. **Select the tax year** (dropdown auto-populated from available data)
3. **View the reconciliation summary** — per period and per employee:
   - PAYE, UIF, SDL totals
   - Each period's breakdown
4. **Compare with SARS payments** — user can enter the amounts actually submitted to SARS for comparison
5. **Use the EMP501 view** for annual per-employee aggregates with IRP5 code breakdowns

### Data Sources

The recon page merges two data sources:
- `payroll_transactions` — from finalized live payroll runs
- `payroll_historical` — from CSV imports of prior period data

**Known gap:** Historical imports via `historical-import.html` currently write to localStorage/KV, not the `payroll_historical` table. The recon page falls back to `ReconService.buildPayrollTotals()` to handle this, but the data is only available in the browser session it was imported in.

---

## 6. Adding Period-Specific Items

Some items are not recurring — they apply to one pay period only (e.g., a once-off bonus, a specific deduction).

1. These are entered as one-off items for the period via `payroll_period_inputs`
2. Overtime is entered via the overtime entry form (writes to `payroll_overtime`)
3. Short-time is entered via the short-time form (writes to `payroll_short_time`)
4. These are automatically fetched by `PayrollDataService` when the payroll run is executed

The exact UI flow for entering period-specific items and overtime is within `payroll-execution.html` and/or `employee-detail.html`.

---

## 7. Net-to-Gross Calculation

When an employer wants to guarantee a specific take-home pay:

1. **Navigate to Net-to-Gross (`net-to-gross.html`)**
2. **Enter the target net pay** (e.g., R20,000)
3. **Configure the employee options** (age, medical members, deductions, etc.)
4. **Calculate** — the engine uses binary search to find the basic salary that produces the target net within R0.01
5. **Result:** Required basic salary to guarantee the target net, plus the full payslip breakdown

This is a planning tool only. The result does not get saved to any employee record automatically. The accountant must manually update the employee's basic salary based on the result.

---

## 8. Historical Data Import

For companies that start using Paytime mid-year (e.g., joining in September) and need to include prior months for EMP501 reconciliation:

1. **Navigate to Historical Import (`historical-import.html`)**
2. **Download the import template CSV**
3. **Fill in the historical payroll data** (per employee, per period — gross, PAYE, UIF, SDL, net)
4. **Upload and validate** — the page validates format and data types
5. **Commit the import** — currently writes to localStorage/KV (see known gap above)

**Known issue:** Historical data imported via this page is NOT written to the `payroll_historical` SQL table. It goes to the KV store. The PAYE recon backend cannot see it through the API — the recon page falls back to a localStorage-based aggregation instead. Data will be lost if browser storage is cleared.

---

## 9. Key Field Aliases to Know

Frontend code uses `date_appointed` — the database column is `hire_date`. The backend maps between them on every API call. You do not need to handle this manually in new code, but be aware of it when reading raw database records.

---

## Related Documents

- [PAYTIME_CAPABILITIES.md](PAYTIME_CAPABILITIES.md) — Full feature status matrix
- [PAYTIME_CALCULATION_AND_TAX.md](PAYTIME_CALCULATION_AND_TAX.md) — Engine internals
- [PAYTIME_SNAPSHOTS_AND_HISTORY.md](PAYTIME_SNAPSHOTS_AND_HISTORY.md) — Snapshot lifecycle
- [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md) — Known gaps and protected areas
