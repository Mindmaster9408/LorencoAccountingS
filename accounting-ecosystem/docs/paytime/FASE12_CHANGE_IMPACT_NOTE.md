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

Not in this phase (spec 14): SN-04 meaning-based item matching ("Comm." = "Commission"),
SN-05 plain-language PAYE change explanations.
Rollback: git revert.
─────────────────────────────────────────────────────────────
