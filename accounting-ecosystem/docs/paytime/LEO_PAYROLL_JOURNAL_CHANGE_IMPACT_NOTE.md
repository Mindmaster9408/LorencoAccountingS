# Change Impact Note — Paytime → Ledger Leo draft payroll journal (VU-04)

> 2026-10-13 · Ruan: "gaan aan met res" · Spec: [spec/10](spec/10_VERSLAE_EN_UITVOERE.md) VU-04 (owner-confirmed: draft, accountant posts)

```text
CHANGE IMPACT NOTE — PAYROLL + LEDGER LEO
─────────────────────────────────────────────────────────────
Files:
  backend/modules/payroll/services/payrollJournal.js   NEW
  backend/modules/payroll/routes/payruns.js            (CRITICAL) finalize/reverse hooks + POST /ledger-journal
  frontend-payroll/payroll-execution.html              result toasts + "📒 Ledger Leo Journal" button
  frontend-accounting/journals.html                    label "Payroll (Paytime)"

Behaviour:
  - On FINALIZE: a DRAFT journal in Ledger Leo, dated the last day of the month,
    reference "PAYROLL YYYY-MM", source_type 'payroll', metadata.run_id. Totals only
    from the run's finalized snapshots:
      Dr 6000 gross · Dr 6020 employer UIF · Dr 6030 SDL
      Cr 2400 PAYE + UIF (both) · Cr 2410 SDL · Cr deductions payable · Cr salaries payable (net)
  - Paytime NEVER posts. The accountant reviews/posts in Leo → Journals.
  - On REVERSE: still-draft journal deleted; posted journal → reversing DRAFT (once).
  - One journal per run (idempotent). Button on a finalized run to (re)create it.
  - Accounts come from the company's own chart. Standard codes exist in 10 companies;
    "Payroll Deductions Payable" and "Salaries Payable / Net Pay Control" exist in NONE
    today → the journal is not created and the screen names exactly what to add.
    Nothing is ever created in a client's chart of accounts automatically.
  - Never affects finalization/reversal: any failure is reported, payroll continues.

Added 2026-10-13 — bank payments (rest of VU-04):
  - modules/accounting/services/payrollBankMatching.js (new) + GET
    /api/accounting/bank/payroll-matches?ids=… (bank.view). For UNMATCHED money-out bank
    lines it suggests, by exact amount (to the cent) and date window, from finalized
    snapshots only:
      net pay of one employee (1st of month → 20 days after month end) → Salaries Payable
      net pay of a whole run (bulk EFT, 2+ employees)                → Salaries Payable
      SARS EMP201 of the month (−10 → +60 days of month end)         → 2400 PAYE/UIF + 2410 SDL
  - Bank page: "Payroll match" line under the transaction + "Allocate as payroll
    payment" → the normal confirm dialog → the normal /allocate endpoint (journal
    posted + validated + reversible as before). Several candidates: "other match".
  - /allocate stores a validated metadata.payrollMatchKey on the bank journal. A match
    already used by a non-reversed bank journal is still shown but ranked last with a
    double-payment warning. Unallocating (journal reversed) frees it again.
  - Missing control account → the line names the account to add; no button.
  - Nothing is allocated automatically. Today no company has both finalized payroll and
    Leo bank lines, so nothing shows anywhere yet.
  Not built: matching by bank reference text (amount+date is enough so far); Capitec
  format (needs a sample).
  Tests: tests/payroll-bank-matching.test.js (9); ofx-bank-import unchanged (16).

Tests: tests/payroll-ledger-journal.test.js (8). Payroll gate 327 pass; golden 0 diffs.
Rollback: git revert (drafts already created can be deleted in Leo).
─────────────────────────────────────────────────────────────
