# Phase 1 Testing Report — Lorenco Storehouse

**Date:** 2026-04-24  
**Purpose:** Manual smoke test plan for all Phase 1 stability fixes  
**Prerequisites:** Migration `016_inventory_phase1_stability.sql` applied, backend deployed

---

## Test Environment Setup

Before testing, ensure:
1. Migration 016 has been applied to Supabase
2. At least one company with inventory module access exists
3. At least one supplier exists in the database
4. At least one inventory item exists with known `current_stock` value

---

## TEST BLOCK 1 — Supplier Routes

### TEST-1A: Load Suppliers List

**Action:** Navigate to Storehouse → Suppliers tab  
**Expected:** Supplier list loads without error. Supplier names display correctly.  
**Pass Criteria:** No "column not found" or 500 error in network tab  

### TEST-1B: Create New Supplier

**Action:** Click "New Supplier", fill in name, email, phone, VAT number, notes, save  
**Expected:** Supplier saves and appears in list  
**Pass Criteria:** HTTP 201 response, supplier visible in list with correct name  

### TEST-1C: Edit Supplier

**Action:** Edit an existing supplier, change name, save  
**Expected:** Changes persist  
**Pass Criteria:** HTTP 200, updated name shows in list  

---

## TEST BLOCK 2 — Stock Movement Validation

### TEST-2A: Valid Stock-In

**Action:** Go to Items tab, note current_stock of any item (e.g., Item A has 10 units).  
Navigate to Movements, create a stock-in movement for Item A, quantity = 5  
**Expected:** Movement created, Item A now shows 15 units  
**Pass Criteria:** HTTP 201, stock increases correctly  

### TEST-2B: Valid Stock-Out

**Action:** Create a stock-out movement for Item A, quantity = 3  
**Expected:** Movement created, Item A now shows 12 units  
**Pass Criteria:** HTTP 201, stock decreases correctly  

### TEST-2C: Reject Negative Quantity

**Action:** Try to POST movement with quantity = -5 (via API or browser DevTools)  
**Expected:** HTTP 400 "quantity must be a positive number"  
**Pass Criteria:** No movement created, no stock change  

### TEST-2D: Reject Over-Issue via Movement

**Action:** Create a stock-out movement for Item A with quantity = 999 (more than current_stock)  
**Expected:** HTTP 422 with `{ error: "Insufficient stock", available: <current>, requested: 999 }`  
**Pass Criteria:** No movement created, no stock change, available qty returned  

### TEST-2E: Zero Quantity Rejection

**Action:** Try to POST movement with quantity = 0  
**Expected:** HTTP 400  
**Pass Criteria:** Rejected cleanly  

---

## TEST BLOCK 3 — Work Order Issue Materials

### TEST-3A: Sufficient Stock — Issue Succeeds

**Setup:** WO in `in_progress` status. Materials: Item B (required_qty = 5, issued_qty = 0). Item B has current_stock = 20.  
**Action:** Issue 5 units of Item B to the WO  
**Expected:** `issued_qty` becomes 5. Item B stock becomes 15. HTTP 200.  
**Pass Criteria:** All three values update correctly  

### TEST-3B: Insufficient Stock — All-or-Nothing Rejection

**Setup:** WO with two materials: Item C (required = 5, stock = 10) and Item D (required = 5, stock = 2)  
**Action:** Issue both in one request (5 of C and 5 of D)  
**Expected:** HTTP 422. Neither item's stock changes. Neither issued_qty changes.  
**Pass Criteria:** Item C stock still = 10, Item D stock still = 2  
**Key test:** This proves the all-or-nothing pre-validation works. If old code was running, C would have been deducted before D was checked.  

### TEST-3C: Cannot Issue to Draft WO

**Action:** Try to issue materials to a WO in `draft` or `released` status  
**Expected:** HTTP 400 "Can only issue materials to an in-progress work order"  

---

## TEST BLOCK 4 — Work Order Completion Safety

### TEST-4A: Block Completion When Materials Not Issued

**Setup:** WO in `in_progress` status with materials where `issued_qty < required_qty`  
**Action:** Attempt to complete the WO  
**Expected:** HTTP 422 with `missing_materials` array listing each unissued material  
**Pass Criteria:** WO status remains `in_progress`, no stock change for finished goods  

### TEST-4B: Allow Completion When All Materials Issued

**Setup:** WO in `in_progress`, all materials fully issued  
**Action:** Complete the WO  
**Expected:** HTTP 200. WO status → `completed`. Finished goods item stock increases by qty_produced.  
**Pass Criteria:** Stock movement record created for finished goods item  

### TEST-4C: Allow Completion With No Materials (No BOM)

**Setup:** WO in `in_progress` with zero material lines  
**Action:** Complete the WO  
**Expected:** HTTP 200. Completes normally.  
**Pass Criteria:** No false "materials not issued" rejection  

---

## TEST BLOCK 5 — PO Receiving Flow

### TEST-5A: Receive Button Appears

**Action:** Navigate to Purchase Orders tab  
**Expected:** All POs in `draft`, `sent`, or `partial_receipt` status have a "Receive" button in the Actions column. POs in `received` or `cancelled` status show "—".  

### TEST-5B: Open Receive Modal

**Action:** Click "Receive" on a PO in `sent` status  
**Expected:** Modal opens. PO lines load with item names, ordered qty, received qty, remaining qty, and a pre-filled quantity input showing remaining qty.  

### TEST-5C: Receive Full PO

**Setup:** PO with 2 lines, both with zero received_qty  
**Action:** Open receive modal, keep default quantities (full remaining), click "Receive Stock"  
**Expected:**  
- Both items' stock increases by received qty  
- Stock movement records created for both items  
- PO status changes to `received`  
- PO table refreshes  
- Success toast shown  

### TEST-5D: Partial Receive

**Setup:** PO with 2 lines (e.g., 10 units each, both unreceived)  
**Action:** Receive 5 of line 1, leave line 2 at 0  
**Expected:**  
- Line 1 item stock increases by 5  
- PO status changes to `partial_receipt`  
- Receive button still shows on the PO  

### TEST-5E: Second Partial Receive Completes PO

**Action:** Click Receive on the same PO now in `partial_receipt`. Receive the remaining 5 of line 1 and all of line 2.  
**Expected:**  
- Stock increases correctly  
- PO status changes to `received`  
- Receive button disappears from the PO row  

### TEST-5F: Block Over-Receiving

**Action:** In the receive modal, manually type a quantity higher than remaining for a line  
**Expected:** HTTP 400 "Over-receiving prevented" error toast  
**Pass Criteria:** No stock change, no PO update  

### TEST-5G: Block Receiving Against Cancelled PO

**Action:** Via API, POST to `/purchase-orders/:id/receive` for a cancelled PO  
**Expected:** HTTP 400 "Cannot receive against a cancelled purchase order"  

---

## TEST BLOCK 6 — Colour Alignment

### TEST-6A: Visual Palette

**Action:** Open the Storehouse and inspect visually  
**Expected:**
- Background: deep indigo (#0f172a) with purple panel gradient
- Borders: cyan-tinted semi-transparent (not white-tinted)
- Modals: indigo panel background (not old navy `#0d1b2a`)

### TEST-6B: Partial Receipt Badge

**Action:** Set a PO to `partial_receipt` status  
**Expected:** Badge shows "partial receipt" (with space, not underscore) with warning styling  

### TEST-6C: PO Status Filter

**Action:** Open the PO status filter dropdown  
**Expected:** "Partial Receipt" option is present between Sent and Received  

---

## TEST BLOCK 7 — Regression Verification

### TEST-7A: Existing BOM Routes Unchanged

**Action:** Create a BOM, add lines, set to active  
**Expected:** Works exactly as before Phase 1 changes  

### TEST-7B: WO Release and Start Still Work

**Action:** Create WO → Release → Start  
**Expected:** Status transitions work as before  

### TEST-7C: Item CRUD Unchanged

**Action:** Create, edit, and view items  
**Expected:** No regression  

### TEST-7D: Warehouse CRUD Unchanged

**Action:** Create, edit, and view warehouses  
**Expected:** No regression  

### TEST-7E: Dashboard Loads

**Action:** Navigate to Dashboard tab  
**Expected:** Stats load without error  

---

## Known Edge Cases to Monitor

| Case | Risk | Mitigation |
|------|------|------------|
| Items with `current_stock < 0` before migration | The `NOT VALID` constraint won't block them, but the RPC will reject further deductions | Run the diagnostic query in migration comments before production deployment |
| Suppliers with no `supplier_name` (legacy null) | Migration backfills from legacy columns; falls back to 'Unknown Supplier' | Monitor for any suppliers named 'Unknown Supplier' after migration |
| POs with status `partial` (old value) | Migration updates constraint but existing `partial` rows remain | Run manual UPDATE: `UPDATE purchase_orders SET status='partial_receipt' WHERE status='partial'` if needed |

---

## Sign-Off Checklist

- [ ] All TEST-1 tests pass (Supplier routes)
- [ ] All TEST-2 tests pass (Movement validation)
- [ ] All TEST-3 tests pass (Issue materials)
- [ ] All TEST-4 tests pass (WO completion)
- [ ] All TEST-5 tests pass (PO receiving)
- [ ] All TEST-6 tests pass (Colour alignment)
- [ ] All TEST-7 tests pass (Regression)
