# SESSION HANDOFF — Codebox 11: Client Billing Preparation + WIP Management

**Date:** 2026-06-19
**Status:** Code complete — migration 062 must be applied before using

---

## What Was Changed

### `backend/config/migrations/062_practice_billing_wip_management.sql` — NEW
- `practice_billing_packs` table (20 columns, 3 indexes)
- `practice_billing_pack_lines` table (14 columns, 4 indexes)
- 4 new columns on `practice_time_entries`:
  - `billing_pack_id INTEGER FK REFERENCES practice_billing_packs(id) ON DELETE SET NULL`
  - `billing_reviewed_at TIMESTAMPTZ`
  - `billing_reviewed_by INTEGER`
  - `writeoff_reason TEXT`
- 1 index on `practice_time_entries(billing_pack_id)`

### `backend/modules/practice/billing.js` — NEW
Full billing router. Key functions:
- `fetchPack(companyId, packId)` — ownership-safe pack fetcher
- `recalculatePack(companyId, packId)` — recomputes pack totals from lines (called after every line mutation)
- `verifyClient(companyId, clientId)` — ownership check before pack creation
- `GET /wip` — approved billable time entries not yet packed, grouped by client
- `POST /packs` — validates same-client constraint, approved-status constraint, no-double-pack constraint
- `GET /packs` — paginated list with client/status filters
- `GET /packs/:id` — pack + lines with joins to time_entries/tasks/workflow_runs
- `PUT /packs/:id` — update notes/proposed_invoice_value on non-locked/cancelled packs
- `PUT /packs/:id/lines/:lineId/writeoff` — write off with mandatory reason; updates time entry
- `PUT /packs/:id/lines/:lineId/exclude` — removes line from billing; returns time entry to WIP
- `PUT /packs/:id/recalculate` — explicit recalculate trigger
- `PUT /packs/:id/approve` — from draft/reviewed → approved
- `PUT /packs/:id/lock` — from approved → locked; marks all included time entries as 'billed'
- `DELETE /packs/:id` — cancel; returns included entries to approved; cannot cancel locked

### `backend/modules/practice/index.js` — ENHANCED
```javascript
const billingRouter = require('./billing');
// ...
router.use('/billing', billingRouter);
```

### `backend/frontend-practice/js/layout.js` — ENHANCED
Added `billing` nav item between `time` and `deadlines`:
```javascript
{ key: 'billing', label: 'Billing', href: '/practice/billing.html' }
```

### `backend/frontend-practice/billing.html` — NEW
- WIP Dashboard: 4 stat cards
- Two-panel: WIP entry list (left) + Create Pack form (right)
- Billing Packs list with status/client filters
- Pack Detail modal (lines, write-off/exclude, approve/lock/cancel)
- Write-off modal with required reason
- All inline styles replaced with CSS classes (zero inline style= attributes)
- `-webkit-user-select` vendor prefix added for Safari

### `backend/frontend-practice/js/billing.js` — NEW
Complete billing page logic. Key functions:
- `loadClients()` — populates all 3 client selects
- `loadBillingStats()` — WIP recoverable, open pack values, locked/written-off totals
- `loadWip()` — WIP list with expandable client sections
- `renderWip()` — renders expandable client cards with checkbox rows
- `toggleEntrySelection()` — enforces single-client constraint on selection
- `toggleClientEntries()` — select-all-for-client with same constraint
- `createPack()` — validates + POSTs + auto-opens new pack detail
- `loadPacks()` / `renderPacks()` — packs list table
- `openPackDetail()` / `renderPackDetail()` — pack modal with full line rendering
- `savePackNotes()`, `recalculatePack()`, `approvePack()`, `lockPack()`, `cancelPack()`
- `openWriteoffModal()`, `submitWriteoff()`, `excludeLine()`

### `backend/frontend-practice/css/practice.css` — ENHANCED
Added:
- `.badge-pack-draft/reviewed/approved/locked/cancelled` — 5 pack status badge variants
- `.badge-line-included/written_off/excluded` — 3 line status badge variants

---

## What Was NOT Changed
- `time.html`, `js/time.js` — unchanged (Codebox 10 work preserved)
- `tasks.html`, `js/tasks.js` — unchanged
- All existing time entry routes in `index.js` — unchanged
- `billing_status` on `practice_time_entries` — still authoritative
- Payroll module — not touched

---

## Audit Findings

### localStorage — CLEAN
- No business data in browser storage
- `localStorage.getItem('token')` in `api.js` — auth token only (permitted Rule D2)
- `localStorage.getItem('company')` in `layout.js` — company display name (UI preference, permitted)
- All billing pack data, WIP data, write-off decisions: DB-authoritative via API

### Multi-tenant safety — VERIFIED
- All billing routes: `req.companyId` from JWT
- `verifyClient()` checks client ownership before pack creation
- `time_entry_ids` verified against `req.companyId` in POST /packs
- `approved_by` / `created_by`: from `req.user.userId` only (never from body)
- Lines: all fetched with `company_id` filter

### Existing behaviour preserved
- All `time_entry` fields from Codebox 10 unchanged (`billing_status`, `approved_at`, etc.)
- `approve/submit-review/reject` time entry routes from Codebox 10 unchanged
- `GET /time-entries/wip` from Codebox 10 unchanged (different endpoint from `/billing/wip`)
- Existing `billable`, `rate` legacy columns unchanged

---

## Testing Steps

1. **Apply migration 062** in Supabase SQL editor. Check verification query output.

2. **Navigation:** Confirm 'Billing' tab appears in nav between Time and Deadlines.

3. **WIP page loads:**
   - Log in, go to Billing page
   - WIP stat cards appear (may show zeros if no approved time)
   - WIP list renders (or empty state)

4. **Create pack flow:**
   - On Time page, approve 2-3 time entries for same client
   - Go to Billing page → expand client in WIP list → check entries
   - Enter pack name, click Create Pack
   - Pack detail modal opens automatically
   - Confirm lines match selected entries

5. **Write-off:**
   - In pack detail, click Write Off on a line
   - Enter reason, submit
   - Line shows Written Off badge, writeoff_value appears in pack summary
   - Recalculate confirms totals updated

6. **Exclude:**
   - Click Exclude on a line
   - Line status → Excluded, entry disappears from billable totals
   - Go to Billing WIP — excluded entry reappears (billing_pack_id cleared)

7. **Approve + Lock:**
   - Approve pack → status → Approved, Approve button hidden, Lock button appears
   - Lock pack → confirm dialog
   - Status → Locked, time entries billing_status → 'billed'
   - Locked pack cannot be cancelled

8. **Cancel pack:**
   - Create another pack (do not approve)
   - Cancel it → entries return to WIP list

9. **Cross-company isolation:**
   - Log in as different company → confirm no packs or WIP visible from other company

10. **localStorage check:**
    - Open DevTools → Application → Local Storage
    - Confirm no billing_pack, WIP, or write-off data stored

---

## Remaining Risks / Follow-ups

- `practice_billing_packs.pack_number` column exists but is not auto-generated — future: sequential numbering per company
- `proposed_invoice_value` field: partner can set a different total; no enforcement against `billable_value`. This is intentional (discounts, fee caps) but no validation yet
- Bulk-approve/bulk-lock not yet built (per-pack only)
- `billing_reviewed_at` and `billing_reviewed_by` are set at lock time on time entries, not at the pack-line level
- Written-off entries retain `billing_pack_id` linkage until pack is cancelled — this is by design (audit trail) but could confuse the WIP filter if not handled
- No pagination on WIP entries yet (loads all approved entries) — could be slow for practices with large backlogs
