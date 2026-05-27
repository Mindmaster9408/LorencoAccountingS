# Historical Comparatives — Save Integrity Implementation Plan

**Date:** 2026-05-27  
**Severity:** HIGH  
**Plan type:** Architecture record + forward-looking governance document  
**Scope:** R1, R2, R3, R4 (primary); R5–R7, R10 (secondary)  
**Audit source:** `accounting-ecosystem/docs/accounting/HISTORICAL_COMPARATIVES_SAVE_INTEGRITY_AUDIT.md`  
**Fix Pack 01 status:** IMPLEMENTED 2026-05-24 (code is live, migration 049 pending deployment)

> This document captures the complete implementation design for the Historical Comparatives  
> save integrity hardening. It serves as an architectural record, a deployment checklist, and  
> the acceptance test specification. It must be read before any further change is made to  
> `historicalComparativesService.js`, `historicalComparatives.js`, or  
> `historical-comparatives.html`.

---

## 1. Current Architecture

### 1.1 Technology layers

The service uses two database clients simultaneously:

```
┌──────────────────────────────────────────────────────────────┐
│  historicalComparativesService.js                            │
│                                                              │
│  const { supabase } = require('../../../config/database');   │
│  const db            = require('../config/database');        │
│                                                              │
│  supabase  ──→  Supabase JS client  ──→  PostgREST API      │
│  db        ──→  pg pool             ──→  Direct TCP to DB   │
└──────────────────────────────────────────────────────────────┘
```

| Client | Used for | Transactions? |
|---|---|---|
| `supabase` (JS client) | Simple reads; single-table writes; batch metadata reads | **No** — PostgREST does not support `BEGIN`/`COMMIT` over HTTP |
| `db` (pg pool) | Multi-table atomic writes; `FOR UPDATE` locks; raw SQL | **Yes** — `client.query('BEGIN')` / `COMMIT` / `ROLLBACK` |

### 1.2 Files under governance

| File | Role | Stability |
|---|---|---|
| `services/historicalComparativesService.js` | All persistence logic | **GOVERNED — auto-trigger file** |
| `routes/historicalComparatives.js` | HTTP routing, validation, delegation | **GOVERNED** |
| `frontend-accounting/historical-comparatives.html` | Capture UI, save flows, dirty tracking | **GOVERNED** |
| `database/migrations/049_historical_comparatives_save_integrity.sql` | New unique index + audit log fix | **MUST RUN BEFORE DEPLOY** |

### 1.3 Data model relevant to save integrity

```
historical_comparative_batches
  id UUID PK
  company_id INTEGER
  status TEXT  ('draft' | 'validated' | 'finalized' | 'archived')
  is_finalized BOOLEAN  (redundant with status for legacy compatibility)
  updated_at TIMESTAMPTZ

historical_comparative_lines
  id UUID PK
  batch_id UUID FK → batches
  company_id INTEGER
  account_id INTEGER NULL  (FK → accounts; NULL for manual freetext entries)
  account_name TEXT
  account_code TEXT NULL
  financial_year INTEGER
  period_month INTEGER (1–12)
  amount NUMERIC
  original_amount NUMERIC  (immutable — preserved from first save)
  is_finalized BOOLEAN
  entered_by INTEGER NULL
  entered_at TIMESTAMPTZ
  updated_by INTEGER NULL
  updated_at TIMESTAMPTZ

  Index uq_hcl_batch_account_period (migration 042):
    UNIQUE (batch_id, account_id, financial_year, period_month) WHERE account_id IS NOT NULL

  Index uq_hcl_batch_account_snapshot_year_month (migration 049):
    UNIQUE (batch_id, COALESCE(account_code,''), account_name, financial_year, period_month)
    WHERE account_id IS NULL
```

### 1.4 Permission model

| Permission | Who has it | Operations |
|---|---|---|
| `historical.view` | admin, accountant, bookkeeper, viewer | list, read, reports |
| `historical.create` | admin, accountant, bookkeeper | create, save, bulk-save, sync |
| `historical.finalize` | admin, accountant | validate, finalize |

---

## 2. Exact Failure Vectors

### 2.1 R1 — Split save non-transactional (**FIXED in Fix Pack 01**)

**Location (pre-fix):** `saveManualGrid()` in service.

**Mechanism:** The old code fetched existing lines with a Supabase SELECT, then ran a Supabase `upsert` for existing months and a separate Supabase `insert` for new months. Both are independent PostgREST requests. If the upsert succeeded and the insert failed, the server returned a 500 but the updated months were already committed. The frontend showed an error, but 6 of 12 months might be saved with new values while the other 6 stayed at old values. No way to determine which months were affected.

**Why this is HIGH risk:** An accountant may accept the partial save as the full save, especially if the error message is vague. On a next "Save All" the stale months are re-saved with whatever is now in the DOM — which may be different from what was originally intended.

**Fix:** Replaced with a single pg `BEGIN`/`COMMIT` transaction. See Section 5.

---

### 2.2 R2 — `Promise.all()` partial-year save (**FIXED in Fix Pack 01**)

**Location (pre-fix):** `saveAccountGrid()` and `saveAllGrids()` in the HTML frontend.

**Mechanism:** For a multi-year batch (e.g. FY2021–FY2023), three POST requests were launched simultaneously with `Promise.all`. If FY2022 failed after FY2021 succeeded, `Promise.all` rejected immediately. FY2023's HTTP request was already in-flight — it may or may not complete, and its result was ignored. The user had no idea which years saved.

**Why this is HIGH risk:** Multi-year batches are the primary use case. An accountant entering 5 years of data expects all 5 years to save or fail together — not some unknown subset.

**Fix:** Sequential `for...of` loops over year entries. See Section 5.

---

### 2.3 R3 — Finalize with unsaved DOM edits (**FIXED in Fix Pack 01**)

**Location (pre-fix):** `finalizeBatch()` in the HTML frontend.

**Mechanism:** No dirty-state tracking existed. An accountant could edit March and April, click Finalize, confirm the irreversible dialog — and the old saved values (not the DOM edits) would be permanently locked. The finalization would succeed silently with the wrong data.

**Why this is HIGH risk:** Finalization is irreversible by design. A wrong value locked in a finalized batch cannot be corrected. A new batch must be created. This is a trust-destroying outcome for a financial data application.

**Fix:** Module-level `historicalDirty` flag + blocking error before finalize. See Section 7.

---

### 2.4 R4 — Finalization non-transactional (**FIXED in Fix Pack 01**)

**Location (pre-fix):** `finalizeBatch()` in the service.

**Mechanism:** Two separate Supabase calls:
1. `UPDATE historical_comparative_lines SET is_finalized = true`
2. `UPDATE historical_comparative_batches SET status = 'finalized'`

If call 1 succeeded and call 2 failed (network timeout, Supabase interruption), all line rows were marked `is_finalized = true` but the batch status remained `'validated'`. Consequence: lines were locked against editing (individual `is_finalized` guard blocks edits) but the batch would not appear in finalized-only reports and the Finalize button might remain active. The batch was stuck in an unrecoverable half-state.

**Why this is HIGH risk:** A partially-finalized batch that blocks edits but doesn't appear in reports is an accounting black hole. The data exists but can't be read or corrected.

**Fix:** Full `BEGIN`/`COMMIT` transaction with `FOR UPDATE` TOCTOU lock. See Section 6.

---

### 2.5 Remaining unresolved risks (not addressed in Fix Pack 01)

| Risk | Severity | Status |
|---|---|---|
| **R8** — No retry on network failure (transient timeout = data not saved) | LOW-MEDIUM | **OPEN** |
| **R9** — `parseCurrency()` silently truncates US-formatted numbers | LOW | **OPEN** |
| `saveManualLine()` — batch `updated_at` write can fail after line save | LOW | **OPEN** |
| `rescaleBatchAmounts()` — amounts updated but batch `updated_at` in separate Supabase call | LOW | **OPEN** |

These are LOW priority but must be tracked. See Section 12 (Work Phases) for scheduling.

---

## 3. Recommended Transaction Strategy

### 3.1 Decision rule

Use the pg pool (`db.getClient()`) for any operation that writes to more than one row or more than one table atomically. Use the Supabase client for read-only queries and single-table, single-row writes.

```
Write type                                            Client to use
─────────────────────────────────────────────────     ─────────────
Single-row read (getBatch, getLine)                → supabase
Single-table, single-row write (saveManualLine)    → supabase (acceptable low risk)
Multi-cell atomic write (saveManualGrid)            → pg pool + BEGIN/COMMIT
Multi-table atomic write (finalizeBatch)            → pg pool + BEGIN/COMMIT
Any write that cannot be partial                    → pg pool + BEGIN/COMMIT
```

### 3.2 Connection management pattern

```javascript
const client = await db.getClient();
try {
  await client.query('BEGIN');
  // ... all writes here ...
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;  // re-throw so the route returns 500
} finally {
  client.release();  // ALWAYS release — prevents pool exhaustion
}
```

**Critical rules:**
- `client.release()` must be in `finally`, not in the `try` or `catch` blocks
- Never `throw` after `release()` — the client is gone
- Never call `supabase` queries inside a `db.getClient()` transaction — they are independent connections and not part of the same `BEGIN`/`COMMIT` scope
- Audit log writes go AFTER `COMMIT`, outside the transaction — audit failure must never roll back committed data

### 3.3 Why not Supabase RPC (stored procedures)?

Supabase RPC functions can execute multiple SQL statements atomically server-side, making them an alternative to raw pg pool transactions. They were not chosen for this implementation because:

1. **No deployment dependency:** pg pool transactions require no Supabase DB schema changes beyond what migrations 042 and 049 already provide.
2. **Debuggability:** Transaction logic in the Node.js service is visible, testable, and version-controlled in the same codebase.
3. **Future portability:** The pg pool abstraction is not tied to Supabase — the codebase could migrate to a different hosted Postgres without rewriting RPC functions.
4. **Error propagation:** Raw pg errors are thrown directly from `client.query()` and can be caught, categorized, and surfaced accurately. RPC errors pass through an additional HTTP layer.

The pg pool approach is the correct long-term architecture for this service.

---

## 4. pg Pool vs Supabase Client Analysis

| Dimension | Supabase JS Client | pg Pool |
|---|---|---|
| **Transaction support** | No — each call is an independent HTTP request | Yes — `BEGIN`/`COMMIT`/`ROLLBACK` |
| **FOR UPDATE row locks** | No | Yes |
| **Custom SQL** | Limited (PostgREST filters only) | Full SQL |
| **Connection overhead** | HTTP REST API (higher latency per call) | Direct TCP (lower latency) |
| **Connection pooling** | Managed by Supabase | Managed by pg Pool config |
| **Auth/RLS enforcement** | Yes — Supabase RLS policies apply | **No** — pg pool bypasses RLS entirely |
| **Batch parameterization** | No multi-row INSERT via JS client | Yes — VALUES ($1,$2,...),($3,$4,...) |
| **Error messages** | PostgREST JSON errors | Raw Postgres errors |

### 4.1 RLS bypass risk (IMPORTANT)

When using the pg pool (`db.getClient()`), Postgres Row Level Security (RLS) policies are **not applied**. The service is trusted to enforce company isolation via `WHERE company_id = $N` in every query. This is the current pattern throughout the accounting module.

**This is only safe because:**
1. `db.getClient()` is called server-side, after JWT auth has already verified company ownership
2. `companyId` is always sourced from `req.user.companyId`, never from request body or query params
3. Every pg pool query in `saveManualGrid()` and `finalizeBatch()` includes `AND company_id = $N`

Any future pg pool query that omits the `company_id` filter would be a cross-company data leak. This must be enforced as a code review rule.

### 4.2 Pool configuration

The pg pool size and timeout settings are in `backend/config/database.js`. A `getClient()` call blocks until a connection is available. If all pool connections are held by slow transactions, new requests queue. The `finally { client.release() }` pattern ensures connections are returned even on error.

For Historical Comparatives, the longest transaction is `saveManualGrid()` with 12 cells on the null-account path (12 individual INSERT/UPDATE calls inside one transaction). Benchmarking estimate: < 50ms total on a low-latency Supabase connection. This is not a pool exhaustion risk at current concurrency levels.

---

## 5. Safe Save Flow

### 5.1 saveManualGrid — account_id path (most accounts)

```
Request arrives: POST /batch/:batchId/manual-grid
Route validates inputs (financialYear, accountName, cells array, cell months/amounts)

Service saveManualGrid():
  ┌─ PRE-FLIGHT (outside transaction) ───────────────────────────────────────┐
  │  getBatch(companyId, batchId) via supabase                               │
  │  → 404 if batch not found                                                │
  │  → 403 + FINALIZED_EDIT_BLOCKED audit log if batch.status = 'finalized' │
  │  getAccount(accountId, companyId) via supabase                           │
  │  → 403 if account.is_postable = false (parent/header account)            │
  │  buildRowData(cells) — pure computation, no DB                           │
  └───────────────────────────────────────────────────────────────────────────┘
  
  ┌─ TRANSACTION ─────────────────────────────────────────────────────────────┐
  │  client = await db.getClient()                                            │
  │  await client.query('BEGIN')                                              │
  │                                                                           │
  │  INSERT INTO historical_comparative_lines                                 │
  │    (batch_id, company_id, account_id, account_code, ..., amount,         │
  │     original_amount, entered_by, entered_at, updated_by, updated_at, ...) │
  │  VALUES ($1,$2,$3,...), ($1,$2,$3,...), ...  ← all 12 months in one stmt  │
  │  ON CONFLICT (batch_id, account_id, financial_year, period_month)        │
  │    WHERE account_id IS NOT NULL                                           │
  │  DO UPDATE SET                                                            │
  │    amount = EXCLUDED.amount,                                              │
  │    updated_by = EXCLUDED.updated_by,                                     │
  │    updated_at = EXCLUDED.updated_at,                                     │
  │    account_code = EXCLUDED.account_code,                                 │
  │    account_name = EXCLUDED.account_name,                                 │
  │    account_type = EXCLUDED.account_type                                  │
  │    -- NOTE: original_amount NOT updated on conflict                      │
  │    -- NOTE: entered_by / entered_at NOT updated on conflict              │
  │                                                                           │
  │  UPDATE historical_comparative_batches                                   │
  │    SET updated_at = $now                                                  │
  │    WHERE id = $batchId AND company_id = $companyId                        │
  │                                                                           │
  │  await client.query('COMMIT')                                             │
  └──────────────── ATOMIC: all 12 months + batch.updated_at ────────────────┘
  
  finally: client.release()
  
  ┌─ POST-COMMIT ──────────────────────────────────────────────────────────────┐
  │  _writeAuditLog(GRID_SAVED) — via supabase, never throws                  │
  └───────────────────────────────────────────────────────────────────────────┘

Route returns: { saved: N, lines: [{ id, period_month }, ...] }
```

**Invariant:** After `COMMIT`, all 12 months for the given `(batchId, accountId, financialYear)` are in the database with the submitted values, or none of them are (if any cell fails).

**Conflict key:** `(batch_id, account_id, financial_year, period_month) WHERE account_id IS NOT NULL` — index `uq_hcl_batch_account_period` from migration 042. This handles the INSERT vs UPDATE decision at the database level in a single atomic statement.

**Preservation rule:** `original_amount`, `entered_by`, `entered_at` are only written on INSERT (first capture). On subsequent saves, the `DO UPDATE SET` clause deliberately omits these columns. This preserves the original capture values permanently as an immutable audit record.

---

### 5.2 saveManualGrid — null-account path (freetext/unlinked accounts)

The `ON CONFLICT` clause requires a non-null unique key. For rows where `account_id IS NULL`, the conflict key is `(batch_id, COALESCE(account_code,''), account_name, financial_year, period_month)` — but this cannot be used in a single multi-row `INSERT ... ON CONFLICT` because Postgres requires the conflict target to match an exact index, and this is a partial index (WHERE account_id IS NULL).

The null-account path uses a different strategy inside the same transaction:

```
BEGIN (same transaction — client already has BEGIN in progress)

SELECT id, period_month, original_amount
  FROM historical_comparative_lines
  WHERE batch_id=$1 AND company_id=$2
    AND account_id IS NULL
    AND account_name=$3
    AND COALESCE(account_code,'') = COALESCE($4,'')
    AND financial_year=$5
  FOR UPDATE                   ← acquires row locks on existing rows
                               ← concurrent saves for same account+year are serialized

for each cell:
  if existing row:
    UPDATE SET amount=..., updated_by=..., updated_at=..., snapshots  WHERE id=existing.id
  else:
    INSERT new row

UPDATE batch.updated_at

COMMIT
```

**`FOR UPDATE` purpose:** Two concurrent saves for the same null-account (two browser tabs, fast clicking) would both see zero existing rows and both INSERT — hitting the unique index from migration 049 with a constraint violation. The `FOR UPDATE` on the SELECT serializes concurrent transactions: the second transaction's SELECT blocks until the first transaction commits, then sees the inserted rows and takes the UPDATE path.

---

### 5.3 saveManualLine — single-cell save (not transactional)

`saveManualLine()` is the single-cell save used by the individual cell API (not the grid UI). Its write pattern is a single Supabase call (either UPDATE or INSERT — not both), so there is no partial-save risk for the data itself.

The only non-atomic element is the subsequent `batch.updated_at` update, which is a separate Supabase call. If this fails, the line data is saved but the batch timestamp is stale.

**Risk assessment:** LOW. The batch `updated_at` timestamp is a display/audit field, not a data integrity field. Stale `updated_at` does not corrupt financial values.

**Planned work:** Wrapping `saveManualLine()` in a pg transaction (to make the line write + batch update atomic) is deferred to Phase 3. Not required for pilot.

---

## 6. Safe Finalize Flow

```
Request arrives: POST /batch/:batchId/finalize
Route checks hasPermission('historical.finalize')

Service finalizeBatch():
  ┌─ PRE-FLIGHT (outside transaction) ──────────────────────────────────────┐
  │  getBatch(companyId, batchId) via supabase                              │
  │  → 404 if not found                                                     │
  │  → 403 if status = 'finalized'                                          │
  │  → 403 if status = 'draft' (must validate first)                        │
  │  (fast check — avoids acquiring a DB connection for an obvious failure) │
  └──────────────────────────────────────────────────────────────────────────┘
  
  ┌─ TRANSACTION ────────────────────────────────────────────────────────────┐
  │  client = await db.getClient()                                           │
  │  await client.query('BEGIN')                                             │
  │                                                                          │
  │  SELECT id, status FROM historical_comparative_batches                  │
  │    WHERE id=$batchId AND company_id=$companyId                          │
  │    FOR UPDATE                  ← TOCTOU guard: locks the batch row      │
  │                                ← concurrent finalize requests serialize │
  │  → 404 if row not found                                                  │
  │  → 403 if status = 'finalized'  (caught by the lock)                    │
  │  → 403 if status = 'draft'                                               │
  │                                                                          │
  │  SELECT COUNT(*) FROM historical_comparative_lines                      │
  │    WHERE batch_id=$batchId AND company_id=$companyId                    │
  │  → 422 if count = 0  (empty batch guard)                                │
  │                                                                          │
  │  UPDATE historical_comparative_lines                                    │
  │    SET is_finalized = true, updated_at = $now                           │
  │    WHERE batch_id=$batchId AND company_id=$companyId                    │
  │                                                                          │
  │  UPDATE historical_comparative_batches                                  │
  │    SET status='finalized', finalized_at=$now, finalized_by=$userId      │
  │    WHERE id=$batchId AND company_id=$companyId                          │
  │    RETURNING *                                                           │
  │                                                                          │
  │  await client.query('COMMIT')                                            │
  └───────────── ATOMIC: all lines + batch row ──────────────────────────────┘
  
  finally: client.release()
  
  ┌─ POST-COMMIT ─────────────────────────────────────────────────────────────┐
  │  _writeAuditLog(BATCH_FINALIZED)                                          │
  └───────────────────────────────────────────────────────────────────────────┘

Route returns: { batch: { id, status:'finalized', finalized_at, finalized_by, ... } }
```

**TOCTOU guard detail:** The `SELECT ... FOR UPDATE` inside the transaction acquires an exclusive row lock on the batch record. If two concurrent `POST /finalize` requests arrive:
- Request A acquires the lock, verifies `status='validated'`, proceeds
- Request B's `SELECT FOR UPDATE` blocks until A commits
- After A commits: B acquires the lock, sees `status='finalized'`, throws "Batch is already finalized"
- ROLLBACK for B, HTTP 403 returned

**Irreversibility:** Finalization is intentionally permanent. There is no un-finalize endpoint. If wrong values were finalized, the correct procedure is:
1. Create a new batch with the correct values
2. Archive the incorrect batch

A correction mechanism (archive + re-open) is tracked as a future feature. It is not in scope for this plan.

---

## 7. Dirty-State Protection Design

### 7.1 Module-level state variables

```javascript
// HistoricalComparatives dirty-state tracking
// Both are module-level — persist across function calls within the same page load
let historicalDirty = false;   // true = grid has unsaved DOM edits
let isSaving        = false;   // true = saveAllGrids() is actively running
```

### 7.2 How `historicalDirty` becomes true

Every `.amount-cell` input in the capture grid has:
```html
<input class="amount-cell"
       oninput="historicalDirty = true"
       data-month="..." data-year="..." data-account-id="..." ...>
```

Any keystroke in any cell immediately sets `historicalDirty = true`. This is set at render time, not dynamically — so cells added or re-rendered by COA sync also get the `oninput` attribute.

### 7.3 How `historicalDirty` becomes false

`historicalDirty` is cleared to `false` only when a complete successful save occurs:
- In `saveAccountGrid()`: set to `false` only if `yearErrors.length === 0` (all years saved without error)
- In `saveAllGrids()`: set to `false` only if `failedItems.length === 0` (all accounts × years saved without error)

If any year or account fails, `historicalDirty` remains `true` even after the (partial) save attempt. The user must resolve the error and re-save before finalization is permitted.

### 7.4 How finalization is blocked when dirty

```javascript
async function finalizeBatch() {
  if (historicalDirty) {
    showMsg('captureMsg', 'error',
      'There are unsaved changes in the grid. Use Save All to save all changes before finalizing.',
      true  // isPersistent = true — message stays until user acts
    );
    return;  // function exits here — no API call is made
  }
  // ... confirm dialog, API call ...
}
```

**No "Finalize Anyway" option exists.** The only path forward is to save first. This is a deliberate design decision — the risk of permanently locking wrong values is too high for any override to be acceptable.

### 7.5 Double-click race guard on Save All

```javascript
async function saveAllGrids() {
  if (isSaving) return;          // guard against rapid double-clicks
  isSaving = true;
  const btn = document.getElementById('btnSaveAll');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    // ... save loop ...
  } finally {
    isSaving = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Save All'; }
  }
}
```

The `isSaving` flag prevents a concurrent `saveAllGrids()` invocation from starting before the first one completes. The button is visually disabled during the save to reinforce this.

### 7.6 Remaining dirty-state gap

**OPEN:** The current implementation has no *visual* indicator that the grid is dirty (no "unsaved changes" banner, no asterisk on changed cells). The accountant must remember that they've made changes. This is an acceptable UX gap for now but should be addressed in Phase 3.

**Proposed visual:** A warning banner above the Save All button:  
`"You have unsaved changes — click Save All before finalizing."`  
Banner appears when `historicalDirty = true`, disappears on successful save.

---

## 8. UI/UX Changes Required

### 8.1 Changes already implemented (Fix Pack 01)

| Change | Purpose | Status |
|---|---|---|
| `oninput="historicalDirty = true"` on all `.amount-cell` inputs | Track unsaved edits | ✅ Done |
| `id="btnSaveAll"` on Save All button | Allow `isSaving` guard to disable it | ✅ Done |
| `isSaving` flag + button disabled state during save | Prevent double-click race | ✅ Done |
| Blocking error in `finalizeBatch()` when dirty | Prevent finalization with unsaved edits | ✅ Done |
| Sequential year saves replacing `Promise.all` | Attributable per-year errors | ✅ Done |
| `failedItems[]` list in Save All error message | Identify which accounts failed | ✅ Done |
| `console.error` with account name and year in Save All catch | Diagnosable failures | ✅ Done |
| Server save count verification vs DOM cell count | Detect and warn on partial server saves | ✅ Done |
| Hardened `api()` — check `res.ok` before `res.json()` | Readable error on non-JSON server responses | ✅ Done |

### 8.2 Changes still needed (Phase 3)

| Change | Purpose | Priority |
|---|---|---|
| Visual "unsaved changes" banner when `historicalDirty = true` | Remove dependency on user memory | MEDIUM |
| Badge/indicator on dirty cells (e.g. yellow background on edited inputs) | Cell-level unsaved indicator | LOW |
| "Save All and Finalize" single-action button | Single atomic UX flow, fewer clicks | LOW |
| Retry prompt on transient save failure | Re-attempt without full page reload | LOW (R8) |

### 8.3 Out of scope (intentional no-change decisions)

| Feature | Decision | Reason |
|---|---|---|
| Per-cell auto-save (save on blur) | **Not implemented** | Creates save storms for 12-cell grids; partial-save risk per-cell is now low with server transactions |
| Optimistic UI (show saved state before server confirms) | **Not implemented** | Financial data must not show "saved" until server confirms |
| Undo/redo | **Not in scope** | Accounting data mutations are logged in audit trail; undo is out of scope for this module |

---

## 9. Rollback Strategy

### 9.1 Application-level rollback (automatic — in place)

Every pg transaction in `saveManualGrid()` and `finalizeBatch()` uses:
```javascript
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

If any SQL statement inside the transaction throws, the `ROLLBACK` fires automatically and the connection is released. The thrown error propagates to the route and returns HTTP 500. No partial data is committed.

### 9.2 Migration rollback (migration 049)

Migration 049 makes three changes:
1. Creates `uq_hcl_batch_account_snapshot_year_month` index
2. Drops and recreates `hcal_action_chk` constraint

**To rollback migration 049 manually:**
```sql
-- Remove the new index
DROP INDEX IF EXISTS uq_hcl_batch_account_snapshot_year_month;

-- Restore original audit log constraint (without GRID_SAVED and BATCH_RESCALED)
ALTER TABLE historical_comparative_audit_log DROP CONSTRAINT IF EXISTS hcal_action_chk;
ALTER TABLE historical_comparative_audit_log ADD CONSTRAINT hcal_action_chk
  CHECK (action IN (
    'BATCH_CREATED', 'BATCH_UPDATED',
    'LINE_CREATED', 'LINE_UPDATED', 'LINE_DELETED',
    'BATCH_VALIDATED', 'BATCH_FINALIZED', 'BATCH_ARCHIVED',
    'FINALIZED_EDIT_BLOCKED'
  ));
```

**Effect of rollback:** The null-account unique index is removed. The duplicate-concurrent-save race condition is re-exposed. The `GRID_SAVED` and `BATCH_RESCALED` audit log entries will start failing silently again. All existing data is unaffected — the migration adds constraints, it does not modify data.

### 9.3 Code rollback (revert Fix Pack 01)

If the transactional service code must be reverted:
- The pg pool calls (`BEGIN`/`COMMIT`) must be replaced with the original two-call Supabase pattern
- The frontend sequential-loop changes must be reverted to `Promise.all`
- The dirty-flag oninput attributes must be removed from all `.amount-cell` inputs

**Reversible:** All code changes are version-controlled. A git revert to the pre-Fix-Pack-01 commit is the clean rollback path.

**Do NOT revert without first rolling back migration 049** — the service code references the null-account index key structure that migration 049 created. The index being present with the old code is harmless; the index being absent with the new code causes `FOR UPDATE` to not prevent the race condition (but won't break saves).

### 9.4 Data-level recovery (partial save occurred before Fix Pack 01)

If an accountant reports that some months are missing after a save (the original symptom), the diagnostic steps are:
1. Check `historical_comparative_lines` for the affected `(batch_id, account_id, financial_year)`
2. Identify which `period_month` values are missing
3. Re-enter and re-save the missing months via the capture UI
4. Verify the `historical_comparative_audit_log` for the batch to trace when each line was last saved

There is no automated recovery — re-entry is the correct path. Fix Pack 01 prevents future occurrences; it does not restore data that was already lost in pre-fix saves.

---

## 10. Migration Requirements

### 10.1 Migration 049 — deployment prerequisites

| Check | Required before running | Notes |
|---|---|---|
| Run duplicate-detection query | **YES** | Migration's DO $$ block will auto-fail if duplicates exist; run the query manually first to be safe |
| Backup or confirm no production null-accountId rows | Recommended | Null-accountId rows are entered without COA sync; confirm whether any exist |
| Migration 042 applied | **YES** | 042 created `historical_comparative_lines` table and `uq_hcl_batch_account_period` index |
| Migration 043 applied | YES (dependency chain) | 043 fixes user_id type issues |
| Migration 044 applied | YES (dependency chain) | 044 adds `is_postable` column to accounts |
| Migration 045 applied | YES (dependency chain) | 045 COA sync |

### 10.2 Duplicate-detection query (run before migration 049)

```sql
SELECT
  batch_id,
  COALESCE(account_code, '') AS account_code,
  account_name,
  financial_year,
  period_month,
  COUNT(*) AS n
FROM historical_comparative_lines
WHERE account_id IS NULL
GROUP BY 1, 2, 3, 4, 5
HAVING COUNT(*) > 1;
```

**If this returns rows:** Duplicates exist. The migration will fail on Step 1's DO $$ block. Use the cleanup query in the migration's header comment to keep only the most-recently-updated row per combination before re-running.

**If this returns no rows:** Proceed with the migration.

### 10.3 Migration execution order

```
Zeabur Supabase SQL Editor:
  1. Confirm migration 042, 043, 044, 045, 046, 047, 048 are applied
  2. Run duplicate-detection query (above)
  3. If no duplicates: paste contents of 049_historical_comparatives_save_integrity.sql and execute
  4. Verify: SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'uq_hcl_batch_account_snapshot_year_month';
     → should return 1
  5. Verify: SELECT constraint_name FROM information_schema.table_constraints 
              WHERE table_name = 'historical_comparative_audit_log' AND constraint_type = 'CHECK';
     → should include 'hcal_action_chk'
```

### 10.4 Deployment order rule

**Migration 049 MUST be applied before deploying the Fix Pack 01 service code to production.**

The null-account path in `saveManualGrid()` relies on the `uq_hcl_batch_account_snapshot_year_month` index as a concurrent-save guard. If the code is deployed without the index:
- Sequential saves work correctly (the `FOR UPDATE` lock still serializes them)
- Concurrent saves (two tabs simultaneously) can still produce duplicate null-account rows

Deploying the code without the migration is functionally safe for single-user batches but does not fully close R7. Apply the migration first.

---

## 11. Runtime Risk Analysis

### 11.1 pg Pool connection exhaustion

**Risk:** If `getClient()` is called and the acquired connection is never released (e.g., `client.release()` not in `finally`), the pool shrinks. Under high concurrency, new requests queue indefinitely.

**Mitigation (in place):** Every `db.getClient()` call in the service is wrapped with `try/catch/finally { client.release() }`. This is an absolute pattern — never remove the `finally` block.

**Monitoring:** If API calls start timing out globally, check pg pool connection count in the backend logs. A pool exhaustion symptom is that ALL routes become slow simultaneously, not just historicals.

### 11.2 Transaction deadlock on null-account path

**Risk:** Two concurrent saves for the same null-account+year (e.g. two browser tabs clicking Save simultaneously) each issue `SELECT ... FOR UPDATE`. Postgres detects the deadlock and kills one transaction with `ERROR: deadlock detected`.

**Effect:** One of the two saves returns HTTP 500. The other completes successfully. The user who received the error must retry — their data was not saved.

**Probability:** Very low. Requires two users editing the same null-account grid simultaneously. Null-account grids are an uncommon path (most accounts have a COA account_id).

**No mitigation needed** at current concurrency levels. If this becomes frequent, the correct fix is to retry the failed transaction automatically in the service (retry once on `error.code === '40P01'`).

### 11.3 Long transaction holding lock on null-account path

**Risk:** A slow DB connection during the null-account path holds the `FOR UPDATE` lock for an extended time, blocking other users trying to save the same account.

**Effect:** Other save requests for the same account+year queue behind the lock. They will succeed once the lock is released (COMMIT or ROLLBACK). Maximum expected lock duration: the time for 12 individual INSERT/UPDATE statements + network round-trips.

**Probability:** Low. Historical comparative saves are not a high-frequency operation.

### 11.4 Migration 049 not yet applied — partial risk exposure

Until migration 049 is applied to the production database, the null-account unique constraint (`uq_hcl_batch_account_snapshot_year_month`) does not exist. This means:
- R1, R2, R3, R4 are fully mitigated by the code (no migration dependency for these)
- R7 (duplicate null-account rows from concurrent saves) remains unmitigated

**Action required:** Apply migration 049 as soon as possible. See Section 12 (Phase 1).

### 11.5 `saveManualLine()` — batch timestamp stale after failure

If the Supabase call to update `batch.updated_at` fails after a successful line save in `saveManualLine()`, the line data is committed but the batch's last-updated timestamp is stale. This affects the "last modified" display in the batch list.

**Effect on data integrity:** None. The line amount is correctly saved. Reports read from `historical_comparative_lines`, not from `batch.updated_at`.

**Planned fix:** Phase 3 — wrap `saveManualLine()` in a pg transaction to make line + batch update atomic.

### 11.6 `rescaleBatchAmounts()` — batch timestamp stale after failure

Same pattern as §11.5 but for the rescale operation. Additionally, if the Supabase `upsert` for rescaled amounts partially succeeds (e.g., succeeds for 50 rows and fails for the last row), some amounts are at the new scale and some are at the old scale.

**Risk assessment:** MEDIUM for rescale operations. Rescale is a recovery tool (used when amounts were stored at 100× scale due to a historical parseCurrency bug). It is not used in routine saves.

**Planned fix:** Phase 3 — wrap `rescaleBatchAmounts()` in a pg pool transaction.

---

## 12. Recommended Work Phases

### Phase 0 — Fix Pack 01 Code Implementation (COMPLETE — 2026-05-24)

All code changes for R1–R4 and R5–R7, R10 are implemented and committed.

| Work item | Status |
|---|---|
| `saveManualGrid()` — pg transaction (R1) | ✅ Implemented |
| `finalizeBatch()` — pg transaction + TOCTOU lock (R4) | ✅ Implemented |
| `finalizeBatch()` — empty-batch guard, 422 | ✅ Implemented |
| `saveAccountGrid()` — sequential year saves (R2) | ✅ Implemented |
| `saveAllGrids()` — sequential year saves (R2) | ✅ Implemented |
| `historicalDirty` flag + `oninput` on cells (R3) | ✅ Implemented |
| Finalize blocks when dirty (R3) | ✅ Implemented |
| `isSaving` guard + Save All button disabled state | ✅ Implemented |
| Server-count verification per year (R6) | ✅ Implemented |
| `saveAllGrids()` error logging with account+year attribution (R5) | ✅ Implemented |
| Hardened `api()` — `res.ok` checked before `res.json()` (R10) | ✅ Implemented |
| Migration 049 — SQL written | ✅ Written |

---

### Phase 1 — Migration Deployment (REQUIRED — do before pilot)

**Owner:** Ruan (Supabase dashboard access required)  
**Risk:** LOW — migration is additive, safe to re-run, has built-in duplicate guard  
**Estimated time:** < 5 minutes

| Step | Action |
|---|---|
| 1 | Run duplicate-detection query in Supabase SQL Editor (Section 10.2) |
| 2 | If no duplicates: paste and execute `049_historical_comparatives_save_integrity.sql` |
| 3 | Verify index created (Section 10.3 verification queries) |
| 4 | Verify audit log constraint includes `GRID_SAVED` |
| 5 | Run acceptance tests AT-01 through AT-10 (Section 13) |

---

### Phase 2 — Regression Testing (REQUIRED — do before pilot)

Run all acceptance tests in Section 13. Pay particular attention to AT-01 (R1 fix) and AT-03 (R3 fix) — these address the primary reported symptoms.

The existing test file `backend/tests/historical-comparatives-dashboard.test.js` covers report correctness but does not cover the save-integrity flows. New tests should be added there. See Section 13 for test specifications.

---

### Phase 3 — Remaining Medium-Risk Items (before general release)

| Work item | Risk | Notes |
|---|---|---|
| Visual "unsaved changes" banner (Section 7.6) | UI only, no DB risk | Implement with CSS class toggle on `historicalDirty` change |
| Wrap `saveManualLine()` in pg transaction | LOW code change | Only affects batch `updated_at`; no data integrity risk |
| Wrap `rescaleBatchAmounts()` in pg transaction | MEDIUM code change | Rescale is infrequent; risk is manageable |
| Add `BATCH_RESCALED` to audit log action constraint | DB migration | Pair with a migration 050 |

---

### Phase 4 — Low-Risk Improvements (deferred — post-pilot)

| Work item | Risk | Notes |
|---|---|---|
| Retry logic on transient network failure (R8) | LOW code | Retry once after 2s on HTTP 5xx |
| `parseCurrency()` US-format detection (R9) | LOW code | Warn user if input contains `,` followed by digits in US pattern |
| "Save and Finalize" single-action button | UX | Reduces cognitive load; no integrity risk |
| Cell-level dirty indicator (yellow background) | UX | Visual confirmation of which cells are changed |

---

## 13. Acceptance Tests

> These tests must pass before Phase 1 is declared complete and before pilot access is granted.

### AT-01 — Transactional grid save (R1 fix verification)

**Setup:** Batch with one account. Save 6 months. Confirm they exist in DB.  
**Action:** Edit all 12 months. While save is in progress, simulate a failure on the INSERT step for new months. (Easiest: temporarily add a DB constraint that blocks inserts; or use a test that throws mid-transaction.)  
**Expected:** Either all 12 months are saved with new values, or none are. The 6 previously-saved months must not have their values updated while the other 6 are missing.  
**Pass criterion:** No partial month state in `historical_comparative_lines` for the affected account+year after the failed save attempt.

---

### AT-02 — Sequential year saves (R2 fix verification)

**Setup:** Multi-year batch (FY2021–FY2023). One account.  
**Action:** Save account grid. Simulate a server error for FY2022 only (mock the route to return 500 for that year).  
**Expected:**  
- FY2021 is saved (first in sequence — completes before FY2022 fails)  
- FY2022 is not saved (returned 500)  
- FY2023 is NOT attempted after FY2022 fails  
- Error message attributes failure specifically to FY2022  
- `historicalDirty` remains `true`  
**Pass criterion:** FY2022 and FY2023 show failure; FY2021 data is in DB; error message identifies FY2022.

---

### AT-03 — Dirty flag blocks finalization (R3 fix verification)

**Setup:** Batch in `validated` status.  
**Action:** Edit a cell value. Click Finalize.  
**Expected:** Finalize function returns immediately with a persistent error message: "There are unsaved changes..." No API call to `POST /finalize` is made (verify via browser Network tab).  
**Pass criterion:** No finalize request fired. Error message visible. Batch still in `validated` status.

---

### AT-04 — Dirty flag clears on successful save

**Setup:** Batch. Edit a cell (sets `historicalDirty = true`). Click Save (single account).  
**Action:** Verify save succeeds. Then click Finalize.  
**Expected:** `historicalDirty` is `false` after successful save. Finalize proceeds to confirmation dialog (not blocked by dirty check).  
**Pass criterion:** Finalize dialog appears after a clean save.

---

### AT-05 — Transactional finalization (R4 fix verification)

**Setup:** Batch in `validated` status with lines.  
**Action:** Call `POST /batch/:id/finalize`. Simulate a failure after lines are updated but before the batch row is updated. (Requires a test that interrupts the transaction mid-way — or verify this by code inspection that both updates are inside the same `BEGIN`/`COMMIT` block.)  
**Expected:** If line update succeeds but batch update fails, both are rolled back. Batch returns to `validated` status. No lines have `is_finalized = true`.  
**Pass criterion:** After simulated failure: no lines with `is_finalized = true`, batch `status` = `'validated'`.

---

### AT-06 — TOCTOU guard — concurrent finalization

**Setup:** Batch in `validated` status.  
**Action:** Send two simultaneous `POST /batch/:id/finalize` requests.  
**Expected:** Exactly one succeeds with HTTP 200. The other returns HTTP 403 "Batch is already finalized."  
**Pass criterion:** Only one finalize completes. No double-finalize inconsistency.

---

### AT-07 — Empty batch cannot be finalized

**Setup:** Batch in `validated` status with zero lines.  
**Action:** `POST /batch/:id/finalize`  
**Expected:** HTTP 422 with message "Cannot finalize an empty historical comparative batch."  
**Pass criterion:** 422 returned. Batch remains in `validated` status.

---

### AT-08 — isSaving guard prevents double-click race

**Setup:** Batch with multiple accounts.  
**Action:** Click "Save All" then immediately click again before it completes.  
**Expected:** Second click has no effect (function returns on `if (isSaving) return`). Only one save loop executes.  
**Pass criterion:** Single save loop completes. No duplicate API requests sent.

---

### AT-09 — Migration 049 unique constraint for null-account rows

**Setup:** Batch with one freetext account (no COA account_id).  
**Action:** Attempt two concurrent saves for the same account+year via two browser tabs.  
**Expected:** One save completes. The other receives a constraint violation error (surfaced as HTTP 500). No duplicate rows in `historical_comparative_lines` for that account+year.  
**Pass criterion:** Exactly 12 rows in DB for the account+year after both attempts.

---

### AT-10 — Save All error attribution

**Setup:** Batch with 3 accounts. Mock one account's save to fail.  
**Action:** Click Save All.  
**Expected:** Error message lists the failed account by name. `console.error` contains account name and year. Other 2 accounts are saved successfully. `historicalDirty` remains `true`.  
**Pass criterion:** Failed account is identifiable from the UI error message without checking the console.

---

## 14. Questions For Ruan

1. **Migration 049 status:** Has migration 049 been applied to the production Supabase project? If not, this should be the first action after reviewing this plan.

2. **Null-account rows in production:** Are there any real batches in production that contain freetext accounts (no `account_id` — entered without COA sync)? If so, the duplicate-detection query in Section 10.2 must be run against production before migration 049 is applied.

3. **saveManualLine atomicity:** Should the batch `updated_at` update in `saveManualLine()` be wrapped in a pg transaction to ensure atomicity? The risk is low (stale timestamp, not corrupted data), but consistency with `saveManualGrid()` is cleaner. Confirm whether Phase 3 should include this.

4. **rescaleBatchAmounts transaction:** Should `rescaleBatchAmounts()` be wrapped in a pg transaction? It is an infrequent recovery operation, but non-atomic amounts update + batch update is structurally the same pattern as the original R1 risk. Confirm priority.

5. **Visual dirty indicator:** Is a "You have unsaved changes" banner acceptable for pilot, or is it required? It is not currently implemented. Finalization is already blocked by the dirty flag — the banner is a UX improvement, not a safety requirement.

6. **"Save and Finalize" button:** Is a single-action "Save All and Finalize" button wanted for the pilot UI? This would save and then immediately invoke the finalize flow if save succeeds — reducing the chance of an accountant forgetting to save before finalizing.

7. **Phase 2 regression tests:** The existing test file (`backend/tests/historical-comparatives-dashboard.test.js`) covers report queries. New tests for the save-integrity flows (AT-01 through AT-10) need to be added. Should these be written before or after the pilot? Recommend: before, as they define the exact acceptance criteria.

8. **Partial-save recovery:** If any accountant experienced the partial-save symptom before Fix Pack 01 was deployed, their batch may have missing months. Are any affected batches known? If so, they should be identified and re-entered before finalization.
