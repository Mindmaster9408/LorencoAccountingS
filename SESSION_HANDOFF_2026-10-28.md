# Session Handoff — 2026-10-28 — Paytime RS-07: e@syFile import file

Ruan: "sal jy kan bou laat ek kan import in easyfile in" → authorised ("jy het toestemming om te bou"),
for every company, any tax year.

## What was built

Paytime → PAYE Reconciliation → **🧾 e@syFile Export**: an IRP5 / IT3(a) import file for SARS
e@syFile Employer, built only from **locked** payroll snapshots (spec 09 RS-01/RS-01a).

- Annual (Mar–Feb, period YYYY02) or interim (Mar–Aug, period YYYY08); LIVE or TEST.
- Preview first: per employee the certificate type, gross, PAYE and everything that still blocks it;
  company problems on top (with the expected SARS UIF/SDL number, i.e. U/L + PAYE's last 9 digits).
- Download: blocked employees can be left out (confirm), company problems always block.
- Format: SARS **BRS PAYE Employer Reconciliation V25.3.0 (Jun 2026)**, checked field by field against
  two SimplePay files that e@syFile accepted (Ruan's Downloads, `tax_certificate_export*`).
  Trailer 6010/6020 reproduce SimplePay's exactly; 6030 follows the BRS (not validated by SARS).

| File | Purpose |
|---|---|
| `backend/migrations/036_easyfile_tax_certificates.sql` | **Run + verified 2026-10-28.** Employee residential address, passport country, DOB, nature of person, bank account type + relationship; `companies.sic7_code`; table `payroll_tax_certificates` |
| `backend/modules/payroll/services/easyfileExport.js` | New. Pure builder: amounts per IRP5 code, validation, record layout, trailer, certificate numbers |
| `backend/modules/payroll/routes/recon.js` | `GET /api/payroll/recon/easyfile` (preview, PAYROLL.VIEW) and `POST` (file + certificate numbers, PAYROLL.PROCESS). Existing routes untouched |
| `backend/shared/routes/employees.js` | PUT accepts the new IRP5 fields (validated; silently ignored until 036 has run) |
| `backend/shared/routes/companies.js` | PUT accepts `sic7_code` (5 digits; ignored until 036 has run) |
| `frontend-payroll/employee-detail.html` | Edit modal: residential address, passport country, DOB, bank account type, account holder relationship; address shown on Basic Info |
| `frontend-payroll/company-details.html` | SIC7 field |
| `frontend-payroll/paye-reconciliation.html` | Button, preview dialog, download |
| `backend/tests/payroll-easyfile-export.test.js` | 18 tests |
| `docs/paytime/spec/09_REKONSILIASIE_EN_SARS.md` | RS-07 → ✅ |

## How amounts get their IRP5 code (per locked snapshot)

- Earning items → their own `irp5_code`, else the Payroll Items screen (same matching as IT-05).
- Overtime → 3607. The rest of cash gross (basic after short time, multi-rate, **imported SimplePay
  months without a breakdown**) → 3601. So imported months land under 3601 except their coded items (e.g. bonus 3605).
- Employer contribution / fringe benefit with a code → that code; 3817/3825/3828/3810 also → 4472/4473/4475/4474 and added to 4001/4003/4006/4005.
- Deductions with a 40xx/44xx code → that code. 4582 = taxable part of 3701+3802+3816, clamped to 20–80% (warning when clamped).
- PAYE / UIF (employee + employer) / SDL / medical credit straight from the snapshot output.
- Sub-codes consolidated to main codes (BRS section 5).

Verified read-only on live data (interim 2026/2027): certificate PAYE equals raw snapshot PAYE for
companies 1, 2, 7, 38, 51. Nothing was written.

## Certificate numbers

PAYE ref + transaction year + `02`/`08` + 14-digit unique part (table id). Same employee + year +
period → same number on every re-export (TEST or LIVE); an interim **final** certificate (terminated
by 31 Aug) uses `02` and keeps its number at year end. If the PAYE reference changes, the old number
is marked cancelled and a new one issued. Numbers are never reused.

## Testing

- `npx jest tests/payroll-easyfile-export.test.js` 18/18; payroll recon/IT-05/golden 86/86.
- Full suite: 4 unrelated suites fail before and after (DB-password suite, missing Sean OCR module,
  historical-comparatives mock order, teach-paytime). `npm run lint`: 0 errors.
- Not changed: payroll engine, PayrollCalculationService, snapshot write/read paths, EMP501 endpoint.
  Regression tests TEST-PAY-01..14: engine untouched → only TEST-PAY-14 (recon) relevant; covered by the live PAYE cross-check above.

## Ruan se take (new)

24. ~~Run migration 036~~ — DONE 2026-10-28, verified.
25. Per company: Company Details → SIC7 code, contact person (first name + surname), phone, street
    address, postal code; fix SARS UIF/SDL numbers (the preview shows the expected U/L numbers, e.g. where a Labour UIF number was captured
    instead of the SARS one). TIL (1) and TEST (51) have no PAYE number.
26. Per employee: residential address, bank account type (current/savings/…), passport country + DOB for non-SA-ID employees.
27. On **Infinite Legacy — TEST**: give it fake but valid company details, open e@syFile Export, download with **TEST**, and import in e@syFile Employer — confirm it imports without errors.

## FOLLOW-UP NOTES

```
FOLLOW-UP NOTE
- Area: e@syFile — ETI
- Dependency: RS-09 (ETI not calculated by Paytime)
- What was done now: code 3026 = N on every certificate (left out for Appendix D public-sector SIC7)
- What still needs to be checked: clients claiming ETI must capture it in e@syFile until RS-09 exists
- Risk if not checked: ETI not claimed
- Recommended next review point: when RS-09 is built (7002–7008 monthly ETI records)
```

```
FOLLOW-UP NOTE
- Area: e@syFile — IT3(a) reason, directives, 65+ medical
- What was done now: IT3(a) always reason 02 (warning shown); employees with a tax directive get a warning
  to capture the directive number in e@syFile; 4120 written as 0.00 for 65+ with 4005
- What still needs to be checked: other IT3(a) reasons / directive numbers are edited in e@syFile
- Risk if not checked: wrong reason code on an IT3(a)
```

```
FOLLOW-UP NOTE
- Area: e@syFile — real import test
- Confirmed now: layout identical to SimplePay files e@syFile accepted; BRS rules implemented
- Not yet confirmed: an actual import of a Paytime-generated file into e@syFile Employer
- Risk if wrong: e@syFile rejects the file (no data reaches SARS — safe failure)
- Recommended next check: Ruan's task 27
```
