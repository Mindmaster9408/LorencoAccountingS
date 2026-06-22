# Codebox 36 — Tax Document Checklist Templates + Tax Pack Automation Foundation

**Module:** Lorenco Practice Management  
**Date:** June 2026  
**Status:** Complete

---

## Purpose

Build reusable tax checklist templates that generate consistent document requests, compliance pack items, and tax return readiness items — all in a controlled, operator-reviewed, non-automated way.

This is NOT document storage. NOT OCR. NOT SARS/eFiling. NOT AI. Template-driven checklist generation only.

---

## What Was Built

### Migration: `085_practice_tax_checklist_templates.sql`

Three tables:

**`practice_tax_checklist_templates`**

| Field | Purpose |
|---|---|
| `template_name` | Human-readable name |
| `template_type` | individual_tax / company_tax / provisional_tax / annual_financials / vat_period / payroll_annual / cipc_annual / custom |
| `client_type` | Optional: scope to individual / company / trust / etc. |
| `tax_year` | Optional: scope to specific year |
| `is_default` | True for seeded default templates |
| `is_active` | Soft delete flag |
| `settings` | JSONB for future extensibility |

**`practice_tax_checklist_template_items`**

| Field | Purpose |
|---|---|
| `item_name` | What to request / create |
| `item_category` | document / tax_data / review / compliance / calculation / approval / custom |
| `target_type` | What to generate: document_request / compliance_pack_item / individual_tax_item / company_tax_item |
| `required` | Whether the item is mandatory |
| `default_due_offset_days` | Days from apply date to set as required_by_date |
| `settings` | JSONB: holds `document_category` (for doc requests), `item_type` (for tax return items) |

**`practice_tax_checklist_template_events`** — append-only audit log

---

### Backend: `tax-checklists.js`

Endpoints at `/api/practice/tax-checklists`:

| Route | Purpose |
|---|---|
| `GET /templates` | List with type/active filters + item count |
| `POST /templates` | Create template |
| `GET /templates/:id` | Single template |
| `PUT /templates/:id` | Update template |
| `DELETE /templates/:id` | Soft deactivate |
| `GET /templates/:id/items` | List items, ordered by sort_order |
| `POST /templates/:id/items` | Add item |
| `PUT /templates/:id/items/:itemId` | Update item |
| `DELETE /templates/:id/items/:itemId` | Hard delete item |
| `POST /seed-defaults` | Seed 5 default templates (skips if already seeded) |
| `POST /templates/:id/apply` | Controlled apply — generates selected target outputs |

---

### Apply Logic

The `/apply` endpoint is the core of CB36. It:

1. Validates template, client, pack, and return ownership (all scoped to `req.companyId`)
2. Fetches all template items
3. For each item:
   - If `target_type = 'document_request'` and `create_document_requests = true`: creates `practice_document_requests` row
   - If `target_type = 'compliance_pack_item'` and `create_pack_items = true`: creates `practice_compliance_pack_items` row
   - If `target_type = 'individual_tax_item'` and `create_tax_items = true`: creates `practice_individual_tax_items` row
   - If `target_type = 'company_tax_item'` and `create_tax_items = true`: creates `practice_company_tax_readiness_items` row
4. **Duplicate guard**: checks existing titles/labels before inserting — skips items that already exist
5. Returns counts: `doc_requests_created`, `pack_items_created`, `tax_items_created`, `skipped`

**No silent automation.** The user explicitly chooses what to create and for which target objects.

---

### Field Mapping on Apply

| Template item field | → | document_request |
|---|---|---|
| `item_name` | → | `request_title` |
| `item_description` | → | `request_description` |
| `settings.document_category` | → | `document_category` (falls back to item_category mapping) |
| apply `due_date` or `default_due_offset_days` | → | `required_by_date` |

| Template item field | → | practice_compliance_pack_items |
|---|---|---|
| `item_name` | → | `item_name` |
| `item_description` | → | `item_description` |
| `settings.item_type` | → | `item_type` (falls back to 'document') |
| `required` | → | `required` |

| Template item field | → | practice_individual_tax_items |
|---|---|---|
| `item_name` | → | `item_label` |
| `settings.item_type` | → | `item_type` (falls back to 'document') |
| `item_description` | → | `notes` |

| Template item field | → | practice_company_tax_readiness_items |
|---|---|---|
| `item_name` | → | `item_name` |
| `settings.item_type` | → | `item_type` (falls back to 'supporting_document') |
| `required` | → | `required` |
| `item_description` | → | `notes` |

---

### Seed Defaults (5 templates)

All seeded with `is_default = true`. Check is by `template_type + template_name` to prevent duplicates.

1. **Individual Tax Return** (8 items: IRP5, medical, RA, travel, rental, investments, donations, business income)
2. **Company Tax Return** (6 items: signed AFS, tax computation, SARS statement, IRP6 history, assessed losses, dividends)
3. **Provisional Tax** (4 items: management accounts, prior assessment, income estimate, previous IRP6)
4. **Annual Financial Statements** (9 items: bank statements, trial balance, debtors, creditors, fixed assets, payroll, loans, inventory, VAT recon)
5. **VAT Period Return** (6 items: output tax invoices, input invoices, bank statements, output summary, input support, import docs)

---

### Frontend: `tax-checklists.html` + `tax-checklists.js`

**Template list** — table with name, type badge, client type, tax year, item count, status, and action buttons (Items, Apply, Edit, Deactivate).

**Create/Edit Template Modal** — name, type, client type, tax year, description.

**Template Item Editor** — expands below the table when "Items" is clicked. Shows all items with category, target type, required flag. Inline delete. "+ Add Item" opens item modal.

**Add Item Modal** — name, description, category, target type, document_category (shown for document_request target only), due offset, required checkbox.

**Apply Modal** — client, due date, three checkboxes (create doc requests / pack items / tax items), conditional selects for pack/individual return/company return.

---

### Router Mount + Nav

**`index.js`:** `router.use('/tax-checklists', taxChecklistsRouter);`

**`layout.js`:** `{ key: 'tax-checklists', label: 'Tax Checklists', href: '/practice/tax-checklists.html' }` (after Tax Actions)

---

## Multi-Tenant Safety

- All queries scoped by `req.companyId`
- All ownership validations use `verifyBelongsToCompany(cid, table, id)`
- No frontend `company_id` in request bodies
- Duplicate guards are client-scoped

## localStorage / KV

None. All data goes to/from the backend SQL tables.

---

## Migration Required

Run `085_practice_tax_checklist_templates.sql` in Supabase SQL Editor before using.

Expected: `Success. No rows returned`

---

## Files Created / Modified

| File | Change |
|---|---|
| `backend/config/migrations/085_practice_tax_checklist_templates.sql` | NEW |
| `backend/modules/practice/tax-checklists.js` | NEW — 11 endpoints |
| `backend/modules/practice/index.js` | MODIFIED — mounts taxChecklistsRouter |
| `backend/frontend-practice/tax-checklists.html` | NEW |
| `backend/frontend-practice/js/tax-checklists.js` | NEW |
| `backend/frontend-practice/js/layout.js` | MODIFIED — Tax Checklists nav entry |
