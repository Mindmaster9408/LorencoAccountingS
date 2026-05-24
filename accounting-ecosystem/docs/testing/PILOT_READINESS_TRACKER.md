# PILOT READINESS TRACKER

**Owner:** Ruan + Claude Code  
**Last updated:** 2026-05-24  
**Goal:** 6-month internal client trial for selected Lorenco clients

---

## 1. Current Rough Estimate

**±33–43 codeboxes remaining** before full-scope release.

Pilot does not require all codeboxes to be complete. It requires the **Pilot Minimum Modules** (Section 3) to be in a Green or Amber-with-known-caveats state.

---

## 2. Pilot Goal

Run a 6-month internal client trial with a small number of selected Lorenco clients. The trial covers:

- Real financial data loaded into a multi-tenant Supabase environment
- Day-to-day accounting operations: bank import, allocation, reconciliation, AR/AP, VAT
- Period-end routines: bank recon, VAT reporting, trial balance check
- Accountant workflow: Ruan and/or a supervising accountant operating the system

The pilot is not a public launch. It is a controlled test with clients who can tolerate rough edges, under close supervision.

---

## 3. Pilot Minimum Modules

These modules must be at least Amber before the pilot begins. Red modules block the pilot.

| Module | Description |
|--------|-------------|
| Bank import | PDF + CSV statement import, staging confirmation |
| Bank allocation | Single, VAT, split allocations; journal creation |
| Trial balance | Reflects all posted journals, opening balances, allocations |
| General ledger | Drill-down by account and period |
| VAT prep | VAT report and return screen (prep only, not submission) |
| Bank reconciliation | Formal recon sessions with closing balance and history |
| AR / AP basics | Customer invoices, supplier invoices, basic payment posting |
| Opening balances | Import prior-year TB, balanced, finalized, journal created |
| Basic reports | TB, P&L, Balance Sheet (even if not pixel-perfect) |
| Multi-tenant safety | Company isolation confirmed across all modules |

---

## 4. Readiness Categories

| Colour | Meaning |
|--------|---------|
| Green | Feature is built, tested, and confirmed working in a live environment |
| Amber | Feature is built and code-reviewed; not yet runtime-tested, or tested with known minor gaps |
| Red | Feature is not built, broken in testing, or has a blocking defect |

---

## 5. Module Status Table

| Module | Status | Reason | Next Action |
|--------|--------|--------|-------------|
| Bank import (PDF/CSV) | Amber | Built and architected; not yet runtime-tested end-to-end | Test 3.1–3.4 in PENDING_TESTS.md |
| Bank allocation | Amber | Built including strict GL, appliedRuleId, audit trail; not runtime-tested | Test 3.5–3.13 |
| Bank reconciliation | Amber | Formal recon sessions built; migration run status unknown | Confirm migration; test 4.1–4.8 |
| Bank rules (suggest) | Amber | Full Phase 1 built; migration 048 not yet applied | Apply migration 048; test 5.1–5.10 |
| Trial balance | Amber | Driven by posted journals; not independently tested after recent changes | Test after allocation and opening balance tests |
| General ledger | Amber | Exists; not specifically re-tested after AR/AP strict GL changes | Test drill-down post allocation |
| VAT prep | Amber | VAT report engine and return UI built; not runtime-tested | Test 6.1–6.8 |
| AR invoicing | Amber | Strict GL mode applied; not runtime-tested | Test 7.1–7.2 |
| AP invoicing | Amber | Strict AP guard applied; not runtime-tested | Test 7.3–7.4 |
| Aged debtors | Amber | Built; not runtime-tested | Test 7.5 |
| Aged creditors | Amber | Exists; not re-tested after strict GL changes | Test 7.6 |
| Control account recon | Amber | Built; not runtime-tested | Test 7.7–7.8 |
| Opening balances | Amber | Built; migration run status unknown | Confirm migration; test 8.1–8.5 |
| Historical comparatives | Amber | Built including expand/collapse; migrations 044+045 may not be applied | Apply migrations; test 9.1–9.10 |
| COA sub-accounts | Amber | Built; not runtime-tested | Test 10.1–10.7 |
| Multi-tenant safety | Amber | Architecturally enforced; not tested across all modules with real data | Test 11.1–11.7 |
| Sean AI (bank suggestion) | Red | Phase 2 not yet built — bank rules cover Phase 1 only | Out of scope for pilot (Phase 2 roadmap) |
| Sean auto-mode | Red | Not yet active | Out of scope for pilot |
| Inventory / POS integration | Red | Not pilot-critical | Out of scope for pilot |
| Export packs (IRP5, etc.) | Red | Not pilot-critical | Out of scope for pilot |
| Historical comparative reports (Balance Sheet) | Red | Schema supports it; report not yet built | Post-pilot |
| VAT final submission | Red | Governance layer not built | Post-pilot — VAT prep only for pilot |

---

## 6. Known High-Risk Areas

| Area | Risk | Mitigation |
|------|------|------------|
| VAT final submission governance | Submitting incorrect VAT to SARS is a compliance risk | Pilot uses VAT prep only — no SARS submission from the system during pilot |
| Historical AR/AP as-at reconstruction | As-at aged debtors/creditors depends on accurate historical data | Ensure opening balances loaded correctly before testing AR/AP |
| Sean auto-mode not yet active | Sean cannot auto-post or auto-suggest across modules in pilot | Sean remains advisory/manual during pilot — no auto-post path exists anywhere |
| Inventory / accounting integration | Not built — POS inventory does not feed into accounting GL yet | Pilot excludes POS-to-accounting journal flow |
| Export packs limited | IRP5, audit pack, general export not complete | Pilot reporting is on-screen only; no export dependency |
| Migration gaps | Several migrations may not be applied to production Supabase | Blocker — all Amber modules depend on their migrations being live |

---

## 7. Pilot Acceptance Checklist

The following must be true before the pilot is considered started:

- [ ] At least 2 test clients loaded in Supabase with company records
- [ ] All required migrations applied (042, 044, 045, 048, opening balances, bank recon sessions)
- [ ] Opening balances entered and finalized for each test client
- [ ] At least 1 bank statement imported per test client
- [ ] Allocations posted for imported transactions
- [ ] Trial balance checked and reconciles to opening balance + posted transactions
- [ ] At least 1 VAT period checked in VAT prep screen
- [ ] Bank reconciliation completed for at least 1 period per test client
- [ ] At least 1 customer invoice and 1 supplier invoice posted per test client
- [ ] Aged debtors and aged creditors checked
- [ ] Multi-tenant company switch tested — confirmed no data cross-contamination
- [ ] PENDING_TESTS.md updated with PASS/FAIL for all Pilot Minimum Module tests

---

## 8. Test Coverage by Workstream

| Workstream | Implementation Report | Pending Tests Section |
|------------|-----------------------|-----------------------|
| Bank import/allocation | `docs/accounting/` | Section 3 |
| Bank reconciliation | `docs/accounting/` | Section 4 |
| Bank rules Phase 1 | `BANK_RULES_PHASE_1_IMPLEMENTATION_REPORT.md` | Section 5 |
| VAT report engine | `docs/accounting/VAT_FORENSIC_FIX_PACK_01_REPORT.md` | Section 6 |
| AR/AP strict GL + aged debtors | `docs/accounting/` | Section 7 |
| Opening balances | `docs/accounting/` | Section 8 |
| Historical comparatives | `HISTORICAL_COMPARATIVES_IMPLEMENTATION_REPORT.md` | Section 9 |
| COA sub-accounts | `HISTORICAL_COMPARATIVES_IMPLEMENTATION_REPORT.md §9` | Section 10 |
| Multi-tenant safety | CLAUDE.md + all routes | Section 11 |

---

## 9. Roadmap Beyond Pilot

These items are tracked but out of scope for the pilot:

- Sean AI bank suggestion (Phase 2 — `BANK_RULES_AND_SEAN_AI_FUTURE_ROADMAP.md`)
- Bank rules Phase 3–7 (split lines, regex, customer/supplier, confidence tracking)
- VAT final submission governance
- IRP5 export and payroll integration
- Inventory / POS → accounting journal bridge
- Historical comparative balance sheet report
- Batch CSV/Excel import for historical comparatives
- Sean global ecosystem learning and IRP5 propagation (CLAUDE.md Part B)

---

## 10. Last Updated

**Date:** 2026-05-24  
**Commit:** `2ae3054`  
**Next review point:** After first test session against live Supabase — update Module Status Table and Pilot Acceptance Checklist.
