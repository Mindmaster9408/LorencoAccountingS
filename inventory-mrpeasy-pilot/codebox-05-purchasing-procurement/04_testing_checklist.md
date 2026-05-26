# Codebox 05 — Testing Checklist

## Pre-Deploy Checklist

- [ ] Migration 055 run against Supabase
- [ ] No `accounting-ecosystem/zbpack.json` exists
- [ ] `accounting-ecosystem/Dockerfile` unchanged
- [ ] No `localStorage.setItem` calls for procurement/receipt/supplier data

---

## Manual Test Cases

### PO Lifecycle

| Test | Steps | Expected |
|---|---|---|
| PCT-01 Create PO | Open Storehouse → Purchase Orders → + Create PO. Select supplier, add 2 lines, save. | PO created as draft with `LPO-YYYY-NNNN` number. Appears in list. |
| PCT-02 Approve PO | Click Approve on draft PO. | Status → approved. Approve button disappears. Mark Ordered appears. |
| PCT-03 Mark Ordered | Click Mark Ordered on approved PO. | Status → ordered. Receive button appears. |
| PCT-04 Receive partial | Click Receive on ordered PO. Reduce qty on line 2 to 0. Submit. | Status → partial_receipt. Receive button still shows. Stock increases for line 1 only. |
| PCT-05 Receive remainder | Click Receive on partial_receipt PO. Submit remaining qty. | Status → fully_received. Close button appears. |
| PCT-06 Close PO | Click Close on fully_received PO. | Status → closed. No action buttons remain (only View). |
| PCT-07 Cancel draft | Create new draft PO. Click Cancel. | Status → cancelled. |
| PCT-08 Cancel with receipts | Attempt cancel on PO with receipts. | Backend returns 400 error. "Cannot cancel — receipts exist." |
| PCT-09 Over-receive blocked | Receive with qty > remaining. | Backend returns 400. No stock mutation. No receipt record. |

---

### Procurement Suggestions

| Test | Steps | Expected |
|---|---|---|
| PCT-10 Load suggestions | Navigate to Procurement tab → Refresh. | Table loads with shortage and reorder rows. Summary bar shows counts. |
| PCT-11 Create PO from suggestion | Click "Create PO" on a suggestion row. | createPoModal opens with supplier and item pre-filled. |
| PCT-12 Overdue POs | Click "Overdue POs" button. | Table shows POs past expected_date with open status. Days overdue shown. |

---

### Receipt History

| Test | Steps | Expected |
|---|---|---|
| PCT-13 View receipt history | Click View on a received PO. | poDetailModal shows PO summary, order lines, and immutable receipt history with costs. |
| PCT-14 Multiple receipts shown | PO with 3 partial receives → View. | All 3 receipts listed with dates, quantities, costs. |

---

### Stock Integrity

| Test | Steps | Expected |
|---|---|---|
| PCT-15 Stock increases on receive | Note stock level for item before receipt. Receive 10 units. Check item stock. | Stock increased by exactly 10. |
| PCT-16 Movement created | After receive, check Movements tab. | One movement per line with type `po_receive`, sourceId = receipt id. |
| PCT-17 Multi-tenant isolation | Log in as different company. | Cannot see or receive POs from other company. 403 or empty results. |

---

## Regression Tests Required (PAYTIME RULE E3 not triggered — no payroll files changed)

Per `paytime.protected.json` — no auto-trigger files were modified. Full 14-test regression gate not required. However standard inventory smoke tests apply:

- [ ] Dashboard loads without errors
- [ ] Items tab loads
- [ ] Stock movements record
- [ ] Work orders load
- [ ] Reservations load
