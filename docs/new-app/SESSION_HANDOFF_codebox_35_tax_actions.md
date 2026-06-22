# Session Handoff — Codebox 35: Tax Work Follow-Up Actions + Review Queue

**Date:** June 2026  
**Session:** CB35 implementation  
**Branch:** main (do not commit/push until migration is run)

---

## What Was Changed

### 1. Migration: `084_practice_tax_work_actions.sql` (NEW)
- `practice_tax_work_actions` — follow-up actions with full lifecycle tracking
- `practice_tax_work_action_events` — append-only audit log
- 7 indexes on actions table + 3 on events table
- **MUST BE RUN in Supabase SQL Editor before testing**

### 2. `backend/modules/practice/tax-actions.js` (NEW)
- 12 endpoints, all scoped to `req.companyId`
- Route ordering: literal routes before `/:id`, 3-segment before 2-segment
- Validates source ownership in `/from-dashboard-risk`
- Logs all state changes to `practice_tax_work_action_events`

### 3. `backend/modules/practice/tax-dashboard.js` (MODIFIED)
- Added `client_id` to SELECT in `/risk` endpoint for:
  - Overdue deadlines
  - Blocked individual returns
  - Blocked company returns
- Required so action modal can pass `client_id` to action creation API

### 4. `backend/modules/practice/index.js` (MODIFIED)
- Added: `const taxActionsRouter = require('./tax-actions'); router.use('/tax-actions', taxActionsRouter);`

### 5. `backend/frontend-practice/tax-dashboard.html` (MODIFIED — CB34→CB35)
- Added CSS for risk action buttons, review queue rows, action modal
- Added `title` attributes to all `<select>` elements (accessibility)
- Added Review Queue panel with filters `tdRqFltType`, `tdRqFltReviewer`
- Added Action Creation Modal with all required fields

### 6. `backend/frontend-practice/js/tax-dashboard.js` (REWRITTEN)
- `init()` now calls `LAYOUT.init('tax-dashboard')` (correct API)
- New: `_loadReviewQueue()` — fetches `/api/practice/tax-actions/review-queue`
- New: `tdLoadReviewQueue()` — public wrapper for filter onchange
- New: `tdOpenActionModal(sourceType, sourceId, clientId, title)` — pre-fills modal
- New: `tdCloseActionModal(evt)` — closes on overlay click
- New: `tdSubmitAction()` — POSTs to `/from-dashboard-risk`
- New: `tdRiskActionBtn(btn)` — reads `data-*` attrs, calls `tdOpenActionModal`
- Updated: `_loadRisk()` — risk rows now include `+ Action` button via `_riskBtn()`
- Updated: `tdRefreshAll()` — calls `_loadReviewQueue()` in parallel
- Updated: `_loadTeamMembersForFilter()` — populates modal member select + RQ reviewer filter

### 7. `backend/frontend-practice/tax-actions.html` (NEW)
- Standalone actions list page
- Dark-native CSS, filter bar, paginated list
- Script tags: polyfills.js → auth.js → api.js → layout.js → tax-actions.js

### 8. `backend/frontend-practice/js/tax-actions.js` (NEW)
- IIFE, `LAYOUT.init('tax-actions')` on boot
- `taComplete(btn)` / `taDismiss(btn)` — inline action buttons
- `taApplyFilters()`, `taPrevPage()`, `taNextPage()`, `taRefresh()` — all window-exported
- All API calls via `PracticeAPI.fetch()` — no localStorage

### 9. `backend/frontend-practice/js/layout.js` (MODIFIED)
- Added: `{ key: 'tax-actions', label: 'Tax Actions', href: '/practice/tax-actions.html' }` (after tax-dashboard)

---

## What Was NOT Changed

- No payroll files touched
- No auth middleware changed
- No other practice modules modified
- CB34 tax-dashboard read endpoints unchanged (only `client_id` addition to risk SELECT)

---

## Required Before Testing

1. **Run migration 084** in Supabase SQL Editor:
   ```sql
   -- paste contents of 084_practice_tax_work_actions.sql
   ```
   Expected: `Success. No rows returned`

2. **Restart backend** so `tax-actions.js` is loaded by `index.js`

3. **Test flow:**
   - Open Tax Dashboard → verify risk panels show `+ Action` and `Open →` buttons
   - Click `+ Action` on any risk item → modal opens pre-filled
   - Fill and submit → toast "Action created"
   - Navigate to Tax Actions page → action appears in list
   - Complete or Dismiss an action → status updates
   - Review Queue panel on Tax Dashboard → shows any items in `ready_for_review`

---

## Open Risks / Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: tax-actions.js — /assign-reviewer and /mark-ready-review endpoints
- Dependency: Source tables must have the expected status and reviewer fields
- Confirmed now: SOURCE_MAP covers all 7 source types with correct field names
- Not yet confirmed: Whether all source tables have reviewer_team_member_id column populated correctly
- Risk if not checked: assign-reviewer returns 400 "source type does not support reviewer assignment" for calc/pack types (this is intentional — they have no reviewer field)
- Recommended next check: Test assign-reviewer on individual_return and company_return only
```

```
FOLLOW-UP NOTE
- Area: Review Queue panel — /review-queue endpoint
- Dependency: Items must have status = ready_for_review in their respective tables
- Confirmed now: 7 parallel queries cover all source types
- Not yet confirmed: Whether existing data has any ready_for_review rows yet
- Risk if not checked: Queue may appear empty until work progresses to that status
- Recommended next check: Manually set one return to ready_for_review in Supabase, then verify it appears
```

---

## Codeboxes Status

| CB | Feature | Status |
|---|---|---|
| 34 | Tax Work Dashboard | Complete |
| 35 | Tax Work Actions + Review Queue | Complete — awaiting migration run |
| 36+ | TBD | — |
