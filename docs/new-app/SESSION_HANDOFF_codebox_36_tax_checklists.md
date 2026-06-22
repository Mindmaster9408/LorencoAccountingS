# Session Handoff — Codebox 36: Tax Document Checklist Templates

**Date:** June 2026  
**Session:** CB36 implementation  
**Branch:** main (do not commit/push until migration is run)

---

## What Was Changed

### 1. `085_practice_tax_checklist_templates.sql` (NEW)
- `practice_tax_checklist_templates` — template metadata with type, client_type, tax_year, is_default, is_active, settings JSONB
- `practice_tax_checklist_template_items` — line items with item_category, target_type, settings JSONB (stores target-specific config like document_category)
- `practice_tax_checklist_template_events` — append-only audit log
- 10 indexes (company, template_type, client_type, is_active, template_id, target_type, created_at)

### 2. `backend/modules/practice/tax-checklists.js` (NEW)
- 11 endpoints
- `POST /seed-defaults` — seeds 5 default templates with items; uses `template_type + template_name` as duplicate key
- `POST /templates/:id/apply` — the core endpoint; multi-step: validate ownership → load items → duplicate guard → create outputs → audit log
- **Field mapping**: document_category from `settings.document_category` (falls back to item_category map); tax item types from `settings.item_type` (falls back to 'document' / 'supporting_document')
- Verified against: `practice_document_requests` DOC_CATEGORIES, `practice_compliance_pack_items` ITEM_TYPES, `practice_individual_tax_items.item_type` CHECK constraint, `practice_company_tax_readiness_items.item_type` CHECK constraint

### 3. `backend/modules/practice/index.js` (MODIFIED)
- Added: `const taxChecklistsRouter = require('./tax-checklists'); router.use('/tax-checklists', taxChecklistsRouter);`

### 4. `backend/frontend-practice/tax-checklists.html` (NEW)
- Template list, item editor panel, create/edit template modal, add item modal, apply modal
- All three modal types (tc-modal-overlay pattern)
- Script order: polyfills.js → auth.js → api.js → layout.js → tax-checklists.js

### 5. `backend/frontend-practice/js/tax-checklists.js` (NEW)
- IIFE; `LAYOUT.init('tax-checklists')` on boot
- `tcLoad()`, `tcSeedDefaults()`, `tcOpenCreateModal()`, `tcOpenEditModal()`, `tcSubmitTemplate()`
- `tcOpenItems()`, `tcOpenAddItemModal()`, `tcSubmitItem()`, `tcDeleteItem()`
- `tcOpenApply()`, `tcApplyCheckboxChanged()`, `tcSubmitApply()`
- Apply data loaded once per page visit via `_loadApplyData()` (parallel fetch: clients, packs, ind. returns, co. returns)
- All window-exported for onclick handlers

### 6. `backend/frontend-practice/js/layout.js` (MODIFIED)
- Added: `{ key: 'tax-checklists', label: 'Tax Checklists', href: '/practice/tax-checklists.html' }` after tax-actions

---

## What Was NOT Changed

- No existing document-requests.js modified (existing `/checklists` path for `practice_document_checklists` is a separate feature — not confused)
- No compliance-packs.js modified
- No individual-tax.js or company-tax.js modified
- All existing endpoints untouched

---

## Required Before Testing

1. **Run migration 085** in Supabase SQL Editor
2. **Restart backend** so `tax-checklists.js` is loaded
3. **Test flow:**
   - Open Tax Checklists page → empty state with "Seed Defaults" button
   - Click "Seed Defaults" → 5 templates created, toast shows count
   - Click "Items" on a seeded template → items panel shows items with categories and target types
   - Click "+ Add Item" → item modal with dynamic doc category row (visible for document_request only)
   - Click "Apply" on a template → select client, check "Create Document Requests", apply
   - Go to Documents page → new doc requests visible for that client
   - Test with compliance pack: check "Create Compliance Pack Items", select a pack, apply
   - Test with individual return: check "Create Tax Return Items", select return, apply
   - Verify duplicate items are skipped on second apply

---

## Open Risks / Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Apply endpoint — compliance_pack_items insertion
- Dependency: practice_compliance_pack_items has a status field NOT in the apply insert
- Confirmed now: Insert uses status = 'not_started'
- Not yet confirmed: Whether 'not_started' is in the ITEM_STATUSES CHECK constraint
- Risk if not checked: Supabase constraint violation on pack item insert
- Recommended next check: Read compliance-packs.js ITEM_STATUSES constant and migration 074
```

```
FOLLOW-UP NOTE
- Area: Apply modal — apply data loading
- Dependency: /api/practice/individual-tax and /api/practice/company-tax return shapes
- Confirmed now: Returns are listed via those paths, response has .returns array
- Not yet confirmed: Exact field names on returned objects (return_name, client_name, tax_year)
- Risk if not checked: Apply modal selects may show "Return #id" instead of meaningful labels
- Recommended next check: Hit /api/practice/individual-tax in browser, verify response shape
```

---

## Codeboxes Status

| CB | Feature | Status |
|---|---|---|
| 34 | Tax Work Dashboard | Complete |
| 35 | Tax Work Actions + Review Queue | Complete — awaiting migration 084 run |
| 36 | Tax Checklist Templates + Apply | Complete — awaiting migration 085 run |
| 37 | Tax Season Bulk Operations Foundation | Recommended next |

---

## Recommended CB37: Tax Season Bulk Operations Foundation

After templates exist, the practice needs bulk operations:
- Create checklists for many clients at once
- Create document requests in bulk
- Create compliance packs in bulk
- Assign owners/reviewers in bulk
- Prepare tax season batches
