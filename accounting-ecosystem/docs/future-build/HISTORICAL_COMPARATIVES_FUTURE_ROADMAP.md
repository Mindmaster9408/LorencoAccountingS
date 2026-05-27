# Historical Comparatives — Future Roadmap

**Date:** 2026-05-27  
**Module:** Historical Comparatives (`historicalComparativesService.js`, `historical-comparatives.html`)  
**Fix Pack 01 status:** COMPLETE ✅  
**Source:** `docs/accounting/HISTORICAL_SAVE_INTEGRITY_IMPLEMENTATION_PLAN.md` (Sections 3, 7, 8, 12)

---

## Overview

Fix Pack 01 closed the four HIGH-severity partial-save and finalization risks. This document tracks the remaining medium- and low-priority improvements organised into work phases. Nothing in this document is urgently blocking — the module is safe to use for pilot.

Items are listed with the file(s) they affect, the risk they address, and the estimated complexity. "Complexity" is a rough estimate of implementation effort: LOW (< 1 hour), MEDIUM (1–4 hours), HIGH (> 4 hours).

---

## Phase 3 — Before General Release

These items should be addressed before the module is opened to all users (not just pilot users). None are data-integrity regressions; all are improvements to atomicity, observability, or UX.

---

### PH3-01 — Wrap `saveManualLine()` in a pg transaction

**File:** `backend/modules/accounting/services/historicalComparativesService.js`  
**Risk addressed:** R10 — `saveManualLine()` currently writes the line row (Supabase) then updates `batch.updated_at` (second Supabase call). If the second call fails, the batch timestamp is stale.  
**Data integrity impact:** NONE — only the `updated_at` display field is affected. Financial values are correct.  
**Complexity:** LOW  

**Implementation notes:**
- Replace the two Supabase calls with a single pg transaction: INSERT or UPDATE the line, then UPDATE batch.updated_at in the same BEGIN/COMMIT block.
- Follow the same `db.getClient()` / `try { BEGIN...COMMIT } catch { ROLLBACK } finally { release() }` pattern as `saveManualGrid()`.
- `_writeAuditLog()` stays outside the transaction.

---

### PH3-02 — Wrap `rescaleBatchAmounts()` in a pg transaction

**File:** `backend/modules/accounting/services/historicalComparativesService.js`  
**Risk addressed:** R11 — `rescaleBatchAmounts()` upserts all rescaled amounts (Supabase), then updates `batch.updated_at` (second Supabase call). Additionally, a Supabase `upsert` for 50 rows may partially commit if the connection drops mid-way.  
**Data integrity impact:** LOW-MEDIUM — rescale is a recovery tool used rarely (to fix the ×100 parseCurrency bug). A partial rescale would leave some amounts at the old scale and some at the new scale.  
**Complexity:** MEDIUM  

**Implementation notes:**
- Fetch all line IDs and rescaled amounts.
- Build a single pg transaction: UPDATE each line with the new amount, UPDATE batch.updated_at.
- A single `UPDATE SET amount = CASE WHEN id = $n THEN $val ... END WHERE id IN (...)` or individual parameterized UPDATEs in a loop are both acceptable; the pg transaction ensures atomicity regardless.
- Consider adding `SELECT ... FOR UPDATE` on all target lines before writing to prevent concurrent rescale interference.

---

### PH3-03 — Visual "unsaved changes" banner

**File:** `frontend-accounting/historical-comparatives.html`  
**Risk addressed:** UX gap from Section 7.6 of implementation plan — `historicalDirty = true` blocks finalization, but there is no visible indicator that the grid is dirty. An accountant may not remember they made edits.  
**Complexity:** LOW  

**Implementation notes:**
- Add a warning `<div id="unsavedChangesBanner">` above the Save All button.
- Toggle its visibility with CSS based on `historicalDirty`.
- Banner text: "You have unsaved changes — click Save All before finalizing."
- Show when `historicalDirty` becomes true (on any `oninput`); hide when `historicalDirty` becomes false (on successful save).
- Example toggle:
  ```javascript
  function updateDirtyBanner() {
    const banner = document.getElementById('unsavedChangesBanner');
    if (banner) banner.style.display = historicalDirty ? 'block' : 'none';
  }
  // Call updateDirtyBanner() wherever historicalDirty is set or cleared.
  ```

---

### PH3-04 — Add `BATCH_RESCALED` to audit log constraint in a migration 050

**File:** `database/migrations/` (new file `050_historical_audit_log_rescaled.sql`)  
**Risk addressed:** `rescaleBatchAmounts()` emits `BATCH_RESCALED` audit records. Migration 049 added `BATCH_RESCALED` to the constraint — wait, checking migration 049 — yes, `BATCH_RESCALED` is included in migration 049's `hcal_action_chk` definition. This item can be closed.  
**Status:** ✅ Already resolved in migration 049.

---

## Phase 4 — Post-Pilot Improvements

These items improve resilience and UX but have no bearing on data integrity. Schedule after pilot feedback is collected.

---

### PH4-01 — Retry logic on transient network failure (R8)

**File:** `frontend-accounting/historical-comparatives.html`  
**Risk addressed:** A transient 5xx or network timeout on Save means the data is not saved. The user currently must retry manually.  
**Complexity:** MEDIUM  

**Implementation notes:**
- On `catch(e)` in `saveAccountGrid()` or `saveAllGrids()` year loop: if `e.message` starts with `HTTP 5` or includes `fetch`, retry once after a 2-second delay.
- Show "Retrying…" in the message area during the retry.
- If the retry also fails, surface the final error normally.
- Do not retry on 4xx responses — these are application errors (e.g., 403 permission, 422 empty batch) that retry will not fix.

---

### PH4-02 — `parseCurrency()` US-format detection (R9)

**File:** `frontend-accounting/historical-comparatives.html`  
**Risk addressed:** `parseCurrency()` strips all non-digit and non-period characters before parsing. A US-formatted value like `1,200.50` is correctly parsed to `1200.50`. However, a value like `1.200,50` (European notation used in SA) strips the dot, giving `120050` — 100× too large.  
**Complexity:** LOW  

**Implementation notes:**
- Before the strip, detect if the input looks like SA decimal format: last separator is a comma (e.g. `1 200,50` or `1.200,50`).
- If detected, replace the comma with a period and remove dots before it.
- Warn the user if the parsed result is > 1 000 000 and the input contained a comma — this may indicate a format misdetection.

---

### PH4-03 — "Save All and Finalize" single-action button

**File:** `frontend-accounting/historical-comparatives.html`  
**Risk addressed:** UX — reduces the chance of an accountant forgetting to save before finalizing. Currently: Save All → check for errors → click Validate → click Finalize → confirm dialog = 4 steps.  
**Complexity:** LOW  

**Implementation notes:**
- Add a button "Save & Finalize" next to the existing Finalize button (visible only when batch is `validated`).
- On click: run `saveAllGrids()`, check `failedItems.length === 0`, then run `validateBatch()` if needed, then run `finalizeBatch()`.
- Show a single status message: "Saving… Validating… Finalizing…" with progress.
- Abort at any failure; the existing individual buttons remain available.

---

### PH4-04 — Cell-level dirty indicator

**File:** `frontend-accounting/historical-comparatives.html`  
**Risk addressed:** UX — no visual indication of which specific cells have been edited but not saved.  
**Complexity:** LOW  

**Implementation notes:**
- On `oninput`, add CSS class `cell-dirty` to the target input.
- Remove `cell-dirty` from all cells within a grid block after that grid's save succeeds.
- CSS: `input.cell-dirty { background-color: #fffbeb; border-color: #f59e0b; }`
- This gives cell-level "unsaved" feedback without interfering with any existing behaviour.

---

## Architectural Guardrails

These are permanent rules that must not be violated by any future change to this module. They are recorded here for maintainers.

### Rule HC-1 — Historical comparatives NEVER write to live financial tables

This module is strictly a historical data capture store. It must never write to:
- `journals` or `journal_lines`
- `bank_transactions` or `bank_statement_lines`
- `vat_returns` or any VAT table
- `accounts` (read-only lookups only)
- Any payroll table

Violations of this rule make historical comparatives part of the live audit trail, which breaks the module's read-only reporting contract.

### Rule HC-2 — Finalized batches are permanently immutable

`status = 'finalized'` and `is_finalized = true` on lines are the source of truth. There is no un-finalize endpoint. A correction requires creating a new batch and archiving the incorrect one. Future development of an archive/correction flow must preserve this immutability — the correction flow must create a new batch, never modify a finalized one.

### Rule HC-3 — company_id must appear in every pg pool query

The pg pool bypasses Postgres RLS. Every `client.query()` call must include `AND company_id = $N` in its WHERE clause. This is the sole cross-tenant isolation mechanism for pg pool queries. Code review must enforce this.

### Rule HC-4 — Audit log writes go outside transactions

`_writeAuditLog()` is called after `COMMIT`, never inside a transaction. If the audit log is inside the transaction: a slow audit write holds the row lock longer; and if the audit log fails (e.g., constraint violation), the whole transaction rolls back — losing the committed data. The audit log must never be able to roll back committed financial data.

### Rule HC-5 — `original_amount`, `entered_by`, `entered_at` are immutable after first capture

In the upsert SQL for `saveManualGrid()` account_id path, these three columns must never appear in the `DO UPDATE SET` clause. They are set only on INSERT (first capture). Future changes to the upsert SQL must preserve this exclusion.

---

## Open Questions for Ruan

1. **Migration 049 production deployment** — Has migration 049 been applied to the production Supabase project? If not, this is the single most important pending action. The null-account concurrent-save race condition (R7) is not fully mitigated until the index exists.

2. **Null-account rows in production** — Are there any batches in production that contain freetext accounts (entered without COA sync, `account_id IS NULL`)? If yes, run the duplicate-detection query from migration 049's header comment before applying the migration.

3. **Phase 3 priority** — Is PH3-03 (visual dirty banner) required before general release, or is the existing blocking error on Finalize sufficient for the first production rollout?

4. **Archive flow** — Should a future "archive incorrect batch" flow be scoped as part of general release, or is "create a new batch for corrections" acceptable as the permanent correction model?

5. **saveManualLine atomicity (PH3-01)** — Is the batch `updated_at` timestamp important enough for the single-cell save path to warrant wrapping in a pg transaction? Risk is only stale display, not corrupted data.
