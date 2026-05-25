# Session Handoff — 2026-05-25

## Session: Historical Comparatives Save Integrity Fix Pack 01

---

## What was changed

### New file — Migration 049
`accounting-ecosystem/database/migrations/049_historical_comparatives_save_integrity.sql`

- **DO block (Step 1):** Detects existing duplicate null-account rows before creating the index. If any exist, raises an explicit exception with manual de-duplication instructions — prevents a silent index-creation failure on production DBs with bad data.
- **Step 2:** `CREATE UNIQUE INDEX IF NOT EXISTS uq_hcl_batch_account_snapshot_year_month` — partial unique index for null-account rows using `COALESCE(account_code, '')` to normalize NULL and `''` as the same key. Covers the race condition gap left by migration 042's index (which only covers `WHERE account_id IS NOT NULL`).
- **Step 3:** Drop + recreate `hcal_action_chk` constraint on `historical_comparative_audit_log` to add the missing actions `'GRID_SAVED'` and `'BATCH_RESCALED'`. Without this, every grid-save and rescale audit record silently failed to insert.
- **Safe to re-run:** All DDL uses `IF NOT EXISTS` / `DROP ... IF EXISTS`.

---

### Modified — Service
`accounting-ecosystem/backend/modules/accounting/services/historicalComparativesService.js`

#### `saveManualGrid()` — fully replaced

**Root cause fixed:** The old implementation split the save into `toUpdate` (Supabase upsert) and `toInsert` (Supabase insert) — two separate calls with no transaction. If updates committed and inserts failed, new months were silently lost with no frontend error.

**New implementation:**
- Acquires a `db.getClient()` pg pool client
- Wraps all writes in `BEGIN` / `COMMIT` / `ROLLBACK`
- **account_id path:** Single `INSERT ... ON CONFLICT DO UPDATE` covering all 12 cells in one statement — either all 12 persist or none do. `original_amount`, `entered_by`, `entered_at` excluded from `DO UPDATE SET` so first-capture values are permanently preserved.
- **null-account path:** `SELECT ... FOR UPDATE` locks existing rows within the transaction, then per-cell `UPDATE` or `INSERT`. Prevents concurrent saves from racing to insert the same row.
- Batch `updated_at` update inside the same transaction.
- Audit log (`GRID_SAVED`) written after `COMMIT`, outside the transaction — audit failure never blocks saves.

#### `finalizeBatch()` — fully replaced

**Root cause fixed:** Two separate Supabase calls (lines update, then batch update) with no transaction. A crash between them left lines `is_finalized=true` but batch `status='validated'` — data locked but invisible in reports.

**New implementation:**
- Pre-flight status guard (Supabase `getBatch()`) before acquiring DB client
- `BEGIN` / `COMMIT` / `ROLLBACK` pg transaction
- `SELECT id, status ... FOR UPDATE` inside transaction — re-verifies status and prevents concurrent finalizations (TOCTOU guard)
- Empty-batch guard: `COUNT(*)` check before touching any rows; throws `statusCode = 422` if zero lines
- `UPDATE historical_comparative_lines SET is_finalized = true` inside transaction
- `UPDATE historical_comparative_batches SET status='finalized' ... RETURNING *` inside transaction
- Audit log written after `COMMIT`, outside transaction

---

### Modified — Route
`accounting-ecosystem/backend/modules/accounting/routes/historicalComparatives.js`

`POST /batch/:batchId/finalize` error handler — added 422 check before the generic 500:
```javascript
if (error.statusCode === 422) {
  return res.status(422).json({ error: error.message });
}
```
This surfaces the empty-batch error to the frontend as a clear 422 rather than a 500.

---

### Modified — Frontend
`accounting-ecosystem/frontend-accounting/historical-comparatives.html`

**Module-level variables (added after `currentLines`):**
```javascript
let historicalDirty = false;  // true after any grid input until save
let isSaving        = false;  // true while saveAllGrids() is running
```

**`api()` — hardened:**
- `res.ok` now checked before `res.json()` — non-JSON error bodies (502 HTML page) no longer hide the real HTTP status behind a `SyntaxError`

**`.amount-cell` inputs — `oninput` added:**
- `oninput="historicalDirty = true"` on every amount input — any edit immediately marks the batch dirty

**Save All button — `id` added:**
- `id="btnSaveAll"` so `saveAllGrids()` can disable/re-enable it

**`saveAccountGrid()` — replaced:**
- Removed `Promise.all()` — now sequential `for...of` per year
- Each year's result: `result.saved` compared to `yearCells.length` — count mismatch shown as warning
- `historicalDirty = false` cleared only on full success (no year errors)
- Error message shows specific failed years and reasons

**`saveAllGrids()` — replaced:**
- `isSaving` guard — early return if already saving
- Button disabled / text set to "Saving…" on entry, restored on exit
- Sequential `for...of` per account, then per year (no `Promise.all` anywhere)
- Every failure: `console.error()` with account label + FY + error; added to `failedItems[]`
- Error message lists every failed `account FY year` explicitly
- `historicalDirty = false` cleared only on zero failures

**`finalizeBatch()` (frontend) — replaced:**
- Checks `historicalDirty` before confirm dialog — if dirty, shows blocking error pointing to Save All
- No "Finalize Anyway" option — user must save first

---

## Root causes fixed

| # | Root cause | Fix location |
|---|---|---|
| R1 | Non-transactional `toUpdate`/`toInsert` split in grid save | `saveManualGrid()` — single pg transaction |
| R2 | `Promise.all()` parallel year saves — partial year state | `saveAccountGrid()` + `saveAllGrids()` — sequential loops |
| R3 | No dirty check before finalize — wrong values locked | Frontend `finalizeBatch()` — `historicalDirty` guard |
| R4 | Non-transactional finalization | `finalizeBatch()` service — single pg transaction + TOCTOU lock |
| R5 | Save All silently swallows errors | `saveAllGrids()` — `console.error` + named `failedItems[]` |
| R6 | Success count from DOM not server | `saveAccountGrid()` — `result.saved` vs `yearCells.length` |
| R7 | No unique constraint for null-account rows | Migration 049 — partial unique expression index |
| R10 | `res.json()` before `res.ok` hides HTTP status | `api()` — `res.ok` checked first |
| NEW | Empty batch finalization | `finalizeBatch()` service — 422 COUNT guard |
| NEW | Audit log missing GRID_SAVED/BATCH_RESCALED | Migration 049 — constraint drop + recreate |

---

## What was confirmed working

- `db.getClient()` available in `accounting-ecosystem/backend/modules/accounting/config/database.js` — `module.exports.getClient = () => getPool().connect()`
- Existing unique index `uq_hcl_batch_account_period` on `account_id IS NOT NULL` path unchanged — new migration only adds the null-account variant
- `_writeAuditLog()` already catches and swallows all errors — safe to call outside transactions
- `showMsg(elementId, type, text, isHtml)` signature supports HTML content via 4th argument — used for multi-line error lists

---

## What was NOT changed

- `saveManualLine()` — single-cell save; not part of identified partial-save vectors
- `validateBatch()` — no integrity issues identified
- `rescaleBatchAmounts()` — uses Supabase upsert but operates only on pre-existing rows by PK; no insert race possible
- All report methods — read-only, zero writes
- All other accounting modules (VAT, bank, AR/AP, trial balance, journals)
- Payroll module — zero overlap

---

## Testing required before production

Run all 14 tests in `docs/accounting/HISTORICAL_COMPARATIVES_SAVE_INTEGRITY_FIX_PACK_01_REPORT.md` (T-HC-01 through T-HC-14).

**Most critical:**
- T-HC-03: Simulated DB failure mid-save → ROLLBACK, zero cells persisted
- T-HC-08: Finalize success → lines AND batch updated atomically
- T-HC-09: Simulated DB failure mid-finalize → ROLLBACK, both remain pre-finalized
- T-HC-14: Migration 049 applied successfully

**Must also run before production:**
```sql
-- Run in Supabase SQL Editor BEFORE migration 049:
SELECT batch_id, COALESCE(account_code,'') AS account_code, account_name,
       financial_year, period_month, COUNT(*) AS n
FROM historical_comparative_lines
WHERE account_id IS NULL
GROUP BY 1,2,3,4,5
HAVING COUNT(*) > 1;
```
If this returns any rows, de-duplicate them manually using the query in the migration header before running migration 049.

---

## Follow-up notes

```
FOLLOW-UP NOTE
- Area: parseCurrency() US-format truncation (Audit R9)
- Dependency: SA locale assumption in all amount inputs
- What was done now: Not addressed — out of Fix Pack 01 scope
- What still needs to be checked: Whether any accountant pastes US-formatted numbers (1,234.56)
- Risk if not checked: LOW — SA format is the expected input. US paste would silently truncate.
- Recommended next review point: If a future session adds clipboard paste handling
```

```
FOLLOW-UP NOTE
- Area: saveManualLine() — single-cell concurrent save race (Audit §13.2)
- Dependency: Two browser tabs saving the same cell simultaneously
- What was done now: Not addressed — Fix Pack 01 focused on grid save and finalization
- What still needs to be checked: Whether saveManualLine() needs a transactional upsert
- Risk if not checked: LOW in practice — single-cell saves are rare; DB unique constraint catches the race with a 500
- Recommended next review point: If single-cell save is used more heavily
```

```
FOLLOW-UP NOTE
- Area: No retry on network failure (Audit R8)
- Dependency: Transient network timeouts during Save All
- What was done now: Not addressed — out of Fix Pack 01 scope
- What still needs to be checked: Whether retry logic is needed for production reliability
- Risk if not checked: LOW-MEDIUM — a timeout results in visible error (not silent), user can manually retry
- Recommended next review point: If network reliability issues are reported in production
```
