# AC-04 Invoice Atomicity Fix Report

**Date:** 2026-05-27  
**Task:** AC-04 — Customer and supplier invoice header + line writes must be atomic  
**Status:** COMPLETE  

---

## 1. Summary

Prior to this fix, customer and supplier invoice creation and editing used multiple independent Supabase PostgREST HTTP calls for the header row and the line rows. These calls could not be wrapped in a single database transaction. A network failure, constraint violation, or any error after the header was written but before the lines were written would leave an orphan invoice header with no lines permanently in the database.

All four affected operations (AR create, AR update, AP create, AP update) now use a `BEGIN` / `COMMIT` / `ROLLBACK` pg pool transaction so the header and lines are written atomically.

---

## 2. Root Cause

The Supabase JavaScript client communicates via PostgREST (HTTP). Each `.from().insert()` or `.from().update()` call is a separate HTTP request. PostgREST does not support multi-statement transactions across separate requests. There is no mechanism in the Supabase JS client to issue `BEGIN` / `COMMIT` that spans two separate insert calls.

The pg pool client (`db.getClient()`) communicates directly over TCP to PostgreSQL port 5432 and fully supports `BEGIN` / `COMMIT` / `ROLLBACK` via `client.query()`. This is the correct tool for multi-statement atomic operations.

---

## 3. Files Changed

| File | Change |
|---|---|
| `backend/modules/accounting/routes/customer-invoices.js` | Added `db` import; replaced non-atomic AR create with pg transaction; replaced non-atomic AR update with pg transaction; removed now-unused `updatePayload` variable |
| `backend/modules/accounting/routes/suppliers.js` | Added `db` import; replaced non-atomic AP create with pg transaction; replaced non-atomic AP update with pg transaction |

---

## 4. Customer Invoice (AR) — Transaction Flows

### 4.1 Create (POST /)

**Pre-flight (outside transaction — Supabase reads, unchanged):**
1. Duplicate invoice number guard — Supabase read, returns 409 if duplicate
2. `processedLines` and `totals` computation — pure calculation, no DB
3. Invoice number auto-generation — Supabase count read (race condition is pre-existing, out of scope)

**pg transaction:**
```
BEGIN
  INSERT INTO customer_invoices (...) VALUES (...) RETURNING *  → invoice
  INSERT INTO customer_invoice_lines (...) VALUES (bulk rows)
COMMIT
```

**Post-commit (outside transaction — unchanged):**
- `AuditLogger.log()`
- `res.status(201).json()`

**Rollback scenario:** If the line INSERT fails for any reason, `ROLLBACK` fires and the header row is also removed. No orphan header can exist.

### 4.2 Update (PUT /:id)

**Pre-flight (outside transaction — Supabase reads, unchanged):**
1. Fetch existing invoice — returns 404 if not found
2. Status guard — returns 409 if not draft (with audit log)
3. `processedLines` and `totals` computation — pure calculation

**pg transaction:**
```
BEGIN
  UPDATE customer_invoices SET ... WHERE id=$N AND company_id=$M
  DELETE FROM customer_invoice_lines WHERE invoice_id=$N
  INSERT INTO customer_invoice_lines (...) VALUES (bulk rows)   ← only if lines provided and non-empty
COMMIT
```

**Post-commit (outside transaction — unchanged):**
- Fetch updated invoice + lines via Supabase (for response shape)
- `AuditLogger.log()`
- `res.json()`

**Rollback scenario:** If the line DELETE or INSERT fails, `ROLLBACK` restores the header and lines to their pre-edit state. The invoice is never left in a state where the header totals have been updated but the lines are absent or inconsistent.

**Effective-value resolution:** The update handler previously built a conditional `updatePayload` object (setting `customer_name`, `invoice_number`, `invoice_date` only when provided). The pg query always sets all three fields using resolved effective values:
```javascript
const effectiveCustomerName  = customerName  || existing.customer_name;
const effectiveInvoiceNumber = invoiceNumber || existing.invoice_number;
const effectiveInvoiceDate   = invoiceDate   || existing.invoice_date;
```
Behaviour is identical to the original — unchanged fields keep their existing values.

---

## 5. Supplier Invoice (AP) — Transaction Flows

### 5.1 Create (POST /invoices)

**Pre-flight (outside transaction — Supabase reads, unchanged):**
1. Supplier ownership verification — returns 400 if supplier not in this company
2. Duplicate invoice number guard — returns 409 if duplicate
3. `processedLines` and `totals` computation — pure calculation
4. Pre-creation GL account validation (codes 2000 and 1400) — returns 422 if absent

**pg transaction:**
```
BEGIN
  INSERT INTO supplier_invoices (...) VALUES (...) RETURNING *  → invoice
  INSERT INTO supplier_invoice_lines (...) VALUES (bulk rows)
COMMIT
```

**Post-commit (outside transaction — unchanged and critical):**
- GL posting via `JournalService.createDraftJournal()` + `JournalService.postJournal()` — **must not run inside the pg transaction**. JournalService issues its own DB calls on separate connections. If GL posting fails, existing compensation logic (journal reversal + invoice cancellation) handles recovery.
- Update `supplier_invoices.journal_id` via Supabase after GL post
- Fetch full invoice for response
- `AuditLogger.log()`
- `res.status(201).json()`

**Rollback scenario:** If the line INSERT fails, `ROLLBACK` removes the header row. No orphan `status='unpaid'` invoice exists when GL posting begins. GL posting only starts after both header and lines are successfully committed.

### 5.2 Update (PUT /invoices/:id)

**Pre-flight (outside transaction — Supabase reads and GL correction, unchanged):**
1. Fetch existing invoice (includes `journal_id`) — returns 404 if not found
2. Paid status guard — returns 400 if paid
3. VAT period lock guard — returns 403 if in a locked VAT period
4. `processedLines` and `newTotals` computation — pure calculation
5. Accounting-impact detection (amount, date, account changes)
6. GL correction if needed: create replacement journal → post → reverse original journal ← **this runs before the invoice update and is unchanged**
7. `newJournalId` is set to the replacement journal ID (or kept as the original if no correction was needed)

**pg transaction:**
```
BEGIN
  UPDATE supplier_invoices SET ... WHERE id=$N AND company_id=$M   ← includes journal_id = newJournalId
  DELETE FROM supplier_invoice_lines WHERE invoice_id=$N
  INSERT INTO supplier_invoice_lines (...) VALUES (bulk rows)
COMMIT
```

**Post-commit (outside transaction — unchanged):**
- Fetch full invoice + lines via Supabase (for response shape)
- `AuditLogger.log()` (with `glCorrected` flag)
- `res.json()`

**Rollback scenario:** If the line DELETE or INSERT fails, `ROLLBACK` restores the header to its pre-edit state (with the original `journal_id`). Note: GL correction (journal reversal + replacement) has already been committed at this point. This is a pre-existing risk inherent to the GL correction pattern and is out of scope for AC-04. The AC-04 fix ensures the invoice record and its lines remain consistent with each other in all rollback scenarios.

---

## 6. Transaction Pattern Used

Pattern established in `historicalComparativesService.js` (Fix Pack 01), now applied consistently:

```javascript
const dbClient = await db.getClient();
let result;
try {
  await dbClient.query('BEGIN');
  // ... atomic DB writes ...
  await dbClient.query('COMMIT');
} catch (txErr) {
  await dbClient.query('ROLLBACK');
  throw txErr;
} finally {
  dbClient.release();
}
// AuditLogger and response outside the transaction
```

**Why `finally { dbClient.release() }`:** Ensures the pg pool client is always returned to the pool even if `ROLLBACK` throws (which is extremely rare but possible if the connection is lost mid-rollback). Without this, pool exhaustion would eventually occur.

---

## 7. What Was Deliberately Not Changed

| Item | Reason |
|---|---|
| `calcLineVAT()` helper | VAT calculation logic — strictly out of scope |
| `JournalService.postJournal()` and `reverseJournal()` calls | GL posting is a post-commit operation; cannot be inside pg transaction |
| Existing GL compensation logic in AP create | journal_id link failure recovery — unchanged and correct |
| Existing GL correction flow in AP update (steps 1-2) | Pre-existing pattern; out of scope for AC-04 |
| `AuditLogger.log()` placement | Must remain outside transactions — same pattern as historicalComparativesService |
| All GET routes (list, detail, aging) | Read-only — no atomicity concern |
| POST /:id/post, POST /:id/void, POST /payments | Out of scope for AC-04 |
| Duplicate invoice guards (Supabase reads) | Pre-flight checks — correct to run before transaction |
| Response fetch after commit (Supabase reads for shape) | Post-commit — correct; response needs join-shaped data not available from `RETURNING *` |

---

## 8. Required Tests Before Push

| Test | Scenario | Expected Result |
|---|---|---|
| AR-CREATE-01 | Create customer invoice with 3 lines; all succeed | Invoice and all 3 lines in DB; no orphan rows |
| AR-CREATE-02 | Simulate line insert failure (e.g., FK violation on account_id) | Header row absent from DB; no orphan header |
| AR-UPDATE-01 | Edit customer invoice (draft); change lines | Header and new lines consistent; old lines gone |
| AR-UPDATE-02 | Simulate line insert failure during update | Header reverts to pre-edit state; lines unchanged |
| AR-UPDATE-03 | Attempt to edit posted customer invoice | Returns 409; header and lines unchanged |
| AP-CREATE-01 | Create supplier invoice with 2 lines; all succeed | Invoice and both lines in DB; GL journal linked |
| AP-CREATE-02 | Simulate line insert failure during supplier create | Header row absent; no orphan unpaid invoice |
| AP-UPDATE-01 | Edit supplier invoice with no accounting change | Header and new lines consistent; no GL correction |
| AP-UPDATE-02 | Edit supplier invoice with amount change | GL corrected (reversal + replacement); header and lines consistent |
| AP-UPDATE-03 | Attempt to edit paid supplier invoice | Returns 400; header and lines unchanged |

---

## 9. Remaining Risks (Out of Scope for AC-04)

| Risk | Description | Status |
|---|---|---|
| AP update GL correction orphan on rollback | If the pg transaction rolls back after GL correction has already committed, the replacement journal is active and the original is reversed — but the invoice header still shows the old `journal_id`. Manual reconciliation required. | Pre-existing risk; requires separate fix in a future task |
| AR invoice number race condition on auto-generate | `count + 1` is not atomic; two concurrent creates could get the same invoice number. A DB unique constraint on `(company_id, invoice_number)` would catch the second and return a constraint error (which is a safe failure). | Pre-existing risk; out of scope |
| AP create GL failure after header+lines committed | If GL posting fails after the pg transaction commits, the compensation logic (cancel invoice) runs via Supabase. This is correct and unchanged. | Existing compensation pattern is adequate |
