# PAYE Reconciliation Audit Report
**Date:** 2026-04-22
**Scope:** Lorenco Ecosystem → Paytime → Finalized Payroll → PAYE Reconciliation
**Status:** AUDIT COMPLETE — No code changed

---

## TABLE OF CONTENTS

1. [Audit Summary](#1-audit-summary)
2. [Finalization Flow Map](#2-finalization-flow-map)
3. [Reconciliation Flow Map](#3-reconciliation-flow-map)
4. [Confirmed Issues](#4-confirmed-issues)
5. [Safe Implementation Plan (No Code Yet)](#5-safe-implementation-plan-no-code-yet)
6. [Files and Tables Involved](#6-files-and-tables-involved)
7. [Risks and Notes](#7-risks-and-notes)
8. [Chain Map — Confirmed Break Point](#8-chain-map--confirmed-break-point)

---

## 1. AUDIT SUMMARY

### Current Finalization Behavior

`POST /api/payroll/run` calculates and stores snapshots in **`payroll_snapshots`** (status `draft`, `is_locked = false`). `POST /api/payroll/finalize` locks those snapshots in place (`status = 'finalized'`, `is_locked = true`) and marks `payroll_runs.status = 'finalized'`. That is the complete write path. No other tables are touched.

### Current Reconciliation Source Behavior

`GET /api/payroll/recon/summary` reads from two sources only:
1. **`payroll_transactions`** — via `period_id` join to `payroll_periods`
2. **`payroll_historical`** — for imported CSV data

It **never reads from `payroll_snapshots`**.

### Likely Break Point — Confirmed

**Finalization writes to `payroll_snapshots`. Reconciliation reads from `payroll_transactions`. Nothing in the entire codebase moves data from `payroll_snapshots` to `payroll_transactions` at finalization time. These two tables are completely disconnected.**

This is not a filter problem, not a status field problem, and not a UI rendering problem. It is a structural storage path mismatch between the two systems.

---

## 2. FINALIZATION FLOW MAP

### What happens step by step when Finalize is pressed

```
User clicks "Finalize Payroll" button (payroll-execution.html)
  → confirmFinalize()
    → PayrollAPI.finalize(runId, periodKey)
      → POST /api/payroll/finalize
        → verifies payroll_run exists for company + period + run_id
        → calls PayrollHistoryService.lockSnapshotsForPeriod()
            → UPDATE payroll_snapshots
               SET status = 'finalized',
                   is_locked = true,
                   finalized_by = userId,
                   finalized_at = now
               WHERE company_id = X
                 AND period_key = 'YYYY-MM'
                 AND payroll_run_id = runId
                 AND is_locked = false
        → calls PayrollHistoryService.finalizePayrollRun()
            → UPDATE payroll_runs
               SET status = 'finalized',
                   finalized_by = userId,
                   finalized_at = now
               WHERE id = runId
        → returns { success, run_id, period_key, locked_count, timestamp }
```

### Tables written during finalization

| Table | Write Type | Fields Updated |
|---|---|---|
| `payroll_snapshots` | UPDATE | `status`, `is_locked`, `finalized_by`, `finalized_at` |
| `payroll_runs` | UPDATE | `status`, `finalized_by`, `finalized_at` |
| `payroll_transactions` | **NOTHING** | — not touched |
| `payroll_historical` | **NOTHING** | — not touched |

### Fields present in `payroll_snapshots.calculation_output` JSONB

`gross`, `taxableGross`, `paye`, `paye_base`, `uif`, `sdl`, `net`, `deductions`, `medicalCredit`, `voluntary_overdeduction`, `negativeNetPay`, `overtimeAmount`, `shortTimeAmount` — all confirmed as top-level keys in `calculation_output`. All the data reconciliation needs is already stored there.

---

## 3. RECONCILIATION FLOW MAP

### What `GET /api/payroll/recon/summary` reads

```
1. Query payroll_periods for the tax year date range
   → gets period_id list for the company

2. Query payroll_transactions
   → WHERE company_id = X
     AND period_id IN (period_id_list)
   → SELECT: gross_income, taxable_income, paye, uif_employee, sdl, net_pay
   → RESULT: empty (no data exists there from new payroll system)

3. Query payroll_historical
   → WHERE company_id = X AND period_key IN (periods)
   → SELECT: gross, paye, uif, net
   → RESULT: only CSV-imported historical data, not live payroll runs

4. Merge both → build per-period, per-employee map
   → If payroll_transactions is empty → only historical import data shows

5. Return { taxYear, periods, totals, employees, annualTotals }
   → All totals are 0 for periods run via new payroll system
```

### Frontend behavior when summary returns all zeros

```
apiGet('/payroll/recon/summary?taxYear=...')
  → data.totals exists (but all zeros) → "backend returned data" branch entered
  → payrollTotals = data.totals  (all zeros)
  → localStorage merge: for each period where gross === 0, try localStorage
      → ReconService.buildPayrollTotals() → PayrollEngine.getHistoricalRecord()
          → reads localStorage['emp_historical_{companyId}_{empId}_{period}']
          → new payroll system NEVER writes these keys
          → result: also empty
  → Final: all zeros displayed
```

### How `filteredPeriods` is derived (critical secondary issue)

```
allPeriods = PayrollEngine.getHistoricalPeriods(currentCompanyId)
  → scans localStorage for keys matching 'emp_historical_{companyId}_*'
  → new payroll system has NEVER written these keys
  → allPeriods = []  (empty for companies using new system only)

filteredPeriods = ReconService.getPeriodsForTaxYear(allPeriods, currentTaxYear)
  → = []  (derived from empty allPeriods)

renderCalcTable() iterates filteredPeriods
  → zero columns rendered
  → table appears blank even if backend returned data
```

---

## 4. CONFIRMED ISSUES

### Issue 1 — PRIMARY BREAK: Storage path mismatch

**Confirmed.**

The batch payroll run system (`/api/payroll/run` + `/api/payroll/finalize`) stores finalized payroll exclusively in `payroll_snapshots`. The reconciliation system (`/api/payroll/recon/summary`) reads exclusively from `payroll_transactions`. There is **zero overlap** between these two tables in the current implementation. This is the root cause of all reconciliation failures for live payroll runs.

- **Location:** `backend/modules/payroll/services/PayrollHistoryService.js` — `lockSnapshotsForPeriod()` and `finalizePayrollRun()` — neither function writes to `payroll_transactions`.
- **Location:** `backend/modules/payroll/routes/recon.js` — `GET /summary` — never queries `payroll_snapshots`.

---

### Issue 2 — SECONDARY BREAK: Field name mismatch in `payroll_transactions`

**Confirmed** (affects old-path data, if any exists).

Even if `payroll_transactions` had manually-created rows (from the legacy `POST /api/payroll/transactions` route), `recon.js` would still misread them:

| `recon.js` queries for | `payroll_transactions` column name | Match? |
|---|---|---|
| `gross_income` | `gross_pay` / `total_earnings` | ❌ |
| `taxable_income` | (no such column) | ❌ |
| `paye` | `paye_tax` | ❌ |
| `uif_employee` | `uif_employee` | ✓ |
| `sdl` | (no such column in legacy table) | ❌ |
| `net_pay` | `net_pay` | ✓ |

This means even for legacy manually-posted transactions, `gross_income`, `paye`, `sdl`, and `taxable_income` would return `null` from Supabase column select, not an error — they silently zero out.

---

### Issue 3 — TERTIARY BREAK: `filteredPeriods` is localStorage-derived

**Confirmed.**

The period columns shown in the reconciliation table are derived from `PayrollEngine.getHistoricalPeriods()` which scans localStorage for `emp_historical_*` keys. The backend payroll run system never writes to localStorage. For any company running payroll exclusively through the new `/api/payroll/run` system, `allPeriods` is empty, `filteredPeriods` is empty, and the reconciliation table renders no columns at all — even if the backend returns correct `data.totals` keyed by period.

**Location:** `frontend-payroll/paye-reconciliation.html` (around line 596)
```javascript
allPeriods = PayrollEngine.getHistoricalPeriods ? PayrollEngine.getHistoricalPeriods(currentCompanyId) : [];
filteredPeriods = ReconService.getPeriodsForTaxYear(allPeriods, currentTaxYear);
```

---

### Issue 4 — Tax year selector misses `payroll_snapshots`

**Confirmed.**

`GET /api/payroll/recon/tax-years` reads from `payroll_transactions` (via period join) and `payroll_historical`. It does not read from `payroll_snapshots`. For a company with no `payroll_transactions` data and no `payroll_historical` imports, the dropdown would show only the auto-injected current tax year — not historical finalized periods.

**Location:** `backend/modules/payroll/routes/recon.js` (around line 75)

---

### Issue 5 — localStorage fallback cannot rescue new payroll data

**Confirmed.**

`ReconService.buildPayrollTotals()` calls `PayrollEngine.getHistoricalRecord(companyId, empId, period)` which reads `localStorage['emp_historical_{companyId}_{empId}_{period}']`. The new payroll system (`/api/payroll/run`, `/api/payroll/finalize`) never writes to these localStorage keys. The fallback path provides no safety net for new payroll runs.

---

### Issue 6 — Frontend merge logic doesn't fall back correctly

**Confirmed** (compound with Issues 1 and 3).

When the API returns `data.totals` with all-zero values, the condition `if (data && data.totals)` is `true` and the `else` branch (full localStorage fallback) is never reached. The frontend enters the "backend returned data" path, merges localStorage (which is also empty), and renders zeros. The fallback `catch` path is also never reached since the API call itself succeeds (200 OK, valid JSON, just empty data).

---

### Issue 7 — No `sdl` column in legacy `payroll_transactions`

**Confirmed.**

The `POST /api/payroll/transactions` route in `transactions.js` inserts `uif_employer`, `uif_employee`, `paye_tax` but has no `sdl` field. The recon query's `.select('...sdl...')` would return `null` for any legacy row, causing SDL totals to always show as zero even if that path was used.

---

## 5. SAFE IMPLEMENTATION PLAN (NO CODE YET)

### Preferred Source of Truth

**`payroll_snapshots`** is the authoritative source for all finalized payroll data. It contains the complete, immutable `calculation_output` JSONB with all required fields (`gross`, `paye`, `uif`, `sdl`, `net`, `taxableGross`). The `is_locked = true` flag identifies finalized records unambiguously. The `period_key` column (`YYYY-MM`) is stored directly (no join required for period identification).

---

### What must be fixed — in priority order

#### Fix A — `recon.js /summary` must read from `payroll_snapshots` (PRIMARY FIX)

Replace (or augment) the `payroll_transactions` query in `GET /api/payroll/recon/summary` with a query against `payroll_snapshots`:
- Filter: `is_locked = true` (or `status = 'finalized'`) + `company_id = X` + `period_key IN (periods)`
- Extract from `calculation_output` JSONB: `gross`, `paye`, `uif`, `sdl`, `net`
- Join with `employees` table using `employee_id` for names
- Keep `payroll_historical` merge unchanged (still needed for imported data)
- The `payroll_transactions` query can remain as a legacy compatibility layer OR be removed if no data exists there

This single change fixes Issues 1, 2, and 7.

#### Fix B — `recon.js /tax-years` must include `payroll_snapshots`

Add a query to `GET /api/payroll/recon/tax-years` that collects distinct `period_key` values from `payroll_snapshots` where `is_locked = true` and `company_id = X`.

This fixes Issue 4.

#### Fix C — Frontend `filteredPeriods` must come from backend, not localStorage

The `filteredPeriods` array used to drive period columns in the reconciliation table must come from `data.periods` returned by the backend API (already returned in the response), NOT from `PayrollEngine.getHistoricalPeriods()` (localStorage scan).

When the API returns `data.periods`, use that directly. Fall back to localStorage-derived periods only if the API is unavailable entirely (the `catch` path).

This fixes Issue 3.

#### Fix D — Frontend `allPeriods` for tax year selector

When the API returns `data.taxYears`, those should be used to override (not merge with) the localStorage-derived tax years list. The current code does this correctly (`var taxYears = data.taxYears || localTaxYears`) — so this path is fine once Fix B provides correct data.

#### Fix E — Deprecation note for `payroll_transactions` recon path

The `payroll_transactions` read path in `recon.js` was built expecting a column schema that doesn't match what `transactions.js` actually writes. Once Fix A is in, evaluate whether `payroll_transactions` should be cleaned up or left as a legacy fallback with corrected field names.

---

### Safest Implementation Direction

1. **Do not delete `payroll_transactions`** — it may contain legacy data or be used elsewhere
2. **Do not change `payroll_snapshots` schema** — the data needed is already there in `calculation_output` JSONB
3. **Do not change the finalization flow** — it correctly produces immutable locked snapshots
4. **Make `recon.js` the adapter layer** — it should be the single point that knows how to aggregate from `payroll_snapshots` into the reconciliation format
5. **No localStorage writes from backend** — the backend should never write to frontend localStorage keys
6. **Prefer full-row select + Node.js extraction** — select full `payroll_snapshots` rows and extract `calculation_output` fields in Node.js. Supabase PostgREST does not support JSONB field aggregation directly in `.select()`. A DB function/view would be cleaner at scale but adds complexity. Full-row extraction is safe and correct for initial implementation.

---

## 6. FILES AND TABLES INVOLVED

### Backend files

| File | Role | Issue |
|---|---|---|
| `backend/modules/payroll/routes/recon.js` | Reconciliation aggregation | Reads `payroll_transactions` instead of `payroll_snapshots` — **primary fix target** |
| `backend/modules/payroll/routes/payruns.js` | Run + finalize | Correct — writes to `payroll_snapshots` — no change needed |
| `backend/modules/payroll/services/PayrollHistoryService.js` | Snapshot management | Correct — data is complete — no change needed |
| `backend/modules/payroll/routes/transactions.js` | Legacy individual payslip | Field name mismatch with recon — secondary concern |

### Frontend files

| File | Role | Issue |
|---|---|---|
| `frontend-payroll/paye-reconciliation.html` | Reconciliation UI | `filteredPeriods` from localStorage — must use `data.periods` from API |
| `frontend-payroll/js/recon-service.js` | localStorage-based fallback | Safe as fallback only — correct as-is |
| `frontend-payroll/js/payroll-engine.js` | `getHistoricalPeriods()` | Only for localStorage data — not wrong, just not the right primary source |
| `frontend-payroll/payroll-execution.html` | Run + finalize UI | Correct — calls the right endpoints — no change needed |
| `frontend-payroll/js/payroll-api.js` | API call wrappers | Correct — no change needed |

### Database tables

| Table | Role in Chain | Status |
|---|---|---|
| `payroll_runs` | Run header, status tracking | Written correctly on run + finalize |
| `payroll_snapshots` | **Finalized payroll — authoritative source** | Written correctly — NOT read by recon |
| `payroll_transactions` | **Read by recon** — legacy individual payslips | NOT written by batch run system |
| `payroll_historical` | Imported CSV history | Read correctly by recon — no issue |
| `payroll_periods` | Period calendar | Used as join target — correct |
| `employees` | Employee names, IDs | Joined correctly everywhere |

### Key DB fields in `payroll_snapshots`

| Field | Type | Content |
|---|---|---|
| `company_id` | int | Multi-tenant key |
| `employee_id` | int | FK → employees |
| `period_key` | varchar | `YYYY-MM` — directly queryable, no join needed |
| `is_locked` | boolean | `true` = finalized — the filter to use |
| `status` | varchar | `'finalized'` — redundant with `is_locked` but explicit |
| `calculation_output` | JSONB | Contains `gross`, `paye`, `uif`, `sdl`, `net`, `taxableGross` as top-level keys |
| `finalized_at` | timestamptz | Audit trail |
| `payroll_run_id` | uuid | FK → payroll_runs |

---

## 7. RISKS AND NOTES

### Must not be broken

- **Immutability of `payroll_snapshots`** — no changes to finalized snapshot rows during fix
- **Multi-tenant isolation** — every query must include `.eq('company_id', companyId)` — recon.js already does this correctly for all its current queries
- **`payroll_historical` merge** — historical imports are working correctly; the fix must not disturb this path
- **Tax year helpers** — `taxYearToDateRange()`, `generatePeriods()`, `taxYearForPeriod()` in recon.js — these are correct; period boundary logic for SA tax year is correctly implemented
- **The finalization flow itself** — `lockSnapshotsForPeriod()` and `finalizePayrollRun()` are correct and must not be changed
- **Locked payslip guard** — already implemented on `payroll_snapshots.is_locked` — must remain

### Special caution — JSONB extraction

Supabase PostgREST does not support `calculation_output->>'paye'` in a `.select()` string for filtering/aggregation. To extract JSONB fields for aggregation, the backend will need to:
- Either select the full row and extract in Node.js (simple, works now, may be slow at scale)
- Or use a Supabase DB function/view that exposes `calculation_output` fields as columns (cleaner at scale)

For the initial fix, full-row select + Node.js extraction is safe and correct.

### Special caution — dual data source deduplication

After the fix, `recon.js /summary` will merge three sources: `payroll_snapshots` (finalized live), `payroll_historical` (imports), and optionally `payroll_transactions` (legacy). Deduplication logic is needed to prevent the same period/employee appearing in both `payroll_snapshots` and `payroll_historical`. The rule should be:

> **`payroll_snapshots` takes precedence over `payroll_historical` for any period where a finalized snapshot exists for the same employee.**

### Special caution — `filteredPeriods` change in frontend

Using `data.periods` from the backend means the period columns shown depend on the API response. If the API is temporarily unavailable (catch path), the localStorage fallback must gracefully handle an empty `allPeriods` — which it already does. The fallback is safe.

### Also affected — `emp501` endpoint

`GET /api/payroll/recon/emp501` has the same issue — it reads from `payroll_transactions` only and will also return empty for live payroll runs. This will need the same fix as `/summary` but is lower priority than the main reconciliation view.

---

## 8. CHAIN MAP — CONFIRMED BREAK POINT

```
POST /api/payroll/run
  → PayrollCalculationService.calculate()
  → PayrollHistoryService.saveSnapshot()
  → payroll_snapshots (status='draft')

POST /api/payroll/finalize
  → PayrollHistoryService.lockSnapshotsForPeriod()
  → payroll_snapshots (status='finalized', is_locked=true)   ← DATA LIVES HERE
  → PayrollHistoryService.finalizePayrollRun()
  → payroll_runs (status='finalized')

                    ↑ NOTHING CROSSES THIS GAP ↓

GET /api/payroll/recon/summary
  → queries payroll_transactions                             ← LOOKS HERE (empty)
  → queries payroll_historical                               ← imported data only
  → returns zeros for all live payroll periods

Frontend paye-reconciliation.html
  → filteredPeriods from localStorage                        ← also empty for new system
  → renders blank table even if API returned data
```

**The break is between `payroll_snapshots` (finalization output) and `payroll_transactions` (reconciliation input). The fix is to make reconciliation read from `payroll_snapshots` directly.**

---

*Audit completed 2026-04-22. No code was changed during this audit.*
*Next step: implement Fix A, B, C in that order after review.*
