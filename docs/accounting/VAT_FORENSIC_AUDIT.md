# VAT / BTW FORENSIC AUDIT

## 1. Executive Summary
This audit reviewed VAT settings, VAT account posting, VAT period assignment/locking, out-of-period handling, VAT reconciliation routes/services, and VAT frontend pages.

Current state:
- Core VAT posting rails exist in GL and are mostly robust (customer invoices, supplier invoices, bank allocations, journal VAT assignment).
- VAT period assignment on posting is implemented centrally in journal posting logic.
- VAT lock controls exist and are enforced in key edit/void flows.
- Out-of-period VAT handling exists and is tracked.

Pilot readiness verdict:
- Not yet ready for VAT pilot use without remediation.

Primary reasons:
- No canonical backend VAT return/report endpoint that produces VAT201 figures from posted journals.
- The VAT return page is static and not API-backed.
- VAT reconciliation UI period keys use YYYY.MM while backend VAT engine uses YYYY-MM, creating period alignment risk.
- Bank allocation fallback can post VAT-bearing amounts without VAT split if VAT control account is missing.

## 2. VAT Settings
Q1. Which tables store VAT settings?
- Company-level VAT registration and filing profile: companies (is_vat_registered, vat_period, vat_cycle_type, vat_registered_date, vat_number).
- VAT rate catalogue: vat_settings.
- Period and reconciliation state: vat_periods, vat_reconciliations, vat_reconciliation_lines, vat_submissions, vat_reports.

Q2. Are VAT rates effective-date aware?
- Yes. vat_settings supports effective_from and effective_to.
- Active rate retrieval uses date-window filtering (effective_from <= asOfDate and effective_to null or >= asOfDate).

## 3. VAT Accounts
South African VAT control account model is implemented as:
- Input VAT: code 1400 (typically reporting_group = vat_asset).
- Output VAT: code 2300 (typically reporting_group = vat_liability).

Where these are used:
- Customer invoice posting credits 2300 when vat_amount > 0.
- Supplier invoice posting debits 1400 when vat_amount > 0.
- Bank allocations split VAT into 1400/2300 for account-type allocations.
- Out-of-period VAT summaries detect VAT by reporting_group or 1400/2300 code.

## 4. VAT From Bank Allocations
Q3. Does bank allocation VAT post correctly?
- Partially yes, with an important fallback risk.

Implemented behavior:
- VAT is only supported on ACCOUNT allocation lines (not CUSTOMER or SUPPLIER settlement lines).
- Inclusive/exclusive VAT split is implemented.
- Money in -> output VAT to 2300.
- Money out -> input VAT to 1400.
- Journal is created then posted; integrity check can reverse invalid postings.

Q11. Are unallocated bank transactions excluded from VAT?
- Yes. VAT only reaches GL when allocation creates a posted journal. Unmatched/unallocated transactions do not post journal_lines and therefore do not feed VAT totals.

Q12. Can VAT-bearing entries post if VAT accounts are missing?
- For bank allocations: yes, they can post without VAT split (fallback to gross-to-allocation account), with warning/audit log. This is a material compliance risk.

## 5. VAT From Customer Invoices
Q4. Does customer invoice VAT post correctly?
- Yes for the main posting path.

Implemented behavior:
- VAT calculation supports inclusive and exclusive modes.
- Posting enforces AR 1100 existence.
- If vat_amount > 0, posting requires 2300; missing 2300 blocks posting (422).
- GL posting pattern: DR 1100, CR revenue lines, CR 2300.
- Payments settle AR only (no VAT re-recognition), which is correct for invoice-based VAT recognition.

## 6. VAT From Supplier Invoices
Q5. Does supplier invoice VAT post correctly?
- Yes for the main posting path.

Implemented behavior:
- VAT calculation supports inclusive and exclusive modes.
- Pre-validation blocks invoice creation if 2000 missing.
- If vat_amount > 0, pre-validation blocks creation if 1400 missing.
- GL posting pattern: DR expense lines, DR 1400, CR 2000.
- Supplier payments settle AP only (no VAT re-recognition), which is correct.

## 7. VAT Period Assignment
Q6. Are VAT periods created automatically or manually?
- Both.

Automatic:
- On journal posting, VAT-relevant journals are assigned to derived VAT periods based on company filing settings.
- Missing periods are auto-created.
- If no current open period exists, service can auto-create one.
- Period ranges can be generated in bulk from company VAT settings.

Manual:
- UI creates/gets periods via /vat-recon/periods.
- Periods can be manually locked via /vat-recon/periods/:id/lock.

Critical inconsistency:
- Backend period utilities use YYYY-MM keys.
- VAT page selector currently uses YYYY.MM keys.
- This can split reconciliation periods from posting-assigned periods.

## 8. VAT Period Locking
Q7. What happens if a VAT period is locked?
- Reconciliation edits are blocked for locked periods.
- Manual lock endpoint sets VAT period to LOCKED and also locks related VAT report/reconciliation rows.
- SARS submission flow locks reconciliation + period + VAT report.
- Customer invoice void flow checks VAT period lock and blocks if locked.
- Supplier invoice edit flow checks VAT period lock and blocks if locked.

## 9. Out-of-Period VAT
Q8. Are out-of-period transactions tracked?
- Yes.

Behavior:
- If journal date derives to a LOCKED VAT period, posting routes to current open period.
- Journal is marked is_out_of_period = true and stores out_of_period_original_date.
- Target period out_of_period counters/totals are incremented.
- API exposes out-of-period journals and VAT totals per period.

## 10. VAT Report Flow
Q9. Does VAT report read posted journal_lines only?
- There is no dedicated backend VAT report endpoint producing VAT201 figures.
- Existing VAT data feed in vat-recon uses trial-balance data from journals with status = posted and then relies on UI-side manual/proefbalans inputs.
- vat-return.html is currently static/hardcoded and not API-backed.

Conclusion:
- Posted journal_lines are available and used in parts of VAT recon, but there is no single authoritative VAT report service yet.

## 11. VAT Reconciliation Flow
Current reconciliation lifecycle:
- Create/get period.
- Save draft reconciliation lines.
- Authorize differences (income/expense and SOA).
- Approve reconciliation.
- Submit to SARS (creates submission row, locks reconciliation and period).

Notes:
- Reconciliation lines are replace-on-save, versioned at header level.
- Retrieval prioritizes APPROVED, then LOCKED, then latest version.

## 12. TB / VAT Control Account Reconciliation
Q10. Does VAT report reconcile to VAT accounts in TB?
- Partially and not yet in a governed backend reconciliation.

What exists:
- vat-recon trial-balance endpoint reads posted journals and exposes account balances.
- VAT stat cards are populated from TB balances of 1400 and 2300.

What is missing:
- No server-side enforced reconciliation artifact that proves VAT return totals tie to VAT control accounts and transaction-level VAT sources for each period.
- vat-return page does not consume backend VAT computations.

## 13. Multi-Tenant Safety
Q14. Is company scoping enforced everywhere?
- Largely yes.

Enforcement pattern:
- Accounting module is mounted behind authenticateToken and requireModule('accounting').
- Accounting auth bridge normalizes req.user.companyId from scoped context.
- Routes and queries consistently filter by company_id/req.companyId/req.user.companyId.
- Service methods receive companyId and scope reads/writes accordingly.

Residual concern:
- As with any large codebase, this should still be regression-tested with cross-company negative tests during pilot hardening.

## 14. What Is Working And Must Be Protected
- Effective-date VAT settings with idempotent default seeding.
- VAT-inclusive/exclusive line calculation in both AR and AP flows.
- Strict blocking of AR/AP posting when mandatory control accounts are missing (except bank allocation fallback path).
- Central VAT period assignment in JournalService.postJournal before status update.
- Out-of-period rerouting and counters.
- VAT lock guards on supplier invoice edits and customer invoice void.
- Atomic journal create/update/reverse patterns with rollback protection.

## 15. Confirmed Risks
- No canonical backend VAT return/report endpoint for VAT201 outputs.
- vat-return page is static and not connected to real VAT data.
- Period key mismatch risk: UI uses YYYY.MM while backend VAT engine uses YYYY-MM.
- Bank allocation fallback can post VAT-bearing entries without VAT split when 1400/2300 are missing.
- Reconciliation UI currently depends on manual grid inputs for parts of VAT logic.
- Mixed status conventions (open/DRAFT/APPROVED/LOCKED) increase edge-case risk.
- vat_submissions filtering by status is coded but status column is not defined in schema.

## 16. Recommended Workstreams
1. Build authoritative VAT report service
- Add backend endpoint(s) generating VAT201 fields from posted journals, VAT settings, and period assignments.
- Persist report snapshots per period/version for audit traceability.

2. Normalize VAT period keys and statuses
- Standardize to one period key format (recommended YYYY-MM) across UI, services, and journal assignment.
- Standardize status enums and case.

3. Remove silent VAT fallback in bank allocations
- Block VAT-bearing allocation when required VAT account is missing, instead of gross fallback.

4. Wire vat-return to backend data
- Replace static values with API-driven values from authoritative VAT report service.

5. Strengthen reconciliation governance
- Add server-side checks that tie VAT return totals to VAT control account movements and source journals per period.

6. Pilot hardening tests
- Multi-tenant negative tests.
- Locked-period mutation tests.
- Out-of-period scenarios across filing frequencies.
- Missing-account guard tests for all VAT-bearing entry points.

## 17. Questions For Ruan Before Code Changes
1. Do you want VAT recognized strictly on invoice posting date (current pattern), or any cash-basis exceptions per client?
2. Should bank allocation with VAT selected be hard-blocked when 1400/2300 are missing (recommended), with no fallback posting?
3. Which period key format is the standard for the product going forward: YYYY-MM or YYYY.MM?
4. Should VAT period statuses be standardized to OPEN/DRAFT/APPROVED/LOCKED, and which transitions are permitted?
5. Must VAT return numbers be immutable snapshots once period is locked, even if later out-of-period items are discovered?
6. Should out-of-period VAT always roll into current open period, or be held in a separate adjustment queue for explicit approval?
7. Do you want a strict reconciliation gate that blocks SARS submission unless TB/control-account tie-outs are within tolerance?
8. Do you require a per-field VAT201 audit trail (source journals and calculations) downloadable for client sign-off?
9. Should VAT report generation be backend-only (no manual UI amount entry), or keep manual override lanes with authorization?
10. For pilot clients, what is the minimum acceptance pack: functional tests only, or functional + accounting sign-off + migration validation?
