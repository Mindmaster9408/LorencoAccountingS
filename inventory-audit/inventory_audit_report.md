# Lorenco Storehouse — Full System Audit Report
**Date:** April 24, 2026
**Audited by:** Principal Architect / Systems Audit
**App:** Lorenco Storehouse (Inventory & MRP)
**Status:** AUDIT ONLY — No code changes made

---

## CRITICAL GLOBAL RULE — localStorage / sessionStorage Scan

**SCAN RESULT: CLEARED**

| File | Line | Usage | Assessment |
|---|---|---|---|
| `frontend-inventory/index.html` | 651 | `localStorage.getItem('token') \|\| sessionStorage.getItem('token')` | ✅ APPROVED — JWT auth token read-only. This is the ecosystem-standard pattern for auth tokens. No business data is stored. |

**Finding:** The inventory frontend does NOT store any business data (stock levels, items, movements, suppliers, purchase orders, BOMs, work orders) in localStorage or sessionStorage. All data flows exclusively through the backend API (`/api/inventory`). The single localStorage access is reading the JWT auth token — identical to all other apps in the ecosystem. **No migration required.**

---

## 1. FRONTEND STRUCTURE

### Overview
- **File:** `accounting-ecosystem/frontend-inventory/index.html`
- **Architecture:** Single HTML file, vanilla JS, no build step, no framework
- **Size:** ~1,600 lines (HTML + CSS + JS combined)
- **Pattern:** Single Page Application — tab switching via `switchTab()`, DOM manipulation

### Pages / Tabs / Routes
| Tab | Section ID | Description |
|---|---|---|
| Dashboard | `tab-dashboard` | Stats cards + quick action links |
| Items | `tab-items` | Stock items CRUD with filters |
| Movements | `tab-movements` | Stock movement log with type filter |
| Locations | `tab-warehouses` | Warehouse/location CRUD |
| Suppliers | `tab-suppliers` | Supplier CRUD |
| Purchase Orders | `tab-orders` | PO list with status filter — **NO view/edit/receive UI** |
| BOMs | `tab-boms` | Bill of Materials CRUD + activate |
| Work Orders | `tab-workorders` | WO lifecycle management |

### In-Memory State Management
| Variable | Scope | Data Held |
|---|---|---|
| `allItems[]` | Module-level | All active inventory items |
| `allWarehouses[]` | Module-level | All active warehouses |
| `_suppliersCache[]` | Module-level | All active suppliers |
| `_bomsCache[]` | Module-level | BOM list |
| `_woCache[]` | Module-level | Work order list |
| `_tabLoaded{}` | Module-level | Tab lazy-load flags (stale data risk) |
| `_itemEditId`, `_whEditId`, `_supEditId`, `_bomEditId`, `_woCompleteId` | Module-level | Edit context IDs |

### UI Flows
- **Stock Items:** Create → Edit → Remove (soft delete = `is_active=false`)
- **Movements:** Create movement (in/out/adjustment/transfer/return) — type drives stock delta
- **BOMs:** Create (draft) → Edit (draft only) → Activate → Deactivate → Create WO from BOM
- **Work Orders:** Create (draft) → Release → Start → Issue Materials (missing UI) → Complete
- **Purchase Orders:** Create → Filter by status — **MISSING: view lines, edit lines, receive goods UI**

### Business Logic in Frontend
| Location | Logic | Assessment |
|---|---|---|
| `filterItems()` | Client-side filtering of `allItems[]` by search/type/warehouse | ACCEPTABLE — display filter only, source data is from API |
| `loadBomsForItem()` | Fires 2 API calls to load active + draft BOMs for selected item | Functional but inefficient (2 requests) |
| `woActionBtn()` | Derives action button from WO status | ACCEPTABLE — read-only UI logic |
| `addBomLine()` | Assembles BOM line HTML dynamically | ACCEPTABLE — form builder |
| `collectBomLines()` | Collects BOM line values from DOM | ACCEPTABLE — form serialisation |

**Finding:** No stock calculations occur in the frontend. All stock mutations happen via backend API. ✅

### XSS Protection
- `esc()` function escapes HTML entities in all user-facing rendered strings
- Consistently applied throughout render functions
- **Assessment: ACCEPTABLE** — no unescaped user data in innerHTML

---

## 2. BACKEND STRUCTURE

### Module Registration
- **File:** `backend/server.js`
- **Mount path:** `POST /api/inventory`
- **Middleware chain:** `authenticateToken` → `requireModule('inventory')` → `auditMiddleware` → `inventoryRoutes`
- **Module gate:** Company must have `inventory` in `modules_enabled` array on the `companies` table

### Files
| File | Responsibility |
|---|---|
| `backend/modules/inventory/index.js` | Core CRUD: warehouses, items, movements, suppliers, purchase orders, categories, dashboard |
| `backend/modules/inventory/routes/boms.js` | BOM header + lines CRUD, activation |
| `backend/modules/inventory/routes/work-orders.js` | Work order lifecycle, material issuance |

### API Endpoints — Full Inventory

| Method | Path | Description |
|---|---|---|
| GET | `/api/inventory/status` | Module health check |
| GET | `/api/inventory/dashboard` | Aggregate stats (items, movements, suppliers, low-stock, open WOs, active BOMs) |
| GET | `/api/inventory/warehouses` | List active warehouses |
| POST | `/api/inventory/warehouses` | Create warehouse |
| PUT | `/api/inventory/warehouses/:id` | Update warehouse |
| GET | `/api/inventory/items` | List items (filter: category, warehouse_id, low_stock) |
| GET | `/api/inventory/items/:id` | Get single item |
| POST | `/api/inventory/items` | Create item |
| PUT | `/api/inventory/items/:id` | Update item |
| DELETE | `/api/inventory/items/:id` | Soft-delete item (`is_active=false`) |
| GET | `/api/inventory/movements` | List movements (filter: item_id, type, limit) |
| POST | `/api/inventory/movements` | Create movement + update `current_stock` |
| GET | `/api/inventory/suppliers` | List active suppliers |
| POST | `/api/inventory/suppliers` | Create supplier |
| PUT | `/api/inventory/suppliers/:id` | Update supplier |
| GET | `/api/inventory/purchase-orders` | List POs (filter: status) |
| POST | `/api/inventory/purchase-orders` | Create PO + lines |
| PUT | `/api/inventory/purchase-orders/:id` | Update PO header (status/notes/dates) only |
| GET | `/api/inventory/categories` | Distinct categories from items |
| GET | `/api/inventory/boms` | List BOMs |
| GET | `/api/inventory/boms/:id` | Get BOM with lines |
| POST | `/api/inventory/boms` | Create BOM + lines |
| PUT | `/api/inventory/boms/:id` | Update BOM + replace lines (draft only) |
| DELETE | `/api/inventory/boms/:id` | Deactivate BOM (blocks if open WOs reference it) |
| POST | `/api/inventory/boms/:id/activate` | Activate BOM (deactivates other versions) |
| GET | `/api/inventory/work-orders` | List work orders |
| GET | `/api/inventory/work-orders/:id` | Get WO with materials |
| POST | `/api/inventory/work-orders` | Create WO + auto-populate materials from BOM |
| PUT | `/api/inventory/work-orders/:id` | Update WO (dates/notes; qty only in draft) |
| POST | `/api/inventory/work-orders/:id/release` | draft → released |
| POST | `/api/inventory/work-orders/:id/start` | released → in_progress |
| POST | `/api/inventory/work-orders/:id/complete` | in_progress → completed + stock-in finished goods |
| POST | `/api/inventory/work-orders/:id/cancel` | Cancel WO |
| POST | `/api/inventory/work-orders/:id/issue-materials` | Deduct materials from stock, update issued_qty |

### **MISSING ENDPOINTS**
| Missing | Impact |
|---|---|
| `GET /purchase-orders/:id` | No detail view of a PO — cannot see line items |
| `PUT /purchase-orders/:id/lines` | Cannot update PO line items after creation |
| `POST /purchase-orders/:id/receive` | No goods receipt flow — PO cannot auto-receive stock |
| `GET /items/:id/movements` | No per-item movement history endpoint |
| `GET /reports/stock-valuation` | No stock valuation report |
| `GET /reports/stock-aging` | No stock aging report |
| `GET /warehouses/:id/stock` | No per-location stock view |
| `POST /items/:id/adjust-stock` | Dedicated stock adjustment (separate from general movement) |

### Business Logic Placement
- **CORRECT:** All stock calculations happen in backend
- **CORRECT:** All stock deltas computed server-side in `POST /movements` and WO endpoints
- **RISK:** Application-layer filtering for `low_stock` and item search (see Risk Register)

---

## 3. DATABASE STRUCTURE

*See `database_structure.md` for full table definitions.*

### Quick Reference — Tables Used by Inventory Module
| Table | Status | Notes |
|---|---|---|
| `inventory_items` | ACTIVE — partial columns in schema.sql, extended by migration 014 | Core item master |
| `warehouses` | ACTIVE — extended by migration 014 | Location master |
| `stock_movements` | ACTIVE | Movement ledger |
| `suppliers` | ⚠️ SCHEMA MISMATCH RISK | Column name mismatch between schema.sql and backend code |
| `purchase_orders` | ACTIVE | PO header — missing PO number field |
| `purchase_order_items` | ACTIVE | PO lines — received_qty exists but unused in backend |
| `bom_headers` | ACTIVE — created by migration 014 | BOM master |
| `bom_lines` | ACTIVE — created by migration 014 | BOM components |
| `work_orders` | ACTIVE — created by migration 014 | Production runs |
| `work_order_materials` | ACTIVE — created by migration 014 | Material requirements per WO |

---

## 4. DATA FLOW

*See `data_flow.md` for full flow traces.*

---

## 5. INVENTORY LOGIC CHECK

| Feature | Status | Notes |
|---|---|---|
| Multi-warehouse | PARTIAL | Multiple warehouses exist, but `inventory_items.warehouse_id` is single FK — one location per item only |
| Stock per location | MISSING | No `stock_per_location` join table — cannot have item stocked in multiple locations |
| Stock movement tracking | BUILT | `stock_movements` table with full history |
| FIFO costing | MISSING | `costing_method='fifo'` flag exists — no cost layer table, no FIFO engine |
| Average costing | PARTIAL | `costing_method='average'` flag exists — `cost_price` is a flat field, no rolling average engine |
| Standard costing | MISSING | Flag exists — no standard cost engine |
| Negative stock protection | MISSING | No DB constraint (`CHECK (current_stock >= 0)` absent); no API-level guard on movements |
| Batch / lot tracking | MISSING | `track_lots` flag exists — no `lot_numbers` or `batch_records` table |
| Serial tracking | MISSING | `track_serials` flag exists — no `serial_numbers` table |
| Reorder point alerts | PARTIAL | `min_stock` field exists; `low_stock_count` in dashboard; no notification/email system |
| Barcode support | PARTIAL | `barcode` field exists on items; no barcode scanner integration |
| BOM / recipe management | BUILT | Full BOM header + lines with versions and activation |
| Work order lifecycle | BUILT | Full 5-state machine (draft → released → in_progress → completed / cancelled) |
| Material issuance | PARTIAL | `issue-materials` endpoint works; no UI for it; no pre-completion check |
| WO backflushing | MISSING | Completing a WO does NOT auto-deduct issued materials from stock if `issue-materials` wasn't called |
| Goods receipt from PO | MISSING | `POST /purchase-orders/:id/receive` endpoint does not exist |
| Transfer movements | PARTIAL | `type='transfer'` exists in stock_movements; no `to_warehouse_id` field — cannot track source/destination |

---

## 6. PERMISSIONS / MULTI-TENANT

| Check | Status | Notes |
|---|---|---|
| `company_id` scoping on all reads | ✅ BUILT | Every Supabase query includes `.eq('company_id', req.companyId)` |
| `company_id` scoping on all writes | ✅ BUILT | All inserts include `company_id: req.companyId` |
| `company_id` scoping on all updates | ✅ BUILT | All updates include `.eq('company_id', req.companyId)` |
| Cross-company data leakage risk | ✅ LOW | No raw SQL, no joins across companies |
| Module access gate | ✅ BUILT | `requireModule('inventory')` middleware on all routes |
| Role-based access control | ⚠️ MISSING | No role checks within inventory routes — any authenticated company user can create/delete items |
| BOM write access control | ⚠️ MISSING | Any user can activate/deactivate BOMs and create work orders |
| Deletion safeguard | PARTIAL | BOM delete checks for open WOs; item delete is always allowed (risk: items referenced in open WOs) |

---

## 7. UI vs DATA AUTHORITY

| Operation | Who Calculates | Assessment |
|---|---|---|
| Current stock level | Backend — `inventory_items.current_stock` updated by `POST /movements` and WO endpoints | ✅ BACKEND IS AUTHORITY |
| Low stock flag | Backend — filter compares `current_stock <= min_stock` (app layer, not DB) | ⚠️ PARTIAL |
| Movement delta (in/out) | Backend — `delta = ['in', 'return'].includes(type) ? qty : -qty` | ✅ BACKEND IS AUTHORITY |
| WO material requirements | Backend — `required_qty = line.quantity * (qty/bomOutputQty) * (1 + scrap%)` | ✅ BACKEND IS AUTHORITY |
| WO finished goods received | Backend — `POST /:id/complete` triggers stock_in movement + current_stock update | ✅ BACKEND IS AUTHORITY |
| PO total amount | ⚠️ MIXED — Frontend sums `quantity * unit_price` before POST; backend stores the passed value without re-calculating | RISK |
| Stock filtering/search | ⚠️ APPLICATION LAYER — backend fetches all items, then filters in JS | RISK (scale) |

**Finding:** No frontend-as-truth logic for stock calculations. The backend is authoritative for all stock mutations. The PO total and search filter are the only partial exceptions.

---

## 8. INTEGRATION READINESS

### Accounting App Integration
| Check | Status |
|---|---|
| GL account linkage on inventory items | MISSING — no `gl_account_id` on `inventory_items` |
| Journal entry on stock movement | MISSING — no accounting event fired |
| Journal entry on goods receipt | MISSING — no goods receipt flow exists |
| Stock valuation API for balance sheet | MISSING |
| COGS calculation per movement | MISSING |

### Paytime Integration
| Check | Status |
|---|---|
| Any payroll dependency | N/A — no natural integration point at this stage |

### Sean AI Integration
| Check | Status |
|---|---|
| Structured learning events emitted | MISSING — no event hooks, no learning capture |
| Stock anomaly detection hooks | MISSING |
| Supplier intelligence hooks | MISSING |

### API Structure
- REST endpoints with consistent JSON responses ✅
- Bearer token auth consistent with ecosystem ✅
- `company_id` scoping throughout ✅
- No versioning on API endpoints ⚠️
- No webhook/event emission on stock changes ⚠️
- No Supabase Realtime subscriptions for live stock updates ⚠️

---

## 9. ERROR HANDLING

| Area | Finding |
|---|---|
| API errors to frontend | Backend returns `{ error: message }` with appropriate HTTP status codes — frontend shows toast ✅ |
| Supabase errors surfaced | All Supabase error objects are checked and propagated — no silent swallows ✅ |
| Movement stock update failure | `POST /movements` creates the movement record FIRST, then updates stock. If stock update fails, movement is created but stock level is wrong — **SILENT PARTIAL FAILURE** ⚠️ |
| BOM line rollback on failure | `POST /boms` deletes the header if line insert fails — clean rollback ✅ |
| WO material issue — invalid material_id | Adds to `errors[]` array but continues loop; returns partial success — **inconsistent error handling** ⚠️ |
| `issue-materials` negative stock | `Math.max(0, stock - qty)` silently clamps — does NOT reject over-issue, does NOT report it ⚠️ |
| `PUT /purchase-orders/:id` — no ownership check | Updates any PO that belongs to company — missing check that PO is in editable state ⚠️ |
| No input validation on movement quantity | `parseFloat(quantity)` — no guard for zero or negative quantity on movement creation ⚠️ |
| Uncaught exceptions | No global error handler for uncaught async errors in route handlers ⚠️ |

---

## 10. CODE QUALITY & RISKS

### Duplicated / Inconsistent Logic
- `current_stock` update pattern repeated in: `POST /movements`, `POST /work-orders/:id/complete`, `POST /work-orders/:id/issue-materials` — three separate implementations of the same stock-update pattern. Should be a shared service function.
- Supabase client reused directly in routes without a service layer — business logic mixed with HTTP routing

### Unused Code
- `purchase_order_items.received_qty` field exists in schema and is inserted as 0 — but never updated by any endpoint (no receiving flow)
- `movement.cost_price` field is stored but never read or used in any calculation (no costing engine consumes it)
- `inventory_items.barcode` is stored and displayed but no barcode scanning integration exists

### Broken Flows
- **Purchase Order receiving**: PO status can be set to `'received'` via `PUT /purchase-orders/:id` but no stock-in movement is created, no `received_qty` is updated on lines
- **Material backflush**: WO can be completed without any materials issued — finished goods added to stock but raw materials never deducted
- **Transfer movements**: `type='transfer'` records a movement but cannot encode source/destination warehouse (no `from_warehouse_id`, `to_warehouse_id` columns)

### Unsafe Assumptions
- `current_stock` is a mutable counter updated with read-then-write pattern (no atomic DB update) — concurrent requests can cause incorrect stock levels
- `GET /items` fetches ALL items for the company into memory before filtering — will degrade at scale
- `GET /movements?limit=200` hardcoded in frontend call — no pagination

### Schema Inconsistency Risk
- `suppliers` table in `schema.sql` (POS module section) uses `supplier_name`, `contact_email`, `contact_phone`
- `backend/modules/inventory/index.js` inserts into `suppliers` with `name`, `email`, `phone`
- **These column names do not match.** Either the live Supabase schema differs from `schema.sql`, or the supplier endpoints are broken. This must be verified immediately.

---

## Summary — Critical Issues

| Priority | Issue |
|---|---|
| 🔴 CRITICAL | `suppliers` table schema mismatch — backend uses `name/email/phone`, schema.sql has `supplier_name/contact_email/contact_phone` |
| 🔴 CRITICAL | No atomic stock update — race condition risk on concurrent movements |
| 🔴 HIGH | No negative stock protection — stock can go below zero silently |
| 🔴 HIGH | Purchase Order receiving flow is completely absent |
| 🔴 HIGH | Work order completion does not backflush raw material stock |
| 🟡 MEDIUM | FIFO/Average/Standard costing flags exist but no costing engine |
| 🟡 MEDIUM | Lot/Serial tracking flags exist but no tracking tables or logic |
| 🟡 MEDIUM | No GL account linkage — cannot integrate with accounting app |
| 🟡 MEDIUM | Silent failure in `issue-materials` when stock is insufficient |
| 🟡 MEDIUM | No role-based access control within inventory module |
| 🟢 LOW | Tab caching (`_tabLoaded`) causes stale data after navigation |
| 🟢 LOW | Application-layer search/filter will not scale |
