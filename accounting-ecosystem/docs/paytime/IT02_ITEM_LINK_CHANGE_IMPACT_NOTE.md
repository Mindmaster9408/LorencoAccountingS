# IT-02 / IT-13 — Payroll items linked by ID, not name (Change Impact Note)

> 2026-10-13 · Ruan: "gaan an" · Spec: [spec/04](spec/04_PAYROLL_ITEMS.md) IT-02, IT-13

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area: how a calculation item (payroll_items, what employees' assignments point to) finds
its settings + IRP5 code on the Payroll Items screen (payroll_items_master).
Files: services/itemLink.js (new), services/PayrollDataService.js (CRITICAL),
       routes/items.js (CRITICAL), migrations/033_payroll_items_master_link.sql (NOT RUN)

Found:
  1. Rename bug: renaming an item synced payroll_items by the NEW name — nothing matched,
     so the calculation rows kept the old name and lost the live settings link.
  2. Same name on two sides (company 7 "Savings": earning id 37 and deduction id 38): the
     calculation picked whichever came last by name; assignment lookup (maybeSingle) failed
     on the pair and fell back to defaults. Today both rows have the same settings, so no
     live figure was wrong.

Changed:
  - itemLink.pickMaster: fixed link (master_item_id) → name + side → unique name (old way).
  - Data service uses it for regular items and once-off inputs (inputs by name + side).
  - Rename on the screen renames the calculation rows of that item (by link, else by the
    OLD name + side) and stamps the link; settings sync the same way.
  - Assigning an item picks the screen row and calculation row of the right side and
    stores the link.
  - Works before and after migration 033 (column probe, cached once it exists).

Migration 033 — RUN 2026-10-14 (Ruan: "ja"): payroll_items.master_item_id + backfill by name + side.
  Result: 14 rows; 8 linked (incl. company 7 Savings deduction → 38), 5 stay NULL
  (no screen row: company 7 Union Membership Fee, Garnishee; company 15 ×3; company 40
  Commission) and keep working by name as before.

Not changed: once-off inputs (payroll_period_inputs) have no ID column — linking them
needs the replace RPC (migration 028) redefined; tracked. Inputs entered BEFORE a rename,
in an open month, still match by the old name until re-saved.

Payroll risk: [x] CRITICAL files, Low behaviour risk (same settings chosen except the
ambiguous-name case). Checks: golden 0 diffs, core 15/15, payroll gate pass,
tests/payroll-item-link.test.js (5), live read-only load of 40 employees: 0 errors.
Rollback: git revert (033 is additive; the column can stay).
─────────────────────────────────────────────────────────────
```
