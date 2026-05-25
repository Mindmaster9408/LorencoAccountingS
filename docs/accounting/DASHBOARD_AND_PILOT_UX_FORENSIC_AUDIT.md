# DASHBOARD AND PILOT UX FORENSIC AUDIT

## 1. Executive Summary
This is a read-only forensic UX audit of the Accounting App pilot journey.

Overall pilot UX status: conditionally usable for internal pilot, but not yet friction-free for six-month accountant-led operation.

Strengths:
- Core workflow surfaces exist for dashboard, bank staging/allocation/reconciliation, VAT, opening balances, reports, AR/AP, and historical comparatives.
- Several critical actions include confirmation prompts and state-driven controls.
- Draft/finalized concepts are present in key governed modules (historical comparatives and period management).

Primary pilot UX blockers/risk areas:
- Dashboard attention model is present but still fragmented across modules.
- Company context is available but can feel inconsistent because context comes from multiple tokens/storage keys.
- Error feedback is mixed quality (some actionable, some generic alert-driven).
- Feature maturity is uneven (notably customer AR tabs marked coming soon).
- Mobile responsiveness appears inconsistent on table-heavy pages.

## 2. Dashboard Current State
Observed dashboard behavior (frontend-accounting/dashboard.html):
- Displays KPI-style cards for key operations, including unmatched/unallocated-like attention indicators and recent activity blocks.
- Pulls account and journal summary data from accounting APIs.
- Includes operational support/contacts paneling for escalation.

UX assessment:
- Q1 (attention visibility): Partially yes. The dashboard signals activity and exceptions, but the signal-to-action path is not always unified into one obvious next-click queue.
- Q2 (unallocated surfaced): Partially yes. Unmatched/queue metrics appear, but users still need workflow knowledge to translate each metric into exact next action.
- Q3 (unreconciled surfaced): Partially yes via bank-oriented counts and dedicated reconciliation pages, but not always as a single explicit "must-do now" recon task list on landing.
- Q4 (VAT action surfaced): Limited on dashboard itself; VAT urgency is clearer inside VAT screens than on the landing dashboard.

## 3. Navigation Audit
Observed navigation behavior (frontend-accounting/js/navigation.js):
- Shared top navigation with grouped accounting areas and app switching.
- Company/client selector integrated in the nav shell.
- Route discoverability is broad (banking, reports, VAT, opening balances, customers, suppliers, historical comparatives, period management).

UX assessment:
- Q10 (report discoverability): Yes, generally discoverable via nav.
- Information architecture is wide but workable for trained accountants.
- Risk: breadth of menu plus mixed maturity can increase cognitive load for first-time pilot users.

## 4. Company / Client Context Visibility
Observed behavior:
- Company context is derived from selected company values and token payloads; nav supports switching via select-company API path and token refresh behavior.
- Company naming/context keys are pulled from multiple local storage/token sources (navigation + polyfill context helpers).

UX assessment:
- Q6 (clear separation): Mostly yes. A switcher exists and functionally enforces per-client context transitions.
- Q7 (selected company always visible): Mostly yes in nav, but practical clarity can degrade when users deep-link or rely on stale local storage naming values.
- Pilot risk: context integrity is technically present, but perceived clarity may still require a stronger always-visible company badge in dense workflow pages.

## 5. Bank Workflow UX
Observed workflow surfaces:
- Bank main screen: import controls, transaction list, allocation controls, status tabs, action rows.
- Bank staging: explicit review states (To Review, Transfer Suggested, Needs Attention, Possible Duplicate, Confirmed, Rejected), modals for confirm/reject/edit/restore, and clear CTA to reconciliation.
- Allocation actions include account selection and handling paths with validation-driven alerts.

UX assessment:
- Q8 (import -> allocation -> recon): Yes, path exists and is traceable, especially with staging status tabs and reconcile CTA.
- Q11 (errors meaningful): Mixed. Some bank errors are excellent and actionable (for example missing ledger account guidance), while other failures remain generic alert text.
- Q12 (empty states useful): Generally yes in banking-related screens; several empty/loading messages exist, though consistency varies.

## 6. Bank Reconciliation UX
Observed behavior (frontend-accounting/bank-reconciliation.html):
- Dedicated reconciliation filters for pending/needs allocation/reconciled.
- Difference and completion summary paneling.
- Checkbox and state disabling to prevent invalid reconcile actions.
- Confirmation prompts around finish/commit actions.

UX assessment:
- Q3 (unreconciled surfaced): Yes in module context.
- Dangerous steps are protected by confirmations and status checks.
- Residual risk: users can still lose flow context when switching between bank, staging, and reconciliation pages without a persistent breadcrumb-style "you are on step X of Y" helper.

## 7. VAT Workflow UX
Observed behavior (frontend-accounting/vat.html):
- Large reconciliation-oriented page with period controls, checks, authorization actions, summary blocks, and submission-related affordances.
- Contains checklist-like structures and action buttons for period operations.

UX assessment:
- Q4 (VAT needing action surfaced): Partially. In-page controls are rich, but density is high and could overwhelm less experienced pilot users.
- Q13 (locked/finalized clarity): Present in period-related modules and VAT authorization states, but VAT page complexity can obscure the current period state at a glance.
- Q11 (error quality): Mixed; some explicit prompts exist, but broad use of alert patterns reduces clarity and consistency.

## 8. Reports UX
Observed behavior:
- Report pages are reachable and include financial outputs with filtering/export affordances.
- Historical comparative report area explicitly supports finalized-only vs draft preview modes.

UX assessment:
- Q10 (discoverable): Yes.
- Q14 (draft vs final labels): Strong in historical comparatives reporting mode; less uniformly explicit across all report pages.
- Pilot gap: not every report surface appears to visibly state whether data is operational, draft-preview, or final/statutory-ready.

## 9. AR/AP UX
Observed behavior:
- Customers page includes multiple tabs, but invoices/quotes/receipts are currently marked coming soon and redirects users toward POS-linked flows.
- Suppliers page is significantly more complete: supplier list, invoices, POs, payments, aging, modal-driven create/edit/record flows.

UX assessment:
- AR maturity is currently lower than AP maturity for pilot expectations.
- Q12 (empty states useful): Yes in both modules; explicit no-data messaging is present.
- Q17 (6-month blocker risk): high for teams expecting full in-app AR workflow in Accounting App without POS dependency.

## 10. Opening Balance UX
Observed behavior (frontend-accounting/opening-balances.html):
- Structured batch lifecycle flow (create, load lines, validate, finalize/archive).
- Clear variance and balance checks.
- User guidance text is stronger than average and explains constraints/next steps.

UX assessment:
- Q9 (opening balance -> TB -> reports path): Mostly feasible from UX perspective because opening balances has clear control points; however, end-to-end user confidence still depends on training users on where to verify downstream report impact.
- Q13 (locked/finalized clarity): Good in this module due to explicit batch status and gated actions.

## 11. Historical Comparatives UX
Observed behavior (frontend-accounting/historical-comparatives.html):
- Distinct tabs for Data Capture and Comparative Reports.
- Explicit draft-preview warnings and role-based restriction on draft access.
- Finalization warning language is strong and irreversible actions are confirmed.
- Includes visible guidance when setup dependencies fail (for example migration/sync issues).

UX assessment:
- Q5 (missing setup visible): Yes, notably good here. COA sync failure message explicitly points to missing migration/application state.
- Q14 (draft vs final labels): Strong and explicit in this module.
- Q15 (admin/draft visibility): role-driven visibility behavior is present and clearer than in many other pages.

## 12. Error / Loading / Empty State Review
Observed patterns:
- Loading states: generally present on data tables/cards.
- Empty states: present across customers/suppliers/aging/POS and several operational views.
- Error states: mixed quality.

Q11 answer (errors meaningful or generic):
- Mixed. Best-in-class examples exist (bank allocation actionable remediation text).
- Many pages still rely on generic alert messages, which can be ambiguous and not always paired with an obvious next step.

Q12 answer (empty states useful):
- Mostly yes. Multiple pages explain "no data" conditions with context.
- Improvement needed: unify style and include explicit next action buttons more consistently.

## 13. Permission Visibility Review
Observed behavior:
- Historical comparatives draft access is role-gated.
- Accounting periods unlock action is labeled admin-only.
- AI settings include explicit administrator-only gating.
- Navigation contains administration-oriented entries.

Q15 answer (admin-only hidden correctly):
- Partially. Some admin-only actions are clearly labeled or role-gated, but broad consistency across all pages cannot be assumed from current frontend patterns alone.
- UX risk is more about consistency than complete absence of gating.

## 14. Dangerous Action Confirmation Review
Observed confirmations:
- Period lock/unlock/delete uses explicit confirm dialogs with warning text.
- Historical comparatives finalize has irreversible warning language.
- Reconciliation completion and several bank staging actions use confirmations.
- Supplier status changes and other destructive transitions include confirms.

Q16 answer (dangerous actions confirmed properly):
- Mostly yes. This is one of the stronger UX safety areas.
- Remaining issue is dialog quality consistency (native confirm/alert tone varies and is not always user-friendly).

## 15. Pilot Training Risks
Key training gaps likely required for six-month internal pilot:
1. Company context discipline: users must be trained to verify selected client before posting/recon actions.
2. Bank journey orientation: users need a standard operating path across import, staging, allocation, and reconciliation pages.
3. VAT navigation discipline: users need structured checklist training due to VAT screen density.
4. AR expectations: users must understand current POS dependency and coming-soon boundaries.
5. Draft vs final reporting literacy: users need clear training on which report states are advisory vs final.

## 16. What Is Working And Must Be Protected
- Shared navigation with client switcher and broad route discoverability.
- Bank staging taxonomy (needs attention/duplicate/confirmed/rejected) and explicit reconciliation handoff.
- Opening balance batch lifecycle with validation and finalization controls.
- Historical comparatives draft-warning and role-gated report mode design.
- Confirmation prompts on irreversible/high-risk actions.
- Presence of loading/empty states across many operational pages.

## 17. Confirmed UX Risks
1. Dashboard attention model is not yet a single consolidated work queue.
2. Company context can be perceived as ambiguous in deep workflows due to multi-source context handling.
3. Error feedback consistency is uneven; many generic alerts remain.
4. AR feature completeness is not aligned with AP completeness for pilot expectations.
5. VAT page complexity may increase user hesitation/error without guided workflow aids.
6. Table-dense pages likely present mobile/responsive usability risk during real-world use.
7. Draft/final semantics are strong in some modules but not uniformly visible across all report surfaces.

## 18. Recommended Workstreams
1. Introduce a dashboard "Action Queue" panel with explicit next steps (unallocated, unreconciled, VAT due actions).
2. Add persistent company context chip in all high-risk pages (bank, VAT, opening balances, reports).
3. Standardize error UI from generic alerts to structured message panels with reason + next action.
4. Add workflow breadcrumbs/checklist headers for bank and VAT journeys.
5. Align AR maturity messaging with pilot scope and provide guided handoff to POS where required.
6. Expand responsive treatment for table-heavy pages and confirm mobile minimum usability.
7. Standardize report state badges: Draft Preview, Finalized Source, Operational View.
8. Normalize admin-only visibility patterns and labels across all modules.

## 19. Questions For Ruan Before Code Changes
1. For pilot, should dashboard become the single operational queue, or remain KPI-only with module drill-ins?
2. Do you want hard visual company locking (always-visible sticky client badge) on every transaction screen?
3. Is POS dependency for customer invoicing acceptable for this pilot phase, or should AR in Accounting App be mandatory?
4. Which mobile devices/viewports must be officially supported during pilot?
5. Should report pages carry mandatory legal-style state labels (Draft/Operational/Final) on every exportable view?
6. Do you want a unified "What to do next" helper panel on VAT and bank pages?
7. Should admin-only items be hidden entirely or shown disabled with explanation text?
8. What is the acceptable training burden (hours per accountant) for pilot onboarding?
9. Should dangerous actions move from native confirm dialogs to standardized confirmation modals with richer context?
10. Is the pilot objective workflow confidence or full feature parity (especially AR)?

---

## Direct Answers to Required Questions
1. Can an accountant see what needs attention on the dashboard?
- Partially yes. Signals exist, but attention items are not yet unified into one explicit action queue.

2. Are unallocated bank transactions surfaced clearly?
- Partially yes. Surfaced in bank-related flows and dashboard indicators, but still requires workflow knowledge to action quickly.

3. Are unreconciled bank accounts surfaced clearly?
- Yes in reconciliation contexts; only partially as a dashboard-first prioritized task.

4. Are VAT periods needing action surfaced clearly?
- More clearly inside VAT screens than on dashboard.

5. Are missing migrations or setup issues visible to the user?
- Yes in historical comparatives (explicit migration/setup guidance shown on sync failure).

6. Are clients/companies clearly separated in the UI?
- Mostly yes through switcher and scoped context handling.

7. Is the selected company always visible?
- Usually visible in shared nav, but perceived clarity can degrade in deep flows due to multi-source context reads.

8. Can a user easily follow bank import -> allocation -> recon?
- Yes, flow exists and is traceable, especially through staging and reconciliation handoff.

9. Can a user easily follow opening balance -> TB -> reports?
- Mostly yes with training; opening balance flow is clear, but downstream verification path should be more guided.

10. Are report pages discoverable?
- Yes, generally discoverable from navigation.

11. Are errors meaningful or generic?
- Mixed: both actionable and generic alert-driven patterns exist.

12. Are empty states useful?
- Mostly yes, with clear no-data messaging in many modules.

13. Are finalized/locked states clear?
- Mostly yes in governed modules (opening balances, historical comparatives, period management).

14. Are draft vs final reports clearly labelled?
- Strong in historical comparatives; less uniformly explicit across all report surfaces.

15. Are admin-only features hidden correctly?
- Partially. Some areas are clearly role-gated/labeled, but consistency should be improved.

16. Are dangerous actions confirmed properly?
- Mostly yes, with several strong confirmations for irreversible actions.

17. What UX gaps could block a 6-month internal pilot?
- Fragmented dashboard actioning, inconsistent error UX, uneven AR maturity, context-visibility ambiguity, VAT/bank complexity without guided workflow, and responsive risk on table-heavy pages.
