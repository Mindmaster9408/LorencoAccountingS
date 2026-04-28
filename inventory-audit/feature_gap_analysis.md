# Lorenco Storehouse — Feature Gap Analysis
**Date:** April 24, 2026
**Benchmarks:** Katana MRP, MRPeasy
**Methodology:** Feature comparison against industry-standard cloud MRP/IMS platforms for SME manufacturing

---

## Status Codes

| Code | Meaning |
|---|---|
| ✅ BUILT | Functional and complete in current system |
| 🔶 PARTIAL | Exists but with known gaps or broken sub-flows |
| ❌ MISSING | Not implemented at all |

---

## Area 1 — Inventory Core

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Item master (name, SKU, unit, category) | ✅ | ✅ | ✅ BUILT | All basic fields present |
| Item types (raw material, finished good, sub-assembly, consumable) | ✅ | ✅ | ✅ BUILT | CHECK constraint via migration 014 |
| Cost price per item | ✅ | ✅ | 🔶 PARTIAL | Field exists (`cost_price`), no costing engine updates it |
| Sell price per item | ✅ | ✅ | ✅ BUILT | Field exists |
| Unit of measure (UoM) | ✅ | ✅ | 🔶 PARTIAL | Single UoM field only — no UoM conversions |
| Multiple units of measure | ✅ | ✅ | ❌ MISSING | No UoM conversion tables |
| Lead time per item | ✅ | ✅ | 🔶 PARTIAL | `lead_time_days` field exists — not used in any scheduling or reorder logic |
| Reorder point / minimum stock | ✅ | ✅ | 🔶 PARTIAL | `min_stock` field + low_stock dashboard count — no automated reorder or alert email |
| Barcode support | ✅ | ✅ | 🔶 PARTIAL | `barcode` field stored — no scanning integration, no barcode print |
| Batch / lot tracking | ✅ | ✅ | ❌ MISSING | `track_lots` flag exists — no `lot_numbers` table, no lot assignment on receipt |
| Serial number tracking | ✅ | ✅ | ❌ MISSING | `track_serials` flag exists — no `serial_numbers` table, no serial assignment |
| Costing method (FIFO / average / standard) | ✅ | ✅ | ❌ MISSING | `costing_method` field exists — no costing engine, no cost layers |
| Stock value calculation | ✅ | ✅ | ❌ MISSING | No valuation report or stock-value endpoint |
| Product attachments / images | ✅ | ❌ | ❌ MISSING | No file attachment fields |
| Custom fields on items | ✅ | ❌ | ❌ MISSING | No custom field system |

**Summary:** Basic item master is solid. All tracking and costing capabilities are flags-only with no implementation behind them.

---

## Area 2 — Stock Management

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Manual stock adjustments | ✅ | ✅ | ✅ BUILT | Via `POST /movements` with type='adjustment' |
| Stock movements ledger | ✅ | ✅ | ✅ BUILT | `stock_movements` table — full history |
| Stock in / out recording | ✅ | ✅ | ✅ BUILT | Types: in, out, adjustment, return |
| Negative stock prevention | ✅ | ✅ | ❌ MISSING | No DB constraint, no API-level guard |
| Atomic stock updates | ✅ | ✅ | ❌ MISSING | Read-modify-write pattern — concurrent update risk |
| Stock on hand per item | ✅ | ✅ | ✅ BUILT | `current_stock` on `inventory_items` |
| Stock on hand per location | ✅ | ✅ | ❌ MISSING | No `stock_per_location` table — single `warehouse_id` FK on item |
| Multi-location stock | ✅ | ✅ | ❌ MISSING | Item can only belong to one warehouse |
| Inter-warehouse transfers | ✅ | ✅ | ❌ MISSING | `type='transfer'` exists — no `from_warehouse_id`/`to_warehouse_id` fields |
| Reserved / committed stock | ✅ | ✅ | ❌ MISSING | No concept of stock reserved for open WOs or sales orders |
| Available-to-promise (ATP) | ✅ | ✅ | ❌ MISSING | Depends on reserved stock — not implemented |
| Physical stock count | ✅ | ✅ | ❌ MISSING | No count workflow |
| Stock age / expiry tracking | 🔶 | ✅ | ❌ MISSING | No expiry date fields |
| Real-time stock updates | ✅ | ✅ | 🔶 PARTIAL | API-driven updates — no WebSocket/Supabase Realtime push |
| FIFO/batch cost layers | ✅ | ✅ | ❌ MISSING | `costing_method='fifo'` on item — no cost layer table |

**Summary:** Core movement recording is functional. Multi-location, costing, reservation, and safety controls are all absent.

---

## Area 3 — Warehouses / Locations

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Multiple warehouses per company | ✅ | ✅ | ✅ BUILT | Full CRUD on `warehouses` |
| Warehouse types (WIP, dispatch, quarantine, etc.) | ✅ | ✅ | ✅ BUILT | `location_type` CHECK constraint via migration 014 |
| Bin / rack / zone tracking | ❌ | ✅ | ❌ MISSING | No `warehouse_bins` or `rack_slots` tables |
| Default warehouse per item | 🔶 | ✅ | 🔶 PARTIAL | `warehouse_id` on item = primary location, not default picking |
| Stock move between warehouses | ✅ | ✅ | ❌ MISSING | See Area 2 — transfer type is incomplete |
| Warehouse-level stock report | ✅ | ✅ | ❌ MISSING | No `GET /warehouses/:id/stock` endpoint |
| Shipping / dispatch workflow | ✅ | ✅ | ❌ MISSING | No fulfillment or dispatch flow |

---

## Area 4 — Suppliers

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Supplier master (name, contact, address) | ✅ | ✅ | 🔶 PARTIAL | CRUD built — ⚠️ column name mismatch vs schema.sql (see Risk Register) |
| VAT / tax reference on supplier | ✅ | ✅ | 🔶 PARTIAL | Field exists (`vat_number` in backend) — schema mismatch risk |
| Multiple contacts per supplier | ✅ | ✅ | ❌ MISSING | Single contact only on supplier record |
| Supplier price lists | ✅ | ✅ | ❌ MISSING | No `supplier_price_list` table |
| Lead time per supplier per item | ✅ | ✅ | ❌ MISSING | `lead_time_days` is on the item, not per-supplier |
| Supplier performance tracking | ❌ | ✅ | ❌ MISSING | No delivery tracking, no on-time stats |
| Preferred supplier per item | ✅ | ✅ | ❌ MISSING | No `preferred_supplier_id` on items |

---

## Area 5 — Purchasing (Purchase Orders)

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Create purchase order | ✅ | ✅ | ✅ BUILT | PO header + line items via single POST |
| PO with multiple line items | ✅ | ✅ | ✅ BUILT | `purchase_order_items` table |
| PO status workflow (draft → sent → received) | ✅ | ✅ | 🔶 PARTIAL | Status field exists — `received` is a manual flag, no goods receipt |
| PO number (human-readable reference) | ✅ | ✅ | ❌ MISSING | No `po_number` field — only internal ID |
| PO approval workflow | 🔶 | ✅ | ❌ MISSING | No approval step or `approved_by` field |
| Goods receipt (GRN) | ✅ | ✅ | ❌ MISSING | `received_qty` exists in schema but no receive endpoint or stock-in |
| Partial delivery receipt | ✅ | ✅ | ❌ MISSING | Cannot receive partial quantities against a PO line |
| 3-way match (PO → GRN → Invoice) | ❌ | ✅ | ❌ MISSING | No invoice module |
| PO edit after creation | ✅ | ✅ | 🔶 PARTIAL | Header editable — line items cannot be edited after creation |
| View PO lines (detail) | ✅ | ✅ | ❌ MISSING | No `GET /purchase-orders/:id` endpoint, no detail modal in UI |
| Auto-create PO from reorder | ✅ | ✅ | ❌ MISSING | No reorder automation |
| Email PO to supplier | ✅ | ✅ | ❌ MISSING | No email system |

**Summary:** PO creation exists but the full purchasing lifecycle is broken. The goods receipt flow — the core commercial function of a purchase order — is entirely absent.

---

## Area 6 — Manufacturing / BOM

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Bill of Materials (BOM) creation | ✅ | ✅ | ✅ BUILT | Full BOM header + lines |
| Multi-level BOM (sub-assemblies) | ✅ | ✅ | ❌ MISSING | Sub-assembly item type exists — no BOM explosion logic for nested BOMs |
| BOM versioning | ✅ | ✅ | ✅ BUILT | `version` field + activation enforces single active version |
| BOM scrap percentage | ✅ | ✅ | ✅ BUILT | Global BOM scrap + per-line scrap override |
| BOM output quantity | ✅ | ✅ | ✅ BUILT | `output_qty` field — used in WO material calculation |
| Component item validation | ✅ | ✅ | ✅ BUILT | Backend validates component item belongs to same company |
| BOM costing (standard cost) | ✅ | ✅ | ❌ MISSING | No BOM cost rollup calculation |
| Routing / operations steps | ✅ | ✅ | ❌ MISSING | No `bom_operations` or `routing` table |
| Labour / machine time per operation | ✅ | ✅ | ❌ MISSING | No labour or capacity tracking |
| By-products / co-products | ❌ | ✅ | ❌ MISSING | No by-product support |
| Substitute components | ✅ | ❌ | ❌ MISSING | No substitute item relationships |

---

## Area 7 — Work Orders / Production

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Work order creation from BOM | ✅ | ✅ | ✅ BUILT | WO auto-populates materials from BOM |
| Work order number (WO-XXXXX) | ✅ | ✅ | ✅ BUILT | Auto-generated sequential per company |
| Work order lifecycle (draft → released → in_progress → completed) | ✅ | ✅ | ✅ BUILT | Full 5-state machine |
| Work order cancel | ✅ | ✅ | ✅ BUILT | |
| Material requirements per WO | ✅ | ✅ | ✅ BUILT | `work_order_materials` with required_qty |
| Material issuance tracking | ✅ | ✅ | 🔶 PARTIAL | `issued_qty` tracked — backend endpoint exists, no UI, silent over-issue |
| Pre-completion material check | ✅ | ✅ | ❌ MISSING | WO can be completed with no materials issued |
| Auto-backflush materials on WO complete | ✅ | ✅ | ❌ MISSING | Materials must be manually issued — no auto-deduction on completion |
| Finished goods stock receipt on WO complete | ✅ | ✅ | ✅ BUILT | `POST /:id/complete` creates stock_in movement |
| Scrap reporting per WO | ✅ | ✅ | ❌ MISSING | No scrap entry on WO completion |
| Production scheduling | ✅ | ✅ | ❌ MISSING | No scheduling, no capacity planning |
| WO assigned to operator | ❌ | ✅ | ❌ MISSING | No `assigned_to` on work_orders |
| Production progress reporting | ✅ | ✅ | ❌ MISSING | No production efficiency reporting |
| Subcontracting | ❌ | ✅ | ❌ MISSING | Not implemented |

**Summary:** Core WO lifecycle is functional. The issue-materials/backflush gap means stock accuracy is unreliable for manufacturing operations.

---

## Area 8 — Sales / Fulfillment

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Sales orders | ✅ | ✅ | ❌ MISSING | No sales order module |
| Customer master | ✅ | ✅ | ❌ MISSING (in inventory) | Customers exist in POS module — no linkage to inventory |
| Order fulfillment / picking | ✅ | ✅ | ❌ MISSING | No fulfillment workflow |
| Back-order management | ✅ | ✅ | ❌ MISSING | No back-order concept |
| Shipping / delivery | ✅ | ✅ | ❌ MISSING | No shipping workflow |
| Invoicing from sales order | ✅ | ✅ | ❌ MISSING | No invoice generation from inventory |
| Quote to sales order | ✅ | ❌ | ❌ MISSING | No quoting module |
| Available-to-promise on order | ✅ | ✅ | ❌ MISSING | Depends on reserved stock — absent |

**Summary:** Sales/fulfillment is entirely absent. This is a major gap vs Katana and MRPeasy. No integration point with the accounting module's customer/invoice features.

---

## Area 9 — Reporting & Analytics

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Dashboard summary (counts) | ✅ | ✅ | ✅ BUILT | `GET /dashboard` — 6 aggregate counts |
| Low stock report | ✅ | ✅ | 🔶 PARTIAL | Low stock count in dashboard — no list report or drill-down |
| Stock movement report | ✅ | ✅ | 🔶 PARTIAL | `GET /movements` endpoint — no date range filter, no grouping |
| Stock valuation report | ✅ | ✅ | ❌ MISSING | No endpoint or calculation |
| COGS report | ✅ | ✅ | ❌ MISSING | No COGS tracking |
| Purchase order summary | ✅ | ✅ | ❌ MISSING | No PO report |
| Work order performance | ✅ | ✅ | ❌ MISSING | No WO completion/efficiency report |
| Supplier spending report | ❌ | ✅ | ❌ MISSING | No supplier analytics |
| Reorder report | ✅ | ✅ | ❌ MISSING | No reorder list report |
| Export (CSV / PDF) | ✅ | ✅ | ❌ MISSING | No export capability |
| Audit trail on inventory actions | ✅ | ✅ | 🔶 PARTIAL | `auditMiddleware` on module — generic audit, not inventory-specific |

---

## Area 10 — Integration & Platform

| Feature | Katana | MRPeasy | Lorenco | Notes |
|---|---|---|---|---|
| Accounting system integration | ✅ | ✅ | ❌ MISSING | No journal entries on stock movements, no GL linkage |
| REST API | ✅ | ✅ | ✅ BUILT | Consistent REST API with JWT auth |
| Webhooks / event notifications | ✅ | ✅ | ❌ MISSING | No event hooks on stock changes |
| Role-based permissions | ✅ | ✅ | ❌ MISSING | No role checks within inventory |
| Multi-company / multi-tenant | ✅ | ✅ | ✅ BUILT | `company_id` scoping throughout |
| Module access control | ✅ | ✅ | ✅ BUILT | `requireModule('inventory')` gate |
| Real-time updates | ✅ | 🔶 | ❌ MISSING | No Supabase Realtime or WebSocket |
| Mobile-friendly UI | ✅ | 🔶 | ❌ MISSING | Single-file SPA — no responsive design specified |
| Barcode scanning (device) | ✅ | ✅ | ❌ MISSING | Barcode field exists — no hardware integration |
| ERP / 3PL integration | ✅ | ✅ | ❌ MISSING | No external integration |

---

## Overall Maturity Score

| Area | Lorenco Score | Notes |
|---|---|---|
| Inventory Core | 35% | Basic item master solid; all tracking/costing absent |
| Stock Management | 40% | Movement ledger built; safety controls and multi-location absent |
| Warehouses | 30% | Multi-warehouse created; stock-per-location and transfers absent |
| Suppliers | 25% | Basic CRUD (with schema risk); no price lists, leads, performance |
| Purchasing | 30% | PO creation built; receiving flow entirely absent |
| Manufacturing / BOM | 55% | BOM and WO lifecycle solid; backflush, scheduling, costing absent |
| Work Orders | 50% | State machine works; material safety checks absent |
| Sales / Fulfillment | 0% | Not started |
| Reporting | 15% | Dashboard only; no analytical reports |
| Integration | 25% | REST API solid; no accounting, no events |

**Total estimated completeness vs Katana MRP standard: ~31%**

---

## Priority Roadmap

### Phase 1 — Stability (Fix Before Adding Features)
1. Fix `suppliers` schema mismatch — confirm live Supabase table matches backend expectations
2. Add atomic stock update — replace read/write pattern with Supabase RPC function
3. Add negative stock check — DB constraint + API validation
4. Fix `issue-materials` — reject over-issue instead of silent floor
5. Fix partial success HTTP status — return 207 Multi-Status or 500 on partial failure

### Phase 2 — Critical Missing Flows
1. Build PO receiving endpoint + stock-in movement generation + `received_qty` update
2. Add `to_warehouse_id` to `stock_movements` for transfer type
3. Add `stock_per_location` table and supporting API
4. Add UI for "Issue Materials" on work orders

### Phase 3 — Manufacturing Completeness
1. Implement WO material completion check (cannot complete without issuing all required materials)
2. Implement auto-backflush option on WO complete
3. Add scrap reporting on WO completion
4. Implement multi-level BOM explosion

### Phase 4 — Inventory Intelligence
1. Implement average costing engine
2. Implement FIFO cost layers
3. Build lot/batch tracking tables and intake flow
4. Build stock valuation report

### Phase 5 — Purchasing & Reporting
1. Add PO number auto-generation
2. Add PO approval workflow
3. Build movement report with date range filters
4. Build stock valuation report
5. Add reorder alerts

### Phase 6 — Integration
1. Link GL accounts to inventory items
2. Emit journal entries on stock movements and goods receipt
3. Accounting integration for COGS and stock asset postings
