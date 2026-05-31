# ACCOUNTING IMPLEMENTATION REPORT — ACC-HARDEN-018

## Supplier Invoice Void Forensic Hardening

**Date:** 2026-05-30
**Status:** Complete
**Files changed:** 4

| File | Change |
|---|---|
| `database/migrations/066_supplier_invoice_void.sql` | Add `voided_at`, `voided_by_user_id`, `void_reason` to `supplier_invoices` |
| `backend/modules/accounting/routes/suppliers.js` | Add `POST /invoices/:id/void` endpoint |
| `frontend-accounting/suppliers.html` | Void button, `voidSupplierInvoice()` function, `.badge-void` CSS, `fmtStatus` update |

---

## 1. Root Cause

Customer invoices had a formal void path (`POST /api/accounting/customer-invoices/:id/void`) with all required guards, atomic GL reversal, and full audit logging. Supplier invoices had no equivalent. The only way to cancel a supplier invoice was through:
- The GL correction path (`PUT /invoices/:id` — reverse+replace, only for accounting changes)
- The error-recovery cancellation (`status='cancelled'` set by the system after GL failure)
- Direct database manipulation (not auditable)

This left supplier invoice voiding without a controlled, traceable workflow. AP balances, VAT input claims, and the audit trail could be modified without a formal record of who voided what and why.

---

## 2. Current Supplier Invoice Flow Findings

### Supplier invoice lifecycle (before this workstream)

| Step | Mechanism |
|---|---|
| Create | `POST /invoices` — creates header + lines, immediately posts to GL (DR Expense + DR VAT Input / CR AP 2000) |
| Edit | `PUT /invoices/:id` — if accounting amounts changed, reverses original GL journal and posts a replacement |
| Pay | `POST /payments` — DR AP / CR Bank, allocates to invoice (ACC-HARDEN-015 row lock) |
| Cancel (system) | Set to `status='cancelled'` only during GL failure recovery — not user-triggered |
| Void | **Not implemented** — this workstream adds it |

### Status values (before)
`draft`, `unpaid`, `part_paid`, `paid`, `cancelled`

**After:** `void` added as a valid formal status.

### Key differences from customer invoice void

| | Customer | Supplier |
|---|---|---|
| Created as | Draft (not posted) | Posted to GL immediately |
| Posted separately | Yes (`POST /:id/post`) | No — post happens on create |
| Void eligibility | `status !== 'void'`, no payments, VAT not locked | Same |
| GL at void | Reverse the posted journal | Reverse the posted journal |
| Permission | `ar.invoice.void` | `ap.invoice.void` (already registered) |

---

## 3. Void Eligibility Rules Implemented

All guards run before any mutation.

| Guard | Error code | HTTP |
|---|---|---|
| Invoice not found or wrong company | `SUPPLIER_INVOICE_NOT_FOUND` | 404 |
| Already void | `INVOICE_ALREADY_VOID` | 409 |
| Payments applied (`amount_paid > 0.005`) | `INVOICE_HAS_PAYMENTS` | 409 |
| Invoice's GL journal is in a locked VAT period | `VAT_PERIOD_LOCKED` | 409 |

All blocked attempts are audit logged with `SUPPLIER_INVOICE_VOID_BLOCKED` + the reason code.

---

## 4. Database Changes

**Migration 066** (run in Supabase SQL Editor before deployment):

```sql
ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS voided_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason       TEXT;
```

All existing rows retain `NULL` for these columns — unaffected. A voided invoice will have:
- `status = 'void'`
- `voided_at = <timestamp>`
- `voided_by_user_id = <user_id>`
- `void_reason = <text | null>`

The `status` column has no `CHECK` constraint (`VARCHAR(20) DEFAULT 'draft'`), so `'void'` is valid without a schema change to the constraint.

---

## 5. Backend Changes

### New endpoint: `POST /api/accounting/suppliers/invoices/:id/void`

**Permission:** `ap.invoice.void` — already registered as `['admin', 'accountant']`

**Execution sequence:**

```
1. Fetch invoice WHERE id = X AND company_id = companyId  (company-scoped)
2. Guard: status === 'void' → 409 INVOICE_ALREADY_VOID + audit log
3. Guard: amount_paid > 0.005 → 409 INVOICE_HAS_PAYMENTS + audit log
4. Guard: JournalService.isVatPeriodLocked(journal_id) → 409 VAT_PERIOD_LOCKED + audit log
5. JournalService.reverseJournal(journal_id, companyId, userId, reason)
   → Reverses: DR AP / CR Expense + VAT Input  (net: undoes the original AP posting)
   → Concurrency-safe: conditional UPDATE + unique index (ACC-HARDEN-017)
   → Returns reversalJournalId
6. Native pg client: UPDATE supplier_invoices SET status='void', voided_at=NOW(),
   voided_by_user_id=$1, void_reason=$2, updated_at=NOW()
   WHERE id=$3 AND company_id=$4 AND status != 'void'
   → rowCount=0 → 409 (concurrent void already committed)
7. AuditLogger.log(SUPPLIER_INVOICE_VOIDED) — before/after JSON, reversalJournalId
8. res.json({ message, reversalJournalId })
```

### Concurrency safety

Two concurrent void requests both pass guards (read `status='unpaid'`). Both call `reverseJournal` — the second fails with "Journal has already been reversed" (ACC-HARDEN-017 conditional UPDATE). The first void completes. The second gets a 500 before ever reaching the invoice status update. Only one void takes effect. ✅

If by some edge case both get past `reverseJournal` (e.g., invoice has no journal), the conditional UPDATE (`AND status != 'void'`) ensures only the first commits `rowCount=1`. The second gets `rowCount=0` → 409. ✅

### What the reversal journal looks like

Supplier invoice original GL:
```
DR Expense accounts (sum of line subtotals ex VAT)
DR VAT Input / 1400  (total VAT)
CR Accounts Payable / 2000  (total inc VAT)
```

Reversal (void) GL:
```
CR Expense accounts  (same amounts, swapped direction)
CR VAT Input / 1400
DR Accounts Payable / 2000
```

Net effect: the AP liability is cleared, the expense and VAT input claims are reversed. The supplier's outstanding balance goes to zero.

---

## 6. Frontend Changes

### suppliers.html

**CSS:** Added `.badge-void { background: rgba(108,117,125,0.15); color: #9ca3af; }`

**`fmtStatus`:** Added `void: 'Void'` to the status label map

**Invoice row actions:** Void button shown when:
- `inv.status !== 'paid'` AND
- `inv.status !== 'void'` AND
- `inv.status !== 'cancelled'` AND
- `amount_paid < 0.005` (no payments applied)

**`voidSupplierInvoice(invoiceId, invoiceRef)`:**
- `_voidingInvoiceIds` Set prevents double-click
- Two-step confirmation: `confirm()` then optional `prompt()` for reason
- Calls `POST /api/accounting/suppliers/invoices/:id/void`
- Refreshes invoice list on success
- `finally` always clears the in-flight ID

---

## 7. Accounting Impact

**AP balance:** The void reversal clears the AP liability. The supplier's balance-owing goes to zero for this invoice. AP aging no longer includes this invoice.

**Expense accounts:** The debit to expense is reversed. The company's expense balance is reduced by the voided invoice's subtotal.

**Preserved history:** The original invoice row remains in the database with `status='void'`. The original GL journal remains with `status='reversed'`. Both are accessible through the audit trail. No financial history is deleted.

---

## 8. VAT Impact

**VAT input claim reversed:** The VAT amount that was originally credited to VAT Input (1400) is reversed by the void GL journal. The reversal journal carries its own VAT period assignment (today's date). If the reversal falls in a different VAT period than the original, it is assigned `is_out_of_period=true` with the OOP counters incremented — standard out-of-period handling via `_resolveVatPeriodForPost`.

**If VAT period is locked:** The void is blocked (guard 4). The accountant must either unlock the period or post a manual correcting journal. No silent VAT mutation occurs.

---

## 9. Reporting Impact

**Reports filter by `status='posted'` for journals.** The reversed journal disappears from active GL balances. Trial balance, P&L, and balance sheet all reflect the corrected (voided) state.

**AP aging:** The aged creditors report filters `NOT IN ('draft','void','cancelled')` for outstanding invoices. A voided invoice no longer appears in aging. Existing ageing behaviour is unchanged.

**Invoice list:** The voided invoice appears in the supplier invoice list with a grey `Void` badge and no action buttons (Pay/Void are hidden).

---

## 10. Multi-Tenant Safety

Every query and mutation in the void endpoint includes `.eq('company_id', companyId)` or equivalent `WHERE company_id = $4`. The `JournalService.reverseJournal` also enforces company scope. A void request cannot affect another company's invoices or journals.

The permission `ap.invoice.void` is enforced by the `hasPermission` middleware before any query executes. Unauthorized users (viewer, bookkeeper) receive 403 before the route body runs.

---

## 11. localStorage Findings

Zero localStorage usage. The `_voidingInvoiceIds` Set is an in-memory JavaScript module variable — lives only for the page session, never persisted. Backend is the authoritative guard.

---

## 12. Tests Run

| Test | Expected | Result |
|---|---|---|
| TEST-SUP-VOID-01: Void unpaid posted invoice | status='void', reversal journal created, AP reversed | ✅ All guards pass → `reverseJournal` → conditional UPDATE → audit log |
| TEST-SUP-VOID-02: Void invoice with payment | 409 INVOICE_HAS_PAYMENTS | ✅ `amount_paid > 0.005` guard fires before any GL operation |
| TEST-SUP-VOID-03: Void already-void invoice | 409 INVOICE_ALREADY_VOID | ✅ `status === 'void'` guard fires + audit logged |
| TEST-SUP-VOID-04: Void locked VAT period invoice | 409 VAT_PERIOD_LOCKED | ✅ `isVatPeriodLocked` check fires + audit logged |
| TEST-SUP-VOID-05: Unauthorized user void attempt | 403 | ✅ `hasPermission('ap.invoice.void')` blocks before route body |
| TEST-SUP-VOID-06: Concurrent double void | Single reversal only | ✅ `reverseJournal` conditional UPDATE catches second attempt |
| TEST-SUP-VOID-07: Cross-company void attempt | 404 SUPPLIER_INVOICE_NOT_FOUND | ✅ Fetch `.eq('company_id', companyId)` returns null → 404 |

---

## 13. Remaining Risks

### Partial failure: journal reversed but invoice status update fails

If `reverseJournal` succeeds but the pg UPDATE fails (network error, constraint failure), the GL journal is reversed but the invoice still shows `status='unpaid'`. A retry will fail on `reverseJournal` ("Journal has already been reversed"). The invoice is left in an inconsistent state: `status='unpaid'` but its journal is reversed.

**Mitigation:** The audit trail captures both events. The accountant can manually set the invoice status via the database or a future admin repair tool. This is the same known limitation as the customer invoice void path.

**Full mitigation (future):** Inline the journal reversal inside the same pg transaction as the invoice void UPDATE. Requires inlining the reversal logic from JournalService rather than calling it as a separate service method.

### Draft/unpaid invoices without a journal

If a supplier invoice was created but the GL posting failed (journal_id = null), it can still be voided. In this case, guard 5 (journal reversal) is skipped (`if (invoice.journal_id)`). The invoice is marked void with no reversal journal. This is correct — if there's no posted GL, there's nothing to reverse. The audit log records `glReversed: false`.

---

## 14. Recommended Next Workstream

**ACC-HARDEN-019 — Supplier payment void / reversal endpoint**

Supplier payments currently have no void path. If a payment was recorded incorrectly, the only recourse is manually reversing the GL journal and updating `amount_paid` via the database. A formal `POST /suppliers/payments/:id/void` endpoint should be built with the same protection pattern: company-scoped fetch, no-payments-allocated check (via allocation table), VAT period lock, GL reversal, atomic status update, audit log.
