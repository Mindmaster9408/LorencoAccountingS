# Reporting Forensic Hardening Pack 01 — Implementation Report

**Module:** Lorenco Accounting — Reports  
**Date:** 2026-05-24  
**Status:** Phase 1 complete  

---

## 1. Summary

This pack hardens the reporting layer for forensic accuracy, multi-tenant integrity, and data-contract transparency. It introduces a report truth badge system, fixes two bank reconciliation tenant-safety gaps, adds journal source filtering to GL-based reports, and improves the VAT unclassified source warning.

**Strict scope — NOT changed:**
- JournalService / posting logic
- Bank import / bank staging / allocation logic
- VAT calculation logic (totals unchanged — only unclassified tracking improved)
- AR/AP payment logic
- Historical comparatives storage
- Opening balance logic
- Period locking logic

---

## 2. Files Changed

### New files

| File | Purpose |
|------|---------|
| `backend/modules/accounting/services/reportTruthBadge.js` | Pure service — returns badge metadata for each report type |
| `docs/accounting/REPORTING_FORENSIC_HARDENING_PACK_01_REPORT.md` | This file |

### Modified files

| File | Change |
|------|--------|
| `backend/modules/accounting/routes/reports.js` | Added badge import; `journalSourceMode` param in `fetchAccountBalances`; bank recon tenant-safety fix; `reportTruth` on all 8 report responses |
| `backend/modules/accounting/services/vatReportService.js` | Added badge import; improved unclassified source warning; `reportTruth` on VAT report response |
| `frontend-accounting/trial-balance.html` | Truth badge CSS + container; journal source filter dropdown; updated `generateReport()` |
| `frontend-accounting/balance-sheet.html` | Truth badge CSS + container; updated `generateReport()` |
| `frontend-accounting/bank-reconciliation.html` | Static truth badge in summary panel |
| `frontend-accounting/control-account-reconciliation.html` | Truth badge CSS + container; updated `generateReport()` |
| `frontend-accounting/vat-return.html` | Truth badge CSS + container; updated `loadReport()` and `clearPanels()` |

---

## 3. Part 1 — Bank Reconciliation Tenant-Safety Hardening

### Problem

`GET /api/accounting/reports/bank-reconciliation` had two Supabase queries on `bank_transactions` that filtered only by `bank_account_id`, with no explicit `company_id` predicate:

1. **`lastTxn` query** — fetches the most recent statement balance for the bank account on or before the requested date
2. **`unrecon` query** — fetches all unmatched/matched transactions for unreconciled balance calculation

The bank account itself was verified company-scoped (via `.eq('company_id', req.user.companyId)` on `bank_accounts`) — so this was a defense-in-depth gap, not an outright data escape. However, if `bank_account_id` values were ever predictable integers, a crafted request could potentially read another company's transaction data.

### Fix

Added `.eq('company_id', req.user.companyId)` as the **first** filter on both queries:

```javascript
// lastTxn — before fix
.from('bank_transactions').select('balance')
  .eq('bank_account_id', bankAccountId)...

// lastTxn — after fix
.from('bank_transactions').select('balance')
  .eq('company_id', req.user.companyId)
  .eq('bank_account_id', bankAccountId)...
```

Same pattern applied to the `unrecon` query.

### What was already correct
- `GET /unallocated-bank-transactions` — already had `.eq('company_id', companyId)` as first filter
- `GET /bank-recon-history/:sessionId` transactions query — already had `.eq('company_id', companyId)`
- All `pg`-pool SQL queries (`ledgerBalance`, GL queries) — already scoped by `company_id = $1`

---

## 4. Part 2 — `reportTruthBadge.js` Service

### Location
`backend/modules/accounting/services/reportTruthBadge.js`

### Three truth types

| Type | Label | Color | Meaning |
|------|-------|-------|---------|
| `posted_gl_only` | Posted GL Only | Green | Only posted journals. No draft, no unallocated bank transactions, no sub-ledger. |
| `mixed_gl_operational` | GL + Operational | Amber | Posted GL + operational data not yet in journals (e.g. unallocated bank transactions). |
| `diagnostic_reconciliation` | Diagnostic | Blue | Two-source proof: compares GL vs sub-ledger or statement vs ledger. Differences flag items requiring investigation. |

### API

```javascript
const { getBadge } = require('../services/reportTruthBadge');

getBadge('posted_gl_only')
// → { type, label, description, color, bgColor, borderColor, journalSourceMode: 'all' }

getBadge('posted_gl_only', { journalSourceMode: 'manual' })
// → { label: 'Posted GL Only — Manual Journals Only', description: '... Filtered to manual journals only.', ... }
```

### No DB calls, no side effects. Pure function.

---

## 5. Part 3 — `reportTruth` on All Report Responses

Every report API response now includes a `reportTruth` field:

| Endpoint | Type |
|----------|------|
| `GET /trial-balance` | `posted_gl_only` (respects `journalSourceMode`) |
| `GET /general-ledger` | `posted_gl_only` (respects `journalSourceMode`) |
| `GET /profit-loss` | `posted_gl_only` (respects `journalSourceMode`) |
| `GET /balance-sheet` | `posted_gl_only` |
| `GET /bank-reconciliation` | `diagnostic_reconciliation` |
| `GET /unallocated-bank-transactions` | `mixed_gl_operational` |
| `GET /bank-recon-history` | `diagnostic_reconciliation` |
| `GET /bank-recon-history/:sessionId` | `diagnostic_reconciliation` |
| `GET /control-account-reconciliation` | `diagnostic_reconciliation` |
| `GET /vat/report` (vatReportService) | `posted_gl_only` |

---

## 6. Part 4 — `journalSourceMode` Parameter

### Added to `fetchAccountBalances()`

```javascript
async function fetchAccountBalances(companyId, {
  fromDate, toDate, asOfDate, types, segmentValueId,
  journalSourceMode    // 'all' | 'manual' | 'system'
} = {}) {
```

### SQL clause appended to both `linesSql` and `countSql`

| Mode | Clause added |
|------|-------------|
| `all` (default) | *(no clause)* |
| `manual` | `AND (j.source_type IS NULL OR j.source_type = 'manual')` |
| `system` | `AND j.source_type IS NOT NULL AND j.source_type != 'manual'` |

No additional SQL parameters needed — these are literal conditions only.

### Routes updated

- `GET /trial-balance` — accepts `?journalSourceMode=all|manual|system`
- `GET /profit-loss` — accepts `?journalSourceMode=all|manual|system`
- `GET /general-ledger` — accepts `?journalSourceMode=all|manual|system`; applied directly to both opening-balance SQL and period SQL

Input is validated server-side: only `all`, `manual`, `system` are accepted. Any other value defaults to `all`.

### `journalCount` consistency

`countSql` also receives the `sourceClause`, so the returned `journalCount` reflects only journals matching the source filter — consistent with the line data shown.

---

## 7. Part 5 — Frontend Truth Badge UI

### Badge shape (from API)

```json
{
  "type": "posted_gl_only",
  "label": "Posted GL Only",
  "description": "Contains only posted journal entries...",
  "color": "#14532d",
  "bgColor": "#dcfce7",
  "borderColor": "#86efac",
  "journalSourceMode": "all"
}
```

### `renderTruthBadge(badge)` function (in each page)

Renders a colored pill badge and a plain-text description alongside it. All values HTML-escaped before injection. Badge has `title` attribute = description for hover tooltip.

```javascript
function renderTruthBadge(badge) {
    const wrap = document.getElementById('truthBadgeWrap');
    if (!wrap || !badge) return;
    const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    wrap.innerHTML = `<span class="truth-badge" style="color:${esc(badge.color)};background:${esc(badge.bgColor)};border-color:${esc(badge.borderColor)};" title="${esc(badge.description)}">${esc(badge.label)}</span>...`;
    wrap.style.display = 'flex';
}
```

### Pages updated

| Page | Badge source | Journal source filter UI |
|------|-------------|--------------------------|
| `trial-balance.html` | Dynamic (`data.reportTruth`) | Yes — dropdown (All / Manual Only / System Only) |
| `balance-sheet.html` | Dynamic (`data.reportTruth`) | No |
| `control-account-reconciliation.html` | Dynamic (`data.reportTruth`) | No |
| `vat-return.html` | Dynamic (`report.reportTruth`) | No |
| `bank-reconciliation.html` | Static (hardcoded Diagnostic badge) | No (workflow page, not report endpoint) |

`clearPanels()` in `vat-return.html` also hides the badge when re-loading.

---

## 8. Part 6 — VAT Unclassified Source Warning Improvement

### Before

```
"Some VAT lines could not be classified by source type."
```

Unhelpful — gave no information about which source types were unclassified or how many journals/VAT amounts were affected.

### After

```
"3 journals with unrecognised source types could not be classified: 'import_batch' (2 journals, output VAT R 1200.00, input VAT R 0.00); 'legacy_import' (1 journal, output VAT R 0.00, input VAT R 840.00). These are included in the VAT totals but not in any source breakdown category. Check the source_type field on these journals."
```

### Changes in `vatReportService.buildSourceBreakdown()`

- Replaced `unclassifiedCount` (integer) with `unclassifiedSources` (object keyed by source_type)
- Each key tracks: `count`, `inputVat`, `outputVat`
- Warning message includes source types, counts, and VAT amounts per type
- `buildSourceBreakdown()` now returns `unclassifiedSources` alongside `sourceBreakdown` and `warnings`
  - `null` when no unclassified sources (avoids sending empty objects to frontend)

**VAT totals are not affected** — unclassified journals were already included in the GL-level `calculateOutputVat()` / `calculateInputVat()` totals before this change. Only the source breakdown attribution is improved.

---

## 9. Multi-Tenant Safety

### Summary of tenant-scoping after this pack

| Endpoint | company_id enforcement |
|----------|----------------------|
| All GL reports (TB, P&L, BS, GL) | `fetchAccountBalances`: accounts `.eq('company_id')` + SQL `WHERE j.company_id = $1` |
| `/bank-reconciliation` lastTxn | **Fixed** — `.eq('company_id', req.user.companyId)` added |
| `/bank-reconciliation` unrecon | **Fixed** — `.eq('company_id', req.user.companyId)` added |
| `/unallocated-bank-transactions` | Already correct — `.eq('company_id', companyId)` |
| `/bank-recon-history` | Already correct — `.eq('company_id', companyId)` |
| `/bank-recon-history/:sessionId` | Already correct — `.eq('company_id', companyId)` on both session and transactions |
| `/control-account-reconciliation` | All SQL uses `company_id = $1` |
| VAT report | All SQL uses `company_id = $1` |

---

## 10. Remaining Risks / Follow-up Notes

| Item | Risk | Recommendation |
|------|------|----------------|
| `journalSourceMode` on `division-profit-loss` | Low — division P&L has complex column-based fetching; source mode not added | Phase 2: pass `journalSourceMode` through each `fetchAccountBalances` call in the column loop |
| Truth badge not shown for `bank-recon-history` and `unallocated-bank-transactions` pages | Low — those are consumed from `reports.html` which doesn't yet have badge rendering | Phase 2: add badge rendering to `reports.html` report sections |
| User names not on truth badge description | Cosmetic | Not needed — badge describes the data type, not the requester |
| `journalSourceMode=system` may show zero results for manual-journal-heavy books | Expected — system correctly returns 0 when no system journals exist for the period | Document in user-facing tooltip |

---

## 11. Tests Required

See `docs/testing/PENDING_TESTS.md` → Section 12 (Reporting Forensic Hardening).

| # | Test |
|---|------|
| RPT-01 | Bank recon `lastTxn` returns only company-scoped transactions |
| RPT-02 | Bank recon `unrecon` returns only company-scoped unreconciled transactions |
| RPT-03 | TB with `journalSourceMode=manual` returns only manual journal lines |
| RPT-04 | TB with `journalSourceMode=system` returns only system journal lines |
| RPT-05 | TB `journalCount` matches source mode filter |
| RPT-06 | GL with `journalSourceMode=manual` — opening balance includes only manual journals |
| RPT-07 | All report responses include `reportTruth` field |
| RPT-08 | `reportTruth.type` is correct for each endpoint |
| RPT-09 | Truth badge renders in trial-balance UI |
| RPT-10 | Truth badge label changes when journal source filter is changed |
| RPT-11 | VAT unclassified warning includes source type names and VAT amounts |
| RPT-12 | VAT totals unchanged after unclassified source tracking improvement |
| RPT-13 | `getBadge()` returns correct color scheme per type |
| RPT-14 | Invalid `journalSourceMode` value defaults to `all` server-side |
