# H02 — Testing Report

**Date:** 2026-06-05  
**Tester:** Code-level static analysis (visual browser testing by Ruan required)  
**Browser target:** Chrome / Edge on Windows (primary deployment platform)

---

## Static Analysis Findings — PASS

All selects were verified to have CSS coverage after the fix:

| CSS Class | Before Fix | After Fix |
|---|---|---|
| `.filter-select` | Dark element, white option list | Dark element, dark option list ✅ |
| `.form-field select` | Dark element, white option list | Dark element, dark option list ✅ |
| `.bom-line-row select` | Dark element, white option list | Dark element, dark option list ✅ |
| `.form-control` (select) | **White element, white option list** | Dark element, dark option list ✅ |
| `.bom-line-item` | **White element, white option list** | Dark element, dark option list ✅ |
| Inline-styled selects (L2320, L4787) | Dark element, white option list | Dark element, dark option list ✅ |
| Global `select` baseline | No baseline | Dark fallback for any unstyled select ✅ |

---

## Tab-by-Tab Checklist

### Dashboard tab
| Dropdown | Expected result |
|---|---|
| (No dropdowns on dashboard itself) | N/A |

### Items tab
| Dropdown | Class | Status |
|---|---|---|
| Item Type filter (L330) | `.filter-select` | ✅ Dark element + dark options |
| Location filter (L338) | `.filter-select` | ✅ Dark element + dark options |
| Item Type (modal, L853) | `.form-field select` | ✅ Dark element + dark options |
| Unit (modal, L863) | `.form-field select` | ✅ Dark element + dark options |
| Location (modal, L865) | `.form-field select` | ✅ Dark element + dark options |
| **Costing Method (modal, L873)** | `.form-field select` | ✅ Dark element + dark options — **reported issue FIXED** |

### Movements tab
| Dropdown | Class | Status |
|---|---|---|
| Movement type filter (L353) | `.filter-select` | ✅ |
| Item (modal, L934) | `.form-field select` | ✅ |
| Movement type (modal, L936) | `.form-field select` | ✅ |
| Warehouse (modal, L945) | `.form-field select` | ✅ |

### Warehouses tab
| Dropdown | Class | Status |
|---|---|---|
| Sub-view selector (L374) | `.filter-select` | ✅ |
| Location warehouse filter (L390) | `.filter-select` | ✅ |
| Warehouse type (modal, L973) | `.form-field select` | ✅ |
| Location type (modal, L1060) | `.form-field select` | ✅ |
| From warehouse (transfer, L1095) | `.form-field select` | ✅ |
| To warehouse (transfer, L1098) | `.form-field select` | ✅ |

### Transfers tab
| Dropdown | Class | Status |
|---|---|---|
| Transfer status filter (L459) | `.filter-select` | ✅ |

### Sales Orders tab
| Dropdown | Class | Status |
|---|---|---|
| SO sub-view (L410) | `.filter-select` | ✅ |
| SO status filter (L415) | `.filter-select` | ✅ |
| ATP item filter (L442) | `.filter-select` | ✅ |

### Purchase Orders tab
| Dropdown | Class | Status |
|---|---|---|
| PO status filter (L492) | `.filter-select` | ✅ |
| PO supplier (modal, L1427) | `.form-field select` | ✅ |
| **PO line item (JS-generated, L3224)** | `.form-control` | ✅ **FIXED** — was white |

### BOMs tab
| Dropdown | Class | Status |
|---|---|---|
| BOM status filter (L533) | `.filter-select` | ✅ |
| Finished product (modal, L1170) | `.form-field select` | ✅ |
| **BOM component items (JS-generated)** | `.bom-line-item` | ✅ **FIXED** — was white |

### Work Orders tab
| Dropdown | Class | Status |
|---|---|---|
| WO status filter (L553) | `.filter-select` | ✅ |
| Product to produce (modal, L1219) | `.form-field select` | ✅ |
| BOM selector (modal, L1220) | `.form-field select` | ✅ |
| **WO output unit (inline, L4787)** | Inline style | ✅ Options dark |
| Wastage reason (modal, L1265) | `.form-field select` | ✅ |

### Quick Receive
| Dropdown | Class | Status |
|---|---|---|
| Supplier (L1319) | `.form-field select` | ✅ |
| Item (L1320) | `.form-field select` | ✅ |

### Reports tab
| Dropdown | Class | Status |
|---|---|---|
| Report type (L621) | `.filter-select` | ✅ |
| Item type filter (L674) | `.filter-select` | ✅ |
| Low stock filter (L682) | `.filter-select` | ✅ |
| Missing cost filter (L686) | `.filter-select` | ✅ |
| PO status filter (L696) | `.filter-select` | ✅ |
| Reservation status (L711) | `.filter-select` | ✅ |
| Reservation source (L720) | `.filter-select` | ✅ |
| Yield direction (L730) | `.filter-select` | ✅ |
| Demand status (L741) | `.filter-select` | ✅ |
| Warehouse filter (L752) | `.filter-select` | ✅ |
| Transfer status (L755) | `.filter-select` | ✅ |

### Stock Counts tab
| Dropdown | Class | Status |
|---|---|---|
| Count status filter (L781) | `.filter-select` | ✅ |
| **Count type (modal, L1521)** | `.form-control` | ✅ **FIXED** — was white |
| **Count warehouse (modal, L1530)** | `.form-control` | ✅ **FIXED** — was white |
| **Count mode (modal, L1537)** | `.form-control` | ✅ **FIXED** — was white |
| **Count category (modal, L1546)** | `.form-control` | ✅ **FIXED** — was white |
| **Approve action (modal, L1609)** | `.form-control` | ✅ **FIXED** — was white |
| **Count line variance reason (table, L5333)** | `.form-control` | ✅ **FIXED** — was white |

### Reservations tab
| Dropdown | Class | Status |
|---|---|---|
| Reservation status (L808) | `.filter-select` | ✅ |
| Reservation source (L816) | `.filter-select` | ✅ |

### Production tab
| Dropdown | Class | Status |
|---|---|---|
| Production sub-view (L577) | `.filter-select` | ✅ |

---

## Accessibility Acceptance Criteria

| Criteria | Status |
|---|---|
| Text readable WITHOUT hover (closed state) | ✅ All selects have `color: var(--text)` (#f8fafc) |
| Text readable WITHOUT hover (open option list) | ✅ `select option { color: #f8fafc }` |
| Selected value readable | ✅ Inherits element text colour |
| Option hover readable | ✅ Browser applies its own hover highlight; text remains #f8fafc |
| Keyboard focus visible | ✅ `select:focus { box-shadow: 0 0 0 2px var(--accent-glow) }` |
| Disabled option readable as muted | ✅ `select option:disabled { color: #475569 }` — muted but not invisible |
| No white dropdown panels with light text | ✅ All converted to dark panel (#1e1b4b) |
| `.form-control` white elements fixed | ✅ Confirmed by CSS addition |
| `.bom-line-item` white elements fixed | ✅ Confirmed by CSS addition |

---

## Known Browser Limitation

**macOS Safari:** The OS renders native `<select>` dropdowns using system chrome. The `select option` colour overrides are largely ignored on macOS. The select element itself (closed state) will still be dark because Safari respects element-level background/color CSS. This is a platform limitation — not fixable with CSS alone without replacing native selects with custom dropdown components, which is out of scope for this hardening task.

**Impact:** Storehouse is a cloud business app. Primary use is Windows/Chrome. macOS limitation is documented but does not block rollout.

---

## Manual Testing Instructions (for Ruan)

After deployment, verify the following in Chrome on Windows:

1. **Items → Add Item** → Open the Costing Method dropdown → Option list must show dark background with white text
2. **Items → Add Item** → Open Unit dropdown → Dark panel, white options
3. **Stock Counts → Start Count** → Open all 4 dropdowns (type, warehouse, mode, category) → All must be dark
4. **Stock Counts → [any count] → Approve** → Open approval action dropdown → Dark
5. **Purchase Orders → Add PO** → Add a line item → Line item dropdown must be dark
6. **BOMs → Add BOM** → Add a component → Component select must be dark
7. **Reports → any filter** → Open any filter dropdown → Dark option list
8. All tabs: press Tab key to cycle through select elements → Focus ring must be visible (cyan glow)

---

*Testing report complete.*
