# Paytime Launch Checklist

> **Timeline:** Testing today → Launch Friday

## Overview

Lorenco Paytime Payroll lives in `accounting-ecosystem/frontend-payroll/` (frontend)
and `accounting-ecosystem/backend/modules/payroll/` (backend). The full API is
implemented and wired. Below are the exact steps to go live.

---

## ✅ Step 1 — Enable the Payroll Module (Deployment Environment)

In your Railway / Render / Zeabur environment variables, add:

```
MODULE_PAYROLL_ENABLED=true
```

Without this, the payroll routes never register and the `/payroll/*` frontend
returns a blank page.

---

## ✅ Step 2 — Set the PostgreSQL Direct URL (for schema auto-init)

The server auto-creates `payroll_kv_store_eco` on startup, and this requires a
direct PostgreSQL connection (not just the Supabase REST client).

Set **at least one** of these in your environment:

```
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-*.pooler.supabase.com:5432/postgres
```

> **Get it from:** Supabase Dashboard → Settings → Database → Connection string  
> Use **Session mode** (port **5432**), NOT Transaction mode (port 6543).

If you already have `ACCOUNTING_DATABASE_URL` set (for the accounting module),
the payroll auto-init will reuse that same pool — no extra env var needed.

---

## ✅ Step 3 — Verify Payroll Tables Exist in Supabase

These tables must exist (they're in `accounting-ecosystem/database/schema.sql`):

| Table | Purpose |
|---|---|
| `payroll_periods` | Pay period headers |
| `payroll_transactions` | Pay run transaction records |
| `payslip_items` | Individual payslip line items |
| `payroll_items_master` | Earning/deduction templates per company |
| `employee_payroll_setup` | Per-employee payroll config (rate, tax status) |
| `employee_bank_details` | Banking info for direct deposits |
| `attendance` | Attendance records |
| `pay_runs` | Pay run summaries |
| `payroll_historical` | Imported historical payroll data |
| `payroll_kv_store_eco` | Frontend KV store — **NEW** (auto-created on startup OR run migration below) |

### If tables DON'T exist yet — run the full schema

Open **Supabase Dashboard → SQL Editor** and run:
`accounting-ecosystem/database/schema.sql` (entire file)

### If only `payroll_kv_store_eco` is missing — run the migration

Open **Supabase Dashboard → SQL Editor** and run:
`accounting-ecosystem/backend/config/migrations/007_payroll_kv_store.sql`

**Or just redeploy** — the server startup auto-creates `payroll_kv_store_eco`
if `DATABASE_URL` / `ACCOUNTING_DATABASE_URL` is set.

---

## ✅ Step 4 — Enable Payroll for Your Company (in Supabase DB)

There's a two-layer module gate:
1. `MODULE_PAYROLL_ENABLED=true` (env var) → enables the routes globally
2. `companies.modules_enabled` array in the DB → controls per-company access

For each company that should have payroll access:

```sql
UPDATE companies
SET modules_enabled = array_append(
  COALESCE(modules_enabled, ARRAY[]::TEXT[]),
  'payroll'
)
WHERE id = <your_company_id>;
```

> Find your company ID: `SELECT id, name FROM companies;`

---

## ✅ Step 5 — Set Up Payroll Items for Your Company

Each company needs default earning/deduction items. Run via Supabase SQL Editor:

```sql
SELECT initialize_payroll_defaults(<your_company_id>);
```

This creates the standard SA payroll items:
- **Earnings:** Basic Salary, Overtime (1.5x/2x/public holiday), Travel Allowance, Cellphone Allowance, Bonus, Commission
- **Deductions:** PAYE, UIF (Employee), Pension Fund, Provident Fund, Medical Aid, Loan Repayment
- **Company Contributions:** UIF (Employer), Skills Development Levy (SDL)

---

## ✅ Step 6 — Verify RBAC Permissions

The following roles automatically have payroll access (defined in `backend/config/permissions.js`):

| Role | Access |
|---|---|
| `business_owner` | PAYROLL.VIEW, PAYROLL.CREATE, PAYROLL.APPROVE |
| `accountant` | PAYROLL.VIEW, PAYROLL.CREATE |
| `payroll_admin` | PAYROLL.VIEW, PAYROLL.CREATE, PAYROLL.APPROVE |

Ensure at least one user has one of these roles in `user_company_access`:

```sql
SELECT u.email, uca.role
FROM user_company_access uca
JOIN users u ON u.id = uca.user_id
WHERE uca.company_id = <your_company_id>;
```

---

## ✅ Step 7 — Test the Login + SSO Flow

### Option A: Direct payroll login
1. Navigate to: `https://<your-domain>/payroll/login.html`
2. Login with email + password
3. Select company → redirected to payroll dashboard

### Option B: Ecosystem SSO launch
1. Login at `https://<your-domain>/` (ecosystem login)
2. Go to Company Dashboard
3. Click **"Paytime Payroll"** module card
4. SSO token is injected → payroll opens pre-authenticated

---

## ✅ Step 8 — Test the Full Pay Run Flow

1. **Employees** — Add at least one employee with a salary rate
2. **Pay Items** — Verify payroll items list loads (earnings + deductions)
3. **New Pay Run** — Create a pay period
4. **Inputs** — Enter basic salary, overtime, deductions
5. **Calculate** — Verify PAYE and UIF calculations
6. **Payslip** — Generate and download a payslip PDF
7. **Approve** — Approve the pay run (requires PAYROLL.APPROVE)

---

## 🔴 Common Issues + Fixes

| Symptom | Cause | Fix |
|---|---|---|
| `/payroll/` returns blank or 404 | `MODULE_PAYROLL_ENABLED` not set | Set env var, redeploy |
| API returns 403 on all `/api/payroll/*` | Module disabled or company missing in `modules_enabled` | Step 4 above |
| `payroll_kv_store_eco: relation does not exist` | Table not created | Run migration 007 OR set `DATABASE_URL` and redeploy |
| Pay items list empty | `initialize_payroll_defaults()` not run | Step 5 above |
| Employee list empty | No employees added OR wrong `company_id` in JWT | Check token decode at `/api/auth/me` |
| PAYE calculation wrong | SA tax tables not seeded | Check `paye_tax_brackets` table in Supabase |

---

## 📋 Quick Deploy Checklist

```
□ MODULE_PAYROLL_ENABLED=true  (env var)
□ DATABASE_URL set to Supabase direct connection (port 5432)
□ Module enabled for company: UPDATE companies SET modules_enabled = array_append(...)
□ Payroll items initialized: SELECT initialize_payroll_defaults(<company_id>)
□ Redeploy to trigger payroll schema auto-init (creates payroll_kv_store_eco)
□ Login and test pay run end-to-end
```

---

## Architecture Notes

- **Frontend:** `accounting-ecosystem/frontend-payroll/` (16 pages, vanilla HTML/JS)
- **Backend:** `accounting-ecosystem/backend/modules/payroll/` (6 route groups)
- **Auth:** Same ecosystem JWT (HS256, 8h) + `requireCompany` middleware
- **Data:** Supabase via JS client (`@supabase/supabase-js`) — NOT localStorage
- **KV Store:** `payroll_kv_store_eco` — localStorage bridge, cloud-backed
- **Calc Engine:** `frontend-payroll/js/payroll-engine.js` — client-side SA tax calculations
- **Schema auto-init:** `backend/config/payroll-schema.js` — runs on every startup
