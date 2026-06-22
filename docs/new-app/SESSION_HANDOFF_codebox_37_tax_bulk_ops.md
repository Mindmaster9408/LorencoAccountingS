# Session Handoff — Codebox 37: Tax Season Bulk Operations

**Date:** June 2026  
**Session:** CB37 implementation  
**Branch:** main (do not commit/push until migration is run)

---

## What Was Changed

### 1. `086_practice_tax_bulk_operations.sql` (NEW)
- `practice_tax_bulk_operations` — main operation with source_filter, options, preview_snapshot, result_summary in JSONB
- `practice_tax_bulk_operation_items` — per-client result rows with item_status CHECK constraint (pending/success/warning/skipped/failed)
- `practice_tax_bulk_operation_events` — append-only audit log
- 13 indexes (company, operation_type, operation_status, tax_year, created_at, operation_id, client_id, item_status)

### 2. `backend/modules/practice/tax-bulk-operations.js` (NEW)
- 8 endpoints (GET /, POST /preview, POST /, GET /:id, GET /:id/items, GET /:id/events, POST /:id/execute, PUT /:id/cancel)
- Route ordering: `/preview` (POST, literal) before `GET /:id`; `/:id/items`, `/:id/events`, `/:id/execute`, `/:id/cancel` before `/:id`
- `buildPreviewData()` — client filter with 5 complex filter paths (provisional_taxpayer, has_taxpayer_profile, has_active_engagement, missing_compliance_pack, base filters)
- `executeOperation()` — per-client loop with full failure isolation; bulk insert of item rows at end
- Sub-functions: `_executeCreatePack`, `_executeApplyChecklist`, `_executeCreateDocRequests`, `_executeAssignOwner`, `_executeAssignReviewer`, `_executeCreateAction`
- Key: `practice_document_requests` uses `request_status` (not `status`) with initial value `'requested'`
- Key: compliance packs have `status = 'draft'`, `readiness_status = 'unknown'` on create
- Key: tax actions have `action_status = 'open'`

### 3. `backend/modules/practice/index.js` (MODIFIED)
- Added: `const taxBulkOperationsRouter = require('./tax-bulk-operations'); router.use('/tax-bulk-operations', taxBulkOperationsRouter);`

### 4. `backend/frontend-practice/tax-bulk-operations.html` (NEW)
- Operations list table + filter bar
- 5-step wizard (type → filters → options → preview → execute)
- Step indicator pills
- 7 operation type cards
- Options sections shown/hidden by op type
- Preview content area + result stats + per-client result table
- Items panel (appears on "Results" click from list)
- Script order: polyfills.js → auth.js → api.js → layout.js → tax-bulk-operations.js

### 5. `backend/frontend-practice/js/tax-bulk-operations.js` (NEW)
- IIFE; `LAYOUT.init('tax-bulk-ops')` on boot
- `_load()` — loads operations list
- `tboNewOp()` — opens wizard, resets state
- `tboSetOpType()` — selects op type card, updates `_selectedOpType`
- `tboPreview()` — POST /preview, renders preview table
- `tboSaveAndContinue()` — POST / with preview_snapshot, moves to step 5
- `tboExecute()` — POST /:id/execute, renders per-client results
- `tboExecuteExisting()` — execute from list row
- `tboViewItems()` — GET /:id/items, shows items panel
- `tboCancel()` — PUT /:id/cancel

### 6. `backend/frontend-practice/js/layout.js` (MODIFIED)
- Added: `{ key: 'tax-bulk-ops', label: 'Tax Bulk Ops', href: '/practice/tax-bulk-operations.html' }` after tax-checklists

---

## What Was NOT Changed

- `tax-checklists.js` not modified — apply logic was replicated inline in `_executeApplyChecklist`
- `compliance-packs.js` not modified — pack creation uses same field names verified directly
- `tax-actions.js` not modified — action creation uses verified table/field names
- `individual-tax.js`, `company-tax.js` not modified — reviewer update queries go direct to DB tables

---

## Important Field Verifications Before Coding

| Table | Field used | Verified from |
|---|---|---|
| `practice_document_requests` | `request_status = 'requested'` | document-requests.js line 271 |
| `practice_compliance_packs` | `status = 'draft'`, `readiness_status = 'unknown'` | compliance-packs.js POST handler |
| `practice_tax_work_actions` | `action_status = 'open'` | tax-actions.js line 279 |
| `practice_individual_tax_returns` | has `reviewer_team_member_id` | migration 077 line 40 |
| `practice_company_tax_returns` | has `reviewer_team_member_id` | migration 081 line 41 |
| `practice_compliance_packs` | PACK_TYPES confirmed | compliance-packs.js lines 17-20 |
| `practice_tax_work_actions` | ACTION_TYPES confirmed | tax-actions.js lines 21-25 |

---

## Required Before Testing

1. **Run migration 086** in Supabase SQL Editor
2. **Also ensure 084 and 085 are run** if not yet done (tax actions + checklist templates)
3. **Restart backend** so `tax-bulk-operations.js` is loaded
4. **Test flow:**
   - Open Tax Bulk Ops page → operations list shows empty state
   - Click "+ New Operation"
   - Step 1: select "Create Compliance Packs" → click Next
   - Step 2: set tax year 2025 → check "Missing compliance pack" → click Next
   - Step 3: select pack type "Individual Tax" → click "Preview Clients"
   - Step 4: preview shows client list + estimated outputs
   - Click "Save & Continue" → step 5 opens with operation summary
   - Click "Execute Now" → per-client results table appears
   - Verify compliance packs created in Compliance Packs page
   - Test "Results" button on operations list
   - Test "apply_tax_checklist" with a seeded default template
   - Verify duplicate prevention: run same operation again → all skipped

---

## Open Risks / Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: apply_tax_checklist in bulk — compliance_pack_items and tax_items skipped
- Dependency: bulk apply needs per-client pack ID / return ID for non-doc targets
- Confirmed now: Only document_request target type items are created in bulk
- Not yet confirmed: Whether users will find this confusing in practice
- Risk if not checked: User expects all template items to be applied
- Recommended next check: Add bulk mode note to template item editor UI
```

```
FOLLOW-UP NOTE
- Area: _executeAssignReviewer — returns may not exist for all clients
- Dependency: Returns are per-year; if no return for tax_year exists, no update occurs
- Confirmed now: Loop handles empty result gracefully
- Not yet confirmed: User expects "0 assignments" for clients without returns
- Risk if not checked: "0 assignments" looks like a failure but is expected
- Recommended next check: Add better message for zero-return clients
```

```
FOLLOW-UP NOTE
- Area: Preview vs execute client list drift
- Dependency: Clients may be added/changed between preview and execute
- Confirmed now: Execute re-fetches clients from DB using preview_snapshot.clients ids
- Not yet confirmed: Whether this is acceptable or whether a staleness warning is needed
- Risk if not checked: New clients added after preview are not included; deleted clients get skipped gracefully
- Recommended next check: Consider adding preview_snapshot timestamp check at execute time
```

---

## Codeboxes Status

| CB | Feature | Status |
|---|---|---|
| 34 | Tax Work Dashboard | Complete |
| 35 | Tax Work Actions + Review Queue | Complete — awaiting migration 084 |
| 36 | Tax Checklist Templates + Apply | Complete — awaiting migration 085 |
| 37 | Tax Bulk Operations Foundation | Complete — awaiting migration 086 |
| 38 | Tax Season Progress Reporting | Recommended next |

---

## Recommended CB38: Tax Season Progress Reporting + Partner Summary Foundation

After bulk operations exist, managers need to track progress:
- Tax season progress % by client, reviewer, type
- Outstanding document requests by client/deadline
- Returns by status (outstanding, in review, completed)
- Compliance packs by readiness score
- Reviewer workload: how many returns per reviewer
- Partner/client group summary dashboards
- Export to CSV for partner review meetings
