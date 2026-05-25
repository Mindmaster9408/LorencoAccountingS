# REPORTING ENGINE FORENSIC AUDIT

## 1. Executive Summary
This is a read-only forensic audit of the accounting reporting engine for pilot trust readiness.

Overall result: core financial reports are mostly built from posted GL truth and are close to pilot-safe, but there are specific risks that must be resolved before full accountant trust signoff.

High-confidence strengths:
- Core TB, P&L, Balance Sheet, and GL logic filters on posted journals.
- Reversal handling is structurally correct for posted-only report models.
- Historical comparative reporting is isolated from live reporting tables.
- Multi-tenant scoping is consistently present in most reporting queries.

Confirmed risks:
- Bank reconciliation reads bank transactions by bank account ID without explicit company filter in key queries.
- Manual vs system journal separation is not available in main financial reports.
- Some reports are derived from operational/sub-ledger balances, not only posted journal_lines.
- Division P&L has potentially expensive repeated scans per segment value.

## 2. Reporting Architecture
Primary live-report engine:
- routes/reports.js

Specialized reporting engines:
- routes/vat-report.js -> services/vatReportService.js
- routes/historicalComparatives.js -> services/historicalComparativesService.js

Query strategy is mixed by design:
- Direct PG (db.query) for heavy journal/journal_line aggregations and historical comparative SQL report builders.
- Supabase/PostgREST for metadata, dimensional data, and smaller retrievals.

Core route mount points:
- /api/accounting/reports/*
- /api/accounting/vat/report
- /api/accounting/historical-comparatives/reports/*

## 3. Trial Balance Audit
Endpoint:
- GET /api/accounting/reports/trial-balance

Truth source:
- Accounts list from accounts table.
- Amounts from journal_lines INNER JOIN journals with status = 'posted'.

Behavior:
- Date range filters are applied on journal date.
- Balance is calculated as debit minus credit.
- Includes all posted journal source types (manual and system), with no source-type split.

Assessment:
- Truth model is correct for GL-based reporting.
- Draft journals are excluded.
- Reversed originals are excluded because only status='posted' is included.

## 4. Profit & Loss Audit
Endpoints:
- GET /api/accounting/reports/profit-loss
- GET /api/accounting/reports/division-profit-loss

Truth source:
- Posted journal_lines via shared fetchAccountBalances helper.

Behavior:
- Income sign: credit minus debit.
- Expense sign: debit minus credit.
- Optional segment filter for profit-loss.
- Division report computes per-division, untagged, and total columns.

Assessment:
- Core sign and posted-only logic are consistent.
- Division report is correct in intent but potentially expensive due to repeated data fetches per division.

## 5. Balance Sheet Audit
Endpoint:
- GET /api/accounting/reports/balance-sheet

Truth source:
- Asset/liability/equity balances from posted journals as-of date.
- Current-year earnings derived from posted income/expense journals over date window.

Behavior:
- Asset sign: debit minus credit.
- Liability/equity sign: credit minus debit.
- Net income injected into equity total.

Assessment:
- Sign convention is internally consistent.
- Uses posted truth correctly.
- Depends on fromDate input quality for current-year earnings scope.

## 6. General Ledger Audit
Endpoint:
- GET /api/accounting/reports/general-ledger

Truth source:
- Opening balance from posted lines prior to fromDate.
- Period lines from posted lines within date filters.

Behavior:
- Running balance is computed after sorting by date then journal_id.
- Closing balance = opening + debits - credits.

Assessment:
- Strong drilldown-quality report for one account.
- Correct posted-only behavior and date-bound opening logic.

## 7. Bank Reporting Audit
Endpoints:
- GET /api/accounting/reports/bank-reconciliation
- GET /api/accounting/reports/unallocated-bank-transactions
- GET /api/accounting/reports/bank-recon-history
- GET /api/accounting/reports/bank-recon-history/:sessionId

Truth sources:
- Ledger balance uses posted journal_lines for bank ledger account.
- Statement/unreconciled components use bank_transactions operational data.

Important findings:
- Unallocated transactions are intentionally excluded from GL-based statements but explicitly surfaced in dedicated unallocated report.
- Bank reconciliation mixes ledger truth and operational transaction status data by design.
- Key bank_reconciliation transaction lookups are filtered by bank_account_id, not explicitly by company_id.

Assessment:
- Useful operationally, but not pure posted-GL truth.
- Requires scoping hardening before pilot-safe classification.

## 8. VAT Reporting Audit
Endpoint:
- GET /api/accounting/vat/report

Truth source:
- Posted journal_lines joined to accounts code 1400/2300.

Behavior:
- Input VAT: sum(debit-credit) on account 1400.
- Output VAT: sum(credit-debit) on account 2300.
- Supports normalized period key parsing and fallback month boundaries.
- Source breakdown uses source_type classification with unclassified warning handling.

Assessment:
- Core VAT totals are posted-only and structurally sound.
- Source classification can be incomplete when source_type values fall outside expected mapping.

## 9. Control Reconciliation Reporting Audit
Endpoint:
- GET /api/accounting/reports/control-account-reconciliation

Truth sources:
- GL side: posted journal_lines for control account codes 1100 (AR) and 2000 (AP).
- Sub-ledger side: outstanding balances from customer_invoices / supplier_invoices.

Behavior:
- Explicit warning generation for manual postings to control accounts.
- Explicit warning generation for orphan invoices/payments without journal linkage.

Assessment:
- Strong forensic diagnostics report.
- Not strictly a pure posted-journal report because it intentionally compares GL to live sub-ledger balances.

## 10. Historical Comparative Reporting Audit
Endpoints:
- /api/accounting/historical-comparatives/reports/monthly-pl
- /api/accounting/historical-comparatives/reports/tb-comparative
- /api/accounting/historical-comparatives/reports/multi-year
- /api/accounting/historical-comparatives/reports/account-trend
- /api/accounting/historical-comparatives/dashboard/trends

Truth source:
- historical_comparative_lines + historical_comparative_batches (separate store from live journals).

Behavior:
- Default mode finalized_only.
- Draft preview/all available only to allowed roles.

Assessment:
- No contamination into live reports found.
- Designed intentionally as isolated reporting domain.

## 11. Draft vs Posted Journal Handling
Live financial reports in reports.js and vatReportService consistently filter journals by status='posted' for journal-derived balances.

Implications:
- Draft journals are excluded from TB, P&L, BS, GL, control GL side, and VAT totals.
- Historical comparative reports are a separate model with controllable status mode.

Assessment:
- Live posted-only principle is mostly enforced correctly.

## 12. Reversal Handling
Reversal model impact on reporting:
- Original journal status changes to reversed.
- Reversal journal is posted.
- Report queries filtering status='posted' naturally remove reversed originals and include posted reversals.

Assessment:
- Reversal handling in reporting is correct under posted-only query policy.

## 13. System vs Manual Journal Handling
Main report endpoints do not separate manual vs system journal contributions.

Current state:
- TB/P&L/BS/GL include all posted journals regardless of source_type.
- Journals listing route supports manual/system scope, but this separation is not exposed in financial statement report endpoints.
- Control reconciliation flags manual control-account postings as warnings.

Assessment:
- Financial statements are comprehensive, but forensic source separation is limited.

## 14. Date Filtering Integrity
Observed date filtering patterns are mostly consistent and inclusive:
- Period filters use >= fromDate and <= toDate.
- GL opening uses strictly < fromDate.
- As-of reports use <= asOfDate.

Assessment:
- Date filters are broadly accurate.
- Reliability still depends on consistent parameter quality (for example fromDate provided where required).

## 15. Multi-Tenant Safety
Strong pattern:
- Most reporting queries explicitly scope by req.user.companyId.

Confirmed concern:
- In bank-reconciliation, key bank_transactions reads are filtered by bank_account_id without explicit company_id constraint.

Risk:
- Even if bank_account_id is globally unique in practice, missing company_id predicates reduce defense-in-depth and should be treated as pilot blocker.

## 16. Performance and Query Strategy
Current strategy:
- Heavy aggregation moved to direct PG SQL joins to avoid PostgREST .in URL-length constraints.
- Supabase used for metadata/smaller reads.

Performance strengths:
- fetchAccountBalances consolidates line retrieval into efficient SQL joins.
- Count and line queries executed in parallel where appropriate.

Performance risks:
- Division P&L loops through each segment value and re-runs account-balance fetches, potentially scaling poorly with many divisions.
- Bank reconciliation can read large transaction sets depending on account history and date.

## 17. What Is Working And Must Be Protected
- Posted-only journal policy for core live financial reports.
- Consistent sign logic in TB/P&L/BS/GL.
- Reversal exclusion/inclusion behavior via status='posted'.
- Control reconciliation warning framework for orphan and manual anomalies.
- Historical comparative isolation from live report sources.
- Direct PG join architecture for large-ledger stability/performance.

## 18. Confirmed Risks
- Bank reconciliation query scoping gap (missing explicit company filter on key bank_transactions reads).
- Main statement reports cannot split manual vs system journal impact.
- Some reports intentionally mix GL and operational/sub-ledger truth, which can be misunderstood as pure GL truth.
- VAT source breakdown can leave unclassified sources.
- Division P&L repeated fetch design may become a bottleneck at scale.

## 19. Recommended Workstreams
1. Tenant-safety hardening for bank reconciliation queries by adding explicit company predicates everywhere bank_transactions are read.
2. Add optional report-level source_type filtering/splitting for TB/P&L/BS/GL to support accountant forensic workflows.
3. Introduce a standardized report truth badge per endpoint: posted_gl_only, mixed_gl_operational, or historical_snapshot.
4. Optimize division P&L with one grouped query (or pre-aggregated strategy) rather than per-division repeated fetch passes.
5. Expand VAT source classification mapping and surface unknown source_type values with explicit category counts.
6. Add endpoint-level pilot-safe checklist and automated query-contract tests for posted-only, company-scope, and date filter integrity.

## 20. Questions For Ruan Before Code Changes
1. Should bank reconciliation be treated as a pure financial statement artifact or as an operational reconciliation view that can include unmatched/matched transaction state?
2. Do you want TB/P&L/BS/GL to support optional manual-vs-system columns for forensic review?
3. For pilot policy, should any endpoint with mixed GL/sub-ledger truth be labeled non-statutory by default?
4. Should historical comparative draft-preview endpoints be disabled in pilot environments unless explicitly enabled?
5. What is the acceptable performance target for division P&L at expected max segment count per company?
6. Should VAT unknown source_type entries be hard-fail, warning-only, or mapped to a standard fallback bucket?
7. Do you want a strict pilot gate that fails deployment if any report query is missing explicit company_id predicate?

---

Forensic answers to required questions

1. Which reports use posted journal_lines only?
- Trial Balance, Profit & Loss, Division P&L, Balance Sheet, General Ledger, VAT totals/source aggregates, and the GL sides of control reconciliation and bank ledger balance.

2. Which reports still rely on derived/live calculations?
- Bank reconciliation statement/unreconciled components and control-account sub-ledger sides (customer/supplier outstanding balances).

3. Are unallocated bank transactions excluded everywhere?
- Excluded from GL-based statements; intentionally included in unallocated-bank-transactions and used operationally in bank reconciliation.

4. Are reversed journals excluded correctly?
- Yes, by status='posted' filtering.

5. How are system journals handled?
- Included with manual journals in main statements unless specifically filtered elsewhere.

6. Are manual journals separated cleanly?
- Not in core financial report endpoints.

7. Are report signs consistent?
- Yes, consistently applied across TB/P&L/BS/GL/VAT/control reports.

8. Are date filters accurate?
- Mostly yes; inclusive bounds are consistent and GL opening uses strict pre-period logic.

9. Are opening balances treated correctly?
- Generally yes in GL/BS logic; bank context should be reviewed for potential opening-balance duplication scenarios depending on data entry process.

10. Does historical comparative reporting contaminate live reports?
- No, it is isolated in separate routes/tables.

11. Are draft journals excluded everywhere?
- In live GL-derived reporting: yes.

12. Can cross-company report leakage occur anywhere?
- Confirmed risk area in bank-reconciliation transaction reads lacking explicit company filter.

13. Which reports use direct pg queries?
- Most heavy live financial reports, VAT service calculations, control reconciliation, and historical comparative SQL reports.

14. Which reports still use Supabase/PostgREST?
- Metadata/dimensional and operational report portions, including accounts lookup, bank account/session/transaction retrieval, segment setup retrieval, and route-level object fetching.

15. Which reports are not yet pilot-safe?
- Bank reconciliation (until explicit tenant scoping is hardened) and any report view that requires mandatory manual/system separation for pilot forensic policy.
