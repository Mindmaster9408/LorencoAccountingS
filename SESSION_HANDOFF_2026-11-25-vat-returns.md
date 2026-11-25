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

## Step 2 — carry differences into a later return (BUILT + PUSHED 2026-11-25)

Migration 190 RUN 2026-11-25. E2E in co 51: 16/16 (carry part, double carry refused, wrong direction refused,
unfiled source refused, target Leo field 12 + VAT report include it, carry into a newly created period, nothing
left, revision needs confirmation, cancel + re-carry, target filed → cancel refused). Test rows removed afterwards.

| File | Purpose |
|---|---|
| `backend/config/migrations/190_vat_corrections.sql` | NEW `vat_corrections`: source period (+ filed return), target period, output_vat (→ field 12), input_vat (→ field 18), reason, active/cancelled. No ledger posting — return-level adjustment only. |
| `vatReturnsService.js` | `carryCorrection` (only what is still uncorrected = Total A/B difference − active corrections; same direction; target must be later and unfiled; serialised with FOR UPDATE on the filed return), `cancelCorrection` (only while target unfiled), corrections into a period added to Leo's field 12/18, revision of a period with carried corrections needs `confirmCorrections` (409 `CORRECTIONS_EXIST`). |
| `routes/vatReturns.js` | POST `/corrections`, POST `/corrections/:id/cancel` (admin/accountant, audit-logged); error `code` passed to the client. Bot blocked (existing `/vat-returns` write block). |
| `vatDetailReportService.js` + PDF + Excel | `summary.corrections` (items, totals, payable incl. corrections); shown under A − B in the VAT Report tab, PDF and Excel. |
| `frontend-accounting/vat.html` | "Correcting the difference" (difference / carried / still to correct, carried list with status + Cancel, carry form), "Corrections of earlier periods in this return", revision confirm. |

Why only what's left can be carried: entries dated in a locked period are swept to the open period by
journalService and already correct themselves there; differences that remain are what the filed return got wrong
or what was posted between eFiling and capturing.

## Follow-ups
- VAT201 Calculation tab still uses calendar month + VAT ÷ 15% back-calc (`/vat/categorized`).
- Reconciliation tab's TB tie-out counts by date; after a period is locked with late items, its TB side will
  include swept-out entries — review when the first period is locked.
- Old `POST /vat-recon/periods/:id/submit` route left in place (unused by the UI now).
