# PERIOD LOCKING AND FINALIZATION FORENSIC AUDIT

## 1. Audit Header
- Audit type: Read-only forensic audit (no code edits, no migrations run)
- Requested focus: Period locking and finalization behavior across accounting, VAT, AR/AP, bank, opening balances, historical comparatives, and year-end close
- Date: 2026-05-24
- Auditor: GitHub Copilot (GPT-5.3-Codex)

## 2. Scope and Method
- Method: Static code inspection only (routes, services, middleware, permissions, schema/migration files)
- Scope in backend accounting module:
  - Lock control surfaces: `routes/accounting-periods.js`, `services/journalService.js`, `routes/vatRecon.js`, `services/vatReconciliationService.js`
  - Flow endpoints: `routes/journals.js`, `routes/bank.js`, `routes/customer-invoices.js`, `routes/suppliers.js`, `routes/openingBalances.js`, `services/openingBalancesService.js`, `routes/historicalComparatives.js`, `services/historicalComparativesService.js`, `routes/yearEnd.js`
  - Observability and access: `services/auditLogger.js`, `routes/audit.js`, `middleware/auth.js`, `backend/middleware/auth.js`, `backend/config/permissions.js`
  - Data model references: `database/012_accounting_schema.sql`, `database/migrations/019_year_end_close.sql`, `database/migrations/042_historical_comparatives.sql`, `database/migrations/046_opening_balances.sql`

## 3. Key Data Structures for Locking and Finalization
- `accounting_periods`:
  - Core fields: `from_date`, `to_date`, `is_locked`, `locked_by_user_id`
  - Used by accounting lock enforcement (`JournalService.isPeriodLocked`)
- `vat_periods`:
  - Core fields: `period_key`, `status`, `locked_by_user_id`, `locked_at`
  - VAT lock state is status-driven (`status = LOCKED`)
- `year_end_close_records`:
  - Unique key `(company_id, from_date, to_date)` enforces year-end close idempotency
- `opening_balance_batches`:
  - Lifecycle status: `draft`, `validated`, `finalized`, `archived`
  - Finalization creates one posted GL journal and stores `journal_id`
- `historical_comparative_batches`:
  - Lifecycle status: `draft`, `validated`, `finalized`, `archived`
  - Finalized status drives immutability for historical data
- `accounting_audit_log`, `opening_balance_audit_log`, `historical_comparative_audit_log`:
  - Audit footprints exist in both generic and module-specific stores

## 4. Control Surfaces and Ownership of Lock Decisions
- Accounting lock owner:
  - API ownership in `routes/accounting-periods.js`
  - Runtime enforcement centralized in `services/journalService.js`
- VAT lock owner:
  - API ownership in `routes/vatRecon.js` and `services/vatReconciliationService.js`
  - Runtime check helper in `services/journalService.js` via `isVatPeriodLocked`
- Finalization owners:
  - Opening balances: `services/openingBalancesService.js`
  - Historical comparatives: `services/historicalComparativesService.js`
  - Year-end: `routes/yearEnd.js`

## 5. Accounting Lock vs VAT Lock Separation
- Confirmed: accounting locks and VAT locks are separate systems.
- Accounting lock:
  - Date-based check against `accounting_periods.is_locked`.
  - Applied to create/update/post/reverse journal-level operations through `JournalService`.
- VAT lock:
  - Status-based check against `vat_periods.status = LOCKED`.
  - Applied selectively where VAT mutation risk exists (for example supplier invoice edit, customer invoice void, bank unallocate).
- Conclusion:
  - Separation is intentional and implemented.
  - It is not a single unified lock graph; it is dual-lock architecture with partial overlap.

## 6. Journal Layer Enforcement Matrix
- `createDraftJournal`: blocks if accounting period locked.
- `updateDraftJournal`: blocks moving/editing into locked accounting period.
- `postJournal`: blocks posting if journal date falls in locked accounting period.
- `reverseJournal`:
  - Blocks if original journal date is in locked accounting period.
  - Also blocks if reversal posting date (today) is locked.
- Route-level blocked audit:
  - `routes/journals.js` logs `JOURNAL_BLOCKED_LOCKED_PERIOD` on post/reverse lock failures.
- Assessment:
  - Core accounting lock enforcement is strong and centralized at journal service layer.

## 7. Bank Flow Locking Findings
- Allocation flow (`routes/bank.js`):
  - Creates and posts GL journal through `JournalService`.
  - Therefore accounting period lock is inherited and enforced indirectly.
- Unallocate flow:
  - Explicit VAT lock guard (`isVatPeriodLocked`) before reversal.
  - Reversal itself also hits accounting lock guards in `reverseJournal`.
- Reconcile/unreconcile flows:
  - Status transitions on bank transaction records; do not create new journals.
  - No explicit accounting period lock check here.
- Risk note:
  - Reconcile/unreconcile are operational state changes and can occur even when accounting period is locked, because they do not pass through accounting lock guards.

## 8. AR Flow Locking Findings (Customer Invoices)
- Post invoice:
  - Creates and posts journal via `JournalService`; accounting lock enforced by service.
- Void invoice:
  - Explicit VAT lock guard on linked `journal_id`.
  - Reversal call then inherits accounting lock checks in `reverseJournal`.
- Record customer payment:
  - Creates and posts payment journal via `JournalService`; accounting lock enforced.
- Edit behavior:
  - Draft-only behavior is status-driven.
  - No explicit VAT lock gate on edit path itself, but VAT-impacting mutation for posted invoices is mostly constrained by status lifecycle.
- Observability:
  - Blocked void attempts include explicit audit entries (reason codes for VAT lock and other blockers).

## 9. AP Flow Locking Findings (Supplier Invoices and Payments)
- Supplier invoice creation:
  - Immediate GL posting via `JournalService`; accounting lock enforced.
- Supplier invoice edit:
  - Explicit VAT lock guard on existing linked journal.
  - Accounting-impacting edits trigger replacement journal post + reverse original.
  - Both replacement post and reverse inherit accounting lock enforcement.
- Supplier payment:
  - Payment GL post is journal-first via `JournalService`; accounting lock enforced.
- Assessment:
  - AP has stronger explicit VAT lock guard on edit than AR edit.

## 10. Reversal Behavior in Locked Contexts
- Global behavior from `reverseJournal`:
  - Original-period lock hard blocks reversal to protect locked historical reporting integrity.
  - Current-date lock also blocks writing reversal journal in locked current period.
- Practical effect:
  - Users cannot reverse historical posted journals in locked periods without unlocking period first.
  - This enforces immutability at accounting-period level.

## 11. Opening Balance Finalization Findings
- Lifecycle controls:
  - Mutable only in `draft`/`validated`; finalized batches immutable by status gate.
- Finalize gate:
  - Re-validates batch prior to finalization.
  - Explicit accounting period lock check on `effective_date` via `JournalService.isPeriodLocked`.
  - Finalization posts exactly one GL journal and writes back `journal_id`.
- Auditability:
  - Dedicated `opening_balance_audit_log` with line and batch actions.
- Assessment:
  - Opening balance finalization has explicit accounting lock enforcement and strong lifecycle controls.

## 12. Historical Comparatives Finalization Findings
- Lifecycle controls:
  - Finalized batches immutable; edit/save/rescale paths block on finalized status and log `FINALIZED_EDIT_BLOCKED`.
- Finalize gate:
  - Requires `validated` status and marks lines and batch finalized.
- Important distinction:
  - This module is intentionally isolated from live journals/ledger posting.
  - No accounting-period lock checks are implemented because no journal posting occurs.
- Assessment:
  - Strong internal immutability model, but separate from accounting period lock domain by design.

## 13. Year-End Close and Year-End Opening Behavior
- Year-end close (`routes/yearEnd.js`):
  - Idempotency guard via prior close record lookup and unique constraint.
  - Explicit accounting period lock check on closing date (`toDate`).
  - Atomic direct transaction for closing journal + lines + close record.
  - Optional period lock step after close can set `accounting_periods.is_locked`.
- Year-end opening balances endpoint:
  - Validates line balance and checks accounting lock on requested date.
  - Uses standard `JournalService` create/post flow.
- Assessment:
  - Year-end path includes explicit lock checks plus transactional integrity.

## 14. Audit Logging and Blocked-Attempt Traceability
- Logging infrastructure:
  - Generic accounting log table via `AuditLogger` (`accounting_audit_log`).
  - Specialized logs for opening balances and historical comparatives.
- Confirmed blocked-attempt logging:
  - Journals post/reverse lock blockers: `JOURNAL_BLOCKED_LOCKED_PERIOD`.
  - Customer invoice void blockers include VAT-locked reason metadata.
  - Supplier invoice edit blockers include VAT-locked reason metadata.
  - Year-end duplicate close blocker logs `YEAR_END_CLOSE_BLOCKED`.
- Coverage gap:
  - Not all lock blocks across all flows are uniformly logged with a normalized reason code taxonomy.

## 15. Override and Privileged Path Analysis
- Accounting period unlock path:
  - `POST /api/accounting/periods/:id/unlock` admin/super-admin only.
  - Audit logged.
- Global admin company override:
  - `backend/middleware/auth.js` allows `x-company-id` override for global/super admins.
- VAT lock operations:
  - Lock/submit operations restricted to admin/accountant style roles in VAT recon routes.
- Observed risk:
  - Elevated users can unlock and back-post/reverse by design; this is a governance risk, not a code bug.

## 16. Hard-Lock vs Soft-Lock Classification
- Hard lock controls (mutation-blocking):
  - `JournalService` accounting-period guards on create/update/post/reverse.
  - VAT period lock checks on selected VAT-sensitive mutation endpoints.
  - Finalized-state edit blockers in historical and opening balance modules.
- Soft controls (status/process controls, not full lock graph):
  - Report endpoint status modes (for example finalized-only vs draft preview in historical reports).
  - Reconcile/unreconcile transaction status changes not tied to accounting period lock.
- Conclusion:
  - System is mixed hard-lock + process-state control; not all operational mutations are lock-coupled.

## 17. Pilot Readiness Gaps and Risk Register
- Gap 1: Inconsistent lock-block audit taxonomy.
  - Impact: Harder forensic reporting and compliance evidence extraction.
- Gap 2: Reconcile/unreconcile status transitions are not accounting-lock-aware.
  - Impact: Operational state drift can occur during locked accounting periods.
- Gap 3: Some AR/AP route access relies on broader middleware context and status rules rather than explicit per-route lock annotations.
  - Impact: Harder to prove lock intent from route layer alone.
- Gap 4: VAT period status casing appears mixed (`open` vs `DRAFT`/`APPROVED`/`LOCKED`) across service code.
  - Impact: Potential edge-case behavior if status normalization is not consistently enforced.
- Gap 5: Dual lock systems are intentionally separate but not represented in a single policy matrix.
  - Impact: Governance and user training risk (users misunderstand what each lock protects).

## 18. Direct Answers to Required Forensic Questions
1. What lock tables exist? `accounting_periods` and `vat_periods`, plus finalized status fields in opening/historical batch tables.
2. Are accounting and VAT lock systems separate? Yes, clearly separate and independently enforced.
3. Where are accounting period lock checks enforced? Centrally in `JournalService` create/update/post/reverse and explicitly in year-end/opening-balance finalize paths.
4. Where are VAT lock checks enforced? Selectively in VAT-sensitive endpoints (supplier invoice edit, customer invoice void, bank unallocate) and VAT recon services.
5. Do reversals respect locked periods? Yes, reversal blocks on both original locked period and locked current posting date.
6. Can AR/AP mutate in locked accounting periods? Journal-impacting AR/AP operations are blocked via `JournalService`; non-journal status operations can still occur depending on route logic.
7. Can AR/AP mutate in locked VAT periods? Selected VAT-sensitive mutations are blocked; coverage is endpoint-specific.
8. Are opening balances locked/finalized safely? Yes, explicit validation, period-lock check, single posted journal finalization, immutable finalized state.
9. Are historical comparatives finalization safeguards present? Yes, finalized immutability and blocked edit logging; intentionally isolated from live ledger lock domain.
10. Does year-end respect lock and idempotency? Yes, lock guard on close date plus duplicate-close prevention and unique DB constraint.
11. Are blocked attempts audit-logged? Partially yes with good coverage in key flows, but not fully normalized across all endpoints.
12. Are override paths present? Yes: admin/super-admin unlock period path and global-admin company override header path.
13. Hard vs soft lock recommendation? Keep hard lock at journal-service boundary; formalize lock-aware behavior for operational state changes and normalize audit codes.
14. Pilot readiness status? Conditional: core lock engine is strong, but governance/audit normalization and lock-coupling gaps should be addressed before high-compliance pilot signoff.

---

### Final Forensic Conclusion
The lock foundation is materially strong where it matters most: journal creation, posting, update, and reversal are guarded centrally by accounting period lock checks. VAT lock is separately implemented and selectively enforced in VAT-sensitive mutation paths. Finalization models for opening balances and historical comparatives are robust within their own domains. The primary readiness risks are governance consistency: incomplete lock-aware handling on some operational status transitions, and uneven blocked-attempt logging normalization across modules.