# H02 — Lorenco Storehouse Dropdown Contrast Audit

**Date:** 2026-06-05  
**File audited:** `accounting-ecosystem/frontend-inventory/index.html` (5,728 lines)  
**Auditor:** Code inspection — full grep of all `<select>` elements  
**Total selects found:** 56 (37 in static HTML, 4 in JS template literals, 15 `.form-control` in modals/JS)

---

## Root Cause Summary

Three separate issues combine to produce unreadable dropdowns:

| # | Issue | Cause | Affected elements |
|---|---|---|---|
| 1 | **Native option list always white** | `select option` never styled — browser uses OS defaults | All 56 selects |
| 2 | **`.form-control` has zero CSS** | Class used in 8 modal/table selects but not defined in stylesheet | 8 selects + 7 inputs/textareas |
| 3 | **`.bom-line-item` has zero CSS** | Class used in JS-generated BOM rows, not defined | JS-generated BOM selects |

---

## Dropdown Inventory

### Group A — `.filter-select` (toolbar/tab area) — 18 selects

These have dark background CSS defined. **The select element is correctly dark. But the open option list is white (issue #1 above).**

| Line | ID | Label | Tab/Section |
|---|---|---|---|
| 330 | `itemTypeFilter` | Item Type | Items |
| 338 | `itemFilterWarehouse` | All Locations | Items |
| 353 | `movTypeFilter` | Movement Type | Movements |
| 374 | `whSubView` | Warehouse sub-view | Warehouses |
| 390 | `locWarehouseFilter` | Location filter | Warehouses |
| 410 | `soSubView` | SO sub-view | Sales Orders |
| 415 | `soStatusFilter` | SO status | Sales Orders |
| 442 | `atpItemFilter` | ATP item | Sales Orders |
| 459 | `transferStatusFilter` | Transfer status | Transfers |
| 492 | `poStatusFilter` | PO status | Purchase Orders |
| 533 | `bomStatusFilter` | BOM status | BOMs |
| 553 | `woStatusFilter` | WO status | Work Orders |
| 577 | `productionSubView` | Production sub-view | Production |
| 621 | `reportType` | Report type | Reports |
| 674–755 | Multiple report filters | Item type, low stock, missing cost, PO status, reservation, yield, demand, warehouse, transfer | Reports |
| 781 | `countStatusFilter` | Count status | Stock Counts |
| 808 | `resvStatusFilter` | Reservation status | Reservations |
| 816 | `resvSourceFilter` | Reservation source | Reservations |

**Issue:** Option list opens white (Windows OS default). ✅ Fixed by `select option` CSS.

---

### Group B — `.form-field select` (modal form selects) — 14 selects

These inherit `.form-field select { background: rgba(255,255,255,0.05); color: var(--text); }` so the **element looks dark**. But the open option list is white (issue #1).

| Line | ID | Label | Modal |
|---|---|---|---|
| 853 | `iItemType` | Item Type | Add/Edit Item |
| 863 | `iUnit` | Unit | Add/Edit Item |
| 865 | `iWarehouse` | Location | Add/Edit Item |
| 873 | `iCostingMethod` | **Costing Method** ← reported issue | Add/Edit Item |
| 934 | `mItem` | Item | Add Movement |
| 936 | `mType` | Movement Type | Add Movement |
| 945 | `mWarehouse` | Location | Add Movement |
| 973 | `whType` | Warehouse type | Add Warehouse |
| 1060 | `locType` | Location type | Add Location |
| 1095 | `tFromWarehouse` | From Warehouse | Transfer |
| 1098 | `tToWarehouse` | To Warehouse | Transfer |
| 1170 | `bomItem` | Finished Product | Add BOM |
| 1219 | `woItem` | Product to Produce | Add Work Order |
| 1220 | `woBom` | Bill of Materials | Add Work Order |
| 1265 | `woWastageReason` | Wastage Reason | Record Wastage |
| 1319 | `quickReceiveSupplier` | Supplier | Quick Receive |
| 1320 | `quickReceiveItem` | Item | Quick Receive |
| 1427 | `poSupplier` | Supplier | Add PO |

**Issues:** Option list white (issue #1). ✅ Fixed by `select option` CSS.

---

### Group C — `.form-control` (stock count, approve, PO line, manual hold) — 8 selects

**These have NO CSS defined at all. The select element itself renders with browser default (white background, dark text). This is a full broken case — both element and option list are wrong.**

| Line | ID | Label | Context |
|---|---|---|---|
| 1487 | `mhItemId` | Item | Manual Hold modal |
| 1521 | `scCountType` | Count type | Stock Count modal |
| 1530 | `scWarehouseId` | Warehouse | Stock Count modal |
| 1537 | `scMode` | Count mode | Stock Count modal |
| 1546 | `scCategory` | Category | Stock Count modal |
| 1609 | `approveCountAction` | Approval action | Approve Count modal |
| 3224 | `poLineItem_${id}` | Line item (PO) | PO line rows (JS-generated) |
| 5333 | `cl-rsn-${l.id}` | Variance reason | Count line table (JS-generated) |

**Issues:** Element is white. Option list is white. Both text and background have no dark theme. ✅ Fixed by `.form-control` CSS definition.

---

### Group D — `.bom-line-item` (JS-generated BOM rows) — JS template

| Line | Context | Label |
|---|---|---|
| 3447 | `addBomLine()` function | BOM component item select |

**Issue:** No CSS for this class. Renders white with dark text. ✅ Fixed by `.bom-line-item` CSS definition.

---

### Group E — Inline-styled selects (no class or overridden)

| Line | Context | Current style | Issue |
|---|---|---|---|
| 2320 | BOM line (another pattern) | `background:rgba(255,255,255,0.05);color:var(--text)` | Element ok; option list white |
| 4787 | WO output unit | `background:rgba(255,255,255,0.05);color:var(--text)` | Element ok; option list white |

✅ Fixed by global `select option` CSS (inline styles on the element don't affect the option list).

---

## Summary of Issues Requiring Fixes

| Priority | Issue | Fix |
|---|---|---|
| CRITICAL | `select option` never styled — all native dropdowns open white | Add `select option { background-color: #1e1b4b; color: #f8fafc; }` |
| CRITICAL | `.form-control` has no CSS — 8 selects render completely white | Define `.form-control` with dark theme |
| HIGH | `.bom-line-item` has no CSS | Define `.bom-line-item` with dark theme |
| LOW | Global `select` baseline missing focus ring | Add `select:focus` global rule |

---

## Browser Compatibility Notes

- **Chrome / Edge (Windows):** `select option { background-color; color }` is respected. The fix works.
- **Firefox (Windows):** Same — option styling respected.
- **Safari (macOS):** macOS renders native select dropdowns using OS chrome. `option` colour overrides are largely ignored. This is an OS-level limitation and cannot be fixed with CSS alone. The storehouse primary deployment is Windows/Chrome.
- **All browsers:** The `select` element itself (the closed/placeholder view) can be fully styled on all platforms.

---

*Audit complete. See `01_css_fix_report.md` for the fix applied.*
