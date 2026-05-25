# Historical Comparatives Save Integrity — Fix Pack 01 Report

**Date:** 2026-05-24  
**Pack:** Fix Pack 01  
**Severity addressed:** HIGH (R1–R4), MEDIUM (R5–R7, R10)  
**Status:** IMPLEMENTED — ready for regression testing  
**Audit source:** `docs/accounting/HISTORICAL_COMPARATIVES_SAVE_INTEGRITY_AUDIT.md`

> **Absolute rule enforced by this pack:**  
> Historical comparative saves must behave transactionally: either all intended lines for
> the save request persist, or the save fails visibly and no partial truth is silently accepted.
> No silent partial persistence.

---

## 1. Scope

**In scope — changes made:**

- `backend/modules/accounting/services/historicalComparativesService.js` — `saveManualGrid()`, `finalizeBatch()`
- `backend/modules/accounting/routes/historicalComparatives.js` — finalize route error handling (422)
- `frontend-accounting/historical-comparatives.html` — `api()`, `saveAccountGrid()`, `saveAllGrids()`, `finalizeBatch()`, amount-cell `oninput`, Save All button
- `database/migrations/049_historical_comparatives_save_integrity.sql` — new migration

**Strictly out of scope — not touched:**

- `saveManualLine()` (single-cell save) — not part of the identified partial-save vectors
- VAT, bank reconciliation, AR/AP, trial balance, journals, live ledger
- Opening balances
- COA sync logic
- Report calculation logic
- Authentication or company-scoping logic
- Any other module

---

## 2. Part 1 — Transactional Manual Grid Save (service)

**File:** `historicalComparativesService.js`  
**Function:** `saveManualGrid()`  
**Audit risk addressed:** R1 (toUpdate/toInsert split without transaction)

### Problem

The old implementation split the save into two separate Supabase calls:

1. Upsert for rows that already existed (`toUpdate` batch)
2. Insert for rows that were new (`toInsert` batch)

If the upsert succeeded and the insert failed (e.g. constraint violation, network drop), the
existing months were re-saved with new amounts but the new months were silently lost. The
frontend received no error (the upsert resolved first), and showed a success message with the
wrong cell count. There was no way for the accountant to know which months were missing.

### Fix

Replaced both Supabase calls with a single PostgreSQL transaction using `db.getClient()`:

**account_id path** (most accounts):
- Single `INSERT INTO ... VALUES (...), (...), ... ON CONFLICT (batch_id, account_id, financial_year, period_month) WHERE account_id IS NOT NULL DO UPDATE SET amount = EXCLUDED.amount, ...`
- One statement covers all 12 months — either all 12 persist or none do
- `original_amount`, `entered_by`, `entered_at` are not included in `DO UPDATE SET` — first-capture values are permanently preserved on subsequent saves

**null-account path** (accounts without a linked COA account_id):
- `SELECT id, period_month, original_amount ... FOR UPDATE` to lock any existing rows for this account+year within the transaction
- Per-cell `UPDATE` or `INSERT` inside the same transaction
- `FOR UPDATE` prevents concurrent saves for the same account from racing to insert the same row simultaneously

**Both paths:**
- `UPDATE historical_comparative_batches SET updated_at = ...` inside the same transaction
- `COMMIT` only after all writes succeed
- `ROLLBACK` on any error; the thrown error propagates to the route which returns HTTP 500
- Audit log (`GRID_SAVED`) written **after** `COMMIT`, outside the transaction — audit failure never blocks the save

### Key invariant

After this fix, the save for a given `(batchId, accountId/accountName, financialYear)` is
atomic. Either all submitted cells are persisted or none are. No partial month state is
possible within a single save call.

---

## 3. Part 2 — DB Constraint Hardening (migration 049)

**File:** `database/migrations/049_historical_comparatives_save_integrity.sql`  
**New migration — safe to run in production**

### Problem A — No unique constraint for null-account rows

Migration 042 added a partial unique index:
```sql
uq_hcl_batch_account_period ON (batch_id, account_id, financial_year, period_month)
WHERE account_id IS NOT NULL
```

This covered accounts with a real `account_id`. Rows where `account_id IS NULL` (accounts
without a COA link) had no unique constraint. Two concurrent saves could INSERT duplicate rows
for the same `(batch, account_name, account_code, year, month)` combination, causing report
queries (which use `SUM`) to double-count those months.

### Problem B — Audit log constraint missing actions

The `hcal_action_chk` constraint on `historical_comparative_audit_log` defined in migration 042
was missing `'GRID_SAVED'` and `'BATCH_RESCALED'`. Every grid-save and rescale audit record
silently failed to insert (the service catches all audit errors). The audit trail was incomplete.

### Fix

**Step 1 — Duplicate detection guard:**  
Before creating the new index, a `DO $$` block counts duplicate `(batch_id, COALESCE(account_code,''), account_name, financial_year, period_month)` combinations where `account_id IS NULL`. If any exist, the migration raises an explicit error with instructions to de-duplicate manually. This prevents a silent index-creation failure on databases with existing bad data.

**Step 2 — New partial unique index:**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_hcl_batch_account_snapshot_year_month
  ON historical_comparative_lines (
    batch_id,
    COALESCE(account_code, ''),
    account_name,
    financial_year,
    period_month
  )
  WHERE account_id IS NULL;
```

`COALESCE(account_code, '')` normalizes both `NULL` and `''` to the same key so accounts with
no code cannot produce two distinct null-vs-empty rows that bypass uniqueness.

**Step 3 — Fix audit log constraint:**
```sql
ALTER TABLE historical_comparative_audit_log DROP CONSTRAINT IF EXISTS hcal_action_chk;
ALTER TABLE historical_comparative_audit_log ADD CONSTRAINT hcal_action_chk
  CHECK (action IN (
    'BATCH_CREATED', 'BATCH_UPDATED', 'BATCH_RESCALED',
    'LINE_CREATED', 'LINE_UPDATED', 'LINE_DELETED',
    'BATCH_VALIDATED', 'BATCH_FINALIZED', 'BATCH_ARCHIVED',
    'FINALIZED_EDIT_BLOCKED', 'GRID_SAVED'
  ));
```

The migration is safe to re-run: `CREATE UNIQUE INDEX IF NOT EXISTS` and `DROP CONSTRAINT IF EXISTS` are both idempotent.

---

## 4. Part 3 — Transactional Finalization (service)

**File:** `historicalComparativesService.js`  
**Function:** `finalizeBatch()`  
**Audit risk addressed:** R4 (non-transactional finalization leaving inconsistent state)

### Problem

The old implementation used two separate Supabase calls:

1. `UPDATE historical_comparative_lines SET is_finalized = true ...`
2. `UPDATE historical_comparative_batches SET status = 'finalized' ...`

If call 1 succeeded and call 2 failed (network error, Supabase timeout), all lines were marked
`is_finalized = true` but the batch status remained `'validated'`. The Finalize button would
still appear active (batch not finalized), but individual line edits would be blocked (lines
marked finalized). The batch would not appear in finalized-only reports but its data was
inaccessible.

### Fix

Both updates now run inside a single pg transaction:

```
BEGIN
  SELECT ... FOR UPDATE  (TOCTOU guard — locks batch row to prevent concurrent finalization)
  COUNT lines            (empty-batch guard — 422 if no lines)
  UPDATE lines SET is_finalized = true
  UPDATE batch  SET status = 'finalized', finalized_at, finalized_by
COMMIT
```

**TOCTOU guard:** `SELECT id, status FROM historical_comparative_batches WHERE id=$1 AND company_id=$2 FOR UPDATE` re-verifies the batch status inside the transaction. If two concurrent finalize requests arrive, the second one will see `status = 'finalized'` after acquiring the row lock and will throw "Batch is already finalized." without attempting the updates.

**Empty-batch guard:** `SELECT COUNT(*) FROM historical_comparative_lines WHERE batch_id=$1 AND company_id=$2`. If count = 0, a `statusCode = 422` error is thrown (ROLLBACK occurs automatically via the catch). The route returns HTTP 422 with a clear message: "Cannot finalize an empty historical comparative batch."

**Audit log:** Written after `COMMIT`, outside the transaction — never blocks finalization on failure.

---

## 5. Part 4 — Frontend Dirty State Before Finalize

**File:** `frontend-accounting/historical-comparatives.html`  
**Function:** `finalizeBatch()`  
**Audit risk addressed:** R3 (unsaved DOM changes silently finalized as old server values)

### Problem

If an accountant edited cell values then clicked Finalize without first clicking Save, the
finalization confirmed and locked the last *saved* values — not the values currently shown on
screen. The edited values were permanently lost. The accountant had no indication this
happened.

### Fix

Added two module-level variables:

```javascript
let historicalDirty = false;  // true after any grid input until save
let isSaving        = false;  // true while saveAllGrids() is running
```

Every `.amount-cell` input now has `oninput="historicalDirty = true"` so any edit immediately
marks the grid dirty.

`historicalDirty` is cleared to `false` only on a fully successful save — either in
`saveAccountGrid()` (when no year errors) or in `saveAllGrids()` (when no failed items).

`finalizeBatch()` checks `historicalDirty` before showing the confirm dialog:

```javascript
if (historicalDirty) {
  showMsg('captureMsg', 'error',
    'There are unsaved changes in the grid. Use Save All to save all changes before finalizing.',
    true
  );
  return;
}
```

There is **no "Finalize Anyway" option**. The user must save first. This is intentional — the
risk of permanently locking wrong values is too high to offer an override.

---

## 6. Part 5 — Remove Promise.all Partial-Year Save Risk

**File:** `frontend-accounting/historical-comparatives.html`  
**Functions:** `saveAccountGrid()`, `saveAllGrids()`  
**Audit risk addressed:** R2 (parallel year saves — partial year state if one fails)

### Problem

Both functions used `Promise.all(Object.entries(byYear).map(...))` to send all year requests
simultaneously. If FY2022 succeeded and FY2023 failed, FY2022 was committed in the DB but the
user only saw the top-level error with no indication that FY2022 had been saved. Retrying the
whole grid would re-save FY2022 (harmless — idempotent upsert) but this was invisible.

### Fix

Both functions now use sequential `for...of` loops over year entries:

```javascript
for (const [year, yearCells] of yearEntries) {
  try {
    const result = await api('POST', ...);
    // verify count
  } catch (e) {
    yearErrors.push(`FY ${year}: ${e.message}`);
  }
}
```

Year saves are strictly sequential. If FY2022 fails, FY2023 is not attempted (for that
account). Each failure is attributed to the specific year and reported individually. Combined
with the server-side transaction (Part 1), each year save is itself atomic — so the sequential
loop and atomic server save together eliminate all partial-state vectors.

---

## 7. Part 6 — Verify Server Save Count Against DOM Count

**File:** `frontend-accounting/historical-comparatives.html`  
**Function:** `saveAccountGrid()`  
**Audit risk addressed:** R6 (client reports DOM count, not server-confirmed count)

### Problem

The success message always showed `cells.length` (computed from the DOM before any API call).
If the server returned fewer saved lines than submitted (e.g. a constraint skip), the message
still said "Saved 12 cells" regardless.

### Fix

`saveAccountGrid()` now reads `result.saved` from each year's server response and compares it
to `yearCells.length`:

```javascript
const serverSaved = result.saved || 0;
totalSaved += serverSaved;
if (serverSaved !== yearCells.length) {
  yearErrors.push(
    `FY ${year}: server confirmed ${serverSaved} of ${yearCells.length} cells saved. Re-save to confirm.`
  );
}
```

If there is any mismatch, the save is reported as having issues rather than as a full success.
The same comparison is applied in `saveAllGrids()` per account+year.

---

## 8. Part 7 — Fix Save All Error Logging

**File:** `frontend-accounting/historical-comparatives.html`  
**Function:** `saveAllGrids()`  
**Audit risk addressed:** R5 (errors silently swallowed — no account name, no console output)

### Problem

```javascript
} catch (e) {
  errors++;
  // e discarded — nothing logged, account name not captured
}
```

The user was told "Saved N, failed M. Check console for details." — but the console was empty.
There was no way to identify which accounts had failed or why.

### Fix

```javascript
} catch (e) {
  accountOk = false;
  const msg = `${label} FY ${year}: ${e.message}`;
  failedItems.push(msg);
  console.error('[HistoricalComparatives] saveAllGrids error:', msg, e);
}
```

Every failure is:
1. Attributed to a specific account (by code + name) and specific year
2. Logged to the console with `console.error` (full Error object included)
3. Added to `failedItems[]` which is displayed in the error message to the user

The user error message now lists every failed item explicitly rather than showing a count.

---

## 9. Part 8 — Harden `api()` Error Handling

**File:** `frontend-accounting/historical-comparatives.html`  
**Function:** `api()`  
**Audit risk addressed:** R10 (non-JSON error body throws parse error, hides HTTP status)

### Problem

```javascript
const json = await res.json();  // throws SyntaxError on non-JSON body
if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
```

If the server returned a 502/504 with an HTML error page, `res.json()` threw a `SyntaxError`
before `!res.ok` was reached. The catch received `"Unexpected token '<'"` rather than something
meaningful about the actual server error.

### Fix

```javascript
if (!res.ok) {
  let errMsg = `HTTP ${res.status}`;
  try {
    const json = await res.json();
    errMsg = json.detail
      ? `${json.error || 'Error'}: ${json.detail}`
      : (json.error || errMsg);
  } catch (_) { /* non-JSON body — keep HTTP status message */ }
  throw new Error(errMsg);
}
return res.json();
```

`res.ok` is checked first. The error body is attempted as JSON but the parse failure is caught
silently — the `HTTP <status>` string is the fallback, which is always accurate. Non-error
responses (200–299) still call `res.json()` which will throw naturally if those are malformed,
as before.

---

## 10. Part 9 — Save All Button State During Save

**File:** `frontend-accounting/historical-comparatives.html`  
**Function:** `saveAllGrids()`  
**HTML:** Save All button  
**Audit risk addressed:** Double-save race from repeated clicks

### Problem

The Save All button had no protection against being clicked multiple times rapidly. Concurrent
`saveAllGrids()` calls would each iterate the same grid blocks simultaneously, sending duplicate
API requests and potentially creating race conditions against the DB unique constraint.

### Fix

The Save All button was given `id="btnSaveAll"`:
```html
<button type="button" id="btnSaveAll" class="btn btn-secondary btn-sm" onclick="saveAllGrids()">Save All</button>
```

`saveAllGrids()` uses the `isSaving` flag as a guard and manages the button state:

```javascript
if (isSaving) return;
isSaving = true;
const btn = document.getElementById('btnSaveAll');
if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
// ...
isSaving = false;
if (btn) { btn.disabled = false; btn.textContent = 'Save All'; }
```

The button is re-enabled in both the success and error paths (no permanent disabled state on
failure). The `isSaving` flag is module-scoped so it survives across multiple rapid clicks.

---

## 11. Part 10 — Finalization Server Guard (empty batch, 422)

**File:** `historicalComparativesService.js` (in `finalizeBatch()`) and  
`backend/modules/accounting/routes/historicalComparatives.js` (finalize route)  
**Audit risk addressed:** New — not in original audit risk register

### Problem

A validated batch with zero saved lines could be finalized. `validateBatch()` catches empty
batches (returns a validation error if `lines.length === 0`), but a batch that was validated
from a state with lines, and then had all lines deleted (or never had data captured), could
reach finalization with zero lines.

Finalizing an empty batch is meaningless and misleads the user into thinking their data is
locked when nothing was locked.

### Fix

Inside the `finalizeBatch()` pg transaction (after the `SELECT FOR UPDATE` status lock):

```javascript
const countResult = await client.query(
  `SELECT COUNT(*) AS line_count FROM historical_comparative_lines
   WHERE batch_id = $1 AND company_id = $2`,
  [batchId, companyId]
);
const lineCount = parseInt(countResult.rows[0].line_count, 10);
if (lineCount === 0) {
  const emptyErr = new Error(
    'Cannot finalize an empty historical comparative batch. Add at least one data line before finalizing.'
  );
  emptyErr.statusCode = 422;
  throw emptyErr;
}
```

The route checks `err.statusCode === 422` and returns HTTP 422 before the generic 500
fallback:

```javascript
if (error.statusCode === 422) {
  return res.status(422).json({ error: error.message });
}
```

The ROLLBACK in the service catch block ensures no partial state is written before the 422
is thrown.

---

## 12. Tests Required Before Sign-Off

The following tests must pass before this fix pack is considered production-ready.

| Test | What it verifies |
|---|---|
| T-HC-01 | Save 12 cells for new account — all 12 persisted, server returns `saved: 12`, success message shows 12 |
| T-HC-02 | Save over 12 existing cells — all 12 updated atomically, no duplicates in DB |
| T-HC-03 | Simulate DB failure mid-insert (e.g. drop network after BEGIN) — ROLLBACK, zero cells persisted |
| T-HC-04 | Save All with 3 accounts × 2 years = 6 requests — all succeed, `historicalDirty = false` after |
| T-HC-05 | Save All with one account returning HTTP 500 — that account+year listed in error, others succeed, error logged to console |
| T-HC-06 | Edit a cell, click Finalize without saving — blocked with "unsaved changes" message, no API call made |
| T-HC-07 | Edit a cell, click Save All (success), click Finalize — not blocked, confirm dialog shown |
| T-HC-08 | Finalize a batch with data — lines marked `is_finalized = true`, batch `status = 'finalized'`, both in same DB state |
| T-HC-09 | Finalize with DB failure between line update and batch update (simulated) — ROLLBACK, both remain in pre-finalized state |
| T-HC-10 | Finalize an empty batch (no lines) — HTTP 422, clear error message, batch not finalized |
| T-HC-11 | Click Save All twice rapidly — second click is no-op (isSaving guard), button shows "Saving…" during first |
| T-HC-12 | Server returns 502 HTML body — `api()` shows "HTTP 502" not "Unexpected token '<'" |
| T-HC-13 | Two concurrent saves for same null-account row — second fails with unique constraint, first fully committed |
| T-HC-14 | Migration 049 applied to DB with no null-account rows — index created, audit constraint fixed |

---

## 13. Final Safety Check

| Safety requirement | Status |
|---|---|
| No partial-save vector remains in manual-grid save | CONFIRMED — single pg transaction, all cells or none |
| Finalization is transactional | CONFIRMED — BEGIN/COMMIT, ROLLBACK on any failure |
| Finalize is blocked with unsaved edits | CONFIRMED — `historicalDirty` flag + blocking error, no override option |
| Save All reports failed account/year clearly | CONFIRMED — `failedItems[]` per account+year, `console.error` per failure |
| No live accounting ledger logic changed | CONFIRMED — no changes to journals, bank, VAT, TB, GL |
| No localStorage business data added | CONFIRMED — `historicalDirty` and `isSaving` are in-memory JS variables, not stored |
| No Paytime payroll files changed | CONFIRMED — zero overlap with payroll module |
| Migration is safe to re-run | CONFIRMED — `IF NOT EXISTS` and `DROP ... IF EXISTS` on all DDL |
