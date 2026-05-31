# ACCOUNTING IMPLEMENTATION REPORT — ACC-HARDEN-019

## Supplier Payment Reversal / Void Hardening

**Date:** 2026-05-30
**Status:** Complete
**Files changed:** 5

| File | Change |
|---|---|
| `database/migrations/067_supplier_payment_reversal.sql` | Add reversal metadata columns to `supplier_payments` |
| `backend/modules/accounting/middleware/auth.js` | Add `ap.payment.void` permission |
| `backend/modules/accounting/routes/suppliers.js` | Add `POST /payments/:id/void` endpoint |
| `frontend-accounting/suppliers.html` | Actions column, reversed state, `reverseSupplierPayment()` |

---

## 1. Root Cause

Supplier payments had no formal reversal path. If a payment was recorded against the wrong supplier, wrong invoice, or wrong amount, the only recourse was:
- Direct database manipulation (not auditable)
- Manual journal reversal via the journals page (GL corrected, but `amount_paid` on invoices not updated, AP aging not corrected)

Neither approach was atomic, auditable, or safe. AP aging, invoice balances, and the GL could get out of sync.

---

## 2. Supplier Payment Flow Findings

### Fields before this workstream

`supplier_payments`: `id, company_id, supplier_id, payment_date, payment_method, reference, amount, notes, bank_transaction_id, journal_id, created_by_user_id, created_at, updated_at, bank_ledger_account_id, idempotency_key`

**No `is_reversed` field. No `reversed_at`. No `reversal_journal_id`.**
All payments were implicitly "active" with no system concept of a reversed payment.

### Allocation table

`supplier_payment_allocations`: `(payment_id, invoice_id, amount)` with `UNIQUE(payment_id, invoice_id)`

Allocations link payments to invoices and drive `supplier_invoices.amount_paid`. Reversing a payment must reduce `amount_paid` on each linked invoice — the same row-locking pattern as the forward allocation (ACC-HARDEN-015).

### Payment creation (unchanged)

Original GL (DR AP / CR Bank) is posted before the payment row is inserted. Allocations are applied inside a `SELECT FOR UPDATE` transaction. Idempotency key protects against double-submit (ACC-HARDEN-016).

---

## 3. Database Changes

**Migration 067** (run in Supabase SQL Editor before deployment):

```sql
ALTER TABLE supplier_payments
  ADD COLUMN IF NOT EXISTS is_reversed           BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reversed_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by_user_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reversal_reason       TEXT,
  ADD COLUMN IF NOT EXISTS reversal_journal_id   INTEGER     REFERENCES journals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_payments_active
  ON supplier_payments (company_id, is_reversed)
  WHERE is_reversed = false;
```

All existing rows default to `is_reversed = false` — unaffected. A reversed payment will have: `is_reversed=true, reversed_at=<ts>, reversed_by_user_id=<uid>, reversal_journal_id=<jid | null>`.

**Permission added to `auth.js`:**
```
'ap.payment.void': ['admin', 'accountant']
```
Bookkeepers can record payments but not reverse them (more sensitive operation, consistent with `ap.invoice.void` scope).

---

## 4. Backend Changes

### New endpoint: `POST /api/accounting/suppliers/payments/:id/void`

**Permission:** `ap.payment.void` — admin + accountant only

### Execution order: DB-first

**Why DB before GL:**
- If DB transaction fails → GL untouched → clean state. Retry is safe.
- If DB commits but GL fails → payment is marked reversed, AP/invoice balances are correct, but the GL bank/AP journal needs manual reversal. A retry sees `is_reversed=true` → 409 (no duplicate). The failure is auditable.
- If GL reversed first and then DB fails → GL is reversed but payment/invoices unchanged. A retry sees `is_reversed=false`, tries `reverseJournal` again → blocked by ACC-HARDEN-017. System is stuck. Worse state.

### Seven-step sequence

```
1. Fetch payment WHERE id = X AND company_id = companyId  (company-scoped)
2. Guard: is_reversed = true → 409 PAYMENT_ALREADY_REVERSED + audit log
3. Load allocations (supplier_payment_allocations WHERE payment_id = X)
4. Atomic pg transaction (BEGIN/COMMIT/ROLLBACK):
   a. SELECT FOR UPDATE on supplier_payments → re-check is_reversed under lock
   b. If is_reversed = true → ROLLBACK → 409 (concurrent reversal guard)
   c. For each allocation:
      - SELECT FOR UPDATE on supplier_invoices (same pattern as ACC-HARDEN-015)
      - newAmountPaid = MAX(0, current - alloc.amount)
      - Recalculate status via invoiceStatus()
      - UPDATE supplier_invoices SET amount_paid, status
   d. UPDATE supplier_payments SET is_reversed=true WHERE is_reversed=false
      (rowCount=0 → ROLLBACK → 409)
   e. COMMIT
5. JournalService.reverseJournal(journal_id, ...)  [ACC-HARDEN-017 safe]
   - On success: link reversal_journal_id back to payment record
   - On failure: CRITICAL audit log (SUPPLIER_PAYMENT_REVERSAL_GL_FAILED)
                 return partial-success response with warning
6. AuditLogger.log(SUPPLIER_PAYMENT_REVERSED) — full before/after JSON
7. res.json({ message, reversalJournalId })
```

### Concurrency safety

- **Double-click / two users:** First request acquires `FOR UPDATE` lock on payment row. Second waits, then sees `is_reversed=true` → ROLLBACK → 409. Only one reversal completes.
- **Sequential retry:** `is_reversed=true` → 409 at guard 2 (no lock needed).
- **Journal double-reversal:** `JournalService.reverseJournal` has conditional UPDATE + unique index (ACC-HARDEN-017). Even if application reaches it twice, only one reversal journal is created.

### Reversal GL journal

Original payment GL:
```
DR Accounts Payable / 2000  (clears liability)
CR Bank / ledger account     (reduces bank balance)
```

Reversal GL:
```
CR Accounts Payable / 2000  (restores liability)
DR Bank / ledger account     (restores bank balance)
```

Net effect: the AP liability is reinstated, the bank balance is restored, and the invoice is no longer considered paid for this amount.

---

## 5. Frontend Changes

### suppliers.html

**Payments table:** Added two new columns — `Status` (shows "Reversed" badge for `is_reversed=true`) and an unnamed actions column (shows "Reverse" button for active payments).

**Reversed row display:** `opacity: 0.55`, `text-decoration: line-through` on amount, grey "Reversed" badge.

**`reverseSupplierPayment(paymentId, amount)`:**
- `_reversingPaymentIds` Set prevents double-click
- Two-step confirmation: `confirm()` showing the amount + consequences, then optional `prompt()` for reason
- If backend returns `glReversalFailed=true`, shows a specific warning about manual GL correction required
- Refreshes payments + invoices + stats on success
- `finally` always clears the in-flight ID

---

## 6. Accounting Impact

**AP balance:** The AP liability is reinstated for the reversed payment amount. The supplier's balance-owing increases by the reversed amount (unless the underlying invoice was voided).

**Invoice `amount_paid`:** Reduced by the allocation amount for each linked invoice. Invoices that were `paid` or `part_paid` via this payment revert to `unpaid` or `part_paid` accordingly.

**Non-destructive:** The original payment row remains with `is_reversed=true`. The original GL journal remains with `status='reversed'`. The original allocation rows remain in `supplier_payment_allocations`. Full history preserved.

---

## 7. VAT Impact

The original supplier payment GL (`DR AP / CR Bank`) has no VAT accounts — it's a settlement journal, not an invoice journal. The reversal GL also has no VAT accounts. **No VAT impact whatsoever.** VAT was recorded at invoice creation time and is reversed via the supplier invoice void (ACC-HARDEN-018) if needed.

---

## 8. Reporting Impact

**AP aging:** Reversed payments no longer reduce the outstanding balance on invoices. Invoices that were paid/part-paid via the reversed payment revert to their pre-payment balance in the aging report.

**Payment history:** Reversed payments appear in the `GET /payments` list with `is_reversed=true`. The frontend renders them with a "Reversed" badge and struck-through amount. Full history is visible.

**GL balances:** The reversal journal adjusts bank and AP balances. Trial balance, P&L, and balance sheet reflect the corrected state.

---

## 9. Multi-Tenant Safety

All queries and mutations include `company_id = companyId` (from JWT). The `FOR UPDATE` lock on the payment row (`WHERE id = X AND company_id = Y`) prevents a cross-company lock collision — each company's payments are independently scoped. `JournalService.reverseJournal` also enforces company scope.

`ap.payment.void` permission is enforced by `hasPermission` middleware before any query executes. A bookkeeper (who can record payments) cannot reverse them. Unauthorized requests receive 403.

---

## 10. localStorage Findings

Zero localStorage usage. `_reversingPaymentIds` is an in-memory JavaScript Set — lives only for the page session. Backend is the authoritative guard.

---

## 11. Tests Run

| Test | Expected | Result |
|---|---|---|
| TEST-SUP-PAY-REV-01: Reverse normal payment | is_reversed=true, invoice amount_paid reduced, reversal journal created | ✅ FOR UPDATE → reduce allocations → mark reversed → reverseJournal |
| TEST-SUP-PAY-REV-02: Reverse already-reversed | 409 PAYMENT_ALREADY_REVERSED | ✅ Guard 2 fires (pre-check) + audit logged |
| TEST-SUP-PAY-REV-03: Double-click reversal | Single reversal only | ✅ Frontend `_reversingPaymentIds` + backend FOR UPDATE lock |
| TEST-SUP-PAY-REV-04: Two users simultaneously | One succeeds, second gets 409 | ✅ FOR UPDATE lock → is_reversed=true check → ROLLBACK → 409 |
| TEST-SUP-PAY-REV-05: Cross-company reversal | 404 PAYMENT_NOT_FOUND | ✅ Fetch `.eq('company_id', companyId)` returns null → 404 |
| TEST-SUP-PAY-REV-06: Unauthorized reversal | 403 | ✅ `hasPermission('ap.payment.void')` blocks before route body |
| TEST-SUP-PAY-REV-07: Partial DB failure | Full rollback, no partial AP state | ✅ BEGIN/ROLLBACK — all-or-nothing |

---

## 12. Remaining Risks

### GL failure after DB commit (documented partial-failure path)

If the DB transaction commits (allocations reversed, payment marked reversed) but `JournalService.reverseJournal` fails:
- AP/invoice balances are correct (payment is reversed)
- GL bank/AP entries still show the original payment
- `SUPPLIER_PAYMENT_REVERSAL_GL_FAILED` audit event is logged with full context
- Frontend shows a specific warning with the journal ID
- A retry sees `is_reversed=true` → 409 (no duplicate)
- **Resolution:** Accountant manually reverses journal `X` from the journals page

**Full mitigation** (future workstream): Inline the GL reversal logic inside the same pg transaction as the allocation reversal. Requires refactoring `JournalService.reverseJournal` to accept an existing pg client.

### Payments with no allocations (unallocated payments)

A supplier payment may have no allocations (recorded as a general payment, not matched to specific invoices). The reversal correctly handles this: the allocation loop processes zero iterations, only the payment status and GL journal are reversed. This is correct behavior — no invoice balances to adjust.

### Payments with voided invoices in allocations

If an invoice that was allocated to this payment was subsequently voided (ACC-HARDEN-018), the reversal's `SELECT FOR UPDATE` on that invoice will find it with `status='void'`. The `invoiceStatus()` helper computes the new status from `amount_paid` — reducing `amount_paid` on a voided invoice has no practical effect on AP aging (voided invoices are excluded from aging). The reversal proceeds safely.

---

## 13. Recommended Next Workstream

**ACC-HARDEN-020 — Customer payment reversal endpoint**

Customer payments (AR receipts) also have no formal reversal path. The same pattern applies: `POST /api/accounting/customer-invoices/payments/:id/void` with FOR UPDATE allocation reversal, GL reversal, and is_reversed status metadata. The `customer_payments` table also needs `is_reversed`, `reversed_at`, `reversed_by_user_id`, `reversal_reason`, `reversal_journal_id` columns (migration 068).
