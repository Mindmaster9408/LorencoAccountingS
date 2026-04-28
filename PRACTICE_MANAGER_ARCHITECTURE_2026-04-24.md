# PRACTICE MANAGER — ARCHITECTURE DESIGN
**Lorenco Ecosystem**
**Design Date:** 2026-04-24
**Status:** Design Only — No Code Written
**Author:** Principal Architect

---

## TABLE OF CONTENTS

1. [Final Data Model](#1-final-data-model)
2. [Client → Company Hierarchy](#2-client--company-hierarchy)
3. [Permission System (RBAC)](#3-permission-system-rbac)
4. [Workflow Engine Design](#4-workflow-engine-design)
5. [SARS / CIPC Deadline Engine](#5-sars--cipc-deadline-engine)
6. [Timekeeping & Billing Engine](#6-timekeeping--billing-engine)
7. [Document System](#7-document-system)
8. [Audit Module Design](#8-audit-module-design)
9. [Share Register Design](#9-share-register-design)
10. [Integration Architecture](#10-integration-architecture)
11. [Data Flow Diagrams](#11-data-flow-diagrams)
12. [Safety Design](#12-safety-design)

---

## 1. FINAL DATA MODEL

### Tenant Safety Rule (applies to every table below)

> Every table that stores practice data **must** have a `company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE` column. Every query **must** include `.eq('company_id', req.companyId)`. The `company_id` value **must** come from the JWT (`req.companyId`) — never from the request body, never from URL params, never trusted from the client.

---

### 1.1 `practice_clients` (EXISTING — extend, do not replace)

Represents the accounting firm's client contact — the person or holding entity.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) ON DELETE CASCADE | Tenant scope |
| `client_code` | TEXT | UNIQUE per company_id | Auto-generated reference (e.g. C-0042) |
| `name` | TEXT | NOT NULL | Primary contact / holding entity name |
| `client_type` | TEXT | NOT NULL, DEFAULT 'business', CHECK IN ('individual','business','trust','cc','npo') | Legal classification |
| `status` | TEXT | NOT NULL, DEFAULT 'active', CHECK IN ('prospect','active','inactive','terminated') | CRM lifecycle |
| `email` | TEXT | | Primary contact email |
| `phone` | TEXT | | Primary contact phone |
| `industry` | TEXT | | Sector classification |
| `address` | TEXT | | Postal/physical address |
| `notes` | TEXT | | Free-form notes |
| `id_number` | TEXT | | Individual ID number (for individual clients) |
| `passport_number` | TEXT | | Passport (non-SA individuals) |
| `income_tax_number` | TEXT | | SARS IT reference for individual clients |
| `provisional_taxpayer` | BOOLEAN | NOT NULL DEFAULT FALSE | Affects deadline generation |
| `referred_by` | TEXT | | Source / referral tracking |
| `is_active` | BOOLEAN | NOT NULL DEFAULT TRUE | Soft-delete flag |
| `assigned_partner_id` | INTEGER | FK → users(id) ON DELETE SET NULL | Responsible partner |
| `assigned_manager_id` | INTEGER | FK → users(id) ON DELETE SET NULL | Day-to-day manager |
| `onboarded_at` | DATE | | Date client relationship started |
| `created_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Indexes:**
```
idx_practice_clients_company            ON (company_id)
idx_practice_clients_company_status     ON (company_id, status)
idx_practice_clients_company_partner    ON (company_id, assigned_partner_id)
idx_practice_clients_client_code        ON (company_id, client_code)
```

**Changes from current schema:**
- Add: `client_code`, `client_type`, `status`, `id_number`, `passport_number`, `income_tax_number`, `provisional_taxpayer`, `referred_by`, `assigned_partner_id`, `assigned_manager_id`, `onboarded_at`, `created_by`
- Remove from this table: `vat_number`, `registration_number`, `fiscal_year_end` → these move to `practice_client_companies`

---

### 1.2 `practice_client_companies` (NEW — CRITICAL)

Represents a legal entity belonging to a client. One client can own many companies.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) ON DELETE CASCADE | Tenant scope |
| `client_id` | INTEGER | NOT NULL, FK → practice_clients(id) ON DELETE CASCADE | Owner client |
| `entity_name` | TEXT | NOT NULL | Legal registered name |
| `entity_code` | TEXT | | Auto-ref (e.g. E-0017) |
| `entity_type` | TEXT | NOT NULL, CHECK IN ('pty_ltd','cc','trust','sole_prop','partnership','npo','individual') | |
| `trading_name` | TEXT | | If different from registered name |
| `status` | TEXT | NOT NULL DEFAULT 'active', CHECK IN ('active','dormant','deregistered','in_liquidation') | |
| `registration_number` | TEXT | | CIPC registration (e.g. 2018/123456/07) |
| `registration_date` | DATE | | CIPC registration date |
| `financial_year_end` | TEXT | NOT NULL | e.g. 'February', '08' (month number or month name) |
| `financial_year_end_day` | INTEGER | DEFAULT 28 | Day of month of FYE |
| `vat_number` | TEXT | | SARS VAT registration |
| `vat_registered` | BOOLEAN | NOT NULL DEFAULT FALSE | |
| `vat_period` | TEXT | CHECK IN ('monthly','bi_monthly','quarterly','annual') | VAT return cycle |
| `vat_category` | TEXT | CHECK IN ('A','B','C','D','E') | SARS VAT category |
| `income_tax_number` | TEXT | | SARS IT number (company/CC/trust) |
| `tax_type` | TEXT | CHECK IN ('company','individual','trust','cc') | Determines deadline rules |
| `paye_emp_reference` | TEXT | | SARS PAYE employer reference |
| `paye_registered` | BOOLEAN | NOT NULL DEFAULT FALSE | |
| `uif_reference` | TEXT | | UIF registration number |
| `sdl_reference` | TEXT | | SDL levy number |
| `cipc_annual_return_date` | DATE | | Anniversary-based |
| `cipc_annual_return_due` | DATE | | Calculated: registration_date anniversary |
| `beneficial_ownership_filed` | BOOLEAN | NOT NULL DEFAULT FALSE | CIPC BO compliance |
| `beneficial_ownership_date` | DATE | | Date last filed |
| `services_enabled` | TEXT[] | NOT NULL DEFAULT '{}' | e.g. ['vat','paye','annual_financials','audit','secretarial','payroll','bookkeeping'] |
| `billing_rate` | NUMERIC(10,2) | | Default hourly rate for this entity |
| `notes` | TEXT | | |
| `assigned_accountant_id` | INTEGER | FK → users(id) ON DELETE SET NULL | Responsible accountant |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Indexes:**
```
idx_pcc_company_id          ON (company_id)
idx_pcc_client_id           ON (client_id)
idx_pcc_company_client      ON (company_id, client_id)
idx_pcc_vat_number          ON (company_id, vat_number)
idx_pcc_income_tax_number   ON (company_id, income_tax_number)
```

**Constraints:**
```sql
UNIQUE (company_id, registration_number)  -- prevent duplicate CIPC numbers per firm
```

---

### 1.3 `practice_tasks` (EXISTING — extend)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `client_id` | INTEGER | FK → practice_clients(id) ON DELETE SET NULL | |
| `client_company_id` | INTEGER | FK → practice_client_companies(id) ON DELETE SET NULL | Which entity |
| `workflow_instance_id` | INTEGER | FK → practice_workflow_instances(id) ON DELETE SET NULL | If generated by engine |
| `workflow_step_order` | INTEGER | | Step position within workflow |
| `title` | TEXT | NOT NULL | |
| `description` | TEXT | | |
| `type` | TEXT | NOT NULL DEFAULT 'general', CHECK IN ('general','vat_return','tax_return','annual_financial','payroll','audit','bookkeeping','secretarial','management_accounts','other') | **Fix: 'annual_financial' not 'annual_financials'** |
| `priority` | TEXT | NOT NULL DEFAULT 'medium', CHECK IN ('low','medium','high','urgent') | |
| `status` | TEXT | NOT NULL DEFAULT 'open', CHECK IN ('open','in_progress','review','completed','cancelled') | |
| `requires_review` | BOOLEAN | NOT NULL DEFAULT FALSE | Triggers review gate |
| `reviewer_id` | INTEGER | FK → users(id) ON DELETE SET NULL | Who must review |
| `reviewed_at` | TIMESTAMPTZ | | |
| `review_notes` | TEXT | | |
| `due_date` | DATE | | |
| `deadline_id` | INTEGER | FK → practice_deadlines(id) ON DELETE SET NULL | Linked SARS deadline |
| `completed_at` | TIMESTAMPTZ | | |
| `assigned_to` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `created_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `notes` | TEXT | | |
| `is_recurring_template` | BOOLEAN | NOT NULL DEFAULT FALSE | Template task flag |
| `tags` | TEXT[] | DEFAULT '{}' | Free tagging |
| `estimated_hours` | NUMERIC(6,2) | | For WIP planning |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Indexes:**
```
idx_practice_tasks_company              ON (company_id)
idx_practice_tasks_client               ON (client_id)
idx_practice_tasks_client_company       ON (client_company_id)
idx_practice_tasks_status               ON (company_id, status)
idx_practice_tasks_assigned             ON (company_id, assigned_to)
idx_practice_tasks_due_date             ON (company_id, due_date)
idx_practice_tasks_workflow_instance    ON (workflow_instance_id)
```

---

### 1.4 `practice_workflow_templates` (NEW)

Reusable service-based workflow definitions.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `name` | TEXT | NOT NULL | e.g. "VAT Return — Monthly" |
| `service_type` | TEXT | NOT NULL, CHECK IN ('vat_return','tax_return','annual_financial','payroll','audit','bookkeeping','secretarial','management_accounts','other') | |
| `description` | TEXT | | |
| `is_active` | BOOLEAN | NOT NULL DEFAULT TRUE | |
| `recurrence` | TEXT | CHECK IN ('none','monthly','bi_monthly','quarterly','annually') | How often to generate |
| `auto_generate` | BOOLEAN | NOT NULL DEFAULT FALSE | Generate on service trigger |
| `default_assigned_role` | TEXT | | Role level to auto-assign |
| `requires_review` | BOOLEAN | NOT NULL DEFAULT FALSE | Global review gate for this template |
| `default_reviewer_role` | TEXT | | Who reviews |
| `estimated_total_hours` | NUMERIC(6,2) | | Total expected hours |
| `created_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

---

### 1.5 `practice_workflow_steps` (NEW)

Ordered steps within a workflow template.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `template_id` | INTEGER | NOT NULL, FK → practice_workflow_templates(id) ON DELETE CASCADE | |
| `step_order` | INTEGER | NOT NULL | Execution sequence |
| `title` | TEXT | NOT NULL | Step title |
| `description` | TEXT | | |
| `task_type` | TEXT | NOT NULL DEFAULT 'general' | Maps to practice_tasks.type |
| `priority` | TEXT | NOT NULL DEFAULT 'medium' | |
| `requires_review` | BOOLEAN | NOT NULL DEFAULT FALSE | Step-level review gate |
| `days_offset_from_start` | INTEGER | NOT NULL DEFAULT 0 | When task is due (relative to workflow start) |
| `days_to_complete` | INTEGER | DEFAULT 5 | Working days budget |
| `default_assigned_role` | TEXT | | Auto-assign to role |
| `is_blocking` | BOOLEAN | NOT NULL DEFAULT TRUE | Next step cannot start until this is done |
| `estimated_hours` | NUMERIC(5,2) | | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Constraint:**
```sql
UNIQUE (template_id, step_order)
```

---

### 1.6 `practice_workflow_instances` (NEW)

A running execution of a workflow template for a specific client entity.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `template_id` | INTEGER | NOT NULL, FK → practice_workflow_templates(id) | |
| `client_id` | INTEGER | NOT NULL, FK → practice_clients(id) ON DELETE CASCADE | |
| `client_company_id` | INTEGER | FK → practice_client_companies(id) ON DELETE SET NULL | |
| `name` | TEXT | NOT NULL | e.g. "VAT Return — March 2026 — Pennygrow" |
| `reference_period` | TEXT | | e.g. "2026-03" or "FY2026" |
| `status` | TEXT | NOT NULL DEFAULT 'active', CHECK IN ('active','completed','cancelled','overdue') | |
| `started_at` | DATE | NOT NULL DEFAULT CURRENT_DATE | |
| `target_completion_date` | DATE | | |
| `completed_at` | TIMESTAMPTZ | | |
| `linked_deadline_id` | INTEGER | FK → practice_deadlines(id) ON DELETE SET NULL | |
| `progress_pct` | INTEGER | NOT NULL DEFAULT 0, CHECK BETWEEN 0 AND 100 | Calculated |
| `total_steps` | INTEGER | NOT NULL DEFAULT 0 | |
| `completed_steps` | INTEGER | NOT NULL DEFAULT 0 | |
| `notes` | TEXT | | |
| `created_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Indexes:**
```
idx_pwi_company             ON (company_id)
idx_pwi_client              ON (client_id)
idx_pwi_client_company      ON (client_company_id)
idx_pwi_status              ON (company_id, status)
```

---

### 1.7 `practice_deadlines` (EXISTING — extend)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `client_id` | INTEGER | FK → practice_clients(id) ON DELETE SET NULL | |
| `client_company_id` | INTEGER | FK → practice_client_companies(id) ON DELETE SET NULL | |
| `title` | TEXT | NOT NULL | |
| `type` | TEXT | NOT NULL DEFAULT 'general', CHECK IN ('general','vat_return','tax_return','paye','uif','sdl','annual_financial','provisional_tax_p1','provisional_tax_p2','provisional_tax_top_up','cipc_annual_return','beneficial_ownership','other') | Expanded type set |
| `reference_period` | TEXT | | e.g. "2026-03" |
| `sars_submission_date` | DATE | | Raw SARS rule date (before weekend adjustment) |
| `due_date` | DATE | NOT NULL | Adjusted working-day deadline |
| `days_remaining` | INTEGER | | Calculated on read (not stored) |
| `status` | TEXT | NOT NULL DEFAULT 'pending', CHECK IN ('pending','submitted','completed','missed') | |
| `submitted_at` | TIMESTAMPTZ | | Date of actual submission |
| `submitted_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `auto_generated` | BOOLEAN | NOT NULL DEFAULT FALSE | Created by deadline engine |
| `escalation_level` | INTEGER | NOT NULL DEFAULT 0 | 0=normal, 1=warning, 2=critical, 3=partner alert |
| `last_escalated_at` | TIMESTAMPTZ | | |
| `notes` | TEXT | | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Indexes:**
```
idx_practice_deadlines_company      ON (company_id)
idx_practice_deadlines_client       ON (client_id)
idx_practice_deadlines_client_co    ON (client_company_id)
idx_practice_deadlines_due_date     ON (company_id, due_date)
idx_practice_deadlines_status       ON (company_id, status)
idx_practice_deadlines_type         ON (company_id, type)
```

---

### 1.8 `practice_time_entries` (EXISTING — extend)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `user_id` | INTEGER | NOT NULL, FK → users(id) ON DELETE RESTRICT | Who logged the time |
| `client_id` | INTEGER | FK → practice_clients(id) ON DELETE SET NULL | |
| `client_company_id` | INTEGER | FK → practice_client_companies(id) ON DELETE SET NULL | |
| `task_id` | INTEGER | FK → practice_tasks(id) ON DELETE SET NULL | |
| `workflow_instance_id` | INTEGER | FK → practice_workflow_instances(id) ON DELETE SET NULL | |
| `audit_job_id` | INTEGER | FK → practice_audit_jobs(id) ON DELETE SET NULL | |
| `hours` | NUMERIC(6,2) | NOT NULL, CHECK (hours > 0 AND hours <= 24) | |
| `description` | TEXT | | |
| `date` | DATE | NOT NULL | |
| `billable` | BOOLEAN | NOT NULL DEFAULT TRUE | |
| `rate` | NUMERIC(10,2) | | Rate at time of entry — copied from user default or client default |
| `amount` | NUMERIC(12,2) | GENERATED ALWAYS AS (hours * rate) STORED | Auto-calculated |
| `billing_item_id` | INTEGER | FK → practice_billing_items(id) ON DELETE SET NULL | Set when invoiced |
| `invoice_id` | INTEGER | FK → practice_invoices(id) ON DELETE SET NULL | Set when invoiced |
| `is_invoiced` | BOOLEAN | NOT NULL DEFAULT FALSE | Lock flag |
| `approved_by` | INTEGER | FK → users(id) ON DELETE SET NULL | Manager approval |
| `approved_at` | TIMESTAMPTZ | | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Constraint:**
```sql
-- Cannot modify invoiced time entries
-- Enforced at application layer: CHECK is_invoiced = FALSE before UPDATE/DELETE
```

**Indexes:**
```
idx_pte_company             ON (company_id)
idx_pte_user                ON (company_id, user_id)
idx_pte_client              ON (client_id)
idx_pte_client_company      ON (client_company_id)
idx_pte_date                ON (company_id, date)
idx_pte_billable            ON (company_id, billable, is_invoiced)
idx_pte_invoice             ON (invoice_id)
```

---

### 1.9 `practice_billing_items` (NEW)

Individual line items on an invoice. Aggregated from time entries or manually added.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `invoice_id` | INTEGER | NOT NULL, FK → practice_invoices(id) ON DELETE CASCADE | |
| `description` | TEXT | NOT NULL | |
| `item_type` | TEXT | NOT NULL DEFAULT 'time', CHECK IN ('time','disbursement','fixed_fee','other') | |
| `quantity` | NUMERIC(8,2) | NOT NULL DEFAULT 1 | |
| `unit` | TEXT | DEFAULT 'hours' | 'hours', 'item', 'km', etc. |
| `rate` | NUMERIC(10,2) | NOT NULL | |
| `amount` | NUMERIC(12,2) | NOT NULL | quantity × rate |
| `vat_applicable` | BOOLEAN | NOT NULL DEFAULT TRUE | |
| `vat_rate` | NUMERIC(5,4) | DEFAULT 0.15 | SA standard rate |
| `vat_amount` | NUMERIC(12,2) | | Calculated |
| `task_id` | INTEGER | FK → practice_tasks(id) ON DELETE SET NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

---

### 1.10 `practice_invoices` (NEW)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `client_id` | INTEGER | NOT NULL, FK → practice_clients(id) | |
| `client_company_id` | INTEGER | FK → practice_client_companies(id) ON DELETE SET NULL | Billed entity |
| `invoice_number` | TEXT | NOT NULL | Auto-generated (e.g. INV-2026-0042) |
| `status` | TEXT | NOT NULL DEFAULT 'draft', CHECK IN ('draft','sent','paid','partial','overdue','cancelled','void') | |
| `invoice_date` | DATE | NOT NULL | |
| `due_date` | DATE | NOT NULL | |
| `period_from` | DATE | | Time period covered |
| `period_to` | DATE | | Time period covered |
| `subtotal` | NUMERIC(12,2) | NOT NULL DEFAULT 0 | Before VAT |
| `vat_amount` | NUMERIC(12,2) | NOT NULL DEFAULT 0 | |
| `total` | NUMERIC(12,2) | NOT NULL DEFAULT 0 | |
| `amount_paid` | NUMERIC(12,2) | NOT NULL DEFAULT 0 | |
| `balance_due` | NUMERIC(12,2) | GENERATED ALWAYS AS (total - amount_paid) STORED | |
| `notes` | TEXT | | |
| `reference` | TEXT | | Client PO number or reference |
| `pdf_storage_path` | TEXT | | Supabase storage path |
| `sent_at` | TIMESTAMPTZ | | |
| `sent_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `paid_at` | TIMESTAMPTZ | | |
| `created_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Constraint:**
```sql
UNIQUE (company_id, invoice_number)
```

---

### 1.11 `practice_documents` (NEW)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `client_id` | INTEGER | FK → practice_clients(id) ON DELETE SET NULL | |
| `client_company_id` | INTEGER | FK → practice_client_companies(id) ON DELETE SET NULL | |
| `task_id` | INTEGER | FK → practice_tasks(id) ON DELETE SET NULL | |
| `audit_job_id` | INTEGER | FK → practice_audit_jobs(id) ON DELETE SET NULL | |
| `audit_section_id` | INTEGER | FK → practice_audit_sections(id) ON DELETE SET NULL | |
| `document_name` | TEXT | NOT NULL | Display name |
| `document_type` | TEXT | NOT NULL DEFAULT 'general', CHECK IN ('general','working_paper','sars_correspondence','signed_document','share_certificate','financial_statement','tax_return','audit_report','payslip','contract','id_document','other') | |
| `file_name` | TEXT | NOT NULL | Original filename |
| `mime_type` | TEXT | | |
| `file_size_bytes` | INTEGER | | |
| `storage_bucket` | TEXT | NOT NULL | Supabase storage bucket name |
| `storage_path` | TEXT | NOT NULL | Full path within bucket |
| `version` | INTEGER | NOT NULL DEFAULT 1 | |
| `supersedes_id` | INTEGER | FK → practice_documents(id) ON DELETE SET NULL | For versioning |
| `access_level` | TEXT | NOT NULL DEFAULT 'team', CHECK IN ('partner_only','manager','team','client') | |
| `retention_date` | DATE | | Auto-delete after this date |
| `description` | TEXT | | |
| `uploaded_by` | INTEGER | NOT NULL, FK → users(id) ON DELETE RESTRICT | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Indexes:**
```
idx_pd_company              ON (company_id)
idx_pd_client               ON (client_id)
idx_pd_client_company       ON (client_company_id)
idx_pd_task                 ON (task_id)
idx_pd_audit_job            ON (audit_job_id)
idx_pd_document_type        ON (company_id, document_type)
```

---

### 1.12 `practice_audit_jobs` (NEW)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `client_id` | INTEGER | NOT NULL, FK → practice_clients(id) | |
| `client_company_id` | INTEGER | NOT NULL, FK → practice_client_companies(id) | |
| `job_reference` | TEXT | NOT NULL | e.g. AUD-2026-0012 |
| `job_type` | TEXT | NOT NULL DEFAULT 'audit', CHECK IN ('audit','review','agreed_procedures','compilation') | |
| `financial_year_end` | DATE | NOT NULL | Period under audit |
| `period_from` | DATE | | |
| `period_to` | DATE | | |
| `status` | TEXT | NOT NULL DEFAULT 'planning', CHECK IN ('planning','fieldwork','review','partner_review','complete','issued') | |
| `lead_accountant_id` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `reviewer_id` | INTEGER | FK → users(id) ON DELETE SET NULL | Senior reviewer |
| `partner_id` | INTEGER | FK → users(id) ON DELETE SET NULL | Signing partner |
| `planning_started_at` | DATE | | |
| `fieldwork_started_at` | DATE | | |
| `review_started_at` | DATE | | |
| `issued_at` | DATE | | Report issue date |
| `total_sections` | INTEGER | NOT NULL DEFAULT 0 | |
| `completed_sections` | INTEGER | NOT NULL DEFAULT 0 | |
| `progress_pct` | INTEGER | NOT NULL DEFAULT 0 | |
| `materiality_amount` | NUMERIC(14,2) | | Audit materiality |
| `performance_materiality` | NUMERIC(14,2) | | |
| `notes` | TEXT | | |
| `created_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Constraint:**
```sql
UNIQUE (company_id, job_reference)
```

---

### 1.13 `practice_audit_sections` (NEW)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `audit_job_id` | INTEGER | NOT NULL, FK → practice_audit_jobs(id) ON DELETE CASCADE | |
| `section_code` | TEXT | NOT NULL | e.g. "B1", "C3" |
| `section_name` | TEXT | NOT NULL | e.g. "Revenue", "Cash and Bank" |
| `assigned_to` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `status` | TEXT | NOT NULL DEFAULT 'not_started', CHECK IN ('not_started','in_progress','prepared','reviewed','signed_off') | |
| `prepared_at` | TIMESTAMPTZ | | |
| `prepared_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `reviewed_at` | TIMESTAMPTZ | | |
| `reviewed_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `signed_off_at` | TIMESTAMPTZ | | |
| `signed_off_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `open_queries` | INTEGER | NOT NULL DEFAULT 0 | Count of unresolved queries |
| `notes` | TEXT | | |
| `sort_order` | INTEGER | NOT NULL DEFAULT 0 | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

---

### 1.14 `practice_audit_queries` (NEW)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `audit_job_id` | INTEGER | NOT NULL, FK → practice_audit_jobs(id) ON DELETE CASCADE | |
| `section_id` | INTEGER | FK → practice_audit_sections(id) ON DELETE SET NULL | |
| `query_number` | TEXT | NOT NULL | e.g. Q-001 |
| `raised_by` | INTEGER | NOT NULL, FK → users(id) | |
| `raised_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `description` | TEXT | NOT NULL | Query content |
| `status` | TEXT | NOT NULL DEFAULT 'open', CHECK IN ('open','responded','resolved','waived') | |
| `response` | TEXT | | Client response |
| `responded_at` | TIMESTAMPTZ | | |
| `resolved_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `resolved_at` | TIMESTAMPTZ | | |
| `resolution_notes` | TEXT | | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

---

### 1.15 `practice_share_register` (NEW)

One row per shareholder per company entity.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `client_company_id` | INTEGER | NOT NULL, FK → practice_client_companies(id) ON DELETE CASCADE | |
| `shareholder_name` | TEXT | NOT NULL | |
| `shareholder_type` | TEXT | NOT NULL DEFAULT 'individual', CHECK IN ('individual','company','trust') | |
| `id_or_reg_number` | TEXT | | SA ID / Passport / Reg number |
| `email` | TEXT | | |
| `address` | TEXT | | |
| `share_class` | TEXT | NOT NULL DEFAULT 'ordinary' | e.g. 'ordinary', 'preference', 'class_a' |
| `shares_held` | INTEGER | NOT NULL CHECK (shares_held >= 0) | Current holding |
| `percentage_held` | NUMERIC(7,4) | | Calculated on write |
| `is_beneficial_owner` | BOOLEAN | NOT NULL DEFAULT TRUE | For CIPC BO |
| `beneficial_ownership_pct` | NUMERIC(7,4) | | Actual beneficial ownership % |
| `is_active` | BOOLEAN | NOT NULL DEFAULT TRUE | |
| `notes` | TEXT | | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Indexes:**
```
idx_psr_company             ON (company_id)
idx_psr_client_company      ON (client_company_id)
```

---

### 1.16 `practice_share_transactions` (NEW)

Immutable ledger — every share movement recorded.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `client_company_id` | INTEGER | NOT NULL, FK → practice_client_companies(id) | |
| `transaction_type` | TEXT | NOT NULL, CHECK IN ('issue','transfer','cancellation','consolidation','subdivision','conversion') | |
| `transaction_date` | DATE | NOT NULL | |
| `from_shareholder_id` | INTEGER | FK → practice_share_register(id) ON DELETE RESTRICT | Null for issue |
| `to_shareholder_id` | INTEGER | FK → practice_share_register(id) ON DELETE RESTRICT | Null for cancellation |
| `share_class` | TEXT | NOT NULL | |
| `shares_quantity` | INTEGER | NOT NULL CHECK (shares_quantity > 0) | |
| `price_per_share` | NUMERIC(14,4) | | |
| `total_consideration` | NUMERIC(14,2) | | |
| `authorised_by` | TEXT | | Name of authorising director/resolution reference |
| `resolution_reference` | TEXT | | Board resolution number |
| `certificate_issued` | BOOLEAN | NOT NULL DEFAULT FALSE | |
| `certificate_id` | INTEGER | FK → practice_share_certificates(id) ON DELETE SET NULL | |
| `notes` | TEXT | | |
| `recorded_by` | INTEGER | NOT NULL, FK → users(id) ON DELETE RESTRICT | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | **Immutable — no updated_at** |

---

### 1.17 `practice_share_certificates` (NEW)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `client_company_id` | INTEGER | NOT NULL, FK → practice_client_companies(id) | |
| `certificate_number` | TEXT | NOT NULL | e.g. "CERT-001" |
| `shareholder_id` | INTEGER | NOT NULL, FK → practice_share_register(id) | |
| `share_class` | TEXT | NOT NULL | |
| `shares_quantity` | INTEGER | NOT NULL | |
| `issue_date` | DATE | NOT NULL | |
| `cancelled_date` | DATE | | If replaced/cancelled |
| `cancelled_reason` | TEXT | | |
| `is_cancelled` | BOOLEAN | NOT NULL DEFAULT FALSE | |
| `pdf_storage_path` | TEXT | | Path to generated PDF |
| `signed_by` | TEXT | | Director name |
| `generated_at` | TIMESTAMPTZ | | When PDF was produced |
| `generated_by` | INTEGER | FK → users(id) ON DELETE SET NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Constraint:**
```sql
UNIQUE (company_id, client_company_id, certificate_number)
```

---

### 1.18 `practice_notifications` (NEW)

Internal notification and email communication log.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `company_id` | INTEGER | NOT NULL, FK → companies(id) | Tenant scope |
| `recipient_user_id` | INTEGER | FK → users(id) ON DELETE SET NULL | Internal user |
| `recipient_email` | TEXT | | External recipient |
| `notification_type` | TEXT | NOT NULL, CHECK IN ('deadline_reminder','task_assigned','task_overdue','invoice_sent','query_raised','escalation','system') | |
| `channel` | TEXT | NOT NULL DEFAULT 'in_app', CHECK IN ('in_app','email','sms') | |
| `subject` | TEXT | | |
| `body` | TEXT | NOT NULL | |
| `template_key` | TEXT | | Reference to email template |
| `entity_type` | TEXT | | 'task', 'deadline', 'invoice', etc. |
| `entity_id` | INTEGER | | |
| `status` | TEXT | NOT NULL DEFAULT 'pending', CHECK IN ('pending','sent','failed','read') | |
| `sent_at` | TIMESTAMPTZ | | |
| `read_at` | TIMESTAMPTZ | | |
| `error_message` | TEXT | | If failed |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Indexes:**
```
idx_pn_company              ON (company_id)
idx_pn_recipient_user       ON (recipient_user_id)
idx_pn_status               ON (company_id, status)
idx_pn_entity               ON (entity_type, entity_id)
```

---

### 1.19 `practice_public_holidays` (NEW — system-wide)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | SERIAL | PRIMARY KEY | |
| `holiday_date` | DATE | NOT NULL | |
| `name` | TEXT | NOT NULL | e.g. "Human Rights Day" |
| `country_code` | TEXT | NOT NULL DEFAULT 'ZA' | |
| `year` | INTEGER | NOT NULL | |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

**Constraint:**
```sql
UNIQUE (holiday_date, country_code)
```

> This table has **no** `company_id` — it is a shared lookup table. Data is maintained by the system administrator, not per-tenant.

---

### Summary of All Tables

| Table | Status | New Columns / Notes |
|---|---|---|
| `practice_clients` | Exists — extend | Add client_code, client_type, status, ID fields, partner/manager assignment |
| `practice_client_companies` | **NEW** | Full SARS/CIPC fields, services_enabled array |
| `practice_tasks` | Exists — extend | Add client_company_id, workflow links, review gate, enum fix |
| `practice_workflow_templates` | **NEW** | |
| `practice_workflow_steps` | **NEW** | |
| `practice_workflow_instances` | **NEW** | |
| `practice_deadlines` | Exists — extend | Add client_company_id, type expansion, escalation_level |
| `practice_time_entries` | Exists — extend | Add client_company_id, invoice link, lock flag, computed amount |
| `practice_billing_items` | **NEW** | |
| `practice_invoices` | **NEW** | |
| `practice_documents` | **NEW** | |
| `practice_audit_jobs` | **NEW** | |
| `practice_audit_sections` | **NEW** | |
| `practice_audit_queries` | **NEW** | |
| `practice_share_register` | **NEW** | |
| `practice_share_transactions` | **NEW** | Immutable ledger |
| `practice_share_certificates` | **NEW** | |
| `practice_notifications` | **NEW** | |
| `practice_public_holidays` | **NEW** | No company_id — system-wide |

---

## 2. CLIENT → COMPANY HIERARCHY

### Design

```
companies  [the accounting firm — Lorenco Accounting]
│
├── practice_clients  [the firm's client contact]
│     │  e.g. "Mr. Kobus van Tonder" or "Van Tonder Family Trust"
│     │
│     └── practice_client_companies  [legal entities owned by the client]
│           ├── Van Tonder Properties (Pty) Ltd  — VAT, PAYE, Audit
│           ├── Van Tonder Farms CC               — VAT, Annual Financials
│           └── Van Tonder Family Trust           — Income Tax, Secretarial
│
├── practice_tasks            [linked to client_company_id]
├── practice_deadlines        [linked to client_company_id + deadline type]
├── practice_time_entries     [linked to client_company_id]
├── practice_invoices         [billed to client_company_id]
├── practice_documents        [linked to client_company_id]
├── practice_audit_jobs       [per client_company_id per year]
├── practice_share_register   [per client_company_id]
└── practice_workflow_instances [per client_company_id]
```

### Services Enabled Model

`practice_client_companies.services_enabled` is a `TEXT[]` array. The value controls:
1. Which SARS/CIPC deadlines are auto-generated for this entity
2. Which workflow templates are offered when creating workflows
3. Which sections appear on the client entity profile page

| Service key | What it enables |
|---|---|
| `vat` | VAT return deadlines generated; VAT Return workflow templates available |
| `paye` | PAYE monthly deadlines generated; Payroll workflow templates available |
| `annual_financials` | Annual financial statements workflow |
| `audit` | Audit job creation enabled |
| `secretarial` | Share register, CIPC returns, beneficial ownership tracking |
| `bookkeeping` | Management accounts workflow templates |
| `management_accounts` | Monthly management accounts workflow |
| `provisional_tax` | Provisional tax deadline generation (P1, P2, top-up) |
| `income_tax` | Company or individual income tax deadline |

### Workflow Triggers

When `services_enabled` is updated to add a new service, the backend must:
1. Check `practice_workflow_templates` for templates matching the new service type
2. If `auto_generate = TRUE` on any template, generate a new `practice_workflow_instances` for the current or upcoming period
3. Generate corresponding `practice_deadlines` for the entity based on the service type and entity's SARS data

---

## 3. PERMISSION SYSTEM (RBAC)

### Role Definitions

| Role Key | Level | Description |
|---|---|---|
| `partner` / `business_owner` | 95 | Full access — signs off, generates invoices, manages staff |
| `practice_manager` | 95 | Equivalent to partner within practice module |
| `administrator` | 85 | Admin-level — no billing finalisation |
| `accountant` | 70 | Works on assigned clients and tasks |
| `reviewer` | 60 | Reviews and approves tasks — limited edit |
| `clerk` | 30 | Data entry — own tasks and time only |
| `client_user` | 10 | External read-only — their entity's documents and deadlines only |

> These roles map to the existing `user_company_access.role` column. No new role infrastructure required — only new permission blocks and route guards.

---

### Permission Groups

#### `PRACTICE_CLIENTS`
| Action | Partner | Practice Mgr | Admin | Accountant | Reviewer | Clerk | Client User |
|---|---|---|---|---|---|---|---|
| VIEW_ALL | ✓ | ✓ | ✓ | assigned only | ✗ | ✗ | own only |
| CREATE | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| EDIT | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| DEACTIVATE | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| VIEW_COMPANIES | ✓ | ✓ | ✓ | assigned | ✗ | ✗ | own |
| MANAGE_COMPANIES | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |

#### `PRACTICE_TASKS`
| Action | Partner | Practice Mgr | Admin | Accountant | Reviewer | Clerk | Client User |
|---|---|---|---|---|---|---|---|
| VIEW_ALL | ✓ | ✓ | ✓ | assigned | assigned | own | ✗ |
| CREATE | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| EDIT_ANY | ✓ | ✓ | ✓ | own | ✗ | ✗ | ✗ |
| DELETE | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| ASSIGN | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| APPROVE_REVIEW | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |

#### `PRACTICE_TIME`
| Action | Partner | Practice Mgr | Admin | Accountant | Reviewer | Clerk | Client User |
|---|---|---|---|---|---|---|---|
| VIEW_ALL | ✓ | ✓ | ✓ | own | ✗ | own | ✗ |
| LOG_OWN | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| EDIT_OWN | ✓ | ✓ | ✓ | ✓ (if not invoiced) | ✓ | ✓ | ✗ |
| EDIT_ANY | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| APPROVE | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| VIEW_RATE | ✓ | ✓ | ✓ | own | ✗ | ✗ | ✗ |

#### `PRACTICE_BILLING`
| Action | Partner | Practice Mgr | Admin | Accountant | Reviewer | Clerk | Client User |
|---|---|---|---|---|---|---|---|
| VIEW_INVOICES | ✓ | ✓ | ✓ | own clients | ✗ | ✗ | own |
| CREATE_DRAFT | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| FINALISE | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| SEND | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| VOID | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |

#### `PRACTICE_DOCUMENTS`
| Action | Partner | Practice Mgr | Admin | Accountant | Reviewer | Clerk | Client User |
|---|---|---|---|---|---|---|---|
| VIEW_ALL | ✓ | ✓ | ✓ | assigned | assigned | assigned | own |
| UPLOAD | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| DELETE | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| VIEW_PARTNER_ONLY | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |

#### `PRACTICE_AUDIT`
| Action | Partner | Practice Mgr | Admin | Accountant | Reviewer | Clerk | Client User |
|---|---|---|---|---|---|---|---|
| CREATE_JOB | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| MANAGE_SECTIONS | ✓ | ✓ | ✗ | assigned | ✗ | ✗ | ✗ |
| PARTNER_SIGN_OFF | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| RAISE_QUERY | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ |

#### `PRACTICE_SHARE`
| Action | Partner | Practice Mgr | Admin | Accountant | Reviewer | Clerk | Client User |
|---|---|---|---|---|---|---|---|
| VIEW | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| RECORD_TRANSACTION | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| GENERATE_CERTIFICATE | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |

---

### Route-Level Enforcement Strategy

Every practice route enforces permissions in this order:

```
1. authenticateToken        — valid JWT required
2. requireCompany           — company_id in JWT required
3. requireModule('practice')— MODULE_PRACTICE_ENABLED=true required
4. requirePracticeRole(group, action) — NEW middleware
5. (optional) scopeToUser() — for Accountant/Clerk — filters results to own data
```

The `requirePracticeRole(group, action)` middleware:
- Reads `req.user.role` from the JWT
- Looks up `PRACTICE_PERMISSIONS[group][action]`
- If the role is not in the allowed list: returns `403 Forbidden`
- If the role requires "own/assigned only" scoping: sets `req.scopeToUser = true` or `req.scopedClientIds = [...]`

---

## 4. WORKFLOW ENGINE DESIGN

### Template Structure

A workflow template defines a repeatable service process:
```
practice_workflow_templates
  ├── service_type: 'vat_return'
  ├── recurrence: 'monthly'
  ├── auto_generate: true
  └── steps (ordered by step_order):
        Step 1: "Gather supporting documents"     — days_offset=0,  is_blocking=true
        Step 2: "Capture transactions"            — days_offset=5,  is_blocking=true
        Step 3: "Prepare VAT201"                  — days_offset=10, is_blocking=true
        Step 4: "Review VAT201"                   — days_offset=13, requires_review=true, is_blocking=true
        Step 5: "Submit to SARS eFiling"          — days_offset=15, is_blocking=false
```

### State Machine

Each task generated from a workflow step obeys the following state machine:

```
open
  │
  ▼ (user starts work)
in_progress
  │
  ├── (requires_review=false) ──────────────────────► completed
  │
  └── (requires_review=true)
        │
        ▼ (submitted for review)
      review
        │
        ├── (reviewer approves) ──────────────────── completed
        │
        └── (reviewer rejects) ──────────────────── in_progress (returned with notes)
```

Cancellation is allowed from any state by Partner/Practice Manager only.

### Assignment Rules

When a workflow instance is generated:
1. Check `template.default_assigned_role` — find users with that role in the company
2. If `client_company.assigned_accountant_id` is set, assign to that user first
3. If no user found, leave `assigned_to = NULL` and flag as unassigned in dashboard
4. For review steps, assign `reviewer_id` to the user matching `template.default_reviewer_role`

### Review Gate Logic

A task with `requires_review = TRUE`:
- Cannot be moved to `completed` by the assigned accountant/clerk
- Can only be moved to `completed` by a user who has `APPROVE_REVIEW` permission (Reviewer, Administrator, Practice Manager, Partner)
- When reviewed: `reviewed_at` and `reviewed_by` are recorded
- If rejected: status returns to `in_progress` and `review_notes` records the rejection reason

### Escalation Logic

The escalation engine runs as a scheduled process (cron — or triggered on each dashboard load):

```
For each open/in_progress task where due_date is in the past:
  days_overdue = today - due_date

  if days_overdue >= 1 and escalation_level = 0:
    set escalation_level = 1 (warning)
    send notification to assigned_to user

  if days_overdue >= 3 and escalation_level < 2:
    set escalation_level = 2 (critical)
    send notification to assigned_to + practice manager

  if days_overdue >= 7 and escalation_level < 3:
    set escalation_level = 3 (partner alert)
    send notification to partner
```

---

### VAT Return Workflow — Full Walk-Through

```
TRIGGER:
  Client entity "Pennygrow (Pty) Ltd" has:
  - services_enabled includes 'vat'
  - vat_period = 'monthly'
  - vat_category = 'B' (end of month following VAT period)

STEP 1 — Auto-generate workflow instance (1st of each month):
  Engine creates:
  practice_workflow_instances:
    name = "VAT Return — March 2026 — Pennygrow"
    reference_period = "2026-03"
    started_at = 2026-04-01
    target_completion_date = 2026-04-23 (2 days before SARS deadline)
    linked_deadline_id = [auto-created deadline record]

STEP 2 — Tasks generated from template steps:
  Task 1: "Gather supporting documents" — due 2026-04-01 → assigned to clerk
  Task 2: "Capture transactions"        — due 2026-04-06 → assigned to accountant
  Task 3: "Prepare VAT201"              — due 2026-04-11 → assigned to accountant
  Task 4: "Review VAT201"               — due 2026-04-14 → review gate → assigned reviewer
  Task 5: "Submit to SARS eFiling"      — due 2026-04-23 → assigned to accountant

STEP 3 — Clerk completes Task 1:
  Status: open → in_progress → completed
  workflow_instance.completed_steps increments (1/5)
  workflow_instance.progress_pct = 20%
  Task 2 becomes available (blocking chain)

STEP 4 — Accountant completes Task 2, 3:
  progress_pct = 60%
  Task 4 opens with requires_review=true

STEP 5 — Accountant submits Task 4 for review:
  status: in_progress → review
  notification sent to reviewer

STEP 6 — Reviewer approves:
  reviewed_by, reviewed_at recorded
  status: review → completed
  progress_pct = 80%
  Task 5 unlocked

STEP 7 — Accountant completes Task 5 (submission):
  workflow_instance.status = 'completed'
  deadline.status = 'submitted', submitted_at = NOW()
  progress_pct = 100%
  Practice Manager notified: "VAT Return March 2026 — Pennygrow — Complete"

STEP 8 — Audit trail:
  audit_log entry per status change
  time entries logged against workflow_instance_id throughout
```

---

## 5. SARS / CIPC DEADLINE ENGINE

### Calculation Engine Design

The engine is a set of pure functions (no side effects, fully testable):

```
calculateSARSDeadline(type, entityData, period) → Date
adjustForNonWorkingDay(date, direction) → Date
isWorkingDay(date) → Boolean
getPublicHolidays(year) → Date[]
generateDeadlinesForEntity(entityId) → DeadlineRecord[]
```

### Public Holiday Handling

```
isWorkingDay(date):
  1. If day is Saturday or Sunday → false
  2. Query practice_public_holidays WHERE holiday_date = date AND country_code = 'ZA'
  3. If found → false
  4. Else → true

adjustForNonWorkingDay(date, direction = 'forward' | 'backward'):
  while NOT isWorkingDay(date):
    date = date + (direction === 'forward' ? +1 : -1) day
  return date
```

### Deadline Calculation Rules

#### VAT (SARS Category B — standard EFT)
```
raw_date = last day of month following VAT period
adjusted = adjustForNonWorkingDay(raw_date, 'backward')

Example: VAT period = March 2026
  raw = 2026-04-30 (Thursday — is working day)
  adjusted = 2026-04-30 ✓

Note: 25th-of-month rule applies for eFiling (Category C entities):
  raw_date = 25th of month following VAT period
  If 25th is non-working day:
    adjusted = adjustForNonWorkingDay(25th, 'backward')
```

#### PAYE / UIF / SDL
```
raw_date = 7th of month following payroll month
If raw_date is non-working day:
  adjusted = adjustForNonWorkingDay(raw_date, 'backward')

Example: Payroll March 2026
  raw = 2026-04-07 (Tuesday)
  adjusted = 2026-04-07 ✓
```

#### Provisional Tax
```
P1: raw = August 31 of current tax year
    adjusted = adjustForNonWorkingDay(raw, 'backward')

P2: raw = last day of February (February 28 or 29)
    adjusted = adjustForNonWorkingDay(raw, 'backward')

Top-up: raw = 6 months after financial year end
    adjusted = adjustForNonWorkingDay(raw, 'backward')
```

#### Company Income Tax (ITR14)
```
raw = 12 months after financial year end
adjusted = adjustForNonWorkingDay(raw, 'backward')
```

#### CIPC Annual Return
```
anniversary = registration_date (same day/month, current year)
window_start = anniversary
window_end = anniversary + 30 business days (iterate through working days)
deadline = window_end
```

#### Beneficial Ownership
```
No fixed calendar — triggered by change event
deadline = change_date + 10 business days
```

---

### Deadline Generation Flow

When a new `practice_client_company` is created or `services_enabled` is updated:

```
generateDeadlinesForEntity(clientCompanyId, lookAheadMonths = 12):

  FOR EACH service in entity.services_enabled:
    
    IF service = 'vat':
      FOR EACH vat_period in next lookAheadMonths:
        check if deadline already exists (prevent duplicates)
        calculate due_date using VAT rules + entity.vat_period + entity.vat_category
        INSERT practice_deadlines WHERE NOT EXISTS

    IF service = 'paye':
      FOR EACH month in next lookAheadMonths:
        calculate PAYE due date (7th adjusted)
        INSERT if not exists

    IF service = 'provisional_tax':
      calculate P1, P2 dates for current tax year
      INSERT if not exists

    IF service = 'income_tax':
      calculate ITR14 date based on entity.financial_year_end
      INSERT if not exists

    IF service = 'secretarial':
      calculate CIPC annual return window
      INSERT if not exists
```

### Day Counter Display

`days_remaining` is **not stored** — it is calculated at read time:

```
days_remaining = countWorkingDays(today, deadline.due_date)
  (negative = overdue by N working days)
  (positive = N working days remaining)
  (zero = due today)
```

### Escalation System

```
Escalation levels on practice_deadlines:
  0 = normal (more than 7 days remaining)
  1 = warning (1–7 days remaining)
  2 = critical (0 days / due today)
  3 = missed (past due, not submitted)

Notifications triggered:
  Level 1 → notify assigned accountant
  Level 2 → notify accountant + practice manager
  Level 3 → notify partner + mark status = 'missed'
```

---

## 6. TIMEKEEPING & BILLING ENGINE

### Time Entry → Invoice Flow

```
STEP 1 — Time captured
  Staff logs time: client_company_id, hours, date, description, billable=true
  rate copied from:
    1. practice_client_companies.billing_rate (if set)
    2. OR staff member's default rate (users table — new field needed)
    3. OR manually entered at log time
  amount = hours × rate (computed/stored)
  is_invoiced = false

STEP 2 — WIP Accumulates
  Billing report shows:
    all time entries WHERE is_invoiced=false AND billable=true
    grouped by client_company_id
    showing: total hours, total amount, date range

STEP 3 — Invoice Draft Generation
  Partner/Practice Manager selects:
    - Client entity to bill
    - Date range (period_from / period_to)
    - Which time entries to include
  
  System creates:
    practice_invoices (status='draft')
    practice_billing_items (one per time entry group or per individual entry)
    practice_time_entries.billing_item_id = new billing_item.id
    practice_time_entries.invoice_id = new invoice.id
    practice_time_entries.is_invoiced = true (LOCKED)

STEP 4 — Invoice Finalisation
  Partner reviews draft, edits line items if needed
  Invoice totals calculated: subtotal, VAT at 15%, total
  Invoice number auto-generated: INV-{YYYY}-{SEQUENCE}
  status = 'draft' → 'sent'
  PDF generated and stored in Supabase Storage
  practice_notifications record created → email sent to client contact

STEP 5 — Payment Recording
  When payment received:
    practice_invoices.amount_paid updated
    balance_due auto-recalculates (generated column)
    if amount_paid >= total: status = 'paid'
    if 0 < amount_paid < total: status = 'partial'

STEP 6 — Accounting Integration (future)
  Finalised invoice pushed to Lorenco Accounting App as:
    Debit: Debtors (client)
    Credit: Professional Fees (revenue account)
    Credit: VAT Output
```

### Rate Handling Priority

```
1. Manual rate entered at log time (override)
2. Entity default rate (practice_client_companies.billing_rate)
3. Staff member default rate (users.default_billing_rate — new field)
4. Company default rate (companies.default_billing_rate — new field)
5. NULL — billing item amount = 0 until corrected
```

---

## 7. DOCUMENT SYSTEM

### Storage Architecture

```
Supabase Storage Bucket: 'practice-documents'
  Structure:
  /{company_id}/{client_id}/{client_company_id}/{document_type}/{YYYY}/{file_uuid}_{original_filename}

  Example:
  /42/101/208/working_papers/2026/a3f9b2c1_trial_balance_2026.xlsx
```

### Linking Model

Each document can be linked to multiple contexts simultaneously:
- `client_id` — always set (which client)
- `client_company_id` — usually set (which entity)
- `task_id` — set if document relates to a specific task
- `audit_job_id` — set if document is an audit working paper
- `audit_section_id` — set if document belongs to a specific audit section

### Access Control

`practice_documents.access_level` controls who can retrieve signed URLs:

| Level | Accessible by |
|---|---|
| `partner_only` | Partner, Practice Manager only |
| `manager` | Partner, Practice Manager, Administrator |
| `team` | All staff assigned to that client |
| `client` | All of the above + Client User with that entity |

The backend `GET /documents/:id/download` endpoint must:
1. Verify the requesting user's role
2. Check the document's `access_level`
3. Verify the user is assigned to the client (for Accountant/Clerk/Client User)
4. Generate a short-lived signed URL from Supabase Storage — **never return the raw storage path to the client**
5. Signed URL expiry: 15 minutes

### Retention

`retention_date` is set on upload based on document type:
- SARS correspondence: 7 years (SARS audit requirement)
- Signed documents: 10 years
- Working papers: 5 years
- General: 3 years

A scheduled job checks `retention_date` and flags documents due for deletion — **manual approval required before actual deletion**. Deletion is never automatic.

---

## 8. AUDIT MODULE DESIGN

### Audit Job Lifecycle

```
PLANNING
  - Job created (partner assigns lead accountant + reviewer)
  - Audit sections defined from standard template
  - Materiality calculated and recorded
  - Planning documentation uploaded
  │
  ▼
FIELDWORK
  - Sections assigned to team members
  - Working papers uploaded per section
  - Queries raised against client
  - Client responds to queries
  │
  ▼
REVIEW
  - Senior reviewer reviews completed sections
  - Section status: in_progress → prepared → reviewed
  - Open queries must all be resolved or waived
  │
  ▼
PARTNER REVIEW
  - Partner reviews all sections
  - Signs off (signed_off_at, signed_off_by recorded per section)
  - All sections must be 'signed_off' before job can move forward
  │
  ▼
COMPLETE → ISSUED
  - Audit report generated
  - issued_at recorded
  - Document stored in practice_documents (document_type='audit_report')
```

### Standard Sections Template

The system ships with a default section list per audit type (ISA-based):

```
A — Planning & Materiality
B — Revenue
C — Debtors
D — Cash and Bank
E — Inventory
F — Fixed Assets
G — Creditors and Accruals
H — Payroll
I — Taxation
J — Related Party Transactions
K — Contingent Liabilities
L — Subsequent Events
M — Audit Report
```

These are created from a template when a new audit job is created.

### Query Management

```
Query raised → open
Client responds → responded
Auditor resolves or waives → resolved / waived

Rules:
- Only Accountant, Reviewer, Partner can raise queries
- No section can be marked 'reviewed' if it has open queries
- No audit job can move to 'partner_review' if any section has open queries
```

### Progress Tracking

```
Section progress:
  not_started (0%) → in_progress (25%) → prepared (50%) → reviewed (75%) → signed_off (100%)

Job progress:
  progress_pct = average of all section progress values
  (recalculated on each section update)
```

---

## 9. SHARE REGISTER DESIGN

### Shareholder Structure

```
practice_client_companies (entity)
  └── practice_share_register (current holdings — one row per shareholder)
        └── practice_share_transactions (immutable ledger of all movements)
              └── practice_share_certificates (issued certificates per transaction)
```

### Share Register Rules

1. `practice_share_register` represents the **current state** of holdings
2. `practice_share_transactions` is the **immutable ledger** — rows are never updated or deleted
3. When a transaction occurs, `practice_share_register` is updated AND a transaction record is created
4. `shares_held` on the register must always reconcile with the net of all transaction records
5. `total_issued_shares` (sum of all register rows per entity) must equal authorised + issued share capital

### Certificate Generation

```
TRIGGER: practice_share_transactions INSERT with transaction_type='issue' or 'transfer'

PROCESS:
1. Generate certificate_number (sequential per entity: CERT-001, CERT-002...)
2. Create practice_share_certificates record
3. Generate PDF certificate using:
   - entity legal name + registration number
   - shareholder name + ID
   - share class + quantity
   - issue date + price per share
   - company seal placeholder
   - signing partner name
4. Store PDF in Supabase Storage: /certificates/{client_company_id}/{cert_number}.pdf
5. Update practice_share_transactions.certificate_id

On transfer:
  - Previous certificate is marked cancelled (is_cancelled=true, cancelled_date=today)
  - New certificate issued to recipient
```

### Beneficial Ownership (CIPC Compliance)

- `is_beneficial_owner` and `beneficial_ownership_pct` on share register rows
- When any shareholding changes, system flags that beneficial ownership must be re-filed within 10 business days
- Triggers a `practice_deadlines` entry: type='beneficial_ownership', due_date = +10 working days
- `practice_client_companies.beneficial_ownership_filed` flag updated when filing confirmed

---

## 10. INTEGRATION ARCHITECTURE

### 10.1 Accounting App Integration

**Direction:** Practice Manager → Accounting App (push)
**Trigger:** Invoice finalised in Practice Manager

```
Practice Manager generates invoice
  → POST /api/accounting/journal-entries (internal API call)
  → Creates journal entry:
      Debit:  Debtors Control (client debtors account)
      Credit: Professional Fees Revenue
      Credit: VAT Output
  → Creates debtor record in accounting client master

Future (read):
  Practice Manager client detail page shows:
    - Outstanding balance (from accounting debtors)
    - Payment history
```

**Integration mechanism:** Internal server-side function call — both modules run in the same Node.js process. No HTTP round-trip required.

---

### 10.2 Paytime Integration

**Direction:** Paytime → Practice Manager (event push)
**Trigger:** Payroll period created in Paytime for a client entity

```
When Paytime creates a new payroll period for a company:
  IF that company is linked to a practice_client_company:
    Emits internal event: 'payroll.period.created'
    Practice module handler:
      Creates practice_task: "Process Payroll — {month} — {entity name}"
      Creates practice_deadline: type='paye', due_date = 7th of following month (adjusted)
```

**Integration mechanism:** Internal event bus — shared service function call within the same Node.js process.

---

### 10.3 Sean AI Integration

**Direction:** Practice Manager → Sean (feed data); Sean → Practice Manager (recommendations)

```
Sean feeds on:
  - Deadline compliance history (which deadlines missed, by how many days)
  - Time entry patterns (how many hours per task type per client)
  - Workflow completion times (actual vs estimated)
  - Billing patterns (average invoice per client type)

Sean produces:
  - Risk alerts: "Pennygrow has missed PAYE 3 times — escalate"
  - Workload alerts: "Accountant John is 40% over capacity this month"
  - Billing insights: "VAT returns average 6.2h — template estimates 8h — update template"
  - Compliance health score per client entity
```

**Integration mechanism:** Read-only Supabase queries from Sean's knowledge module. Sean writes only to `sean_knowledge_items` and `sean_learning_log` — never to practice tables directly.

---

### 10.4 Dochub Integration

**Direction:** Practice documents stored via Dochub instead of direct Supabase Storage (future phase)

```
Current design (Phase 1–7): Direct Supabase Storage
Future (Phase 10): Route all document uploads through Dochub

Document upload flow with Dochub:
  1. Staff uploads file in Practice Manager UI
  2. Practice backend sends file to Dochub API
  3. Dochub stores file, returns document_id + storage_path
  4. Practice backend stores Dochub document_id in practice_documents.storage_path
  5. Document retrieval: Practice backend requests signed URL from Dochub API
  6. Dochub enforces its own access policy (additional security layer)

Impact on data model:
  Add: practice_documents.dochub_document_id TEXT
  practice_documents.storage_bucket becomes 'dochub' when integrated
```

---

### 10.5 Ecosystem Hub Integration

**Direction:** Bidirectional (Hub shows practice status; Practice receives navigation context)

```
Ecosystem Hub shows:
  - Overdue task count (badge on Practice app tile)
  - Upcoming deadlines count (next 7 days)
  - Hours logged today (current user)

Practice receives from Hub:
  - Selected company context (already in JWT)
  - Deep link parameters: ?client_id=X&tab=tasks (open directly to a client's tasks)

Hub API calls:
  GET /api/practice/hub-summary → { overdue_tasks, upcoming_deadlines, hours_today }
  Called by Ecosystem Hub on dashboard load — lightweight endpoint
```

---

## 11. DATA FLOW DIAGRAMS

### 11.1 Client Creation Flow

```
User (Administrator or above)
│
├── [UI] Fills in client modal: name, type, contact details, identity fields
│
├── [Frontend] POST /api/practice/clients
│     Body: { name, client_type, email, phone, id_number, provisional_taxpayer, ... }
│
├── [Middleware] authenticateToken → requireCompany → requireModule → requirePracticeRole('PRACTICE_CLIENTS','CREATE')
│
├── [Backend] Validates required fields
│            Auto-generates client_code (SELECT COUNT(*)+1 per company_id → C-0042)
│            Inserts into practice_clients (company_id = req.companyId — NEVER from body)
│            Writes audit_log: CREATE / practice_client / id
│
├── [Response] { client: { id, client_code, name, ... } }
│
└── [UI] Client appears in list
     User can now add client companies to this client
```

---

### 11.2 Workflow Generation Flow

```
Trigger: practice_client_companies INSERT / services_enabled UPDATE
│
├── [Backend event] generateDeadlinesForEntity(clientCompanyId)
│     Calculates SARS deadlines for each enabled service
│     Inserts practice_deadlines (auto_generated=true) — skips if already exists
│
├── [Backend event] generateWorkflowsForEntity(clientCompanyId)
│     For each service in services_enabled:
│       Find practice_workflow_templates WHERE service_type = service AND auto_generate = true
│       For each template:
│         Generate practice_workflow_instances record
│         For each template step:
│           Generate practice_tasks record
│             - title = step.title
│             - due_date = instance.started_at + step.days_offset_from_start
│             - assigned_to = resolveAssignment(step.default_assigned_role, clientCompanyId)
│             - workflow_instance_id = new instance id
│             - workflow_step_order = step.step_order
│         Link instance.linked_deadline_id to the matching practice_deadline
│
└── [Notifications] Send task assignment notifications to assigned users
```

---

### 11.3 Deadline Creation Flow

```
Two paths:

PATH A — Auto-generated (new entity or service enabled):
│
├── Engine calculates due_date for type, entity, period
├── Checks: no existing deadline for same (company_id, client_company_id, type, reference_period)
├── Inserts practice_deadlines (auto_generated=true)
└── Escalation level starts at 0

PATH B — Manual (user creates deadline):
│
├── [UI] User fills deadline modal
├── [Frontend] POST /api/practice/deadlines
├── [Backend] Validates title, due_date
│            Inserts with auto_generated=false
└── Escalation level starts at 0

SHARED — Escalation runner (triggered on dashboard load or cron):
│
├── For each deadline WHERE status='pending':
│     Calculate days_remaining = workingDaysBetween(today, due_date)
│     If days_remaining between 1–7 AND escalation_level < 1:
│       SET escalation_level = 1
│       INSERT practice_notifications (type='deadline_reminder')
│     If days_remaining = 0 AND escalation_level < 2:
│       SET escalation_level = 2
│       INSERT practice_notifications (type='escalation')
│     If days_remaining < 0 AND escalation_level < 3:
│       SET escalation_level = 3, status = 'missed'
│       INSERT practice_notifications (type='escalation')
│       Notify partner
```

---

### 11.4 Time Capture Flow

```
Staff member
│
├── [UI] Fills in log-time form: client_company, task, date, hours, description, billable, rate
│
├── [Frontend] POST /api/practice/time-entries
│
├── [Middleware] requirePracticeRole('PRACTICE_TIME','LOG_OWN')
│
├── [Backend] Validates: hours > 0, date present, hours <= 24
│            Sets user_id = req.user.userId (cannot be overridden)
│            Sets company_id = req.companyId (cannot be overridden)
│            Rate resolution: entity rate → user rate → company rate → NULL
│            Calculates amount = hours × rate
│            is_invoiced = false
│            Inserts practice_time_entries
│            Writes audit_log: CREATE / practice_time_entry / id
│
└── [Response] { time_entry: { id, hours, amount, ... } }
     WIP balance for the client entity increases by amount
```

---

### 11.5 Billing Output Flow

```
Partner/Practice Manager
│
├── [UI] Opens Billing section, selects client entity + date range
│
├── [Frontend] GET /api/practice/billing/wip?client_company_id=X&date_from=Y&date_to=Z
│     Response: list of unbilled time entries with subtotal
│
├── [UI] Reviews WIP, selects entries, clicks "Generate Invoice Draft"
│
├── [Frontend] POST /api/practice/billing/generate-draft
│     Body: { client_company_id, time_entry_ids[], period_from, period_to, notes }
│
├── [Backend] requirePracticeRole('PRACTICE_BILLING','CREATE_DRAFT')
│            Validates all time_entry_ids belong to company_id (SECURITY CHECK)
│            Validates none are already is_invoiced=true
│            Creates practice_invoices (status='draft')
│            Creates practice_billing_items per time entry group
│            Updates practice_time_entries SET is_invoiced=true, invoice_id=X, billing_item_id=Y
│            Writes audit_log: CREATE / practice_invoice / id
│
├── [UI] Draft invoice displayed — partner can edit line items, add disbursements
│
├── [UI] Partner clicks "Finalise & Send"
│
├── [Frontend] POST /api/practice/billing/invoices/:id/finalise
│
├── [Backend] requirePracticeRole('PRACTICE_BILLING','FINALISE')
│            Recalculates totals (subtotal, VAT, total)
│            Generates invoice_number: INV-{YYYY}-{padded sequence}
│            Generates PDF (PDFKit)
│            Stores PDF in Supabase Storage
│            status = 'sent', sent_at = NOW(), sent_by = req.user.userId
│            Creates practice_notifications (channel='email')
│            Email service sends invoice PDF to client contact
│            [Future] Pushes journal entry to Accounting App
│
└── [Response] { invoice: { id, invoice_number, pdf_url, status: 'sent' } }
```

---

## 12. SAFETY DESIGN

### Multi-Tenant Protection

**Layer 1 — JWT enforcement:**
- `company_id` is embedded in the JWT at login, based on which company the user selected
- `authenticateToken` middleware extracts `company_id` from the token and sets `req.companyId`
- No route reads `company_id` from `req.body`, `req.query`, or `req.params`
- A user cannot switch company without re-authenticating (new token with new `company_id`)

**Layer 2 — Database query scoping:**
- Every Supabase query includes `.eq('company_id', req.companyId)`
- Every INSERT includes `company_id: req.companyId`
- No wildcard queries (`SELECT * FROM practice_clients` without company filter)

**Layer 3 — Cross-entity ownership validation:**
- Before operating on a child record (e.g. time entry), the backend must verify the parent (client_company) belongs to `req.companyId`
- Example: `DELETE /time-entries/:id` — must verify `SELECT company_id FROM practice_time_entries WHERE id = :id` equals `req.companyId` before deleting
- This prevents a user from accessing records from another firm by guessing IDs

**Layer 4 — Supabase Row Level Security (RLS) — future hardening:**
- All `practice_*` tables should have RLS policy: `company_id = current_setting('app.company_id')::int`
- The backend sets `SET app.company_id = X` at the start of each connection
- Even if the application layer has a bug, RLS provides a second enforcement layer

---

### Permission Enforcement

**Route-level:**
```
Every route declares its required permission:
  requirePracticeRole('PRACTICE_TASKS', 'DELETE')

The middleware:
  1. Reads req.user.role
  2. Checks PRACTICE_PERMISSIONS['PRACTICE_TASKS']['DELETE'] includes the role
  3. If not: return 403 { error: 'Insufficient permissions', required: 'PRACTICE_TASKS.DELETE' }
  4. Writes a PERMISSION_DENIED entry to audit_log if 403 returned
```

**Scoping for restricted roles:**
```
Accountant viewing tasks:
  requirePracticeRole sets req.scopeToUser = true
  
  The route then applies:
    if (req.scopeToUser) {
      query = query.or(`assigned_to.eq.${req.user.userId},created_by.eq.${req.user.userId}`)
    }
```

---

### Audit Logging

Every meaningful action in the practice module writes to `audit_log`:

| Action | Required log |
|---|---|
| Create client | CREATE / practice_client |
| Edit client | UPDATE / practice_client / field_name, old_value, new_value |
| Deactivate client | UPDATE / practice_client / is_active=false |
| Create task | CREATE / practice_task |
| Change task status | UPDATE / practice_task / status / old → new |
| Delete task | DELETE / practice_task |
| Log time | CREATE / practice_time_entry |
| Delete time entry | DELETE / practice_time_entry |
| Generate invoice | CREATE / practice_invoice |
| Finalise invoice | UPDATE / practice_invoice / status = sent |
| Void invoice | UPDATE / practice_invoice / status = void |
| Upload document | CREATE / practice_document |
| Delete document | DELETE / practice_document |
| Record share transaction | CREATE / practice_share_transaction |
| Generate certificate | CREATE / practice_share_certificate |
| Permission denied | PERMISSION_DENIED / route / user / role |

The `audit_log` table is **append-only**. No UPDATE or DELETE is ever executed on it. Retention minimum: 7 years (POPI Act + SARS requirement).

---

### Data Integrity Rules

| Rule | Enforcement |
|---|---|
| Invoiced time entries cannot be edited or deleted | Application check: `if (entry.is_invoiced) return 403` before any PUT/DELETE |
| Share transactions are immutable | No PUT or DELETE route for `practice_share_transactions` — ever |
| Completed audit sections cannot be un-signed without partner | `requirePracticeRole('PRACTICE_AUDIT','PARTNER_SIGN_OFF')` on status reversal |
| `company_id` never accepted from request body | All routes extract from `req.companyId` only |
| Time entry hours must be > 0 and ≤ 24 | DB CHECK constraint + backend validation |
| Invoice totals must reconcile with billing items | Recalculated server-side on every finalise — client totals are never trusted |
| Deadline `due_date` cannot be in the past for new manual deadlines | Backend validation + warning on auto-generated past-due deadlines |

---

## DESIGN DOCUMENT COMPLETE

**Safe build order — do not skip phases:**

| Phase | Scope |
|---|---|
| Phase 1 | Bug fixes (enum mismatch, deadline edit modal) — current |
| Phase 2 | Permission layer (`requirePracticeRole` middleware) |
| Phase 3 | `practice_client_companies` table + client hierarchy UI |
| Phase 4 | Workflow engine (templates, steps, instances) |
| Phase 5 | Deadline engine (SARS rules, auto-generation, escalation) |
| Phase 6 | Billing engine (invoices, WIP, PDF generation) |
| Phase 7 | Document system (upload, storage, signed URLs) |
| Phase 8 | Audit module (jobs, sections, queries) |
| Phase 9 | Share register (transactions, certificates) |
| Phase 10 | Integration layer (Accounting, Paytime, Sean, Dochub, Hub) |

**Phase 1 bug fixes must be completed before any new schema is touched.**

---

*Design only. No code written. Awaiting Phase 1 bug fix authorization.*
