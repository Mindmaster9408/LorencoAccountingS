# Historical Comparatives Save Integrity — Forensic Audit

**Severity:** HIGH  
**Audit type:** Forensic audit + safe fix plan  
**Date:** 2026-05-24  
**Status:** AUDIT COMPLETE — Fix Pack 01 implemented 2026-05-24  
**Auditor:** Claude Code (Sonnet 4.6)

> **Symptom:** User enters data, clicks Save, some values persist and some do not.  
> Accountant believes data has been saved. Report may show incomplete data.  
> Silent partial persistence is not acceptable for historical financial records.

---

## 1. Executive Summary

The save flow in Historical Comparatives has **four confirmed partial-save vectors** and **three silent failure modes**. The highest-severity risk is the non-transactional split between the `toUpdate` upsert and `toInsert` insert in `saveManualGrid()`: if updates succeed and inserts fail, only months that previously existed are re-saved — new months are silently lost with no frontend indication.

A second major risk is `Promise.all()` in both `saveAccountGrid()` and `saveAllGrids()` for multi-year grids: if one year's save request fails after another year's request already completed, the already-completed years remain committed but the user sees the top-level error and may retry the entire grid, potentially creating stale confusion about which data is and isn't persisted.

A third risk is the non-transactional finalization sequence: line marking (`is_finalized = true`) and batch marking (`status = 'finalized'`) are two separate Supabase calls with no atomicity — a crash between them leaves the batch in an inconsistent state.

None of the three save operations (single-line, single-grid, save-all) use a PostgreSQL transaction. None of the server responses are verified against the frontend's success count. Save All silently swallows individual account errors with no console logging.

**No fix has been implemented.** See Section 17 (Fix Plan) for the recommended remediation list.

---

## 2. Audit Scope

**In scope:**
- `frontend-accounting/historical-comparatives.html` — all JavaScript save functions
- `backend/modules/accounting/services/historicalComparativesService.js` — all save methods
- `backend/modules/accounting/routes/historicalComparatives.js` — route validation and delegation

**Strictly out of scope (not audited, not touched):**
- VAT, bank, AR/AP, trial balance, general ledger, reports outside historicals
- Opening balances
- Any journal or live financial table (historicals never write there)
- Authentication or company-scoping logic (no issues identified in those paths)

---

## 3. Files Audited

| File | Lines | Purpose |
|------|-------|---------|
| `frontend-accounting/historical-comparatives.html` | 1796 | Full capture UI, save buttons, grid rendering, report rendering |
| `backend/modules/accounting/services/historicalComparativesService.js` | 1486 | All persistence logic: batch CRUD, line save, COA sync, finalization |
| `backend/modules/accounting/routes/historicalComparatives.js` | 574 | Route validation, delegation to service, HTTP responses |

---

## 4. Save Flow — Exact Walkthrough

### 4.1 Single account grid "Save" button

**Trigger:** `onclick="saveAccountGrid('${gridId}', ${JSON.stringify(acc)}, [${showYears.join(',')}])"` on the per-account Save button.

**Step 1 — DOM read:**  
`saveAccountGrid()` (`html:1249`) queries all `.amount-cell` inputs inside `tbl_${gridId}`, reads `data-month`, `data-year`, and `parseCurrency(input.value)` for each. Cells are grouped by year into `byYear = { year: [{ periodMonth, amount }] }`.

**Step 2 — Parallel year requests:**  
```javascript
await Promise.all(Object.entries(byYear).map(([year, yearCells]) =>
  api('POST', `/batch/${currentBatch.id}/manual-grid`, { ... })
));
```
One POST request per year, all launched simultaneously.

**Step 3 — Route (`POST /batch/:batchId/manual-grid`, `routes:~400`):**
- Validates `financialYear` (integer), `accountName` (non-empty), `cells` (array)
- Coerces: `financialYear = parseInt(financialYear, 10)`, `accountId = parseInt(accountId)` (null if NaN), each `cell.periodMonth = parseInt(c.periodMonth)`, `cell.amount = parseFloat(c.amount)`
- Returns 403 if batch is finalized
- Calls `HistoricalComparativesService.saveManualGrid()`
- Returns `res.json({ saved: results.length, lines: results })`

**Step 4 — Service `saveManualGrid()` (`service:482`):**
1. `getBatch()` — finalization guard (1 query)
2. Postability guard for accountId (1 query)
3. Fetch all existing lines for this account+batch+year (1 query)
4. Build `existingMap` keyed by `${line.period_month}` (string key)
5. For each cell: determine `toUpdate` (has existing row) or `toInsert` (no existing row)
6. `if (toUpdate.length > 0)` → `supabase.upsert(toUpdate).select('id')` (1 DB call)
7. `if (toInsert.length > 0)` → `supabase.insert(toInsert).select('id')` (1 DB call)
8. Update batch `updated_at` (1 DB call)
9. Write audit log (1 DB call, never throws)
10. Return `savedLines`

**Step 5 — Frontend success/error:**
- Success: `showMsg('captureMsg', 'success', 'Saved ${cells.length} cells for ${acc.account_name}.')`
- Error: `showMsg('captureMsg', 'error', e.message)`

Note: `cells.length` is counted from the DOM BEFORE the API response. The server's `results.length` is never read.

---

### 4.2 "Save All" button

**Trigger:** `onclick="saveAllGrids()"` (`html:872`).

**Step 1:**  
`document.querySelectorAll('.account-grid-block')` — finds ALL grid blocks including those inside collapsed (display:none) groups.

**Step 2 — Sequential account loop:**
```javascript
for (const block of gridBlocks) {
  try {
    // read inputs from block, group by year, await Promise.all(...)
    saved++;
  } catch (e) {
    errors++;
  }
}
```
Each account is processed sequentially. Within each account, years are saved in parallel via `Promise.all`.

**Step 3:**  
If `errors > 0`: `showMsg('captureMsg', 'error', 'Saved ${saved}, failed ${errors}. Check console for details.')`  
If `errors === 0`: `showMsg('captureMsg', 'success', 'All ${saved} account grid(s) saved successfully.')`

---

### 4.3 Single-line save (manual-line route)

**Trigger:** `saveManualLine()` in the service, called by `POST /batch/:batchId/manual-line`.

Flow: finalization guard → postability guard → fetch existing line for (batch, account, year, month) → conditional update-by-id or insert → batch `updated_at` → audit log.

This is a five-step sequential operation with no transaction. Used for individual cell saves (not the grid UI — the grid UI only uses `manual-grid`).

---

## 5. Partial Save Analysis

### 5.1 CONFIRMED: toUpdate/toInsert split without transaction

**Location:** `saveManualGrid()`, lines 584–600.

```javascript
if (toUpdate.length > 0) {
  const { data, error } = await supabase
    .from('historical_comparative_lines')
    .upsert(toUpdate)          // ← commits immediately if successful
    .select('id');
  if (error) throw error;
  if (data) savedLines = savedLines.concat(data);
}

if (toInsert.length > 0) {
  const { data, error } = await supabase
    .from('historical_comparative_lines')
    .insert(toInsert)          // ← separate DB operation, no transaction
    .select('id');
  if (error) throw error;     // ← if this throws, toUpdate is already committed
  if (data) savedLines = savedLines.concat(data);
}
```

**Scenario that triggers partial save:**  
User saved 6 months of FY2022 previously. Now enters data for all 12 months and clicks Save.
- `toUpdate` = 6 existing months → upsert succeeds, committed to DB
- `toInsert` = 6 new months → insert fails (e.g. unique constraint on a concurrent save, network error, timeout)
- Service throws on `if (error) throw error`
- Frontend catch shows error message
- **Result:** 6 months saved, 6 months not saved. User sees an error but does not know which months are missing.

**Risk:** HIGH. This is the most likely root cause of the reported symptom.

---

### 5.2 CONFIRMED: Promise.all race in saveAccountGrid (multi-year)

**Location:** `saveAccountGrid()`, html:1273.

```javascript
await Promise.all(Object.entries(byYear).map(([year, yearCells]) =>
  api('POST', `/batch/${currentBatch.id}/manual-grid`, { ... financialYear: parseInt(year), ... })
));
```

**Scenario:**  
Batch covers FY2021, FY2022, FY2023. User saves one account grid.
- FY2021 request sent, completes (committed to DB)
- FY2022 request sent, fails after FY2021 completes
- `Promise.all` rejects immediately on FY2022 failure
- FY2023 request was already in-flight — it may or may not complete depending on network timing

**Result:** FY2021 is definitely saved. FY2023 is in an unknown state. FY2022 is missing. Frontend shows the error from FY2022 but cannot tell the user which years saved.

**Risk:** HIGH for multi-year batches.

---

### 5.3 CONFIRMED: Save All swallows account-level errors silently

**Location:** `saveAllGrids()`, html:1301.

```javascript
for (const block of gridBlocks) {
  try {
    ...
    await Promise.all(...);
    saved++;
  } catch (e) {
    errors++;   // ← 'e' is silently discarded. No console.error. No account name logged.
  }
}
```

**Problem:** When an account fails, the error is caught and discarded. The user sees "Saved 3, failed 2. Check console for details." — but nothing is written to the console (`console.error` is absent from the catch block). The user cannot identify which accounts failed, and cannot reproduce or diagnose the failure.

**Risk:** MEDIUM (the data risk is caused by the underlying partial save; this risk compounds it by hiding which accounts failed).

---

### 5.4 CONFIRMED: Success count unverified against server response

**Location:** `saveAccountGrid()`, html:1284.

```javascript
showMsg('captureMsg', 'success', `Saved ${cells.length} cells for ${acc.account_name}.`);
```

`cells.length` is computed from the DOM **before the API call**. The server returns `{ saved: results.length, lines: results }` but the frontend never reads `results.length`. If the server saved fewer cells than expected (e.g., insert partially failed before throwing), the success message is inaccurate.

**Risk:** MEDIUM. The message is misleading in failure-adjacent scenarios.

---

## 6. Transaction Safety Assessment

**Summary: No SQL transaction is used anywhere in the save path.**

| Operation | DB calls | Wrapped in transaction? | Consequence if mid-operation failure |
|-----------|----------|------------------------|--------------------------------------|
| `saveManualGrid()` — update path | 1 upsert | No | Safe — one operation |
| `saveManualGrid()` — insert path | 1 insert | No | Safe — one operation |
| `saveManualGrid()` — update + insert combined | 2 operations | **No** | **PARTIAL SAVE** — see §5.1 |
| `saveManualLine()` — update path | update + batch update + audit | No | update committed, batch update may fail |
| `saveManualLine()` — insert path | insert + batch update + audit | No | insert committed, batch update may fail |
| `finalizeBatch()` | lines update + batch update | **No** | **INCONSISTENT STATE** — see §14 |
| `rescaleBatchAmounts()` | upsert all lines + batch update | No | amounts updated, batch update may fail |

**Assessment:** The Supabase JS client does not support PostgreSQL transactions natively. The correct solution is to use the raw `pg` pool (already imported as `const db = require('../config/database')`) with `BEGIN`/`COMMIT`/`ROLLBACK` for multi-step writes.

The service already imports both:
```javascript
const { supabase } = require('../../../config/database');  // for simple table queries
const db = require('../config/database');                   // for heavy SQL (used in report queries)
```

The `db` pool supports `BEGIN`/`COMMIT`. Transactional writes are architecturally possible without new dependencies.

---

## 7. Frontend State Analysis

### 7.1 `lineDataMap` — stale after saves

**Location:** `renderCaptureMain()`, html:813.

```javascript
const lineDataMap = {};
for (const line of linesData) {
  if (!line.account_id) continue;
  if (!lineDataMap[line.account_id]) lineDataMap[line.account_id] = {};
  if (!lineDataMap[line.account_id][line.financial_year]) lineDataMap[line.account_id][line.financial_year] = {};
  lineDataMap[line.account_id][line.financial_year][line.period_month] = line.amount;
}
```

`lineDataMap` is built once from the server fetch on batch open. It is NOT updated after saves. This means:
- The initial grid render is correct.
- After a successful save, the DOM inputs contain the saved values (user can see them).
- The **totals row** (`<tfoot>`) is updated on blur by `updateGridTotal()` — so the running total is current.
- However, `lineDataMap` remains stale and would produce wrong initial values if `renderCaptureMain()` were called again without a fresh server fetch (e.g., a bug in re-render logic).
- COA sync (`syncCOA()`) calls `renderCaptureMain(currentBatch)` which re-fetches from server — `lineDataMap` is rebuilt fresh. Safe.

**Risk:** LOW for current save flows. Potential issue if any code path calls `renderCaptureMain()` with stale `currentBatch` data.

---

### 7.2 Dirty state tracking — absent

There is no dirty-state tracking in the frontend. Every cell in every grid is always treated as "to save" by both `saveAccountGrid()` and `saveAllGrids()`.

**Consequence:**
- If a user opens a batch with 84 accounts (7 accounts × 12 months), clicks "Save All" without changing anything, all 84 × N_years cells are re-sent to the server.
- Zero amounts are submitted and saved as 0.00 — even for cells the user never touched.
- This is not a bug per se (existing zeros are fine), but it creates unnecessary write volume and makes it harder to detect which cells were actually changed.
- A cell the user intends to leave blank is saved as 0.00. On next open it shows "0.00" rather than empty. This is cosmetically unexpected and could be confused with "a value exists here."

**Risk:** LOW (no data loss), MEDIUM (UX confusion and unnecessary writes).

---

### 7.3 `Promise.all()` behavior under partial failure

When `Promise.all([req1, req2, req3])` is called:
- All three requests are launched immediately (before any completes).
- If `req2` fails: `Promise.all` rejects with `req2`'s error.
- `req1` (if already completed): its result is committed in the DB — cannot be undone.
- `req3` (in-flight): the HTTP request was already sent. It may or may not complete depending on network timing. The response is ignored.

**For `saveAccountGrid()` with 3 years:** FY2021 committed, FY2022 failed, FY2023 in unknown state.

**For `saveAllGrids()` inner `Promise.all()` per account:** Same pattern. The outer `for...of` is sequential, so accounts don't race with each other — only the years within one account race.

---

### 7.4 Debounce — not applicable to saves

The 250ms debounce is only on the COA account search (`searchAccounts()`). Save operations are fully explicit (button click) with no debounce. No issue here.

---

### 7.5 Hidden rows (collapsed groups) — correctly handled

**This was explicitly thought through in the implementation:**

From `buildGroupedRows()` (`html:954`):
> "Children inside a collapsed group are still rendered in the DOM (display:none) so that saveAllGrids() and querySelectorAll('.account-grid-block') always find them."

`saveAllGrids()` uses `document.querySelectorAll('.account-grid-block')` which finds ALL grid blocks regardless of `display:none`. Reading input values from hidden elements works correctly in JavaScript. **This concern is safe.**

---

## 8. Key Mismatches and Type Safety

### 8.1 `existingMap` key construction

**Service:** `existingMap[`${line.period_month}`]` — string key built from the DB integer.  
**Lookup:** `existingMap[`${cell.periodMonth}`]` — string key built from the route-coerced integer.

Route coerces: `periodMonth: parseInt(c.periodMonth)`. Frontend sends integer from `SA_MONTHS` array. This is safe as long as `periodMonth` is always an integer (1–12). If any upstream source sends "1.0" or " 1", `parseInt` handles it correctly. **No mismatch risk.**

### 8.2 `account_id` type safety

Frontend sends `accountId: acc.account_id || null`. The `||` short-circuits on falsy values, meaning `account_id = 0` would be sent as `null` (safe — IDs are never 0 in practice).

Route coerces: `parseInt(accountId)` → NaN for empty string or `null` → falls back to `null`. Safe.

Service checks `if (accountId)` to switch between account_id query and name+code fallback. **No type mismatch.**

### 8.3 `parseCurrency()` — SA locale vs US locale

```javascript
function parseCurrency(str) {
  const normalized = String(str).replace(/\s/g, '').replace(',', '.');
  return parseFloat(normalized) || 0;
}
```

- SA format "2 073 662,00" → "2073662.00" → 2073662.00 ✓
- SA format "1 234,56" → "1234.56" → 1234.56 ✓
- US format "1,234.56" → "1.234.56" → `parseFloat("1.234.56")` → 1.234 ✗ (JS stops at second decimal point)

**Risk:** LOW in production (SA locale is the target). If an accountant pastes US-formatted numbers, they would be silently truncated. A value of "1,234.56" would be saved as 1.23, not 1234.56. No warning is shown.

The ×100 bug referenced in the `rescaleBatchAmounts()` comment was a prior incident; the `parseCurrency` function appears correct for SA locale inputs now.

### 8.4 Account name/code fallback path

For accounts without `account_id` (manually added via COA search before sync, or accounts where `account_id` was not resolved), the existing-line fetch falls back to:
```javascript
.eq('account_name', accountName)
.eq('account_code', accountCode || '')
```

**Risk:** If the account's name or code was changed in the COA since the original entry, the fallback query returns no rows, so all 12 months are treated as inserts. If those rows already exist in the DB under the old name, they remain as orphaned rows AND new rows are inserted — creating duplicates. See §9.3 for the duplicate-row double-counting risk.

---

## 9. Overwrite and Stale State Risks

### 9.1 COA sync — does NOT overwrite line amounts (safe)

`syncBatchAccountsFromCOA()` upserts into `historical_comparative_batch_accounts` (the account list table), not `historical_comparative_lines` (the amounts table). The upsert key is `(batch_id, account_id)` and only updates `synced_at`, `account_name`, `account_code` metadata.

**COA sync cannot overwrite entered amounts. Safe.**

### 9.2 Save All over already-saved data

`saveAllGrids()` reads the current DOM values (which reflect what the user entered or previously loaded). It sends all 12 months for each account. For months that already exist in the DB, the service does an UPDATE (via the upsert path). The update replaces the old amount with whatever is in the DOM.

If the user opened the batch, saw correct values, clicked "Save All" without changing anything, all values are re-saved with the same amounts. **No data loss in this scenario.**

However, if the user opened the batch and the initial values are wrong (stale, incorrect, or zero due to a rendering bug), "Save All" would overwrite correct DB data with incorrect DOM values.

### 9.3 Duplicate row risk for null-accountId accounts

**This is the most dangerous stale-state risk.**

Scenario:
1. User adds account manually (via COA search before COA sync). Account appears in grid with `account_id = 12`.
2. User saves. Rows are inserted with `account_id = 12`.
3. COA sync runs. Account gets an entry in `batch_accounts` table.
4. Next time batch opens, `lineDataMap` is built from `lines` which include rows with `account_id = 12`.
5. Grid renders correctly.

No duplicate here. This scenario is actually safe.

**Dangerous scenario:**
1. User adds account manually via direct search on a batch that has NO COA sync yet.
2. Search returns account with `account_id = 12`.
3. User saves. Rows inserted with `account_id = 12`.
4. User also manually types data for a second account that has NO `account_id` (somehow entered without using the search — e.g., a bug in `selectAccount()` or a manually rendered grid block with empty `data-account-id`).
5. Those rows are saved with `account_id = NULL`, falling back to `(account_name, account_code)` matching.
6. Later, COA sync runs. The account with NULL id may or may not get linked.

**Actual high-risk duplicate scenario** (if the DB does NOT have a unique constraint covering NULL account_ids):
- Same account saved twice (e.g., double-click Save, or Save then Save All)
- First save: SELECT returns 0 rows → all inserts
- Second save: SELECT returns the rows from first save → all updates → safe

Actually, since the SELECT is done before the writes, concurrent saves are the risk, not sequential ones. Sequential saves for the same account are safe because the second save's SELECT will see the first save's committed rows.

**True duplicate risk:** Two browser tabs open on the same batch simultaneously, both clicking Save for the same account at the same time. Both SELECTs return 0 rows (no existing data). Both try to INSERT. The second INSERT hits a unique constraint. This is the race condition.

---

## 10. Validation Failure Handling

### 10.1 Route-level validation

`POST /batch/:batchId/manual-grid` validates:
- `financialYear` — must parse to integer (400 if not)
- `accountName` — must be non-empty string (400 if not)
- `cells` — must be array (400 if not)
- Each cell: `periodMonth` must be 1–12 integer, `amount` must be parseable float

Returns `{ error: 'message' }` with HTTP 400 on validation failure.

### 10.2 Frontend error propagation from saveAccountGrid

```javascript
} catch (e) {
  showMsg('captureMsg', 'error', e.message);
}
```
The error message from the server is shown to the user. **Adequate for single-grid save.**

### 10.3 Frontend error suppression in saveAllGrids

```javascript
} catch (e) {
  errors++;
  // e is discarded — no console.error(), no e.message logged anywhere
}
```

**CRITICAL ISSUE:** The error is swallowed. The user is told "Saved N, failed M. Check console for details." but the console contains nothing. There is no way to determine which accounts failed or why. The accountant cannot diagnose or reproduce the issue from this output.

### 10.4 Non-JSON error responses

If the server returns a 502 or 504 (gateway error with HTML body), `api()` calls `res.json()` which throws a JSON parse error. The catch receives a JSON parse error, not the actual server error. The shown error message would be something like "Unexpected token '<'" rather than "Service unavailable." This is a minor UX issue but worth noting.

---

## 11. Success Messaging Accuracy

### 11.1 saveAccountGrid — cell count is pre-computed

```javascript
const cells = [];
SA_MONTHS.forEach(month => {
  years.forEach(year => {
    const input = tbl.querySelector(...)
    if (input) cells.push({ periodMonth: month, amount: parseCurrency(input.value), year });
  });
});
// ...
await Promise.all(...);  // ← API calls happen here
showMsg('captureMsg', 'success', `Saved ${cells.length} cells for ${acc.account_name}.`);
```

`cells.length` is computed before any API call. If the server returns 8 saved lines instead of 12 (e.g., partial save), the message still says "Saved 12 cells." **The success message is factually incorrect in partial-save scenarios.**

### 11.2 saveAllGrids — account count, not cell count

`saved++` is incremented after `await Promise.all(...)` resolves without throwing. This correctly counts accounts (not cells). The message "All 7 account grid(s) saved successfully" means 7 accounts completed without error — which is accurate at the account level but tells the user nothing about whether all cells within each account were saved.

### 11.3 No server-side count verification in either path

Neither save function reads the server's returned `{ saved: N, lines: [...] }` to verify the save count matches the submitted cell count. A discrepancy would be invisible to the user.

---

## 12. Network and API Flow

### 12.1 Request volume for Save All

For a batch with 30 accounts × 3 years = 90 POST requests in `saveAllGrids()`. Due to the sequential outer loop and parallel inner loop, requests fire as: [account1-FY21, account1-FY22, account1-FY23], then [account2-FY21, account2-FY22, account2-FY23], etc.

Peak simultaneous requests = (number of years in batch). For a 5-year batch: 5 simultaneous requests per account. Total for 30 accounts: 150 POST requests total, max 5 in-flight at once.

No rate limiting or retry logic exists. If the server is under load and some requests timeout, those accounts enter the `errors++` path silently.

### 12.2 `api()` fetch helper

```javascript
async function api(method, path, body) {
  const res = await fetch(BASE + path, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
```

Risk: `res.json()` is called before checking `res.ok`. If the server returns a 502 with HTML body, `res.json()` throws a JSON parse error. The `!res.ok` check is never reached. The catch receives a parse error, not the intended server error.

A safer pattern: check `res.ok` first, then conditionally parse JSON for the error body.

### 12.3 No retry logic

No retry on network failure. A transient timeout results in the data not being saved. Since there is no dirty-tracking, the user has no indication which data was not persisted (beyond the general error count in Save All).

---

## 13. Database Constraint Analysis

### 13.1 Unique constraint assumption

The save logic in `saveManualGrid()` assumes that `(batch_id, account_id, financial_year, period_month)` is a unique combination in `historical_comparative_lines`. This is implied by the code's SELECT-then-INSERT/UPDATE pattern.

**If this unique constraint exists in the DB:** A concurrent double-insert would fail with a unique constraint violation error, which is caught and surfaced as a 500 error. No silent duplicate. **Safe.**

**If this unique constraint is absent or only covers non-NULL account_id:** For rows with `account_id = NULL`, a double-insert could create duplicate rows. The report queries use `SUM(l.amount)`, which would double-count these rows. This would cause the monthly P&L report to show twice the actual values for affected accounts.

**The constraint covering the NULL account_id case cannot be confirmed from the application code alone.** The migration file for `historical_comparative_lines` must be inspected to verify.

### 13.2 `saveManualLine()` — conditional insert vs upsert

`saveManualLine()` does not use Supabase's native upsert with `onConflict`. Instead:
1. SELECT to find existing row
2. If found: UPDATE by `existingLine.id`
3. If not found: INSERT

This is safe for sequential calls. For concurrent calls (two browser tabs, same cell), both SELECTs may return no row, both attempt INSERT → unique constraint violation on the second.

This is the same race condition as §9.3.

---

## 14. Finalization Safety

### 14.1 Non-transactional finalization sequence

`finalizeBatch()` (`service:748`):

```javascript
// Step A — mark all lines
const { error: linesError } = await supabase
  .from('historical_comparative_lines')
  .update({ is_finalized: true, updated_at: now })
  .eq('batch_id', batchId)
  .eq('company_id', companyId);

if (linesError) throw linesError;

// Step B — mark the batch
const { data: finalizedBatch, error: batchError } = await supabase
  .from('historical_comparative_batches')
  .update({ status: 'finalized', finalized_at: now, finalized_by: ... })
  ...
```

Steps A and B are separate Supabase calls. If Step A succeeds but Step B fails (network interruption, Supabase timeout):
- All lines have `is_finalized = true`
- Batch still has `status = 'validated'`

**Inconsistent state A:** Lines appear finalized (individual line guard blocks edits of individual lines) but batch shows "validated" → the Finalize button may still appear active, and the batch would not appear in finalized-only reports. Data is protected from edits but invisible in reports.

If Step A fails and Step B is not reached:
- Lines are NOT finalized
- Batch is still "validated"
- No inconsistency — clean failure

The dangerous case is A succeeds + B fails, which leaves partially-finalized state with no UI indication.

### 14.2 No "save before finalize" guard

The UI does not check for unsaved changes before finalization. If the user edits cells, clicks Finalize (without clicking Save first), the confirm dialog says "Finalizing is PERMANENT" but does not mention "make sure you've saved your changes first."

**Scenario:** User edits March and April figures, clicks Finalize, confirms. The finalization commits the last SAVED values (possibly old), not the values currently in the DOM. The accountant believes the corrected March and April are in the finalized batch, but the old values are what was finalized.

**Risk:** HIGH for data accuracy. Silent data loss at the most critical lifecycle event (finalization is irreversible).

---

## 15. Reproduction Plan

### To reproduce the partial-save symptom (missing months after Save)

**Prerequisite:** Batch with at least one financial year configured. Some months for an account already saved (from a previous session).

1. Open batch. Load account grid.
2. Edit amounts for ALL 12 months (including months that already have values AND new months that are currently 0).
3. Simulate a network interruption mid-save: open browser DevTools → Network → throttle to "Offline" AFTER clicking Save (to allow the existing-rows fetch to complete, but block the insert request).
4. Click Save for the account grid.
5. The upsert for existing months may complete. The insert for new months will fail.
6. Remove throttle. Click Save again.
7. Check the DB: months that existed before the test should have updated values. The months that were new (insert path) may have wrong values or be missing.

### To reproduce the Success All / error suppression symptom

1. Open a batch with multiple accounts.
2. Temporarily break one account's data: edit `data-account-name` in DevTools to an empty string for one grid's inputs.
3. Click Save All.
4. Observe: the error count is shown but the console has no details. The user cannot identify which account failed.

### To reproduce the "unsaved changes finalized" symptom

1. Open a batch in validated status.
2. Edit several cells.
3. Click Finalize WITHOUT clicking Save first.
4. Confirm the finalization dialog.
5. Check DB: the saved values (from before step 2) are finalized, not the edited values from step 2.

---

## 16. Risk Register

| # | Risk | Severity | Likelihood | Root Cause | Manifestation |
|---|------|----------|-----------|------------|---------------|
| R1 | `toUpdate`/`toInsert` split — partial month save | HIGH | MEDIUM | No transaction; two DB ops | New months missing after partial-save scenario |
| R2 | `Promise.all()` for years — partial year save | HIGH | MEDIUM | No transaction; concurrent year requests | Some financial years saved, others missing |
| R3 | Unsaved changes finalized silently | HIGH | LOW-MEDIUM | No dirty-check before finalize | Wrong values permanently locked into finalized batch |
| R4 | Non-transactional finalization | HIGH | LOW | Two Supabase calls without BEGIN/COMMIT | Inconsistent lines-finalized vs batch-finalized state |
| R5 | Save All error suppression | MEDIUM | CERTAIN | `catch (e) { errors++ }` — `e` discarded | User cannot diagnose which accounts failed |
| R6 | Success count unverified vs server response | MEDIUM | LOW-MEDIUM | Client counts DOM cells, not server response | "Saved 12 cells" shown when fewer were actually saved |
| R7 | Duplicate rows for null-accountId accounts | MEDIUM | LOW | Race condition + possibly absent unique constraint | Report totals double-counted for affected accounts |
| R8 | No retry on network failure | LOW-MEDIUM | MEDIUM | No retry logic | Silent data loss on transient network errors |
| R9 | `parseCurrency()` US-format truncation | LOW | LOW | SA-only decimal handling | Pasted US numbers silently truncated |
| R10 | Non-JSON error response unhandled in api() | LOW | LOW | `res.json()` before `!res.ok` check | Parse error shown instead of server error message |

---

## 17. Fix Plan (SAFE FIXES — NOT YET IMPLEMENTED)

> **DO NOT implement any of these fixes until authorized. This section documents the recommended remediation path only.**

### Fix 1 — Wrap toUpdate + toInsert in a PostgreSQL transaction (REQUIRED)

**Target:** `saveManualGrid()` in `historicalComparativesService.js`

**Approach:**  
Replace the two Supabase client calls with a raw `db.query()` transaction:
```
BEGIN
  -- UPSERT all toUpdate rows (using INSERT ... ON CONFLICT DO UPDATE)
  -- INSERT all toInsert rows
COMMIT
```
Use a single `INSERT INTO historical_comparative_lines (...) VALUES ... ON CONFLICT (batch_id, account_id, financial_year, period_month) DO UPDATE SET amount = EXCLUDED.amount, ...` for all cells in one statement.

This eliminates the toUpdate/toInsert split entirely and makes the whole grid save atomic.

**Prerequisite:** Verify the unique constraint on `historical_comparative_lines` exists and covers the correct columns (including the NULL account_id fallback case — likely needs `(batch_id, account_name, account_code, financial_year, period_month)` for null-id rows).

---

### Fix 2 — Make finalization atomic (REQUIRED)

**Target:** `finalizeBatch()` in `historicalComparativesService.js`

**Approach:**  
Use a `db.query()` transaction with `BEGIN`/`COMMIT`:
```sql
BEGIN;
UPDATE historical_comparative_lines SET is_finalized = true, updated_at = $now WHERE batch_id = $batchId AND company_id = $companyId;
UPDATE historical_comparative_batches SET status = 'finalized', finalized_at = $now, finalized_by = $userId, updated_at = $now WHERE id = $batchId AND company_id = $companyId;
COMMIT;
```
Both updates succeed together or both fail together.

---

### Fix 3 — Unsaved changes check before finalization (REQUIRED)

**Target:** `finalizeBatch()` in `historical-comparatives.html`

**Approach:**  
Before calling the finalize API, check if any `.amount-cell` input has been modified since the last save. Options:
- Track a `isDirty` flag set on any `oninput` event, cleared after each successful save.
- On finalize click, compare current DOM values against `currentLines` (the last loaded server state).

If dirty: show blocking confirmation: "You have unsaved changes. Save your data before finalizing, or your edits will be lost. [Save Now] [Cancel]". Do not offer "Finalize Anyway" — the data integrity risk is too high.

---

### Fix 4 — Log errors in saveAllGrids (REQUIRED — quick fix)

**Target:** `saveAllGrids()` in `historical-comparatives.html`

**Approach:**  
```javascript
} catch (e) {
  errors++;
  const accountName = inputs.length > 0 ? inputs[0].dataset.accountName : '(unknown)';
  console.error(`[SaveAllGrids] Failed to save account "${accountName}":`, e);
  failedAccounts.push(accountName);
}
```
After the loop, show the error message with the list of failed account names.

---

### Fix 5 — Verify server-returned save count (RECOMMENDED)

**Target:** `saveAccountGrid()` in `historical-comparatives.html`

**Approach:**  
After `await Promise.all(...)`, sum `results[year].saved` for all years. If `serverSaved < cells.length`, show a warning: "Save completed with partial results: expected N cells, server confirmed M. Some data may not have saved — please verify and retry."

---

### Fix 6 — Sequential year saves instead of Promise.all (RECOMMENDED)

**Target:** Both `saveAccountGrid()` and `saveAllGrids()` in `historical-comparatives.html`

**Approach:**  
Replace `Promise.all(yearEntries.map(...))` with a sequential `for...of` loop. This ensures a year-2 failure is reported before year-3 is attempted, and the user can identify which year failed. Trade-off: slightly slower for multi-year batches.

Alternative: keep `Promise.all` but switch to Fix 1 (transactional server-side save) which makes each year's save atomic. If year 2 fails, the user retries only year 2.

---

### Fix 7 — Validate DB unique constraint for null-accountId rows (REQUIRED — DB audit)

**Target:** Migration file for `historical_comparative_lines`

**Action (no code change — DB audit):**  
Confirm whether the table has:
```sql
UNIQUE (batch_id, account_id, financial_year, period_month)
```
and whether it correctly handles NULL `account_id` rows (SQL NULL != NULL means this constraint won't prevent two rows with account_id=NULL, same batch, year, month).

If null-account rows are possible, a partial unique index may be needed:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lines_null_account
  ON historical_comparative_lines (batch_id, account_name, account_code, financial_year, period_month)
  WHERE account_id IS NULL;
```

---

### Fix 8 — Harden `api()` error handling (MINOR)

**Target:** `api()` function in `historical-comparatives.html`

**Approach:**  
```javascript
async function api(method, path, body) {
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      errMsg = json.error || errMsg;
    } catch (_) { /* non-JSON error body */ }
    throw new Error(errMsg);
  }
  return res.json();
}
```

---

## 18. Appendix — Relevant Code Excerpts

### A. toUpdate/toInsert split (save-integrity risk)
**File:** `historicalComparativesService.js:584–600`
```javascript
if (toUpdate.length > 0) {
  const { data, error } = await supabase
    .from('historical_comparative_lines')
    .upsert(toUpdate)
    .select('id');
  if (error) throw error;
  if (data) savedLines = savedLines.concat(data);
}

if (toInsert.length > 0) {
  const { data, error } = await supabase
    .from('historical_comparative_lines')
    .insert(toInsert)
    .select('id');
  if (error) throw error;   // ← updates already committed if this throws
  if (data) savedLines = savedLines.concat(data);
}
```

### B. Promise.all for years (partial-year risk)
**File:** `historical-comparatives.html:1273`
```javascript
await Promise.all(Object.entries(byYear).map(([year, yearCells]) =>
  api('POST', `/batch/${currentBatch.id}/manual-grid`, {
    accountId: acc.account_id || null,
    financialYear: parseInt(year),
    cells: yearCells,
  })
));
showMsg('captureMsg', 'success', `Saved ${cells.length} cells for ${acc.account_name}.`);
```

### C. Silent error swallow in saveAllGrids
**File:** `historical-comparatives.html:1301–1333`
```javascript
for (const block of gridBlocks) {
  try {
    ...
    await Promise.all(Object.entries(byYear).map(...));
    saved++;
  } catch (e) {
    errors++;   // ← e.message never logged, account name not captured
  }
}
if (errors) {
  showMsg('captureMsg', 'error',
    `Saved ${saved}, failed ${errors}. Check console for details.`);
  // nothing was written to the console
}
```

### D. Finalization — non-transactional (two separate calls)
**File:** `historicalComparativesService.js:758–784`
```javascript
const { error: linesError } = await supabase
  .from('historical_comparative_lines')
  .update({ is_finalized: true, updated_at: now })
  .eq('batch_id', batchId).eq('company_id', companyId);

if (linesError) throw linesError;   // ← if this throws, batch not yet marked

const { data: finalizedBatch, error: batchError } = await supabase
  .from('historical_comparative_batches')
  .update({ status: 'finalized', finalized_at: now, ... })
  .eq('id', batchId).eq('company_id', companyId)
  .select().single();

if (batchError) throw batchError;   // ← lines finalized, batch not finalized if this throws
```

### E. No dirty-state check before finalize
**File:** `historical-comparatives.html:1363`
```javascript
async function finalizeBatch() {
  if (!currentBatch) return;
  if (currentBatch.status !== 'validated') { ... return; }
  if (!confirm('Finalizing is PERMANENT...')) return;
  // No check for unsaved DOM changes
  showMsg('captureMsg', 'info', 'Finalizing…');
  await api('POST', `/batch/${currentBatch.id}/finalize`, {});
  ...
}
```

---

*Audit complete. Fix Pack 01 implemented 2026-05-24. See Section 19 for implementation record.*

---

## 19. Fix Pack 01 — Implementation Record

**Implemented:** 2026-05-24  
**Scope:** Save integrity hardening — all vectors confirmed in audit.  
**Full report:** `docs/accounting/HISTORICAL_COMPARATIVES_SAVE_INTEGRITY_FIX_PACK_01_REPORT.md`

### Audit finding → implementation mapping

| Audit finding | Fix Pack 01 action | Status |
|---|---|---|
| R1 — `toUpdate`/`toInsert` split without transaction | `saveManualGrid()` rewritten as single pg `BEGIN`/`COMMIT` transaction | FIXED |
| R2 — `Promise.all()` parallel year saves | `saveAccountGrid()` and `saveAllGrids()` converted to sequential `for...of` | FIXED |
| R3 — Unsaved changes finalized silently | `historicalDirty` flag + blocking error check in frontend `finalizeBatch()` | FIXED |
| R4 — Non-transactional finalization | `finalizeBatch()` rewritten as pg transaction with `SELECT FOR UPDATE` TOCTOU guard | FIXED |
| R5 — Save All silently swallows errors | `console.error()` + named `failedItems[]` per account+year reported to user | FIXED |
| R6 — Success count unverified vs server | `result.saved` compared to `yearCells.length`; mismatch shown as warning | FIXED |
| R7 — Duplicate rows for null-accountId (race) | Migration 049: unique expression index on `(batch_id, COALESCE(account_code,''), account_name, financial_year, period_month) WHERE account_id IS NULL`; null-account path uses `SELECT FOR UPDATE` lock | FIXED |
| R10 — Non-JSON error response in `api()` | `api()` hardened: `res.ok` checked before `res.json()`, JSON parse failure falls back to `HTTP <status>` | FIXED |
| Empty batch finalization | Backend 422 guard: `COUNT(*) = 0` check inside transaction before finalizing | FIXED (new — not in original audit) |
| Audit log constraint missing GRID_SAVED | Migration 049: drop + recreate `hcal_action_chk` with all required actions | FIXED (new — discovered in audit) |
| Double-save race (Save All button) | `isSaving` flag + `btnSaveAll` disabled during save | FIXED |

### Not addressed by Fix Pack 01

| Audit finding | Reason not addressed |
|---|---|
| R8 — No retry on network failure | Out of Fix Pack 01 scope; tracked as follow-up |
| R9 — `parseCurrency()` US-format truncation | Low risk, out of scope; considered acceptable for SA locale target |
| §8.4 — Name/code change orphan rows | Would require COA linkage redesign; out of scope |
| §9.2 — Save All over wrong DOM values | User-training concern, not a code bug |
