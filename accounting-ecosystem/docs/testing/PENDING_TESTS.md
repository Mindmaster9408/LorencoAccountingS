# PENDING TESTS REGISTER

**Owner:** Ruan (runtime verification) + Claude Code (tracking)  
**Last updated:** 2026-05-24  
**Commit:** _(update after each test pass)_

---

## 1. Purpose

This file is the single source of truth for all manual and runtime tests that are outstanding before pilot launch.

Every feature built in recent workstreams has been code-reviewed and architecturally validated, but many have not yet been executed against a live Supabase environment with real data. This register captures what still needs to be verified so nothing falls through the cracks between implementation and pilot.

**Rules:**
- Update status in this file after each test session.
- If a test fails, log the failure in the Notes column and open a fix before marking it PASS.
- BLOCKED means a prerequisite (e.g. a migration not yet run) is preventing the test from being executed.
- Do not mark a test PASS based on code review alone — it must be executed in a running environment.

---

## 2. Test Status Legend

| Symbol | Meaning |
|--------|---------|
| NOT TESTED | Not yet run against a live environment |
| PARTIAL | Run but not all scenarios covered |
| PASS | Executed and confirmed working |
| FAIL | Executed, found a defect — fix required |
| BLOCKED | Cannot test until a prerequisite is resolved |

---

## 3. Bank Import / Allocation

> **Prerequisites:** Bank import routes live, staging table exists, `bank_transactions` table exists.

| # | Test | Status | Notes |
|---|------|--------|-------|
| 3.1 | PDF bank statement imports and parses correctly | NOT TESTED | |
| 3.2 | CSV bank statement imports and parses correctly | NOT TESTED | |
| 3.3 | Imported rows land in staging table | NOT TESTED | |
| 3.4 | Staging confirm moves rows to `bank_transactions` | NOT TESTED | |
| 3.5 | Duplicate detection blocks re-import of same transaction | NOT TESTED | |
| 3.6 | Transfer detection flags intra-company transfers | NOT TESTED | |
| 3.7 | Single-line allocation (debit → one GL account) creates journal | NOT TESTED | |
| 3.8 | Allocation with VAT setting splits correctly | NOT TESTED | |
| 3.9 | Split allocation across multiple accounts creates multi-line journal | NOT TESTED | |
| 3.10 | Allocation creates journal entry in `journals` + `journal_lines` | NOT TESTED | |
| 3.11 | Transaction status becomes `matched` after allocation | NOT TESTED | |
| 3.12 | Trial balance updates correctly after allocation | NOT TESTED | |
| 3.13 | Failed/reversed allocation reverses the journal entry | NOT TESTED | |

---

## 4. Bank Reconciliation

> **Prerequisites:** Bank recon sessions migration applied, `bank_recon_sessions` table exists.

| # | Test | Status | Notes |
|---|------|--------|-------|
| 4.1 | Statement date saved to recon session | NOT TESTED | |
| 4.2 | Closing balance saved to recon session | NOT TESTED | |
| 4.3 | `bank_recon_sessions` row created on session open | NOT TESTED | |
| 4.4 | `recon_session_id` linked to bank transactions during recon | NOT TESTED | |
| 4.5 | Unmatched transactions show "Requires allocation first" message | NOT TESTED | |
| 4.6 | Matched/allocated transactions can be ticked as reconciled | NOT TESTED | |
| 4.7 | Recon history endpoint returns past sessions | NOT TESTED | |
| 4.8 | Unallocated bank report returns correct rows | NOT TESTED | |

---

## 5. Bank Rules

> **Prerequisites:** Migration `048_bank_allocation_rules.sql` run in Supabase.

| # | Test | Status | Notes |
|---|------|--------|-------|
| 5.1 | Migration 048 applied — `bank_allocation_rules` table exists | BLOCKED | Must be run manually in Supabase SQL Editor |
| 5.2 | Create a rule via `bank-rules.html` — saved correctly | NOT TESTED | |
| 5.3 | Parent (non-postable) account rejected when creating rule | NOT TESTED | |
| 5.4 | Rule suggestion prefills account + VAT on unmatched bank row | NOT TESTED | |
| 5.5 | Manually changing account after suggestion clears `appliedRuleId` | NOT TESTED | |
| 5.6 | Override banner shows "Rule suggestion overridden." | NOT TESTED | |
| 5.7 | Accepting suggestion passes `appliedRuleId` in allocation payload | NOT TESTED | |
| 5.8 | `appliedRuleId` stored in journal metadata after allocation | NOT TESTED | |
| 5.9 | `BANK_RULE_ACCEPTED` audit event logged | NOT TESTED | |
| 5.10 | No `safeLocalStorage` allocation draft written anywhere | NOT TESTED | Check DevTools → Application → Storage |

---

## 6. VAT

> **Prerequisites:** VAT report migration applied, `vat_settings` populated for test company.

| # | Test | Status | Notes |
|---|------|--------|-------|
| 6.1 | VAT report endpoint (`/api/accounting/vat/report`) returns data | NOT TESTED | |
| 6.2 | VAT return frontend (`vat-return.html`) renders without errors | NOT TESTED | |
| 6.3 | Period `YYYY.MM` format normalised to `YYYY-MM` on submission | NOT TESTED | |
| 6.4 | Bank transaction with VAT missing account 1400 (input VAT) is blocked | NOT TESTED | |
| 6.5 | Bank transaction with VAT missing account 2300 (output VAT) is blocked | NOT TESTED | |
| 6.6 | AR invoice VAT still calculated and posted correctly | NOT TESTED | |
| 6.7 | AP invoice VAT still calculated and posted correctly | NOT TESTED | |
| 6.8 | Unallocated bank transactions excluded from VAT report | NOT TESTED | |

---

## 7. AR / AP

> **Prerequisites:** AR/AP routes live, strict GL mode active, aged debtors migration applied.

| # | Test | Status | Notes |
|---|------|--------|-------|
| 7.1 | Customer invoice posts to correct AR control account | NOT TESTED | |
| 7.2 | Customer payment strict GL — non-AR account rejected | NOT TESTED | |
| 7.3 | Supplier invoice strict AP account guard — non-AP account rejected | NOT TESTED | |
| 7.4 | Supplier payment strict GL — non-AP account rejected | NOT TESTED | |
| 7.5 | Aged debtors report loads and shows correct buckets | NOT TESTED | |
| 7.6 | Aged creditors report loads and shows correct buckets | NOT TESTED | |
| 7.7 | Control account reconciliation — AR tab shows correct balance | NOT TESTED | |
| 7.8 | Control account reconciliation — AP tab shows correct balance | NOT TESTED | |

---

## 8. Opening Balances

> **Prerequisites:** Opening balances migration applied, `opening_balance_batches` table exists.

| # | Test | Status | Notes |
|---|------|--------|-------|
| 8.1 | Create opening balance batch | NOT TESTED | |
| 8.2 | Unbalanced trial balance blocked from finalizing | NOT TESTED | |
| 8.3 | Balanced trial balance finalizes successfully | NOT TESTED | |
| 8.4 | Opening journal entry created in `journals` on finalization | NOT TESTED | |
| 8.5 | Trial balance reflects opening balance amounts | NOT TESTED | |

---

## 9. Historical Comparatives

> **Prerequisites:** Migrations 042, 044, 045 applied in Supabase.

| # | Test | Status | Notes |
|---|------|--------|-------|
| 9.1 | Create batch via `historical-comparatives.html` | NOT TESTED | |
| 9.2 | Manual amount capture and Save works | NOT TESTED | |
| 9.3 | COA Sync populates account list | NOT TESTED | |
| 9.4 | Monthly P&L comparative report renders with finalized data | NOT TESTED | |
| 9.5 | Finalize locks all inputs | NOT TESTED | |
| 9.6 | Finalized batch — editing blocked (403 returned) | NOT TESTED | |
| 9.7 | Parent/sub-account grouping renders correctly (parent = section header, child = editable grid) | NOT TESTED | |
| 9.8 | Expand/collapse tree UI — group headers toggle children | NOT TESTED | |
| 9.9 | Expand All / Collapse All buttons work | NOT TESTED | |
| 9.10 | Save All includes data from collapsed (hidden) groups | NOT TESTED | |

---

## 10. COA Sub-Accounts

| # | Test | Status | Notes |
|---|------|--------|-------|
| 10.1 | "Create Sub Account" button visible in edit modal for postable parent | NOT TESTED | |
| 10.2 | Button hidden for inactive accounts, sub-accounts, and system accounts | NOT TESTED | |
| 10.3 | Sub-account modal auto-suggests next suffix (`001`, `002`, …) | NOT TESTED | |
| 10.4 | Creating sub-account sets parent `is_postable = false` | NOT TESTED | |
| 10.5 | Parent account cannot post to journals after first sub-account | NOT TESTED | |
| 10.6 | Child (sub-account) can post to journals | NOT TESTED | |
| 10.7 | Reports group parent and children correctly | NOT TESTED | |

---

## 11. Multi-Tenant Safety

| # | Test | Status | Notes |
|---|------|--------|-------|
| 11.1 | Switch company — dashboard reloads with new company's data | NOT TESTED | |
| 11.2 | Reports isolated — Company A data not visible when logged in as Company B | NOT TESTED | |
| 11.3 | Bank transactions isolated by company | NOT TESTED | |
| 11.4 | AR/AP invoices isolated by company | NOT TESTED | |
| 11.5 | VAT report isolated by company | NOT TESTED | |
| 11.6 | Bank allocation rules isolated by company | NOT TESTED | |
| 11.7 | Historical comparative data isolated by company | NOT TESTED | |

---

## 12. Pilot Blockers

| Area | Blocker | Severity | Owner | Status | Notes |
|------|---------|----------|-------|--------|-------|
| Bank Rules | Migration 048 not yet applied to Supabase | HIGH | Ruan | OPEN | Run `048_bank_allocation_rules.sql` in Supabase SQL Editor |
| Historical Comparatives | Migrations 044 + 045 may not be applied | HIGH | Ruan | OPEN | Run `044_coa_sub_accounts.sql` and `045_historical_coa_sync.sql` |
| Opening Balances | Opening balance migration run status unknown | HIGH | Ruan | OPEN | Confirm `opening_balance_batches` table exists |
| Bank Recon | Recon sessions migration run status unknown | MEDIUM | Ruan | OPEN | Confirm `bank_recon_sessions` table exists |
| VAT | `vat_settings` must be populated for test company | MEDIUM | Ruan | OPEN | At least one VAT rate configured before testing |
| All | No test client data loaded | HIGH | Ruan | OPEN | Load at least 2 test clients with accounts, opening balances, and bank statements before pilot |

---

## 13. Last Updated

**Date:** 2026-05-24  
**Commit:** `2ae3054` (historical-comparatives expand/collapse)  
**Next update:** After first test session against live Supabase environment
