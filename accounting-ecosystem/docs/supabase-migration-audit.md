# Supabase Migration Audit
> Last updated: 2026-03-21

Full audit of every SQL migration file, what each creates, the correct run order, and what to do if starting fresh on a new Supabase instance.

---

## Migration Run Order (Fresh Install)

Run in this exact order in the **Supabase SQL Editor**:

| # | File | Purpose |
|---|---|---|
| 1 | `schema.sql` | Foundation — all shared, POS, and Payroll tables |
| 2 | `sean-schema.sql` | Early SEAN AI tables |
| 3 | `007_coaching_schema.sql` | Coaching module tables |
| 4 | `008_eco_clients_packages.sql` | Eco-client billing + `client_company_id` |
| 5 | `009_user_app_access.sql` | Per-user app access gates |
| 6 | `010_user_client_access.sql` | Per-user client visibility gates |
| 7 | `011_sean_irp5_learning.sql` | IRP5 learning engine tables |
| 8 | `012_accounting_schema.sql` | All accounting module tables |
| 9 | `013_sean_learning.sql` | SEAN bank learning + Codex |
| 10 | *(manual — no file)* | `eco_client_firm_access` table — see below |

---

## File-by-File Reference

### `schema.sql`
Foundation. Must be run first.

**Creates:**
- `companies` — base columns (name, registration, vat_number, modules_enabled, etc.)
- `users` — shared auth identity, `is_super_admin` flag
- `user_company_access` — multi-company user access
- `employees` — shared across POS + Payroll
- `audit_log` — forensic log for all modules
- `eco_clients` — cross-app client registry (base columns)
- **POS tables:** `categories`, `products`, `customers`, `tills`, `till_sessions`, `sales`, `sale_items`, `sale_payments`, `stock_adjustments`, `vat_settings`, `company_settings`, `barcode_settings`
- **Payroll tables:** `payroll_periods`, `payroll_items_master`, `employee_payroll_setup`, `employee_recurring_inputs`, `payroll_transactions`, `payslip_items`, `period_inputs`, `attendance`, `leave_records`, `leave_balances`, `employee_notes`, `pay_runs`, `payroll_historical`, `payroll_kv_store_eco`, `employee_bank_details`
- **Legacy accounting stubs:** `chart_of_accounts`, `journal_entries`, `journal_lines` (old FK set — superseded by 012)
- `bank_accounts`, `bank_transactions`, `financial_periods`
- `paye_config_income_types`, `paye_config_deduction_types`, `paye_periods`, `paye_reconciliations`, `paye_employee_lines`, `paye_employee_income_lines`, `paye_employee_deduction_lines`
- `app_kv_store`, `pos_kv_store`, `accounting_kv_store`
- RLS enabled on all tables
- `update_updated_at_column()` trigger function + triggers

---

### `sean-schema.sql`
Early SEAN AI foundation tables.

**Creates:**
- `sean_codex_private` — per-company encrypted learned decisions
- `sean_patterns_global` — anonymised global merchant patterns

---

### `007_coaching_schema.sql`
Coaching module. Only needed if the coaching app is active.

**Creates:**
- `coaching_users`, `coaching_program_modules`, `coaching_coach_program_access`
- `coaching_clients`, `coaching_client_steps`, `coaching_client_sessions`
- `coaching_client_gauges`, `coaching_ai_learning_data`, `coaching_ai_conversations`
- Seeds default program modules (journey, gauges, assessments, ai_assistant, reports)

---

### `008_eco_clients_packages.sql`
Extends eco_clients with billing and client isolation columns.

**Adds to `eco_clients`:**
- `package_name VARCHAR(100) DEFAULT 'standard'`
- `addons TEXT[] DEFAULT ARRAY[]::TEXT[]`
- `last_billed_employees INTEGER`
- `last_billed_period VARCHAR(10)`
- `last_billed_date TIMESTAMPTZ`
- `client_company_id INTEGER REFERENCES companies(id)` — each client gets their own isolated company

---

### `009_user_app_access.sql`
Per-user, per-company app access control.

**Creates:**
- `user_app_access (user_id, company_id, app_key, granted_by, granted_at)`
- `app_key` CHECK: `pos | payroll | accounting | sean | coaching`
- Logic: if no rows exist for a user+company pair → unrestricted (backward-compatible default)

---

### `010_user_client_access.sql`
Per-user client visibility filtering.

**Creates:**
- `user_client_access (user_id, company_id, eco_client_id, granted_by, granted_at)`
- Logic: if no rows exist for a user+company pair → all clients visible (backward-compatible default)

---

### `011_sean_irp5_learning.sql`
IRP5 code learning engine for Paytime. Implements CLAUDE.md Part B (Rules B1–B11).

**Adds to `payroll_items_master`:**
- `irp5_code VARCHAR(10)` — nullable; Sean learns this
- `irp5_code_updated_at TIMESTAMPTZ`
- `irp5_code_updated_by INTEGER REFERENCES users(id)`

**Creates:**
- `sean_learning_events` — immutable log of every IRP5 code change (who, what, when, previous/new value)
- `sean_irp5_mapping_patterns` — aggregated patterns (normalized_item_name → suggested_irp5_code, confidence, occurrence_count)
- `sean_irp5_propagation_approvals` — authorization workflow; no propagation without an approved row
- `sean_irp5_propagation_log` — immutable audit trail of every propagation write

**Safety rules enforced:**
- Sean may only INSERT irp5_code where it is NULL/empty
- Sean may never overwrite an existing irp5_code
- Global propagation requires explicit authorization

---

### `012_accounting_schema.sql`
All accounting module tables. The largest migration. Safe to re-run (all IF NOT EXISTS).

**Adds to `companies`:**
`income_tax_number`, `paye_reference`, `uif_reference`, `sdl_reference`, `coid_number`, `financial_year_end`, `vat_period`, `company_type`, `physical_address`, `city`, `postal_code`, `postal_address`, `phone`, `email`, `website`, `bank_name`, `branch_code`, `account_number`, `account_type`, `account_holder`, `logo_url`, `account_holder_type`

**Adds to `accounts`:**
`is_system`, `sub_type`, `reporting_group`, `sort_order`, `vat_code`

**Fixes `journal_lines`:**
Drops old FKs (journal_entries + chart_of_accounts) that would block accounting module inserts. Adds `segment_value_id`.

**Fixes `bank_accounts`:**
Drops NOT NULL on `bank_name`, `account_name`, `account_number` (old schema constraints that blocked accounting module creates).

**Creates:**
- `accounting_periods`
- `accounts` (Chart of Accounts)
- `journals` (header) — with `status`, `source_type`, `reversal_of_journal_id`, `reversed_by_journal_id`
- `journal_lines` (if not exists)
- `bank_accounts` (extended)
- `bank_transactions` (extended) — adds `company_id`, `status`, `import_source`, etc.
- `bank_transaction_attachments`
- `vat_periods`, `vat_reconciliations`, `vat_reconciliation_lines`, `vat_submissions`, `vat_reports`
- `paye_config_income_types`, `paye_config_deduction_types`, `paye_reconciliations`, `paye_employee_lines`, `paye_employee_income_lines`, `paye_employee_deduction_lines`
- `accounting_audit_log`
- `pos_reconciliations`
- `coa_templates`, `coa_template_accounts` — with Standard SA Base seeded (76 accounts)
- `coa_segments`, `coa_segment_values`
- `company_template_assignments`
- `suppliers` (accounting AP version), `supplier_invoices`, `supplier_invoice_lines`, `purchase_orders`, `purchase_order_lines`, `supplier_payments`, `supplier_payment_allocations`
- `accounting_kv_store`
- `customer_invoices`, `customer_invoice_lines`, `customer_payments`, `customer_payment_allocations`

---

### `013_sean_learning.sql`
SEAN bank allocation learning. Run after 012.

**Creates:**
- `ecosystem_apps` — app registry (seeded: Accounting, Paytime, Checkout Charlie)
- `sean_bank_learning_events` — immutable log of trusted bank transaction allocations
- `sean_bank_allocation_patterns` — anonymised patterns (description → account code)
- `sean_bank_learning_proposals` — authorization workflow for bank pattern propagation
- `sean_codex_articles` — global SA tax/accounting reference library (seeded: bank charges, VAT, fuel, salaries, COS)

**Adds to `bank_transactions`:**
- `import_source VARCHAR(20) DEFAULT 'manual'` — tracks how transaction entered (pdf/csv/api/manual). Sean only learns from `pdf` and `api`.

---

## Missing Files — No SQL File Exists

These early migrations were run directly in Supabase. No file to re-run. Documented here for reference.

| Migration | What it did | Recovery |
|---|---|---|
| `001_sean_tables.sql` | Early SEAN tables | Use `sean-schema.sql` |
| `002_super_practice.sql` | Super practice company seed data | Re-seed manually if needed |
| `003_eco_clients.sql` | eco_clients base table | Already in `schema.sql` |
| `004_the_infinite_legacy.sql` | The Infinite Legacy company seed | Re-seed manually if needed |
| `005_eco_client_company.sql` | Added `client_company_id` to eco_clients | Covered by `008` |
| `006_client_firm_access.sql` | `eco_client_firm_access` table | **Run the block below — table is live** |

---

## `eco_client_firm_access` — Manual SQL Required

This table is **actively used in production** (the "Manage Firms" cross-firm visibility feature on the dashboard). No migration file exists. If this table is missing, run:

```sql
CREATE TABLE IF NOT EXISTS eco_client_firm_access (
  id              SERIAL PRIMARY KEY,
  eco_client_id   INTEGER NOT NULL REFERENCES eco_clients(id)  ON DELETE CASCADE,
  firm_company_id INTEGER NOT NULL REFERENCES companies(id)    ON DELETE CASCADE,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by      INTEGER REFERENCES users(id),
  UNIQUE(eco_client_id, firm_company_id)
);
CREATE INDEX IF NOT EXISTS idx_ecfa_client ON eco_client_firm_access(eco_client_id);
CREATE INDEX IF NOT EXISTS idx_ecfa_firm   ON eco_client_firm_access(firm_company_id);
```

---

## Auto-Migration (accounting-schema.js)

The file `backend/config/accounting-schema.js` runs on every server startup and applies all column additions via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. It covers everything in `012_accounting_schema.sql` plus VAT Prompt 2 additions.

**It only runs if `DATABASE_URL` is set in Zeabur** (uses pg Pool). If `DATABASE_URL` is not set, the auto-migration silently fails and the accounting module will error on all routes that use pg Pool.

**VAT Prompt 2 additions applied by auto-migration (not in 012 SQL file):**

On `journals`:
```sql
ALTER TABLE journals ADD COLUMN IF NOT EXISTS vat_period_id               INTEGER REFERENCES vat_periods(id) ON DELETE SET NULL;
ALTER TABLE journals ADD COLUMN IF NOT EXISTS is_out_of_period            BOOLEAN DEFAULT false;
ALTER TABLE journals ADD COLUMN IF NOT EXISTS out_of_period_original_date DATE;
```

On `vat_periods`:
```sql
ALTER TABLE vat_periods ADD COLUMN IF NOT EXISTS out_of_period_total_input  NUMERIC(15,2) DEFAULT 0;
ALTER TABLE vat_periods ADD COLUMN IF NOT EXISTS out_of_period_total_output NUMERIC(15,2) DEFAULT 0;
ALTER TABLE vat_periods ADD COLUMN IF NOT EXISTS out_of_period_count        INTEGER DEFAULT 0;
```

**Recommendation:** Set `DATABASE_URL` in Zeabur to the Supabase direct connection string (port 5432). This keeps the schema in sync with code on every deploy automatically.

---

## What Changed Yesterday (2026-03-20)

### Commit `fe92f5c` — Admin panel fix
**No new SQL required.**

The route `PATCH /api/companies/:id/account-holder-type` was failing with a misleading 404 when the `account_holder_type` column was missing. Now returns a clear 500 with the exact SQL to run.

If `account_holder_type` is missing from your Supabase `companies` table:
```sql
ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_holder_type VARCHAR(50);
```
This is already covered by `012_accounting_schema.sql`. If you ran 012, it's there.

### Commit `a7125f9` — Net-to-Gross calculator
**Zero database changes.** Pure frontend + payroll engine JS (`net-to-gross.html`, `payroll-engine.js`). No SQL needed.

---

## Open Database Risks

| Risk | Impact | Fix |
|---|---|---|
| `DATABASE_URL` not set in Zeabur | All accounting pg Pool routes return 500. Auto-migration never runs. `account_holder_type` and VAT Prompt 2 columns missing. | Add Supabase direct connection string (port 5432) as `DATABASE_URL` in Zeabur env vars |
| `eco_client_firm_access` missing | "Manage Firms" feature and cross-firm client visibility breaks with 500 | Run the manual SQL block above |
| Coaching tables missing | Coaching app errors | Run `007_coaching_schema.sql` |
| SEAN bank learning tables missing | Bank allocation learning silently skips (graceful) but no learning builds up | Run `013_sean_learning.sql` |
