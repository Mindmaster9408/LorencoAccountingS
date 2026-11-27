# Session handoff, 2026-11-27: audit R1, reversed journals in VAT and year-end

**Status:** code changes are done and tested, but **not committed**. The data fix for Turkstra has already been run.
**Deploy dependency:** the Turkstra data now assumes the new counting rule. Until this code is live, Leo shows Turkstra's October input VAT as R98 472,03. The correct figure is R122 098,84. Deploy before Turkstra's October VAT is filed.

## Root cause
1. `reverseJournal` always dated the reversal **today**. So undoing an October allocation in November moved the VAT and P&L into November, even though October was still open.
2. The VAT services, year-end and diagnostics summed only `status='posted'`. A reversed original (`status='reversed'`) dropped out of the sums, but its reversal (`posted`) was still counted, so each pair netted to −X instead of 0. `reports.js` was already fixed on 2026-09-02; these files were not.
3. Year-end also read journals and lines through Supabase, which stops at 1000 rows, and skipped inactive accounts.

## Changes (per file)
| File | Change |
|---|---|
| `backend/modules/accounting/services/journalService.js` | New `_chooseReversalPlacement`: the reversal takes the original's date and VAT period while both are open. It goes to today when the VAT period is LOCKED, a VAT return is filed, a year-end close covers the date, or the journal has VAT lines without a VAT period. On a DB error it throws rather than guessing. Out-of-period counters are netted. The placement mode and reason are written to the reversal's metadata. |
| `vatReportService.js` (4), `vatReturnsService.js`, `vatDetailReportService.js`, `vatCategoryReportService.js`, `vatReconciliationService.js` (2) | `status IN ('posted','reversed')`. The detail report notes "Later reversed". |
| `diagnosticsService.js` | Same rule, but only for balance sums (861, 1009, 1063, 1140, 1179, 1242, 1283). The list checks still use `posted`. |
| `routes/yearEnd.js` | One SQL aggregate: posted + reversed, no row cap, inactive accounts included. |
| `backend/tests/journal-reversal-placement.test.js` | New: 18 tests. |
| `accounting-ecosystem/docs/OUDIT_2026-11-27_EKOSTELSEL.md` | New: the full 3-angle audit (Afrikaans). R1 is marked as fixed. |

All 30 callers of `reverseJournal` (bank un-allocate, invoice, credit-note and supplier voids, staging, diagnostics) get the new rule automatically.

## Verified
- jest: 1687 passed (88 suites); lint: 0 errors.
- E2E in company 51, 10/10: no-VAT, open VAT period, LOCKED VAT period, and VAT lines without a period. Journals 2982–2988 were left in company 51; they net to zero. The temporary locked period was removed.
- Turkstra data (company 7), run in one transaction:
  - 47 bank reversals moved from 24/25 Nov to their original October date and VAT period 51.
  - Backup table: `zz_backup_audit_r1_20261127`. Audit: an `accounting_audit_log` DATA_FIX row.
  - After deploy, October input VAT is R122 098,84 and November is R0. Before the fix, November showed −R23 626,81.

## Not changed
- Turkstra's other reversals (10 bank and 4 manual without VAT, 4 invoices and 1 supplier invoice whose VAT lines have no period) were not moved; only the 47 were approved.
- Other companies' past non-VAT reversals were not moved either; their P&L still shows the reversal in the later month.
- The 1000-row cap and `.in(journalIds)` in `vatReconciliationService.js:612` are unchanged; this is a follow-up.
- `vatCategoryReportService` is invoice-based. A voided invoice drops out of a filed period there. This was already the case before; follow-up.

## Follow-ups
- Deploy soon (see above). After deploy, open Turkstra October and November in Leo's VAT report and check the figures.
- Optional: drop `zz_backup_audit_r1_20261127` after 90 days.
- Optional: offer a manual "reversal date" field on journals.html for deliberate next-month reversals (accrual reversal). Today these follow the open-period rule.
