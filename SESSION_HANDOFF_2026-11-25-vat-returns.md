# Session handoff — 2026-11-25 — Ledger Leo: filed SARS VAT returns (step 1)

## What was built

Ledger Leo can now record what was **actually filed** on eFiling (every VAT201 field), what was **paid**
to SARS, and show where the books **now differ** from the filed return.

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/189_vat_returns_filed.sql` | NEW. `vat_returns` (one row per period per version, all VAT201 fields as columns, DB checks that 13/19/20 add up, one `filed` version per period), `vat_payments` (VAT / penalty / interest / refund, soft delete, optional bank-line link). Step 1 fixes 17 VAT periods stored one day early. `vat_submissions` marked deprecated (0 rows, never used). |
| `backend/modules/accounting/services/vatReturnsService.js` | NEW. overview, period detail (versions, payments, Leo's VAT201 now, differences, entries posted on/after the filing date), capture (revision supersedes in one transaction, then locks the period), payments. |
| `backend/modules/accounting/routes/vatReturns.js` | NEW. `/api/accounting/vat-returns/*`. View = VAT/report roles; capture + payments = admin/accountant; audit-logged. |
| `backend/modules/accounting/index.js` | Mounts `/vat-returns`. |
| `backend/modules/accounting/services/vatReportService.js` | **Root-cause fix:** shared `PERIOD_JOURNAL_FILTER`. A late entry swept out of a locked period no longer ALSO counts in its old period (it used to count in both). Verified: identical figures today (no locked periods yet). |
| `backend/modules/accounting/services/vatDetailReportService.js` | Uses the shared filter; accepts an explicit period range; marks fixed-asset purchases `capital` (→ VAT201 field 14). |
| `backend/modules/mcp/lorencoApi.js` | Bot may read but never write `/vat-returns` ("done by a person"). |
| `frontend-accounting/vat.html` | New **SARS Returns** tab (overview, period detail, VAT201 capture form prefilled from Leo, payments, differences + causes, capture an older period). "Submit to SARS" now opens this capture. `parsePeriodKey` date bug fixed (local midnight → toISOString was one day early in SA). |
| `backend/tests/vat-returns.test.js` | NEW, 20 tests. |

## Root causes fixed
1. VAT periods one day early: `vat.html` `parsePeriodKey()` built local-midnight dates and converted to UTC.
2. Late entries double-counted once a period is locked (date-range filter had no exclusion for entries swept out).

## Confirmed
- 34 VAT tests pass; full suite 1575 pass, 0 fail; lint 0 errors; inline scripts in vat.html parse.
- Old vs new period filter give identical totals on real data (Turkstra Oct input VAT R122 098,84 both).

## NOT done / needs doing
- Migration 189 RUN 2026-11-25 (17 period rows in companies 1, 2, 7, 40, 41, 51 now start on the 1st).
- E2E in test company 51: 12/12 pass (capture, lock, wrong total refused, revision, one filed version, payments,
  penalty apart, delete payment, older period). Test rows removed and periods reset to DRAFT afterwards.
- Pushed b53d226 together with the VAT detail PDF one-line fix.

## Step 2 (agreed, not built)
Carry a difference into a later return (output → field 12, input → field 18) with from/to period, amount and
reason recorded so nothing is corrected twice; the next VAT201 + detail report include it.

## Follow-ups
- VAT201 Calculation tab still uses calendar month + VAT ÷ 15% back-calc (`/vat/categorized`).
- Reconciliation tab's TB tie-out counts by date; after a period is locked with late items, its TB side will
  include swept-out entries — review when the first period is locked.
- Old `POST /vat-recon/periods/:id/submit` route left in place (unused by the UI now).
