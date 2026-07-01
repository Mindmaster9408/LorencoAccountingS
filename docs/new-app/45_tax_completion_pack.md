# Codebox 45 — Tax Compliance Finalization + Completion Evidence Pack

> Module: Practice Management — Tax Completion
> Status: Complete (migration 103 not yet applied to Supabase)
> Migration: 103
> Routes: `/api/practice/tax-completion/*`

---

## Purpose

Provides the final quality-control gate before a tax matter is marked complete.
The practice team must:
1. Tick off a checklist of required evidence/actions
2. Submit the pack for partner review
3. Have the partner approve it
4. Pass all quality gate checks (or override soft blocks with reason)
5. Complete the pack — which freezes an immutable completion snapshot

**This is NOT SARS integration. NOT document storage. NOT eFiling.**
All data is internal practice-management state only.

---

## Migration 103

### `practice_tax_completion_packs` — one pack per tax matter

| Field | Notes |
|---|---|
| `source_type` | `individual_tax`, `company_tax`, `provisional_tax`, `vat`, `payroll` |
| `pack_status` | 5-value machine: `draft → review_pending → approved → completed / cancelled` |
| `completion_score` | 0–100 integer (% of required items marked complete) |
| `completion_snapshot` | JSONB frozen at completion — immutable once set |
| `settings` | JSONB — stores `partner_overrides` array |
| `approved_by / approved_at` | Set by the `approve` endpoint |
| `completion_date` | DATE — set at completion |

Auto-updates `updated_at` via `tg_ptcp_updated_at` trigger.

### `practice_tax_completion_items` — checklist per pack

Each item has `item_type` (12 values), `item_name` (free text), `required`, `completed`, `completed_at`, `completed_by`, `notes`, `sort_order`.

### `practice_tax_completion_events` — append-only audit log

Never updated or deleted. 7-year retention.

---

## Backend — `tax-completion.js`

### Endpoints (18 total)

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Status counts + low-score + near-complete counts |
| GET | `/` | Paginated list with filters + client name enrichment |
| POST | `/create-from-submission` | Create pack linked to submission; auto-generates default items; duplicate guard (409) |
| POST | `/` | Manual create (no auto-items) |
| GET | `/:id` | Single pack with checklist items + quality gate blocks |
| PUT | `/:id` | Update non-status fields (review_notes, partner_notes, completion_summary) |
| DELETE | `/:id` | Soft cancel (blocks if already completed) |
| POST | `/:id/generate-default-items` | Generate default checklist for source_type (409 if items exist) |
| POST | `/:id/recalculate-score` | Recompute completion_score from items and save |
| PUT | `/:id/submit-review` | Status: draft → review_pending |
| PUT | `/:id/approve` | Status: review_pending → approved; sets approved_by + approved_at |
| PUT | `/:id/complete` | Status: approved → completed; runs quality gate; builds snapshot |
| PUT | `/:id/partner-override` | Add/replace partner override for a specific soft block type |
| GET | `/:id/items` | List checklist items |
| POST | `/:id/items` | Add item; recalculates score |
| PUT | `/:id/items/:itemId` | Update item; mark complete/incomplete; recalculates score |
| DELETE | `/:id/items/:itemId` | Remove item; recalculates score |
| GET | `/:id/events` | Append-only event log |

### State Machine

```
draft → review_pending → approved → completed
          (any) → cancelled (except completed)
```

Terminal states: `completed`, `cancelled`. All transitions block from terminal states.

### Quality Gate (PUT /:id/complete)

**Hard blocks — cannot be overridden:**
- `incomplete_checklist`: `completion_score < 100`
- `not_approved`: `pack_status !== 'approved'`

**Soft blocks — partner override allowed:**
- `outstanding_payments`: payable direction with status `outstanding` or `partially_paid`; or refundable direction with status `refund_pending`
- `unmatched_sars_lines`: statement lines with status `unmatched` or `disputed`
- `open_disputes`: dispute cases with status outside `accepted`, `rejected`, `completed`, `cancelled`

Partner overrides stored in `settings.partner_overrides[]` as `{override_type, reason, user_id, timestamp}`.
Each override type can only have one entry (replace-not-append).

### Completion Snapshot (JSONB — frozen at completion)

Contains:
- `frozen_at`, `frozen_by`, pack metadata, score, approver
- `checklist_items[]` — all items with completion state
- `partner_overrides[]` — any overrides used
- `payments_at_completion[]` — payment records at the time of completion
- `sars_recon_at_completion` — matched/unmatched/disputed counts
- `disputes_at_completion[]` — dispute cases at time of completion

Snapshot is set once and never modified.

### Default Checklist Items by Source Type

| Source Type | Items |
|---|---|
| `individual_tax` | Submission Proof, Assessment, Payment/Refund, SARS Recon, Supporting Docs, Working Papers, Partner Review |
| `company_tax` | above + AFS Review, Tax Adjustments Review |
| `provisional_tax` | Submission Proof, Tax Calculation, Payment Handling, Working Papers, Partner Review |
| `vat` | VAT201 Submission, Payment/Refund, SARS Recon, Input/Output Recon, Working Papers (optional), Partner Review |
| `payroll` | EMP201/EMP501, PAYE Payment, UIF/SDL Payment, EMP Recon, Working Papers (optional), Partner Review |

### Multi-Tenant Safety

Every query scoped to `req.companyId`. `_verifyPack` and `_verifyItem` re-check ownership before every action. Client ownership verified on create. Supabase queries never return cross-company data.

### Score Calculation

```javascript
required = items WHERE required = true
done     = items WHERE required = true AND completed = true
score    = required.length === 0 ? 100 : Math.round(done.length / required.length * 100)
```

Score is recalculated and saved to DB on every item add, update, or delete.

---

## Integration

### Tax Submissions Frontend (`tax-submissions.js`)

`_renderFooter` now appends a **Completion Pack ↗** link (green) after the existing Open Disputes ↗ link. Opens `/practice/tax-completion.html?submission_id=<id>`.

### `index.js` Mount

```javascript
const taxCompletionRouter = require('./tax-completion');
router.use('/tax-completion', taxCompletionRouter);
```

Mounted after `/tax-disputes` block, before `/dashboard`.

### `layout.js` Nav

"Tax Completion" entry added between "Tax Disputes" and "Tax Config".

---

## Frontend — `tax-completion.html` + `js/tax-completion.js`

### Page

- Summary cards (Draft, Review Pending, Approved, Completed, Low Score, Near Complete) — clickable to filter
- Filter bar: status, source type, client ID, submission ID, active-only checkbox
- Paginated packs table with inline score progress bar
- Create Pack modal (client ID, source type, optional submission ID)
- Pack Detail modal: 2 tabs (Checklist & Status / Events)
  - **Checklist tab**: pack overview grid, quality gate panel, score progress bar, interactive item checklist, inline add-item form, partner/review notes
  - **Events tab**: append-only event log
- Partner Override modal: reason input, records override in DB
- Context-sensitive footer: Submit for Review → Approve → Complete → Cancel Pack

### Quality Gate Display

- Hard blocks: red panel with non-overridable error messages
- Soft blocks: amber panel with per-block Override button → opens override modal
- After override: shows green "Overrides applied" panel with reason

### No localStorage / KV

Zero browser storage usage. All state from server. `node --check` passed on both files.

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/103_practice_tax_completion_packs.sql` | 3 tables + triggers + indexes |
| `backend/modules/practice/tax-completion.js` | Backend router — 18 endpoints |
| `backend/frontend-practice/tax-completion.html` | Frontend page |
| `backend/frontend-practice/js/tax-completion.js` | Frontend IIFE (`tc` prefix) |
| `docs/new-app/45_tax_completion_pack.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_45_tax_completion.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Mount tax-completion router after tax-disputes |
| `backend/frontend-practice/js/layout.js` | Add "Tax Completion" nav between Tax Disputes and Tax Config |
| `backend/frontend-practice/js/tax-submissions.js` | Add "Completion Pack ↗" link to `_renderFooter` |
