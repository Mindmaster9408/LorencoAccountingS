# Session handoff — 2026-11-18 — Paytime historical import rebuild

Authorised by Ruan ("doen dit laat die goed kan werk"). Change Impact Note:
`accounting-ecosystem/docs/paytime/HI_IMPORT_REBUILD_CHANGE_IMPACT_NOTE.md`.
**Not committed** — on the pending commit list (Ruan batches pushes). No migration needed.

## Root cause fixed
Historical Import → Confirm wrote the full row to the KV bridge (Part D violation) and only
gross/PAYE/UIF/net to `payroll_historical`. The payslip, YTD, recon and EMP501 read only
`payroll_snapshots`, so the payslip showed a fresh live calculation (basic only, UIF = 1% of basic).
Imported data was stored, but nowhere the app reads.

## What changed
| File | Purpose |
|---|---|
| `backend/modules/payroll/services/historicalImport.js` (new) | Pure row → locked snapshot builder (figures as supplied, every column a payslip line incl. negatives, net check, taxable/YTD fields, employer UIF/SDL); DB import, batch list, undo |
| `backend/modules/payroll/routes/historical-import.js` (new) | `GET /setup`, `POST /` (dry_run or import), `GET /batches`, `POST /batches/:id/undo` (reason required, audited). Import/undo need PAYROLL.PROCESS |
| `backend/modules/payroll/index.js` | Mounts `/api/payroll/historical-import` |
| `backend/modules/payroll/routes/unlock.js` | Refuses to unlock `*_import` snapshots (422 IMPORTED_PAYSLIP) — HI-05 |
| `backend/shared/routes/employees.js` | `POST /api/employees/:id/reinstate` (reason required, note + audit, clears termination_date) |
| `frontend-payroll/historical-import.html` | All three tabs (CSV/Excel, PDF, manual) go through the server; column → payroll item mapping table; "import rows that do not add up" option; import history + Undo from the server; all KV writes removed; no frontend-engine auto-fill; ended employees included |
| `frontend-payroll/js/bulk-import-utils.js` | CSV read as text (opt-in); Excel date serials accepted as periods (fixes "Invalid period: 46082") |
| `frontend-payroll/js/data-access.js` | `reinstateEmployee()` |
| `frontend-payroll/employee-management.html` | "Reinstate" button next to "Ended" (shows end date) |
| `backend/tests/payroll-historical-import.test.js` (new) | 28 tests |
| `docs/paytime/spec/12_HISTORIESE_INVOER.md` | HI-01/02/03/05/06/07/09/11/12 → ✅ |

## Confirmed
- New unit tests 28/28; full backend suite 1431 passed (8 skipped, pre-existing); golden gate 56/56; lint 0 errors.
- E2E against the real DB, company 51 only, real HTTP server: 36/36 — dry run writes nothing; duplicates
  skipped; unknown employee / future period / net mismatch refused; import → locked snapshots with exact
  figures; `/calculate` returns the locked import with all lines (UIF 64.30, short time −90, overtime);
  next month's YTD counts the imported month; unlock refused; undo (reason) reverses; End of Service →
  months after termination refused, termination month imports; reinstate works.
- E2E left in company 51: one reversed test batch (2 snapshots, audit only); employee 270's old unlocked
  Aug 2026 draft was replaced and then undone (no draft now); PGW-004 ended + reinstated (notes + audit rows).

## Not changed / open
- **Turkstra (company 7) leftovers NOT deleted** — 234 `payroll_historical` rows (csv_import, 2026-03..10)
  and ~250 `emp_historical_7_*` KV keys from the broken imports. Mar–Jul already exist as locked
  simplepay snapshots (re-import skips them). Delete after Aug–Oct are re-imported — needs Ruan's ja.
- The page itself was not clicked through in a browser — server endpoints were tested over HTTP and
  the page's parsing helpers in Node. **Ruan: run one real import in company 51 before using it on a client.**
- HI-04 (recon marks imported months as declared), HI-08 (add item after import), HI-14 (PDF per-source
  layouts) still open. Scripts still sum deductions into one line.
- Turkstra's "Annual Bonus" item has paye_projection_type VARIABLE_AVERAGE; the import treats IRP5 3605
  as once-off regardless (documented in the Change Impact Note).
- No column→item learning across clients (Part B) — mapping memory is per company only (last batch).

## Testing required
1. In company 51: upload a small .csv with `period` as `2026-09` text → mapping → preview → confirm →
   Employee detail → Sep 2026 → Preview Payslip shows every line and the file's totals.
2. Undo that import with a reason; payslip returns to a live calculation.
3. Then for Turkstra: re-import Aug–Oct, compare the EMP201 per month to SimplePay to the cent (HI-04a).
