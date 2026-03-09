# Follow-up Notes

## Follow-up Note 2026-03-09: Master Ecosystem Architecture Audit
- Area: Whole-repo architecture and cross-app integration documentation
- Dependency: Current browser compatibility stabilization phase completion
- What was done now: Browser hardening work prioritized (storage safety, date handling standardization, polyfills rollout, targeted CSS compatibility fallbacks, browser baseline config)
- What still needs to be checked: Full multi-app architecture deep audit and integration blueprint generation
- Risk if not checked: Hidden cross-app coupling, undocumented integration gaps, inconsistent data ownership and standards drift over time
- Recommended next review point: Immediately after browser hardening and validation are signed off
- Required output target: docs/ecosystem-architecture.md

## CRITICAL Follow-up Note 2026-03-09: Data Persistence Audit
- **Priority**: URGENT - Business Continuity Risk
- **Area**: Data storage architecture across all apps (POS, Accounting, Ecosystem, Coaching)
- **Critical User Requirement**: "We can't have any data on local storage - if we delete history I am done for"
- **What's done**: Payroll app already compliant (Supabase cloud storage only, localStorage only for session/token)
- **What MUST be checked IMMEDIATELY**:
  1. Point of Sale: Where are transactions, inventory, sales stored? localStorage = DATA LOSS RISK
  2. Accounting App: Where are ledgers, invoices, journal entries? localStorage = DATA LOSS RISK
  3. Ecosystem Dashboard: Client data storage location? localStorage = DATA LOSS RISK
  4. Coaching App: Assessment/client data persistence?
- **Required Actions**:
  - Audit each app's data persistence layer
  - Identify any business data in localStorage
  - Migrate critical data to cloud storage (Supabase/server DB)
  - Document data storage location for each app
- **Policy Created**: docs/DATA_PERSISTENCE_POLICY.md
- **Risk if not done**: User clears browser history → PERMANENT loss of all business data in localStorage
- **Timeline**: ASAP - this is a production data safety issue
