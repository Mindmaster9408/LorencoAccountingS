# Codebox 03 — Implementation Report
**Date:** June 2026

---

## FILES CREATED / MODIFIED

| File | Action | Purpose |
|---|---|---|
| `database/migrations/052_inventory_stock_counts.sql` | **CREATED** | DB schema: 3 tables, 9 indexes |
| `backend/modules/inventory/services/stockCountService.js` | **CREATED** | All count business logic (7 functions) |
| `backend/modules/inventory/routes/stock-counts.js` | **CREATED** | Express router (9 endpoints) |
| `backend/modules/inventory/routes/reports.js` | **MODIFIED** | Added 2 new report endpoints |
| `backend/modules/inventory/index.js` | **MODIFIED** | Mounted `/stock-counts` sub-router |
| `frontend-inventory/index.html` | **MODIFIED** | New tab, section, 3 modals, JS functions |

---

## SERVICE LAYER — `stockCountService.js`

### `createCountSession(supabase, companyId, options)`
Creates session + immediately generates lines. Rolls back session row if line generation fails.  
Returns `{ success, session, lines, line_count }`.

### `generateCountLines(supabase, companyId, sessionId, options)`
Snapshots `current_stock` and `average_cost` from `inventory_items` into `stock_count_lines`.  
Supports modes: `full` / `category` / `low_stock` / `items`.  
Returns `{ success, lines, count }`.

### `updateCountLine(supabase, companyId, sessionId, lineId, options)`
Updates `counted_quantity`, `variance_reason`, `variance_notes` for a single line.  
Only allowed when session status is `draft` or `in_progress`.

### `submitCount(supabase, companyId, sessionId, userId)`
Validates all lines have `counted_quantity` (non-null).  
Calculates `variance_quantity = counted − system` and `variance_value = variance × average_cost`.  
Sets `status = 'submitted'` and records `submitted_at`.

### `approveCountSession(supabase, companyId, sessionId, userId, action, notes)`
Inserts immutable record into `stock_count_approvals`.  
Maps actions: `approved→'approved'`, `rejected→'rejected'`, `recount_required→'in_progress'`.  
Sets `approved_by`, `approved_at` on session.

### `applyApprovedVariance(supabase, companyId, sessionId, userId)`
**Critical function.** Idempotency guard via conditional `UPDATE WHERE status='approved'`.  
For each line where `variance_quantity ≠ 0`:
- Positive variance → `adjustStockTx(..., 'count_adjustment_in', ...)`
- Negative variance → `adjustStockTx(..., 'count_adjustment_out', ...)`
- Zero → skipped  

Returns `{ success, applied, skipped, failed, results }`.

### `getCountSession(supabase, companyId, sessionId)`
Fetches session + lines + approvals.  
**Blind count enforcement:** if `blind_count=true` AND status not in `[submitted, approved, rejected, applied]`, sets `system_quantity`, `variance_quantity`, `variance_value` to `null` in response.

---

## ROUTE LAYER — `stock-counts.js`

| Method | Path | Service call |
|---|---|---|
| GET | `/` | Direct DB query (with filters + line_count, counted_count) |
| POST | `/` | `createCountSession()` |
| GET | `/:id` | `getCountSession()` |
| PATCH | `/:id/lines/:lineId` | `updateCountLine()` |
| POST | `/:id/submit` | `submitCount()` |
| POST | `/:id/approve` | `approveCountSession()` |
| POST | `/:id/apply` | `applyApprovedVariance()` |
| GET | `/:id/history` | Direct query on `stock_movements WHERE source_type='stock_count'` |
| DELETE | `/:id` | Cancel (only draft/in_progress) |

All routes: `const { companyId } = req;` before any DB call. No exceptions.

---

## REPORT ENDPOINTS — `reports.js`

### `GET /reports/stock-counts`
Returns list of sessions with:
- `line_count`, `counted_count`, `variant_count` (lines with variance ≠ 0), `total_variance_value`
- Summary: `applied_count`, `pending_count`, `total_variance_value` across all sessions

### `GET /reports/variance-summary`
Applied sessions only. Aggregates:
- `by_reason` — group by `variance_reason`, sum of `variance_value`
- `by_item_type` — group by `item_type` (joined from `inventory_items`)
- `top_variance_items` — top 10 items by absolute variance value

---

## FRONTEND ADDITIONS — `index.html`

### Nav
Added after Reports tab: `<div class="nav-tab teal" onclick="switchTab('stockcounts')">📦 Stock Counts</div>`

### Section
`id="tab-stockcounts"` — follows existing `.section` / `.section.active` pattern.  
Includes: status filter dropdown, Refresh button, Start Count button, summary info bar, sessions table.

### Modals
1. `startCountModal` — Create session form (type, warehouse, mode, category/items, blind_count, notes)
2. `countLinesModal` — Full-width table of lines with qty inputs, reason selects, save buttons per line; submit button
3. `approveCountModal` — Action select + notes textarea

### JS Functions
- `loadCountSessions()` — GET /stock-counts, renders sessions table
- `openStartCountModal()` — populates warehouse select, opens modal
- `submitStartCount(e)` — POST /stock-counts
- `openCountLinesModal(sessionId)` — GET /stock-counts/:id, renders lines
- `renderCountLines(...)` — renders count line table with blind-count awareness
- `saveCountLine(sessionId, lineId)` — PATCH /lines/:lineId
- `_submitCountFromModal()` — calls `submitCountSession` for current modal session
- `submitCountSession(sessionId)` — POST /:id/submit
- `openApproveModal(sessionId, sessionNumber)` — opens approve modal
- `submitApproval(e)` — POST /:id/approve
- `applyCountVariance(sessionId)` — POST /:id/apply (with confirmation)
- `cancelCountSession(sessionId)` — DELETE /:id (with confirmation)
