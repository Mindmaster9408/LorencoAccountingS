# SESSION HANDOFF — Codebox 13: Billing Pack Numbering + Billing Controls

**Date:** 2026-06-20
**Status:** Code complete — apply migration 064 in Supabase before using

---

## What Was Changed

### `backend/config/migrations/064_practice_billing_controls.sql` — NEW
- 7 new columns on `practice_billing_packs`: `approved_at`, `approved_by`, `locked_at`, `locked_by`, `cancelled_at`, `cancelled_by`, `billing_period_key`
- 2 new indexes on `practice_billing_packs`: `idx_billing_packs_pack_number`, `idx_billing_packs_period_key`
- New table `practice_billing_pack_events` (10 columns)
- 4 indexes on `practice_billing_pack_events`
- Verification queries included at end of file

### `backend/modules/practice/billing.js` — ENHANCED

**New helper functions (added after `verifyClient`):**
- `generatePackNumber(companyId)` — sequential `BP-YYYY-NNNNNN` per company, app-level sequencing
- `buildPeriodKey(clientId, periodStart, periodEnd)` — returns `clientId_start_end` or null
- `logPackEvent(companyId, packId, eventType, opts)` — non-fatal event log to `practice_billing_pack_events`

**POST /packs — enhanced:**
- Period validation: period_end < period_start → 409 error
- Duplicate check: active pack for same `billing_period_key` → 409 with pack reference
- `pack_number` generated via `generatePackNumber()` — added to insert payload
- `billing_period_key` added to insert payload
- `logPackEvent('pack_created')` + `logPackEvent('pack_number_assigned')` after creation
- `auditFromReq` now includes `pack_number` in metadata

**PUT /packs/:id/lines/:lineId/writeoff — enhanced:**
- `logPackEvent('pack_line_written_off')` added before existing `auditFromReq`

**PUT /packs/:id/lines/:lineId/exclude — enhanced:**
- `logPackEvent('pack_line_excluded')` added before existing `auditFromReq`

**PUT /packs/:id/recalculate — enhanced:**
- `logPackEvent('pack_recalculated')` added before existing `auditFromReq`

**PUT /packs/:id/approve — enhanced:**
- Guard: requires at least one included line before approving (new `lineCheck` query)
- Auto-recalculate before approving (calls `recalculatePack()`)
- Update now sets `approved_at = now()` and `approved_by = actor`
- `logPackEvent('pack_approved')` added with status transition

**PUT /packs/:id/lock — enhanced:**
- Update now sets `locked_at = now()` and `locked_by = actorId`
- `logPackEvent('pack_locked')` added with locked_entries count in metadata

**DELETE /packs/:id (soft cancel) — enhanced:**
- Update now sets `cancelled_at = now()` and `cancelled_by = cancelActor`
- `logPackEvent('pack_cancelled')` added with returned_entries count

**New endpoint — GET /packs/:id/history:**
- Verifies pack ownership via `fetchPack(companyId, id)`
- Returns all `practice_billing_pack_events` for the pack, ordered by `created_at DESC`
- Response: `{ events, pack_id, pack_number }`

### `backend/frontend-practice/billing.html` — ENHANCED

**New CSS in `<style>` block:**
- `.pack-status-banner` + `.banner-draft/reviewed/approved/locked/cancelled`
- `.modal-md`, `.history-event`, `.history-event-type`, `.history-event-status`, `.history-event-meta`

**`#packStatusBanner` element:**
- Added above `#packDetailSummary` in pack detail modal body
- Initially has class `hidden`; `renderPackDetail()` replaces className and sets text

**History button:**
- Added between Close and Save Notes in `packDetailActions`
- `onclick="openHistoryModal()"`

**`#historyModal` — new modal:**
- Added before `<script>` tags
- `#historyList` div — content injected by `renderPackHistory()`

### `backend/frontend-practice/js/billing.js` — ENHANCED

**New constant after `LINE_STATUS_LABELS`:**
- `EVENT_TYPE_LABELS` — 9 human-readable event type labels

**`renderPacks()` — updated:**
- Added "Ref" column (pack_number, muted style) as first column

**`renderPackDetail()` — updated:**
- Subtitle now shows `pack_number · clientName · status` (joined with ·)
- Status banner: sets `bannerEl.className` and `.textContent` based on pack status; includes formatted dates for approved/locked/cancelled

**New functions:**
- `openHistoryModal()` — shows modal, fetches `/history`, calls `renderPackHistory()`
- `renderPackHistory(events)` — renders `.history-event` blocks with label, status transition, notes, timestamp, actor

### `backend/frontend-practice/css/practice.css` — ENHANCED
- Added `.pack-status-banner` + 5 variant classes (shared for any future page)
- Added `.history-event`, `.history-event-type`, `.history-event-status`, `.history-event-meta`

---

## What Was NOT Changed
- All 11 original Codebox 11 billing routes: logic unchanged (only added `logPackEvent` calls + new columns to update blocks)
- 3 Codebox 12 report endpoints: unchanged
- `EDITABLE_STATUSES` = `['draft', 'reviewed']`: unchanged — write-off/exclude blocked on approved+locked+cancelled (intentionally stricter than spec's "after lock" wording)
- Payroll module: not touched

---

## Audit Findings

### localStorage — CLEAN
- `openHistoryModal()`: uses `PracticeAPI.fetch()` — no localStorage
- Status banner renders from API response — no localStorage
- Pack number renders from API response — no localStorage
- No numbering, controls, or history state in browser storage

### Multi-tenant safety — VERIFIED
- `generatePackNumber()` filters `company_id = req.companyId` — no cross-company number pollution
- Period duplicate check filters `company_id = req.companyId`
- `logPackEvent()` inserts with `company_id = companyId` (passed from `req.companyId`)
- `GET /history` gates on `fetchPack(companyId, id)` — 404 for wrong company

### Existing behaviour preserved
- All Codebox 11 + 12 routes: existing logic intact; only additions made (new fields, new event calls)
- `fetchPack()` + `recalculatePack()` + `verifyClient()` helpers: unchanged
- `EDITABLE_STATUSES` constant: unchanged
- Existing `auditFromReq` calls: all preserved (logPackEvent is additive)

---

## Migration Verification SQL

After applying 064, run these in Supabase SQL editor to verify:

```sql
-- 1. New columns on practice_billing_packs (expect 7 rows)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'practice_billing_packs'
  AND column_name IN (
    'approved_at', 'approved_by', 'locked_at', 'locked_by',
    'cancelled_at', 'cancelled_by', 'billing_period_key'
  )
ORDER BY column_name;

-- 2. New table exists (expect 1 row)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'practice_billing_pack_events';

-- 3. Indexes (expect billing-related indexes)
SELECT indexname FROM pg_indexes
WHERE tablename IN ('practice_billing_packs', 'practice_billing_pack_events')
  AND indexname LIKE '%billing%'
ORDER BY indexname;
```

---

## Testing Steps

1. Apply migration 064 in Supabase SQL editor
2. Run verification SQL above
3. Restart backend server
4. Create a new billing pack → check Supabase: `pack_number = BP-YYYY-000001`, `billing_period_key` set
5. Create second pack for same company → `BP-YYYY-000002`
6. Billing packs list: verify "Ref" column shows pack numbers
7. Pack detail subtitle: verify format `BP-YYYY-000001 · ClientName · Draft`
8. Status banner: correct colour for current pack status
9. Try approving empty pack (all lines written off) → expect error "no included lines"
10. Approve a valid pack → `approved_at` set in DB; banner shows "Approved [date] — ready to lock"
11. Lock pack → `locked_at` set in DB; banner shows "Locked [date]"
12. Click History → events listed: pack_created, pack_number_assigned, pack_approved, pack_locked
13. Cancel a draft pack → `cancelled_at` set; banner shows "Cancelled [date]"
14. Try same period again → should succeed (cancelled pack excluded from duplicate check)
15. Try creating pack with period_end before period_start → expect 400 "period_end cannot be before period_start"
16. DevTools → Local Storage → no history, numbering, or controls data

---

## Remaining Risks

- `generatePackNumber()`: app-level sequencing; race condition possible under very high concurrent creation (not realistic for this app)
- `billing_period_key`: app-level uniqueness check only; no DB constraint; same race condition caveat
- History modal shows `User {id}` not name — acceptable for now; future: join users table
- `logPackEvent()` is non-fatal fire-and-forget; silent failures possible under DB stress
- `report_version` from migration 063 still not auto-incremented on pack updates
