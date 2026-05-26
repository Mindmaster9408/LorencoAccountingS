# Codebox 06 — Manufacturing Execution Testing Checklist

## Pre-Test Setup
- [ ] Run migration `056_manufacturing_execution.sql` on Supabase
- [ ] Deploy backend to Zeabur (or run locally)
- [ ] Confirm no `zbpack.json` in `accounting-ecosystem/`

---

## TEST-MFG-01 — Work Order Status Transition: pause/resume
**Precondition:** WO in `in_progress` status  
**Action:** Click Pause in WO list  
**Expected:**  
- WO status becomes `paused`  
- WO action button changes to Resume  
- Stock reservations remain intact  
**Action:** Click Resume  
**Expected:** WO status returns to `in_progress`, Complete button visible  

---

## TEST-MFG-02 — Work Order Close
**Precondition:** WO in `completed` status  
**Action:** Click Close, confirm dialog  
**Expected:**  
- WO status becomes `closed`  
- `closed_at`, `closed_by` populated in DB  
- WO row shows no action buttons  

---

## TEST-MFG-03 — Complete WO without wastage
**Precondition:** WO in `in_progress`  
**Action:** Open Complete modal, leave Wastage Qty as 0, click Receive & Complete  
**Expected:**  
- Finished goods stock increases  
- `production_batches` row created with `wastage_qty = 0`  
- No `production_wastage` row created  
- `production_variances` rows created for each BOM material  

---

## TEST-MFG-04 — Complete WO with wastage
**Action:** Enter Wastage Qty > 0, select reason, add operator notes  
**Expected:**  
- Wastage reason field auto-shows when qty > 0  
- `production_wastage` row created with correct reason  
- `production_batches.wastage_qty` matches entered value  
- `estimated_value = wastage_qty × unit_cost` populated  

---

## TEST-MFG-05 — Yield calculation
**Precondition:** WO planned qty = 100, produced = 85  
**Expected:**  
- `yield_percent = 85.0000`  
- `actual_yield_percent` on `work_orders` = 85.0  
- Production dashboard shows yield < 98% highlighted in red  

---

## TEST-MFG-06 — Material variance — under-consumption
**Precondition:** BOM material required 10 units, actual issued = 8 units  
**Expected:**  
- `production_variances` row: `variance_qty = 2`, `variance_direction = 'under'`  
- Variance report shows the line in info colour  

---

## TEST-MFG-07 — Material variance — over-consumption
**Precondition:** BOM material required 5 units, actual issued = 7 units  
**Expected:**  
- `production_variances` row: `variance_qty = 2`, `variance_direction = 'over'`  
- Variance report shows warning colour  

---

## TEST-MFG-08 — Production Dashboard loads
**Action:** Click 🏭 Production nav tab  
**Expected:**  
- Summary cards populated (batches today, batches this month, active WOs, wastage this month)  
- Recent batches table renders  
- No JS errors in console  

---

## TEST-MFG-09 — Sub-view switching
**Action:** Switch between Dashboard / Batch History / Wastage Log / Variance Report  
**Expected:** Only one view visible at a time; data loads for each view  

---

## TEST-MFG-10 — Wastage reason auto-show/hide
**Action:** Enter 0 in Wastage Qty field  
**Expected:** Wastage reason hidden  
**Action:** Enter 5 in Wastage Qty field  
**Expected:** Wastage reason auto-shows  

---

## TEST-MFG-11 — Multi-tenant isolation
**Action:** Switch company, load Production tab  
**Expected:** Only batches, wastage, and variances for the selected company are visible  

---

## TEST-MFG-12 — Cancel a paused WO
**Action:** Cancel a WO that is currently `paused`  
**Expected:**  
- Status = `cancelled`  
- Stock reservations released  
- No error  

---

## TEST-MFG-13 — No localStorage for production data
**Action:** Complete a WO with wastage, open browser DevTools → Application → localStorage  
**Expected:** No keys for batch, wastage, variance, production data present  

---

## TEST-MFG-14 — Batch record is immutable
**Action:** Attempt to DELETE or UPDATE a `production_batches` row in Supabase  
**Expected:** No application endpoint allows this; SQL row is INSERT-only at app level  

---

## TEST-MFG-15 — WO complete modal resets on reopen
**Action:** Complete WO with wastage, open another WO's complete modal  
**Expected:** Wastage Qty = 0, Wastage Reason hidden, Operator Notes cleared  

---

## TEST-MFG-16 — Status filter shows paused and closed
**Action:** Open Work Orders tab, filter by Paused  
**Expected:** Only paused WOs shown  
**Action:** Filter by Closed  
**Expected:** Only closed WOs shown  

---

## TEST-MFG-17 — Invalid status transitions blocked
**Action:** Try to close a WO that is `in_progress` (directly via API: POST /close)  
**Expected:** 400 response with message "Cannot transition from in_progress to closed"  
