# AC-02 — Atomic Draft Journal Delete Fix Report

**Date:** 2026-05-27  
**Source audit:** `docs/accounting-qa/01_FULL_APP_TEST_AUDIT.md` (risk ID: AC-02)  
**Status:** FIXED ✅

---

## 1. Summary

`DELETE /journals/:id` used two separate non-atomic Supabase calls — one to delete `journal_lines`, one to delete the `journals` header row. If the header delete failed after lines were already deleted, the journal row would remain with no lines (a ghost record). The header delete also lacked a `company_id` filter, meaning any authenticated user could theoretically delete any journal row by ID regardless of company.

Both problems have been resolved by replacing the entire handler body with an atomic pg `BEGIN/COMMIT/ROLLBACK` transaction using `SELECT ... FOR UPDATE` row-locking and an explicit `rowCount` verification.

---

## 2. Risks Addressed

| Risk ID | Description | Severity |
|---------|-------------|----------|
| AC-02-A | Non-atomic delete: lines deleted, header delete fails → ghost journal with no lines | HIGH |
| AC-02-B | Header delete missing `company_id` filter → cross-tenant delete possible | HIGH |
| AC-02-C | No concurrent delete protection — two simultaneous requests could race | MEDIUM |
| AC-02-D | `req.params.id` used as string without integer validation — potential type mismatch | LOW |

---

## 3. Root Cause

The original handler used the Supabase JS client for both deletes:

```javascript
// Delete journal lines first
const { error: linesErr } = await supabase
  .from('journal_lines').delete().eq('journal_id', req.params.id);
if (linesErr) throw new Error(linesErr.message);

// Delete journal — MISSING company_id filter
const { error: journalErr } = await supabase
  .from('journals').delete().eq('id', req.params.id);
if (journalErr) throw new Error(journalErr.message);
```

**Problem 1 (atomicity):** These are two independent round-trips to the database. If the network drops between them, or the journal delete fails for any reason, the lines are gone but the header remains. There is no rollback.

**Problem 2 (company_id filter):** The journal header delete only filtered on `id`. If RLS was not enforced at the DB level for this table, any company's user with `journal.delete` permission could delete any journal in the system by guessing the ID.

**Problem 3 (concurrent race):** Two simultaneous requests for the same journal ID would both pass the initial fetch check (status === 'draft'), both delete lines, and then race on the header delete. The second would silently succeed against an already-deleted row with no error.

---

## 4. Files Changed

| File | Change |
|------|--------|
| `backend/modules/accounting/routes/journals.js` | Added `db` import (line 3). Replaced DELETE handler body with pg transaction. |
| `backend/tests/ac02-atomic-journal-delete.test.js` | New — 10 tests covering all failure modes, races, and audit behaviour. |

**Files NOT changed:**
- `JournalService.js` — untouched
- Journal POST, PUT, GET routes — untouched
- Journal post/reverse handlers — untouched
- VAT, AR/AP, bank, reconciliation — untouched

---

## 5. New Handler Design

**File:** [journals.js](../../backend/modules/accounting/routes/journals.js)  
**Route:** `DELETE /:id`

### Step 1 — Integer validation before DB

```javascript
const journalId = parseInt(req.params.id, 10);
if (isNaN(journalId)) {
  return res.status(400).json({ error: 'Invalid journal ID' });
}
```

Guards against string IDs that could cause type errors in pg queries.

### Step 2 — Acquire pg client, BEGIN transaction

```javascript
const client = await db.getClient();
await client.query('BEGIN');
```

### Step 3 — SELECT FOR UPDATE (fetch + lock)

```sql
SELECT id, status, date, reference, description
  FROM journals
 WHERE id = $1 AND company_id = $2
   FOR UPDATE
```

`FOR UPDATE` acquires a row-level exclusive lock. A concurrent request attempting the same delete will block at this point until the first transaction commits or rolls back. Combined with the `company_id = $2` filter, this simultaneously enforces ownership and prevents races.

### Step 4 — Status check inside transaction

```javascript
if (rows.length === 0) { await client.query('ROLLBACK'); return 404; }
if (journal.status !== 'draft') { await client.query('ROLLBACK'); return 409; }
```

Both checks happen inside the transaction, after the row lock is held. This eliminates the TOCTOU gap in the original handler.

### Step 5 — Delete lines, delete header, verify rowCount

```javascript
await client.query('DELETE FROM journal_lines WHERE journal_id = $1', [journalId]);
const deleteResult = await client.query(
  `DELETE FROM journals WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
  [journalId, companyId]
);
if (deleteResult.rowCount !== 1) {
  throw new Error('Draft journal delete failed. No changes were saved.');
}
await client.query('COMMIT');
```

The journal header delete re-asserts `company_id` and `status = 'draft'` as a final safety gate. `rowCount !== 1` catches any remaining race condition (status changed between lock and delete — should not be possible with FOR UPDATE, but is a defensive belt-and-suspenders check).

### Step 6 — Audit log outside transaction

```javascript
await AuditLogger.logUserAction(req, 'DELETE', 'JOURNAL', ...).catch(auditErr => {
  console.error('Audit log failed for journal delete:', auditErr.message);
});
```

Consistent with the pattern used in all other journal route handlers — audit calls are kept outside the pg transaction so a COMMIT success is not rolled back by an audit write failure.

---

## 6. Error Response Map

| Condition | Status | Error message |
|-----------|--------|---------------|
| `req.params.id` is not a valid integer | 400 | `Invalid journal ID` |
| Journal not found or wrong company | 404 | `Draft journal not found.` |
| Journal status is not `draft` | 409 | `Only draft journals can be deleted. Posted journals must be reversed.` |
| Lines delete throws / rowCount guard fails / any other DB error | 500 | `Draft journal delete failed. No changes were saved.` (or specific error message) |

The 403 from the original handler (`'Can only delete draft journals'`) has been replaced with 409, which more accurately represents the conflict (the resource exists but its state conflicts with the request).

---

## 7. Tests Run

**Test file:** `backend/tests/ac02-atomic-journal-delete.test.js`

```
PASS tests/ac02-atomic-journal-delete.test.js
  AC-02 — Atomic Draft Journal Delete
    TEST-DEL-01: Happy path — draft journal deleted successfully
      ✓ returns 200 and commits the transaction
    TEST-DEL-02: Journal not found → 404
      ✓ returns 404 and rolls back when row is not in DB
    TEST-DEL-03: Company isolation — wrong company returns 404
      ✓ returns 404 when journal exists but belongs to a different company
    TEST-DEL-04: Posted journal → 409
      ✓ returns 409 and rolls back when journal status is posted
    TEST-DEL-05: Reversed journal → 409
      ✓ returns 409 and rolls back when journal status is reversed
    TEST-DEL-06: Concurrent delete race — rowCount 0 → 500, rolled back
      ✓ returns 500 with specific message and rolls back when journal was already deleted concurrently
    TEST-DEL-07: Lines delete fails inside transaction → rollback
      ✓ rolls back entire transaction when journal_lines delete throws
    TEST-DEL-08: Invalid journal ID → 400 before DB is touched
      ✓ returns 400 immediately for non-numeric IDs
    TEST-DEL-09: Audit log fires after COMMIT with correct snapshot data
      ✓ calls audit with correct entity type, action, and snapshot fields
    TEST-DEL-10: Audit log failure does NOT prevent 200 response
      ✓ returns 200 even when audit logger throws

Tests: 10 passed, 10 total
```

---

## 8. Remaining Risks

| ID | Risk | Severity | Status |
|----|------|----------|--------|
| AC-02-R1 | If `journal_lines` FK has `ON DELETE CASCADE` configured in the DB schema, the lines delete inside the transaction is redundant (cascade handles it). If cascade is NOT present, the explicit delete is required. The explicit delete is safe in both cases — it is a no-op when cascade removes the lines first. | LOW | Mitigated — explicit delete is safe regardless |
| AC-02-R2 | `SELECT FOR UPDATE` will block (not fail) if another transaction holds a lock on the same row. Under high load this could increase response times. A `NOWAIT` or `SKIP LOCKED` variant could be added if this becomes a problem, but is not needed for the current load profile. | LOW | Acceptable — blocking is the correct behaviour here |
| AC-01 | `hasPermission()` unknown permission key → silently permits. (Separate issue — not addressed in this fix.) | HIGH | Not addressed in this fix scope |

---

## Final Safety Check

- [x] Delete is now fully atomic — no partial state possible (lines deleted without header, or vice versa)
- [x] `company_id` filter present on both SELECT and DELETE queries
- [x] `SELECT FOR UPDATE` prevents concurrent race conditions
- [x] `rowCount !== 1` guard catches any residual race
- [x] Integer validation on journal ID before any DB call
- [x] Status guard (draft-only) inside the transaction, after the row lock
- [x] Audit log outside transaction — commit cannot be rolled back by audit failure
- [x] All other journal routes untouched
- [x] JournalService internals untouched
- [x] VAT, AR/AP, bank, reconciliation untouched
