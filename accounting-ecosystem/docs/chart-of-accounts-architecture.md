# Chart of Accounts — Architecture Reference

> Last updated: March 2026
> Status: Implemented (Standard SA Base v1.0 + Farming SA Overlay v1.0)

---

## Overview

The Chart of Accounts (COA) system is template-driven. A global template library defines standard account sets. When a company is provisioned, the chosen template is **instantiated** into that company's own `accounts` table rows.

This means:
- Companies own their accounts entirely (no shared account rows)
- Templates are reference data only — not used at runtime after provisioning
- A company can freely add custom accounts without affecting the template
- Industry overlays can be applied on top of a base template to add sector-specific accounts
- Future industry templates (retail, professional services, hospitality) can be added without changing core logic

---

## Database Schema

### `coa_templates`
Global library of COA templates. One per industry/use-case.

| Column               | Type         | Notes                                               |
|---|---|---|
| id                   | SERIAL PK    |                                                     |
| name                 | VARCHAR(255) | e.g. "Standard SA Base"                             |
| description          | TEXT         |                                                     |
| industry             | VARCHAR(100) | "general", "farming", "retail" etc                 |
| is_default           | BOOLEAN      | One template is the default                         |
| version              | VARCHAR(20)  | Semantic version                                    |
| parent_template_id   | FK           | → coa_templates.id — for overlay/industry templates |
| sean_metadata        | JSONB        | Sean AI context: overlay flag, suggested segments   |
| created_at           | TIMESTAMPTZ  |                                                     |

**Template types:**
- `parent_template_id IS NULL` — base template (provisions a company from scratch)
- `parent_template_id IS NOT NULL` — overlay template (adds industry accounts to existing COA)

### `coa_template_accounts`
Account definitions within a template. One row per account.

| Column            | Type         | Notes                                  |
|---|---|---|
| id                | SERIAL PK    |                                        |
| template_id       | FK           | → coa_templates.id                     |
| code              | VARCHAR(20)  | Unique within template                 |
| name              | VARCHAR(255) |                                        |
| type              | VARCHAR(50)  | asset / liability / equity / income / expense |
| sub_type          | VARCHAR(50)  | See sub_type reference below           |
| reporting_group   | VARCHAR(100) | Frontend grouping within sub_type      |
| parent_code       | VARCHAR(20)  | For hierarchical COAs (optional)       |
| description       | TEXT         |                                        |
| sort_order        | INTEGER      | Natural sort — matches account code    |
| is_system_account | BOOLEAN      | If true, cannot be edited/deleted      |
| vat_code          | VARCHAR(20)  | SARS VAT code for this account type    |

### `accounts` (per-company instantiated)
Each company's live accounts table. Extended with new columns:

| New Column      | Type         | Notes                              |
|---|---|---|
| sub_type        | VARCHAR(50)  | Inherited from template at provisioning |
| reporting_group | VARCHAR(100) | Inherited from template            |
| sort_order      | INTEGER      | Inherited from template            |
| vat_code        | VARCHAR(20)  | Inherited from template            |
| is_system       | BOOLEAN      | Prevents edit/delete of system accounts |

### `company_template_assignments`
Tracks which templates each company has provisioned or overlaid.

| Column        | Type        | Notes                                  |
|---|---|---|
| company_id    | FK          | → companies.id                         |
| template_id   | FK          | → coa_templates.id                     |
| applied_at    | TIMESTAMPTZ |                                        |
| accounts_added| INTEGER     | How many accounts were inserted        |

### `coa_segments` + `coa_segment_values`
Schema-ready tables for dimensional accounting (cost centres, farming segments).

| Addition       | Type        | Notes                                  |
|---|---|---|
| sort_order     | INTEGER     | Added to coa_segment_values            |
| color          | VARCHAR(20) | Added to coa_segment_values — UI use   |

### `journal_lines` — dimensional tagging
`segment_value_id INTEGER REFERENCES coa_segment_values(id)` added to `journal_lines`.

This enables segmented P&L reporting (e.g. Cattle vs Macadamia vs whole farm) without account duplication. A single "Salaries" account can be tagged to a segment at journal line level.

---

## sub_type Reference

Sub-types drive P&L section calculation. Every account should have a sub_type set.

### Income accounts (`type = 'income'`)

| sub_type         | P&L Section          |
|---|---|
| operating_income | Revenue              |
| other_income     | Other Income         |

### Expense accounts (`type = 'expense'`)

| sub_type          | P&L Section          |
|---|---|
| cost_of_sales     | Cost of Sales        |
| operating_expense | Operating Expenses   |
| depreciation_amort| Depreciation         |
| finance_cost      | Finance Costs        |

> Accounts without a sub_type fall back to `operating_income` (income) or `operating_expense` (expense).
> This ensures backwards-compatibility with pre-template accounts.

---

## P&L Report Structure

The `GET /api/reports/profit-loss` endpoint returns:

```
Revenue (operating_income)
Less: Cost of Sales (cost_of_sales)
────────────────────────────────
= Gross Profit

Add: Other Income (other_income)
Less: Operating Expenses (operating_expense)
Less: Depreciation (depreciation_amort)
────────────────────────────────
= Operating Profit

Less: Finance Costs (finance_cost)
────────────────────────────────
= Net Profit Before Tax
```

Legacy `income` and `expense` flat arrays are included in the response for backwards-compatibility.

---

## Standard SA Base Template (~87 accounts)

The default template for all new South African companies.

### Account Ranges

| Range     | Category                   | Sub-Type               |
|---|---|---|
| 1000–1029  | Bank and Cash              | current_asset          |
| 1030       | Bank — Savings/Call        | current_asset          |
| 1100–1599  | Debtors, Inventory, Prepayments | current_asset     |
| 1600–1730  | Fixed Assets + Accum Dep   | non_current_asset      |
| 1800–1810  | Intangible Assets          | non_current_asset      |
| 1850       | Long-term Investments      | non_current_asset      |
| 1900       | Accum Amortisation         | non_current_asset      |
| 2000–2600  | Current Liabilities        | current_liability      |
| 2700–2750  | Non-Current Liabilities    | non_current_liability  |
| 3000–3200  | Equity                     | equity                 |
| 4000–4499  | Operating Income           | operating_income       |
| 4500–4999  | Other Income               | other_income           |
| 5000–5999  | Cost of Sales              | cost_of_sales          |
| 6000–6999  | Operating Expenses         | operating_expense      |
| 7000–7499  | Finance Costs              | finance_cost           |
| 7500–7999  | Depreciation               | depreciation_amort     |

### Reporting Groups (within sub_types)

**current_asset:** bank_cash, debtors, inventory, prepayments, vat_asset, other_current_asset
**non_current_asset:** fixed_assets, accumulated_depreciation
**current_liability:** creditors, short_term_loans, bank_cash, accruals, vat_liability, paye_payable, tax_payable
**non_current_liability:** long_term_loans
**equity:** share_capital, retained_earnings, drawings
**operating_income / other_income:** operating_income, other_income
**cost_of_sales:** cost_of_sales
**operating_expense:** personnel, occupancy, communication, motor, admin, it_software, professional_fees, banking, insurance, marketing, sundry
**finance_cost:** finance_costs
**depreciation_amort:** depreciation

---

## Farming SA Overlay Template (~34 accounts)

An **overlay** template — adds farming-specific accounts to a company already provisioned with Standard SA Base.

`parent_template_id` → Standard SA Base.

### Farming Account Ranges

| Range     | Category                        | Sub-Type               |
|---|---|---|
| 1250–1270  | Biological Assets — Current    | current_asset (inventory) |
| 1660–1690  | Biological Assets — Non-Current | non_current_asset (fixed_assets) |
| 1740–1750  | Accum Dep — Farming Assets     | non_current_asset (accumulated_depreciation) |
| 4050–4090  | Farming Income Streams         | operating_income / other_income |
| 5050–5090  | Direct Farming Cost of Sales   | cost_of_sales          |
| 6080–6085  | Farming Labour                 | operating_expense (personnel) |
| 7550–7570  | Depreciation — Farming Assets  | depreciation_amort     |

### Farming Example — Segmented P&L

A farming company uses Standard SA Base + Farming SA Overlay, plus a "Enterprise" segment:

```
coa_segments:       Enterprise
coa_segment_values: Cattle | Macadamia Nuts | Avocado | Whole Farm
```

Journal lines are tagged with a `segment_value_id`. The P&L can then be filtered:

**Cattle P&L:**
- Revenue: Cattle Sales (4050) — tagged CATTLE
- COS: Livestock Purchases (5050), Animal Feed (5055), Veterinary (5060)
- Labour: Casual Farm Labour (6080) tagged CATTLE
- = Cattle Gross Profit / Net Profit

**Whole Farm (consolidated):**
- All segment_value_ids combined = full company P&L
- No account duplication — same "6000 Salaries" account, different segment tags

This is **not yet implemented** in the reporting API — `segment_value_id` is schema-ready on `journal_lines`. Segmented filtering in reports is a future implementation step.

---

## Provisioning Flow

### Base Template (new company)

1. On first use, a new company has zero accounts
2. `accounts.html` detects the empty state → fetches available templates → shows template picker cards
3. User selects a template → `POST /api/accounting/accounts/provision-from-template/:templateId`
4. Backend calls `provisionFromTemplate(companyId, client, templateId)`
5. Accounts inserted with `ON CONFLICT DO NOTHING` (idempotent)
6. `vat_code` is copied from template to company accounts
7. Assignment recorded in `company_template_assignments`

Quick path: `POST /api/accounting/accounts/provision-defaults` provisions the default template.

### Overlay Template (industry extension)

1. Company already has Standard SA Base accounts
2. User clicks "Industry Templates" button → overlay picker
3. Selects Farming SA Overlay → `POST /api/accounting/accounts/apply-overlay/:templateId`
4. Backend calls `applyTemplateOverlay(companyId, client, templateId)`
5. Only new accounts inserted (no overwrite of existing codes)
6. Assignment recorded in `company_template_assignments`

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET    | /api/accounting/accounts                            | List accounts (supports ?type=, ?includeInactive=) |
| GET    | /api/accounting/accounts/:id                        | Single account |
| POST   | /api/accounting/accounts                            | Create account |
| PUT    | /api/accounting/accounts/:id                        | Edit account |
| DELETE | /api/accounting/accounts/:id                        | Soft-delete (deactivate) |
| GET    | /api/accounting/accounts/templates                  | List available COA templates |
| GET    | /api/accounting/accounts/templates/:id/accounts     | Preview accounts in a template |
| POST   | /api/accounting/accounts/provision-defaults         | Provision default template |
| POST   | /api/accounting/accounts/provision-from-template/:id | Provision specific base template |
| POST   | /api/accounting/accounts/apply-overlay/:id          | Apply overlay template to existing COA |

---

## Sean AI Integration Design

### Template Seeding via Sean

`coa_templates.sean_metadata JSONB` stores Sean-specific context:

```json
{
  "overlay": true,
  "requires_base_template": "Standard SA Base",
  "industry_segments_suggested": ["Enterprise", "Cattle", "Grain", "Fruit", "Game"],
  "sean_notes": "Use coa_segments to create enterprise dimension for this company after provisioning."
}
```

### Sean-Assisted Template Generation Flow

1. Sean identifies client's industry from transaction patterns or explicit user input
2. Sean queries `coa_template_accounts` for existing industry templates
3. Sean proposes accounts (with sub_types) matching the industry
4. Authorized user reviews and approves the proposed template set
5. Approved accounts inserted into `coa_templates` + `coa_template_accounts`
6. Client provisions via `provision-from-template` or `apply-overlay`

This follows the same approval model as IRP5 code standardization (Part B of CLAUDE.md).

### Sean COA Learning (future)

Sean can learn COA patterns across companies:
- Which accounts are most used per industry
- Which custom accounts appear repeatedly (candidates for template inclusion)
- Which account names map to the same semantic meaning (like IRP5 code normalization)

Learning → proposal → approval → propagation. Never automatic overwrite.

---

## Adding a New Industry Template

1. Define the account array constant (e.g. `RETAIL_SA_OVERLAY`)
2. Add a `seedRetailTemplate(client)` function following `seedFarmingTemplate` pattern
3. Call it in `ensureAccountingSchema()` after the farming seed call
4. The provisioning system works unchanged — `applyTemplateOverlay(companyId, client, newTemplateId)`

---

## Future: Industry Segments (Cost Centres)

`coa_segments` and `coa_segment_values` tables are in place. `journal_lines.segment_value_id` is schema-ready.

### What's needed to activate segmented reporting

1. Journal entry UI — allow tagging a line with a segment value
2. API — accept and store `segment_value_id` on journal line create/update
3. Reports API — add `?segmentValueId=` or `?segmentId=` filter param to P&L endpoint
4. Frontend — segment filter dropdown on P&L report page

---

## Implementation Notes

- `sort_order` defaults to the numeric value of the account code (e.g. code "6100" → sort_order 6100)
- `vat_code` is now copied from template to company accounts at provisioning time
- Accumulated depreciation accounts use `type = 'asset'` with `reporting_group = 'accumulated_depreciation'` — they are credit-balance contra assets
- Overlay accounts have codes that deliberately do not clash with Standard SA Base ranges
- The `is_system` flag is `false` for all template accounts by default
- `company_template_assignments` is idempotent — safe to re-provision without duplicating records
