# Paytime — Architecture Reference

> Last updated: 2026-04-29  
> Audited from source. All statements here are derived from actual code, not guesses.

---

## 1. What This Document Covers

The internal technical architecture of Paytime: how requests flow, what owns what, how state is managed, and what the non-negotiable structural rules are. Future developers must read this before making any backend or frontend structural changes.

---

## 2. System Overview

Paytime is one application in the Lorenco multi-app ecosystem. It is NOT a standalone product. It shares the same:

- **Backend server** — `accounting-ecosystem/backend/server.js` (Express.js, Node.js)
- **Database** — PostgreSQL via Supabase (single shared instance, multi-tenant by `company_id`)
- **Auth layer** — JWT tokens, same auth middleware as all other apps
- **Infrastructure** — Zeabur Docker deployment, single service

Frontend code lives in `accounting-ecosystem/frontend-payroll/`. Backend payroll code lives in `accounting-ecosystem/backend/modules/payroll/`. The core engine lives in `accounting-ecosystem/backend/core/payroll-engine.js`.

---

## 3. Directory Map

```
accounting-ecosystem/
├── backend/
│   ├── core/
│   │   └── payroll-engine.js          ← Pure calculation engine (sole PAYE/UIF/SDL authority)
│   ├── modules/
│   │   └── payroll/
│   │       ├── routes/
│   │       │   ├── calculate.js       ← POST /api/payroll/calculate
│   │       │   ├── payruns.js         ← POST /api/payroll/run, /finalize, GET /history
│   │       │   ├── employees.js       ← Payroll-specific employee endpoints (bank-details, etc.)
│   │       │   ├── items.js           ← Payroll items CRUD
│   │       │   ├── kv.js              ← KV store proxy (GET/SET key-value pairs)
│   │       │   ├── recon.js           ← GET /api/payroll/recon/*
│   │       │   ├── transactions.js    ← Period inputs, overtime, short-time
│   │       │   ├── periods.js         ← Payroll period management
│   │       │   ├── pay-schedules.js   ← Pay schedule configuration
│   │       │   ├── attendance.js      ← Leave and attendance
│   │       │   ├── unlock.js          ← Admin snapshot unlock
│   │       │   └── sean-integration.js ← Sean AI IRP5 learning
│   │       └── services/
│   │           ├── PayrollCalculationService.js  ← Orchestrates engine calls
│   │           ├── PayrollDataService.js         ← Fetches/normalizes DB inputs
│   │           ├── PayrollHistoryService.js      ← Snapshot preparation
│   │           └── paytimeAccess.js              ← Employee visibility scoping
│   ├── shared/
│   │   └── routes/
│   │       └── employees.js           ← Shared employee CRUD (used by all apps)
│   └── config/
│       └── payroll-schema.js          ← Auto-migration: CREATE/ALTER TABLE on server startup
│
└── frontend-payroll/
    ├── *.html                         ← 17 HTML pages (see PAYTIME_CAPABILITIES.md)
    └── js/
        ├── payroll-engine.js          ← Client-side mirror of engine (PREVIEW ONLY — not authoritative)
        ├── polyfills.js               ← localStorage interceptor — routes to KV store
        ├── data-access.js             ← DataAccess class — API client helpers
        ├── payroll-api.js             ← PayrollAPI class — run/finalize/history endpoints
        ├── recon-service.js           ← PAYE recon aggregation service
        ├── auth.js                    ← JWT session management
        ├── permissions.js             ← Client-side role/permission mirror
        ├── sidebar.js                 ← Shared sidebar injection
        └── ...                        ← other utility JS files
```

---

## 4. Request Flow — Payroll Calculation

This is the canonical flow. It must not be bypassed.

```
Browser (payroll-execution.html)
  │
  │  POST /api/payroll/run
  │  Body: { period_key, employee_ids, start_date?, end_date? }
  │  Headers: Authorization: Bearer <jwt>, x-company-id: <id>
  ▼
backend/modules/payroll/routes/payruns.js
  │  Validates JWT, extracts companyId from token + x-company-id header
  │  Validates employee_ids are integers, max 200
  │  Checks paytimeAccess employee visibility scope
  │
  ▼
PayrollDataService.fetchCalculationInputs(companyId, employeeId, periodKey, supabase)
  │  1. Fetches payroll_periods (auto-creates if absent)
  │  2. Fetches employees.* (SELECT *)
  │     - If basic_salary missing → fallback to KV store (legacy path, deprecated)
  │  3. Fetches employee_work_schedules (fallback: Mon-Fri 8h default)
  │  4. Fetches company_payroll_settings (fallback: SA 2026/2027 defaults)
  │  5. Fetches companies.sdl_registered + uif_registered flags
  │  6. Fetches employee_payroll_items (recurring items — always-on each period)
  │  7. Fetches payroll_period_inputs, payroll_overtime, payroll_short_time,
  │     payroll_multi_rate (period-specific one-off items)
  │  Returns: normalized input object
  │
  ▼
PayrollCalculationService.calculate(normalizedInputs, options)
  │  Fetches tax config from KV store (key: tax_config, company: __global__)
  │  Builds effective tax tables (merges override with engine defaults)
  │  Decides: pro-rata path (if start/end dates provided) or standard path
  │
  ▼
PayrollEngine.calculateFromData() OR PayrollEngine.calculateWithProRata()
  │  Pure function — no I/O, no DB, no state
  │  Returns: output object with 17 named fields (see ENGINE OUTPUT CONTRACT below)
  │
  ▼
PayrollHistoryService.prepareSnapshot(...)
  │  Packages full input + full output into snapshot structure
  │  status: 'draft', is_locked: false
  │
  ▼
INSERT INTO payroll_snapshots (upsert — replace draft if exists, skip if finalized)
  │
  ▼
Response: { success, run_id, processed[], errors[], totals, timestamp }
```

### Finalization flow

```
POST /api/payroll/finalize
  Body: { period_key }
  │
  ▼
payruns.js route
  │  Sets is_locked = true, status = 'finalized', finalized_by, finalized_at
  │  on ALL draft snapshots for the company/period
  │
  ▼
payroll_snapshots row is now IMMUTABLE
  No further updates allowed (enforced in application layer — see snapshot rules)
```

---

## 5. Multi-Tenancy Rules

Every query that touches payroll data MUST include `company_id` from the authenticated request. This is enforced in two places:

1. **JWT token** — `req.user.company_id` extracted by `authenticateToken` middleware
2. **`x-company-id` header** — required by `requireCompany` middleware; must match a company the user has access to

All Supabase queries in payroll routes include `.eq('company_id', companyId)`. There is NO implicit company context. Missing or mismatched company context = 400 error.

---

## 6. Authentication and Permissions

Auth middleware chain applied to all payroll routes:

```javascript
router.use(authenticateToken);   // Validates JWT, populates req.user
router.use(requireCompany);      // Validates x-company-id header, populates req.companyId
```

Per-route permission checks use `requirePermission('PAYROLL.XXX')`:

| Permission | Used for |
|---|---|
| `PAYROLL.VIEW` | Read-only access to payroll data |
| `PAYROLL.RUN` | Trigger payroll calculations |
| `PAYROLL.APPROVE` | Run payroll, trigger finalization |
| `PAYROLL.ADMIN` | Tax config, unlock, admin operations |

Employee visibility scoping (via `paytimeAccess.js`):
- Non-admin Paytime users can be restricted to see only specific employees
- `getEmployeeFilter(req)` returns a filter applied to all employee queries
- `requirePaytimeModule('payroll')` checks the user has Paytime access at all

---

## 7. Engine Authority Rule

**The backend `payroll-engine.js` is the sole authoritative source for PAYE, UIF, and SDL calculations.**

The file `frontend-payroll/js/payroll-engine.js` is a client-side mirror used ONLY for instant preview/UI feedback. It must never be used as a source of truth for:
- Stored payslip values
- Finalized calculations
- Compliance reporting
- Any value written to the database

Any discrepancy between frontend and backend engine results is considered a frontend display bug, not a calculation dispute. Backend wins.

---

## 8. Tax Configuration Override

The engine ships with hardcoded SA tax tables (`BRACKETS`, `PRIMARY_REBATE`, etc.). These are the fallback defaults.

The Infinite Legacy super-admin can override the current tax year's tables via the Tax Configuration panel in Payroll Items. The override is stored in:

```
Table: payroll_kv_store_eco
Key:   tax_config
company_id: (the __global__ company ID)
Value: {
  TAX_YEAR, BRACKETS, PRIMARY_REBATE, SECONDARY_REBATE, TERTIARY_REBATE,
  UIF_RATE, UIF_MONTHLY_CAP, SDL_RATE,
  MEDICAL_CREDIT_MAIN, MEDICAL_CREDIT_FIRST_DEP, MEDICAL_CREDIT_ADDITIONAL
}
```

`PayrollCalculationService.buildEffectiveTables()` merges the KV override with engine defaults field by field. Any missing field in the KV config falls back silently to the engine default. Infinity bracket max values are normalized back from null (JSON serialization converts Infinity → null).

Historical periods (e.g., calculating April 2023 in 2026) automatically use `HISTORICAL_TABLES` indexed by SA tax year. The override is for the CURRENT year only.

---

## 9. Database Schema — Key Tables

All tables are created/migrated by `backend/config/payroll-schema.js` on every server startup (idempotent `ALTER TABLE IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`).

| Table | Purpose |
|---|---|
| `employees` | Employee master records. Includes: `basic_salary`, `medical_aid_members`, `tax_directive`, `payment_method`, `job_title`, `bank_name`, `account_holder`, `account_number`, `branch_code` (added Apr 2026) |
| `employee_bank_details` | Dedicated bank details table. Written by `PUT /api/payroll/employees/:id/bank-details`. Mirrors key fields also exist on `employees` row. |
| `employee_work_schedules` | Per-employee schedule (days + hours). Fallback: Mon-Fri 8h. |
| `employee_payroll_items` | Recurring payroll items assigned to employee (commission, allowances, deductions). |
| `payroll_items` | Master payroll item definitions (name, IRP5 code, tax treatment). |
| `payroll_periods` | Pay period records (YYYY-MM). Auto-created from period_key if absent. |
| `payroll_period_inputs` | One-off period items entered for a specific pay run. |
| `payroll_overtime` | Overtime entries per employee per period. |
| `payroll_short_time` | Short-time deductions per employee per period. |
| `payroll_multi_rate` | Multi-rate hours per employee per period. |
| `payroll_snapshots` | Immutable payroll run results. Full input + full output stored per employee per period. |
| `payroll_transactions` | Transaction-level breakdown records (from finalized runs). |
| `payroll_kv_store_eco` | Cloud-backed key-value store. Used for: tax_config, employee payroll setup fallback, audit logs, feature flags, UI preferences. |
| `payroll_historical` | Imported historical payroll data (from CSV import, prior periods). |
| `leave_records` | Leave requests and records. |
| `leave_balances` | Per-employee annual leave balances. |
| `company_payroll_settings` | Company-level payroll settings (hourly divisor, defaults). |
| `companies` | Company master. Includes: `sdl_registered`, `uif_registered` flags. |

---

## 10. KV Store Usage

`payroll_kv_store_eco` is a cloud-backed key-value store proxied via `/api/payroll/kv`. It is used for non-relational configuration data and operational state.

**Legitimate KV uses:**
- `tax_config` — global tax table override (managed by super-admin)
- `audit_log_{companyId}` — rotating audit event buffer (not a substitute for a real audit table)
- `feature_flags` — UI feature toggles
- UI preferences (theme, sidebar state) — these are genuinely user-local

**Prohibited KV uses (see PAYTIME_NO_LOCALSTORAGE_RULE.md):**
- Employee master data (salary, bank details, payroll setup)
- Payroll calculation results
- Period inputs (overtime, deductions)
- Any data that must survive a browser reset or is needed for compliance

---

## 11. Field Name Aliases

Two field names differ between frontend convention and database schema:

| Frontend name | DB column | Notes |
|---|---|---|
| `date_appointed` | `hire_date` | Mapped in both GET (response alias) and PUT (allowed field mapping) in `shared/routes/employees.js` |
| `salary` (legacy) | `basic_salary` | `PayrollDataService` normalizes: if `basic_salary` is undefined, falls back to `salary` |

Do not break these aliases. Any direct DB query that returns `hire_date` must continue to alias it as `date_appointed` in the API response. Any frontend that sends `date_appointed` must be accepted by the PUT endpoint.

---

## 12. Auto-Migration on Startup

`backend/config/payroll-schema.js` runs on every server startup. It uses `IF NOT EXISTS` guards on all DDL. This means:

- Adding a new column to this file will apply it on next deploy without manual SQL
- It is safe to deploy multiple times — idempotent
- New columns added here have DEFAULT values so existing rows are not broken
- This is how `basic_salary`, `medical_aid_members`, `tax_directive`, `job_title`, `payment_method`, and bank detail columns were added (Apr 2026)

**Do not add destructive DDL (DROP, TRUNCATE) to this file.** It is for additive migrations only.

---

## 13. Deployment

See [CLAUDE.md](../../CLAUDE.md) Part C for the complete Zeabur deployment rules. Critical summary:

- Build context: `accounting-ecosystem/` directory
- Config: `accounting-ecosystem/Dockerfile` — must exist, must not be deleted
- `zbpack.json` must NEVER exist in `accounting-ecosystem/` — breaks Zeabur build
- `WORKDIR /app` in Dockerfile — required for frontend path resolution
- `CMD ["node", "backend/server.js"]`

---

## Related Documents

- [PAYTIME_CALCULATION_AND_TAX.md](PAYTIME_CALCULATION_AND_TAX.md) — Engine internals, tax tables, output contract
- [PAYTIME_SNAPSHOTS_AND_HISTORY.md](PAYTIME_SNAPSHOTS_AND_HISTORY.md) — Snapshot immutability and lifecycle
- [PAYTIME_NO_LOCALSTORAGE_RULE.md](PAYTIME_NO_LOCALSTORAGE_RULE.md) — Hard rule on data storage
- [PAYTIME_CAPABILITIES.md](PAYTIME_CAPABILITIES.md) — What is built vs planned
