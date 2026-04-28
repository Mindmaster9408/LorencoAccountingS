# SESSION HANDOFF — Employee Detail Save Persistence Fix
**Date:** 2026-04-24  
**Area:** Paytime → Employee Detail → Save/Load Persistence

---

## ROOT CAUSE IDENTIFIED AND FIXED

### Root Cause
`saveEmployeeInfo()` in `frontend-payroll/employee-detail.html` was writing to `safeLocalStorage` (KV store), **never updating the employees SQL table**. Since `loadEmployee()` always re-fetches from the SQL table, every save was immediately overwritten on next page load.

Only `hire_date` + `termination_date` were sent to the backend (via a fire-and-forget call to `/api/payroll/employees/:id/employment-dates`). All other fields — first_name, last_name, email, phone, id_number, tax_number, department, position, job_title, payment_method, medical_aid_members, tax_directive, bank_name, account_holder, account_number, branch_code — were never persisted to any backend table.

---

## CHANGES MADE

### 1. `backend/config/payroll-schema.js` — Added missing columns
Added idempotent (`IF NOT EXISTS`) ALTER TABLE to add these columns to the `employees` table at server startup:
- `basic_salary DECIMAL(12,2) DEFAULT 0` — PayrollDataService already reads this
- `medical_aid_members INTEGER DEFAULT 0` — SARS medical credit calculation
- `tax_directive DECIMAL(10,4) DEFAULT 0` — fixed SARS tax directive override
- `payment_method VARCHAR(50) DEFAULT 'EFT'` — EFT/Cash (controls bank section)
- `job_title VARCHAR(100)` — display job title (separate from `position`)
- `bank_name VARCHAR(100)` — employee bank name
- `account_holder VARCHAR(255)` — account holder name
- `account_number VARCHAR(50)` — bank account number
- `branch_code VARCHAR(50)` — bank branch code

### 2. `backend/shared/routes/employees.js` — Extended PUT and GET
**PUT `/:id`:**
- Added to `allowed` list: `job_title`, `payment_method`, `medical_aid_members`, `tax_directive`, `basic_salary`, `bank_name`, `account_holder`, `account_number`, `branch_code`
- Added `date_appointed → hire_date` mapping (frontend uses `date_appointed`, DB uses `hire_date`)

**GET `/` and `/:id`:**
- Added `date_appointed: emp.hire_date || emp.date_appointed || null` alias in response mapping so frontend receives the field name it expects

### 3. `backend/modules/payroll/routes/employees.js` — bank-details PUT
**PUT `/:id/bank-details`:**
- Added `account_holder` to the destructuring and upsert payload
- Added mirror update to `employees` table columns (`bank_name`, `account_holder`, `account_number`, `branch_code`) so `GET /api/employees` returns bank data without requiring a join

### 4. `frontend-payroll/employee-detail.html` — `saveEmployeeInfo()` rewritten
- Made `async`
- **Removed** the `safeLocalStorage.setItem('employees_' + currentCompanyId, ...)` write
- **Removed** the fire-and-forget `/employment-dates` call (hire_date is now included in the main PUT)
- **Added** `PUT /api/employees/:id` call with ALL fields (core + payroll-detail + bank)
- **Added** secondary `PUT /api/payroll/employees/:id/bank-details` call for `employee_bank_details` table (used by payslip PDF generation)
- Now shows a real error alert if the backend save fails (instead of false success)
- `loadEmployee()` after save now re-fetches from the correctly updated SQL table

---

## WHAT WAS NOT CHANGED

- `calculatePayslip()` — untouched, still fully backend-authoritative
- Classification / ETI / work-schedule saves — untouched, already correct
- Leave management — untouched
- Pay schedule assignment — untouched
- `saveBasicSalary()` / `savePayrollData()` / `saveRegularInput()` etc. — these still use safeLocalStorage (KV store) which is cloud-backed via polyfills.js. This is a separate concern to address in a future session.
- The `employee_bank_details` table — not dropped, still in use (payslip PDF reads from it)

---

## TESTING REQUIRED

1. Open an employee in Paytime → Edit Info tab → click Edit Employee
2. Change any field (name, email, tax_number, bank name, medical members, etc.)
3. Save → confirm "Employee information saved!" alert appears (not an error alert)
4. **Refresh the page** → confirm all changed fields are still visible
5. Open a different browser / incognito window → confirm changes persist
6. Run a payslip calculation for the employee → confirm `medical_aid_members` and `tax_directive` are used correctly in the tax calculation
7. Confirm that employees with no valid integer ID (old `emp-` format) get the appropriate error message

---

## FOLLOW-UP NOTE

```
FOLLOW-UP NOTE
- Area: Payroll data persistence (basic_salary, recurring inputs, overtime, etc.)
- Dependency: safeLocalStorage → KV store path still in use for payroll-specific data
- What was done now: Employee personal info (name, contact, tax, bank) fixed to save to SQL table
- What still needs checking: basic_salary, regular_inputs, current_inputs, overtime, short-time,
  multi-rate — these still use safeLocalStorage/KV store for save. They're cloud-backed via
  polyfills.js KV store but not the canonical SQL tables. See PayrollDataService KV fallback.
- Risk if not checked: Basic salary set in the UI may not update the employees.basic_salary
  column correctly (the saveBasicSalary() function writes to KV but not to /api/payroll/employees/:id/salary)
- Recommended next review: Audit saveBasicSalary() and savePayrollData() to ensure basic_salary
  is persisted to employees table (or employee_payroll_setup) via REST endpoint, not just KV store.
```
