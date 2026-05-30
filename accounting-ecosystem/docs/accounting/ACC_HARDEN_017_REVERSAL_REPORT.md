# ACCOUNTING IMPLEMENTATION REPORT — ACC-HARDEN-017

## Payment Reversal / Void Forensic Hardening

**Date:** 2026-05-30
**Status:** Complete
**Files changed:** 5

| File | Change |
|---|---|
| `database/migrations/065_journal_reversal_uniqueness.sql` | Unique index on `journals.reversal_of_journal_id` |
| `backend/modules/accounting/services/journalService.js` | Conditional UPDATE with rowCount guard in `reverseJournal` |
| `backend/modules/accounting/routes/journals.js` | Return 409 (not 400) for reversal conflict errors |
| `frontend-accounting/journals.html` | In-flight guard (`_reversingIds` Set) on `reverseJournal()` |

---

## 1. Root Cause

The `reverseJournal` service method performs its state checks (status='posted', reversed_by_journal_id IS NULL) outside the database transaction. Two concurrent requests both pass these checks before either writes. Both then enter the pg transaction and both INSERT a reversal journal. Both then run the UPDATE:

```sql
UPDATE journals SET status='reversed', reversed_by_journal_id=$1
WHERE id=$2 AND company_id=$3
```

No state predicate on the UPDATE — it succeeds for both. Last-write-wins: the second concurrent request overwrites `reversed_by_journal_id` with its reversal journal ID, orphaning the first reversal journal. Both reversal journals (with swapped debit/credit) are now posted, effectively double-reversing the original journal's accounting effect.

No database-level constraint prevented two reversal journals from referencing the same original.

---

## 2. Payment Entry Points Audited

### Customer payment reversals
**Finding:** No `POST /api/accounting/customer-invoices/payments/:id/reverse` endpoint exists.

Customer payment reversal is not implemented. The system correctly blocks invoice voiding when payments are applied (`amount_paid > 0 → 409`). The intended workflow is: accountant posts a correcting manual journal entry rather than reversing the payment. This is an intentional architectural choice and not a gap.

### Supplier payment reversals
**Finding:** No supplier payment reversal endpoint exists. Same finding as customer.

### Customer invoice void (`POST /api/accounting/customer-invoices/:id/void`)
**Already protected:**
- `status === 'void'` → 409 ALREADY_VOIDED
- `status === 'paid' || amount_paid > 0` → 409 HAS_PAYMENTS
- VAT period lock check (via JournalService.isVatPeriodLocked)
- Calls `reverseJournal` which has its own state guards
- Full audit log on every void event (blocked and successful)

No gaps found. With the GAP-1 fix applied, concurrent double-void attempts are also safe — the second `reverseJournal` call fails cleanly.

### Supplier invoice void
**Finding:** No supplier invoice void endpoint. Supplier invoices are edited via GL correction (reverse + replace). No standalone void path.

### Journal reversal (`POST /api/accounting/journals/:id/reverse`)
**GAP FOUND — concurrent double-reversal race (see §3).**

---

## 3. Concurrent Double-Reversal Gap (Fixed)

### Pre-existing sequential protection

`reverseJournal` already had two sequential guards:
- `status !== 'posted'` → throw
- `reversed_by_journal_id IS NOT NULL` → throw "Journal has already been reversed"

These work for sequential retries. They fail for truly concurrent requests because both read before either writes.

### The race

```
T1: SELECT journal → status='posted', reversed_by_journal_id=null ✓ (pre-check passes)
T2: SELECT journal → status='posted', reversed_by_journal_id=null ✓ (pre-check passes)
T1: BEGIN → INSERT reversal_1 → INSERT lines → UPDATE (no state check) → COMMIT
T2: BEGIN → INSERT reversal_2 → INSERT lines → UPDATE (overwrites reversed_by_journal_id) → COMMIT
Result: reversal_1 orphaned, accounting double-reversed
```

### Fix: Two independent layers

**Layer 1 — Application (journalService.js):**
```sql
UPDATE journals
SET status='reversed', reversed_by_journal_id=$1
WHERE id=$2 AND company_id=$3
  AND status='posted'              -- ← new predicate
  AND reversed_by_journal_id IS NULL  -- ← new predicate
```
`rowCount === 0` → ROLLBACK → throw "Journal has already been reversed — concurrent reversal detected"

The UPDATE is atomic under PostgreSQL's row-level locking. Only one concurrent transaction can win this predicated UPDATE. The second gets `rowCount=0` and rolls back.

**Layer 2 — Database (migration 065):**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_journals_reversal_source
  ON journals (reversal_of_journal_id)
  WHERE reversal_of_journal_id IS NOT NULL;
```

Two reversal journals cannot reference the same original. The second INSERT fails with 23505 (unique violation) → ROLLBACK. This is an independent guard that works even if the application code has a bug.

Either layer alone closes the race. Both together eliminate it completely.

---

## 4. Database Changes

**Migration 065** (run in Supabase SQL Editor before deployment):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_journals_reversal_source
  ON journals (reversal_of_journal_id)
  WHERE reversal_of_journal_id IS NOT NULL;
```

- Partial index: normal (non-reversal) journals have `reversal_of_journal_id = NULL` — completely unaffected
- A reversal of a reversal journal is still permitted: it points to the reversal journal (a different ID), not the original
- Non-destructive: fails only if corrupted data (two reversals for one journal) already exists in the database

---

## 5. Backend Transaction Changes

### journalService.js — `reverseJournal`

**Before:**
```javascript
await client.query(
  `UPDATE journals SET status='reversed', reversed_by_journal_id=$1
   WHERE id=$2 AND company_id=$3`,
  [reversalJournal.id, originalJournalId, companyId]
);
```

**After:**
```javascript
const markResult = await client.query(
  `UPDATE journals SET status='reversed', reversed_by_journal_id=$1
   WHERE id=$2 AND company_id=$3
     AND status='posted'
     AND reversed_by_journal_id IS NULL`,
  [reversalJournal.id, originalJournalId, companyId]
);
if (markResult.rowCount === 0) {
  throw new Error('Journal has already been reversed — concurrent reversal detected');
}
```

### journals.js — error response code

**Before:** `res.status(400)` for all reversal errors

**After:** `res.status(409)` for "already been reversed" and "concurrent reversal" errors. This is the correct HTTP semantics — 409 Conflict, not 400 Bad Request.

---

## 6. Frontend Changes

### journals.html — `reverseJournal()`

Added `_reversingIds` Set — a lightweight in-flight guard:
- When a reversal is submitted for journal ID X, X is added to the set
- If the same journal's Reverse button is clicked again while the request is in-flight, it returns immediately
- X is removed from the set in the `finally` block (success or error)

This is the UI complement to the backend enforcement. The backend is the authoritative guard; this eliminates the most common user-facing scenario (double-click on the Reverse button).

---

## 7. Accounting Impact

**None on correct (single) reversal paths.** The `reverseJournal` logic (swap debit/credit, mark original as reversed) is unchanged. All existing reversals continue to work identically.

**On concurrent double-reversal:** Previously, both reversals would succeed and accounting would be double-reversed. After the fix, only the first succeeds. The second request receives a 409 Conflict response. No duplicate reversal journals exist. No orphaned journal lines. GL balances remain correct.

---

## 8. VAT Impact

The VAT assignment in `reverseJournal` is unchanged. The fix only adds a predicate to the UPDATE and a rowCount check — both within the same atomic transaction that already handles VAT assignment correctly.

On the second concurrent reversal being rolled back: the reversal journal's INSERT is also rolled back (it's in the same transaction). No reversal journal exists. No VAT period is modified. The original journal's VAT period assignment remains as-is (still `status='posted'`).

---

## 9. Reporting Impact

**None.** Reports filter journals by `status='posted'`. The original journal remains `status='posted'` until a single successful reversal marks it `status='reversed'`. No duplicate reversal journals appear in reports. AR/AP aging, P&L, balance sheet, VAT reports are all unaffected.

---

## 10. Multi-Tenant Safety

All existing tenant guards in `reverseJournal` are preserved:
- `SELECT WHERE company_id = companyId` — fetch is company-scoped
- `UPDATE WHERE company_id = $3` — write is company-scoped
- No cross-tenant journal access possible

The unique index `idx_journals_reversal_source` scopes implicitly — a journal's `reversal_of_journal_id` is within a company's journal space. No cross-tenant constraint interaction is possible.

---

## 11. localStorage Findings

Zero localStorage usage in any reversal path. The `_reversingIds` Set in `journals.html` is a JavaScript module-level in-memory variable — it lives only for the page session and is never persisted.

---

## 12. Security Test Results

| Test | Before | After |
|---|---|---|
| TEST-REV-01: Double-click reversal | Two reversal journals, accounting double-reversed | Frontend `_reversingIds` blocks second request; backend conditional UPDATE + unique index catches any that slip through → 409 |
| TEST-REV-02: Two users reverse simultaneously | Concurrent race → double reversal | Conditional UPDATE rowCount=0 for second → ROLLBACK → 409 |
| TEST-REV-03: Retry after timeout | Sequential retry: caught by pre-existing `reversed_by_journal_id IS NOT NULL` check → throw | Same, now returns 409 instead of 400 |
| TEST-REV-04: Partial DB failure mid-reversal | Existing BEGIN/ROLLBACK catches this | Unchanged — `rowCount=0` check inside same transaction |
| TEST-REV-05: Unauthorized reversal | `hasPermission('journal.reverse')` on the route | Unchanged |
| TEST-REV-06: Reverse already-reversed | Caught by `reversed_by_journal_id IS NOT NULL` pre-check | Returns 409 instead of 400 |

---

## 13. Remaining Risks

### No payment-level reversal endpoints (by design)
Customer and supplier payments cannot be reversed through the API. This is intentional — the system enforces: reverse the payment's effect via a manual correcting journal entry, not a payment-level reversal operation. This design means payment GL journals are the only way to adjust payment accounting, which is auditable and explicit.

If a dedicated payment reversal flow is ever needed, it should:
- Mark the payment as `status='reversed'` (requires schema column)
- Reverse the GL journal via `JournalService.reverseJournal`
- Reverse the allocation effects (restore `amount_paid` on invoices via SELECT FOR UPDATE — same pattern as ACC-HARDEN-015)
- Audit log the full reversal chain

### Concurrent reversal of a concurrent reversal (EDGE CASE — TRIVIAL)
If the first reversal is reversed (reversal of reversal), and simultaneously another reversal-of-reversal is attempted — the same conditional UPDATE fix applies to that scenario too. The unique index on `reversal_of_journal_id` handles it at the DB level.

---

## 14. Recommended Next Workstream

**ACC-HARDEN-018 — Supplier invoice void hardening**

Supplier invoices currently have no void endpoint. If a supplier invoice is posted but needs to be cancelled, the only path is a manual journal reversal + editing the invoice record directly in the database. A formal `POST /suppliers/invoices/:id/void` endpoint should be built with the same protection pattern as the customer invoice void (status guard, payment check, VAT period lock, GL reversal, audit log).
