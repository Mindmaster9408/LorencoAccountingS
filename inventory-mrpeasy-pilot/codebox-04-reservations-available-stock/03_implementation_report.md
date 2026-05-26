# Codebox 04 — Implementation Report

## Files Created

### 1. `accounting-ecosystem/database/migrations/053_inventory_reservations.sql`
- `stock_reservations` table with 4 constraints
- `reserve_stock()` RPC with `SELECT FOR UPDATE` concurrency protection
- 4 performance indexes

### 2. `accounting-ecosystem/backend/modules/inventory/services/reservationService.js`
6 exported functions:

| Function | Purpose |
|---|---|
| `getAvailableStock(supabase, companyId, itemId, warehouseId?)` | Returns on-hand, active_reserved, available_stock + active reservation list |
| `createReservation(supabase, params)` | Calls `reserve_stock()` RPC; returns success/error with availability details |
| `releaseReservation(supabase, id, companyId, qty?, userId)` | Partial or full release; updates status to `released` when fully settled |
| `consumeReservation(supabase, id, companyId, qty?, userId)` | Partial or full consume; updates status to `consumed` when fully settled |
| `getReservationsForSource(supabase, companyId, sourceType, sourceId)` | All reservations for a WO or other source entity |
| `getShortageReport(supabase, companyId)` | Aggregates items where active_reserved > current_stock; returns sorted shortage list |

### 3. `accounting-ecosystem/backend/modules/inventory/routes/reservations.js`
7 API endpoints (all under `/api/inventory/reservations`):

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | List reservations (filters: status, source_type, item_id, limit) |
| `GET` | `/availability/:itemId` | Available stock for one item (declared before `/:id`) |
| `GET` | `/reports/shortages` | Shortage report — items where reserved > on hand |
| `GET` | `/item/:itemId` | All reservations for one item |
| `GET` | `/source/:sourceType/:sourceId` | All reservations for a WO or source entity |
| `POST` | `/manual-hold` | Create a manual stock hold |
| `POST` | `/:id/release` | Partially or fully release a reservation |

---

## Files Modified

### 4. `accounting-ecosystem/backend/modules/inventory/routes/work-orders.js`

**Three integration points:**

#### a) WO `/release` — Stock reservation on release
- Fetches all `work_order_materials` for the WO
- Calls `createReservation()` for each material line
- **Hard availability gate:** if any material has insufficient available stock, compensates (releases already-created reservations) and returns HTTP 422 with `{ error, shortages[] }`
- On success: transitions to `released` and returns `{ work_order, reservations_created }`

#### b) WO `/cancel` — Reservation release on cancel
- Fetches all `stock_reservations` with `source_type='work_order'` and `source_id=wo.id` where status IN (`active`, `partially_released`)
- Calls `releaseReservation()` for each
- Then transitions to `cancelled`
- Returns `{ work_order, reservations_released }`

#### c) WO `/issue-materials` — Reservation consume on issue
- After each successful `adjustStockTx()`, queries for the matching reservation (`source_type='work_order'`, `source_id=wo.id`, `source_line_id=mat.id`, status IN `active`/`partially_released`)
- If found: calls `consumeReservation()` for the issued quantity
- If not found (WO released before Codebox 04 migration): continues silently — **backward compatible**

### 5. `accounting-ecosystem/backend/modules/inventory/index.js`

**Four changes:**

1. Added `require('./routes/reservations')` and `router.use('/reservations', reservationRoutes)`
2. Added `require('./services/reservationService')` for dashboard use
3. **`GET /items`** — after fetching items, queries `stock_reservations` for all item IDs and maps `reserved_qty` + `available_stock` onto each result. Low-stock filter now uses `available_stock` instead of `current_stock`
4. **`GET /demo-dashboard`** — replaced DB-side low-stock count with computed available-stock comparison; added parallel query for active reservations; added `active_reservations`, `total_reserved_value`, `shortage_item_count` to response

### 6. `accounting-ecosystem/frontend-inventory/index.html`

**12 changes:**

| # | Change |
|---|---|
| CSS | Added `.nav-tab.orange`, `.avail-ok/.avail-low/.avail-none`, `.reserved-qty`, `.shortage-badge`, `.stat-card.orange` |
| Nav | Added `🔒 Reservations` tab (orange class) |
| Items table header | Changed `Stock` → `On Hand / Reserved / Available` (3 columns) |
| Items table rows | Shows On Hand (plain), Reserved (orange if >0), Available (colored by threshold); low-stock badge uses `available_stock`; added Shortage badge if `reserved > on_hand` |
| Dashboard stats | Added 3 new stat cards: Active Reservations, Reserved Stock Value, Shortage Items |
| `loadDashboard()` | Populates the 3 new stat card IDs from `d.active_reservations`, `d.total_reserved_value`, `d.shortage_item_count` |
| `switchTab()` | Added `if (name === 'reservations') await loadReservations()` |
| `releaseWo()` | Handles HTTP 422 shortage response — shows per-item shortage detail in toast |
| New section HTML | `tab-reservations` section with status/source filters, Refresh, and Manual Hold buttons |
| Manual Hold modal | `manualHoldModal` — item dropdown (with available qty), quantity, reference, reason |
| JS — Reservations | `loadReservations()`, `renderReservationsTable()`, `releaseReservationRow()` |
| JS — Manual Hold | `openManualHoldModal()`, `submitManualHold()` |
