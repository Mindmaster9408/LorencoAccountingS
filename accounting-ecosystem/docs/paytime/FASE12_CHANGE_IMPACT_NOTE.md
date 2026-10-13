# Fase 12 — Change Impact Note (Sean: IRP5 write atomic)

> 2026-10-13 · Ruan: "gaan aan met res" · Spec: [spec/14](spec/14_SEAN.md) SN-03 · Finding B13 · CLAUDE.md Part B (B6, B9)

```text
CHANGE IMPACT NOTE — SEAN / PAYTIME
─────────────────────────────────────────────────────────────
Area: backend/sean/irp5-learning.js _propagate() — the only place Sean writes IRP5 codes.

Found: the "only fill in when empty" rule was checked when the item list was read and
then the code was written UNCONDITIONALLY. A code an accountant entered between the
read and the write (e.g. while an approval ran) would have been overwritten —
a breach of CLAUDE.md B6/B9.

Changed: the condition is part of the UPDATE itself (… WHERE id = ? AND irp5_code IS NULL,
or = '' for the empty-string case) and the written rows are returned. 0 rows → the code
was set meanwhile: re-read it and log 'skipped_existing' (same code) or
'skipped_exception' (different code, listed for manual review) — never overwritten.

Tests: tests/irp5-learning.test.js — 2 new race/condition tests; 3 tests that failed
before this work only because of message wording after the shared learning-engine
refactor were aligned → suite 53/53 (was 50/53).
Full Jest 940 pass; remaining failing suites (5) are pre-existing and unrelated to
payroll figures: historical-comparatives-dashboard, payroll-employee-sync (needs live
pg), pdf-statement-import, supplier-invoice-ocr-drafts, teach-paytime (text parsing).

Added later (Fase 12b, 2026-10-13) — SN-04 meaning-based matching:
  - backend/sean/item-meaning.js (new, reusable): name → meaning ("Comm." = "Commission",
    "Basic Pay" = "Salary" = "Basic Salary", "O/T" = "Overtime", "13th Cheque" = bonus …)
    with a deliberately short, unambiguous word list; anything doubtful stays unmatched.
  - The SIDE is part of the meaning: an earning "Savings" and a deduction "Savings" are
    different items. Before, matching was on the name only — an approved deduction code
    could have been written onto an earning with the same name (live data has exactly
    this: "Savings" as earning and as deduction).
  - Subject stored on patterns: "commission", "savings [deduction]", "pension fund
    [employer]". 0 patterns existed, so nothing to convert; old plain subjects are read
    as earning-side names (canonicalSubject).
  - Grouping (analysis), proposal buckets, propagation and /exceptions all use it.
    GET /exceptions accepts an optional &type=.
  - SEVCO proposal card lists each "will be filled" company + the actual item name,
    so the approver checks every meaning match before approving (B8).
  - Safety rules unchanged: only empty codes are filled, conditionally (SN-03/B9).
  Tests: sean-item-meaning (4 new), irp5-learning +1 (meaning + side) → 58/58.
  Full Jest 958 pass; same 5 pre-existing failing suites.

Not in this phase (spec 14): SN-05 plain-language PAYE change explanations.
Rollback: git revert.
─────────────────────────────────────────────────────────────
