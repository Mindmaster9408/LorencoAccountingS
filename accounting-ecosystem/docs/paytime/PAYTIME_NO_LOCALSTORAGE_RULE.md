# Paytime — No Business Data in localStorage (Hard Rule)

> Last updated: 2026-04-29  
> Audited from source: `frontend-payroll/js/polyfills.js`, `PayrollDataService.js`, `SESSION_HANDOFF_2026-04-23-zero-localstorage-audit.md`

---

## 1. The Rule

**Business data must never be stored only in localStorage.**

This is a hard, non-negotiable rule that applies to all Paytime pages and all future Paytime development.

"Business data" means anything that:
- Belongs to an employee record (name, salary, bank details, tax number, ID number)
- Is part of a payroll calculation (inputs, outputs, snapshots)
- Is a payroll item (earnings, deductions, IRP5 codes)
- Is used for compliance reporting (PAYE, UIF, SDL totals, reconciliation data)
- Must survive a browser reset or a different browser session

---

## 2. Why the Rule Exists

**localStorage is browser-local, ephemeral storage.** It is:
- Lost when the user clears browser storage
- Not accessible from a different browser or device
- Not backed up
- Not auditable
- Not shareable between users

Paytime handles compliance-critical payroll data for South African employers. If an employee's salary is only in localStorage and the browser storage is cleared, that data is gone. If a finalized payslip's values are derived from localStorage-only calculations, they cannot be reproduced in an audit.

The original architecture of Paytime stored large amounts of business data in localStorage. That architecture was progressively migrated to the database. The migration is incomplete as of 2026 (see PAYTIME_RISKS_AND_PROTECTED_AREAS.md), but the rule is absolute for all new development.

---

## 3. How the Polyfill Works

`frontend-payroll/js/polyfills.js` monkey-patches the browser's `localStorage` API:

```javascript
Storage.prototype.setItem = function(key, value) { ... };
Storage.prototype.getItem = function(key) { ... };
Storage.prototype.removeItem = function(key) { ... };
```

When any code calls `localStorage.setItem(key, value)`:

1. The polyfill checks if `key` is in the **native whitelist** (stays in real localStorage)
2. The polyfill checks if `key` starts with a **local prefix** (stays in real localStorage)
3. Everything else is routed to `POST /api/payroll/kv` → stored in `payroll_kv_store_eco` table in Supabase

This means `safeLocalStorage.setItem('someKey', data)` is NOT writing to the browser — it is writing to the cloud database.

---

## 4. Whitelist — What Stays Native

**Keys that remain in real browser localStorage:**

| Key | Purpose |
|---|---|
| `token` | JWT authentication token |
| `session` | Session data |
| `user` | User profile |
| `activeCompanyId` | Currently selected company |
| `selectedCompanyId` | Selected company (alternate key) |
| `company` | Company data |
| `demoMode` | Demo mode flag |
| `eco_token` | ECO system auth token |
| `eco_user` | ECO user profile |
| `eco_companies` | ECO company list |

**Key prefixes that remain in real browser localStorage:**

| Prefix | Purpose |
|---|---|
| `cache_` | Client-side cache entries |
| `theme` | UI theme preference |
| `darkMode` | Dark mode toggle |
| `sidebar` | Sidebar collapse state |

Everything else that goes through `localStorage.setItem` is cloud-backed.

---

## 5. The Critical Distinction — Cloud KV Is Not SQL Storage

Even though `safeLocalStorage` routes data to Supabase, the KV store (`payroll_kv_store_eco`) is still NOT the correct storage for business data.

**KV store drawbacks for business data:**
- Not queryable by field (values are stored as JSON blobs, not columns)
- Cannot be joined with other tables
- Cannot be aggregated (no SQL SUM, GROUP BY)
- Keys are arbitrary strings — no schema enforcement
- No foreign key relationships
- Harder to audit and impossible to validate

**Employee records, payroll calculations, and compliance data must live in proper relational tables** (`employees`, `payroll_snapshots`, `payroll_transactions`, etc.).

Use the KV store ONLY for:
- Non-relational configuration (tax config override)
- Operational state that doesn't need to be queried (audit log buffer, feature flags)
- UI preferences (though these could also stay native)

---

## 6. The Employee Save Bug (Root Cause Reference — April 2026)

The clearest example of why this rule is critical:

When an employee's payroll details were saved on `employee-detail.html`, the old code called:
```javascript
safeLocalStorage.setItem('employees_' + currentCompanyId, updatedEmployees);
```

This wrote the employee list to the KV store (`payroll_kv_store_eco`), NOT to the `employees` SQL table. The result:
- The update appeared to save (no error shown)
- The employee list in the KV store was updated
- The `employees` table in the database was NOT updated
- On next page load, the data loaded from the `employees` table (the API), not the KV store
- All changes were lost

**Fix applied (commit 3e15dc0, April 2026):** `saveEmployeeInfo()` was rewritten to call `PUT /api/employees/:empId` with all fields, writing directly to the `employees` table. The KV store write was removed.

This bug pattern — writing to KV instead of to the SQL table — must never recur.

---

## 7. Rules for Writing New Paytime Code

When writing any new code that saves data in Paytime:

**Before writing data:**
1. Ask: Is this business data? If yes → it goes to a SQL table via an API endpoint.
2. Ask: Does this need to survive a browser reset? If yes → SQL table, not KV.
3. Ask: Does this need to be queried, aggregated, or joined? If yes → SQL table, not KV.
4. Ask: Will this be displayed on a payslip or compliance report? If yes → SQL table ONLY.

**If you need a new place to store data:**
1. Check if an appropriate SQL table already exists
2. If not, add columns to an existing table or create a new table via `backend/config/payroll-schema.js`
3. Create API endpoints to read/write from those tables
4. Call those endpoints from the frontend — do NOT call `localStorage.setItem` directly

**Never do this:**
```javascript
// WRONG — even though polyfills.js will route this to Supabase KV, not a SQL table
localStorage.setItem('employee_salary_' + empId, salary);
safeLocalStorage.setItem('payroll_result_' + periodKey, result);
```

**Do this instead:**
```javascript
// CORRECT — writes to a SQL table via the API
await fetch('/api/employees/' + empId, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ basic_salary: salary })
});
```

---

## 8. Pages with Known Remaining localStorage Dependency (As of April 2026)

The following areas still rely on localStorage for data that ideally should be in SQL. These are documented in PAYTIME_RISKS_AND_PROTECTED_AREAS.md.

| Area | Status |
|---|---|
| Historical import (`historical-import.html`) | Writes imported records to localStorage/KV, not `payroll_historical` table |
| Reports (`reports.html`) | Reads all report data from localStorage |
| PAYE recon SARS comparison values | User-entered comparison values stored in localStorage |
| Voluntary tax over-deduction config | Frontend path exists; persistence unclear |

These are known technical debt items. They do not break the application today because fallback paths exist, but they represent data loss risk if localStorage is cleared.

---

## 9. Detecting Violations

If you encounter a `safeLocalStorage.setItem` or `localStorage.setItem` call that is:
- Storing data with a key that looks like `employee_`, `payroll_`, `emp_`, `period_`, `snapshot_`, or any other business-data pattern
- NOT in the whitelist above

That is a violation of this rule. It must be fixed by:
1. Identifying the corresponding SQL table
2. Creating or using an existing API endpoint
3. Replacing the localStorage write with an API call
4. Removing the localStorage write

---

## Related Documents

- [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md) — KV store table, legitimate KV uses
- [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md) — Known remaining localStorage areas
- `accounting-ecosystem/docs/data-integrity-no-localstorage.md` — Original data integrity audit doc
