# DATA PERSISTENCE POLICY — ABSOLUTE NO BROWSER STORAGE RULE

**Date**: 2026-05-08 (supersedes 2026-03-09 version)
**Priority**: CRITICAL — Hard Coding Gate
**Scope**: All applications in the Lorenco Accounting Ecosystem
**Authority**: CLAUDE.md Part D — Absolute No Browser Storage Rule

---

## THE RULE

**Browser storage (`localStorage`, `sessionStorage`, `indexedDB`, cookies) must NEVER be used for business data.**

This is absolute. There are no exceptions, no grace periods, and no "temporarily until migrated" clauses. Any code that writes business data to browser storage is a production bug, not technical debt.

---

## WHY THIS RULE EXISTS

Browser storage is cleared when a user clears browser data. There is no server backup, no recovery path, no audit trail. For a financial/accounting platform:

- **Silent data loss** — user clears browser history, payroll records disappear
- **Multi-device failure** — user logs in from another machine, no data present
- **Audit trail broken** — no server record of what was stored or changed
- **Compliance risk** — SARS/UIF/IRP5 compliance requires tamper-proof records
- **Finalization integrity** — payslip locked state sourced from browser can be manipulated

This was not theoretical. In May 2026, finalized payslip state was partially stored in localStorage, causing finalization to break on different machines and causing frozen payslip values to display incorrect (live) data instead of the frozen snapshot values.

---

## WHAT IS BUSINESS DATA (NON-EXHAUSTIVE)

If losing the data causes financial, compliance, or audit consequences — it is business data.

- Payroll records, payslips, pay runs, finalization state, snapshots
- Employee records, salary, tax number, deductions, allowances
- Financial transactions, invoices, payments, receipts
- Accounting entries, ledgers, chart of accounts, reconciliations
- Tax configuration: PAYE, UIF, SDL, voluntary tax overrides
- Attendance records
- SARS data: IRP5, EMP201, EMP501
- Client data, company data, banking details
- Bank allocations, transaction mappings
- Sean learning mappings (these inform compliance decisions)
- Any data subject to retention or audit trail requirements

---

## WHAT IS PERMITTED IN BROWSER STORAGE

Only the following are safe to store in browser storage:

| Permitted | Why it's safe |
| --- | --- |
| JWT / session tokens | Re-authentication recovers them |
| Supabase session | Re-authentication recovers it |
| SSO app-handoff tokens | Short-lived, not business data |
| UI preferences (theme, language) | No financial consequence if lost |
| Unsaved draft form state | Must display explicit warning to user; data not committed |

---

## THE `safeLocalStorage` KV BRIDGE IS NOT COMPLIANT

`shared/js/polyfills.js` contains a `safeLocalStorage` wrapper that intercepts calls and routes them to Supabase KV (`payroll_kv_store_eco`). This was a migration aid to move off raw localStorage. It is **not** a compliant final destination for business data.

KV storage is a schemaless blob store with:

- No relational integrity
- No foreign keys
- No query capability
- No structured audit trail
- No row-level security per business entity

Business data must live in proper SQL tables with defined schema, constraints, and audit history.

### KV Keys Requiring SQL Migration

| KV Key Pattern | Target SQL Table | Priority |
| --- | --- | --- |
| `voluntaryTaxConfig_{co}_{emp}` | `employee_tax_overrides` | High — affects tax calculations |
| `attendance_{co}_{emp}_{period}` | `attendance_records` | High — affects pay calculations |
| `paye_recon_sars_{co}_{period}` | `paye_reconciliation` | High — SARS compliance data |
| `paye_recon_bank_{co}_{period}` | `paye_reconciliation` | High — SARS compliance data |
| `sean_learning_{*}` | `sean_knowledge_mappings` | Medium — informs IRP5 coding |
| `bank_allocations_{co}_{*}` | `bank_transaction_allocations` | Medium — financial records |

The `safeLocalStorage` bridge may remain for **auth tokens and UI preferences only** until the above migrations are complete.

---

## COMPLIANCE STATUS BY APP

### Payroll App (`frontend-payroll/`)

| Area | Status | Notes |
| --- | --- | --- |
| Payroll snapshots (finalization) | ✅ Compliant | DB `payroll_snapshots` table, `is_locked` column |
| Payslip locked state | ✅ Compliant | Sourced from DB backend calculate endpoint only |
| Employee salary / basic data | ✅ Compliant | `employees` table |
| Payroll line items | ✅ Compliant | `payroll_items` table |
| Voluntary tax overrides | ⚠️ KV Bridge | Needs `employee_tax_overrides` SQL table |
| Attendance records | ⚠️ KV Bridge | Needs `attendance_records` SQL table |

### Accounting App (`frontend-accounting/`)

| Area | Status | Notes |
| --- | --- | --- |
| Bank allocations | ⚠️ KV Bridge | Needs `bank_transaction_allocations` SQL table |
| Sean learning mappings | ⚠️ KV Bridge | Needs `sean_knowledge_mappings` SQL table |
| PAYE reconciliation | ⚠️ KV Bridge | Needs `paye_reconciliation` SQL table |

### POS App (`frontend-pos/`)

| Area | Status | Notes |
| --- | --- | --- |
| Transactions | Needs audit | Full audit not completed |

### Ecosystem Dashboard (`frontend-ecosystem/`)

| Area | Status | Notes |
| --- | --- | --- |
| Auth/session | ✅ Compliant | JWT only |
| Client data | Needs audit | Verify no business data in localStorage |

---

## ENFORCEMENT MECHANISM

### For Claude (AI-assisted development)

Per CLAUDE.md Rule D5: any code Claude generates that writes business data to browser storage must be corrected before being shown to the user. This is a pre-output gate, not a post-review note.

### For Code Review

Every PR touching data persistence must verify:

- [ ] No `localStorage.setItem()` / `sessionStorage.setItem()` with business data
- [ ] No `safeLocalStorage.setItem()` with business data
- [ ] No `indexedDB` writes with business data
- [ ] New data stores go to SQL via API endpoints
- [ ] If uncertain — treat as business data and use SQL

### For New Features

Before storing any data, answer:

1. What happens if browser storage is cleared tomorrow?
2. Can this data be recovered from the server?
3. Does this data have audit/compliance implications?

If the answer to (1) is "data loss" or (2) is "no" — it goes to SQL, not browser storage.

---

## MIGRATION PROCEDURE FOR EXISTING KV DATA

When migrating a KV-backed key to a SQL table:

1. Create SQL migration (new table or column)
2. Create API endpoints (GET, POST, PUT) with auth and company_id scoping
3. Update frontend to use API instead of `safeLocalStorage`
4. Backfill existing KV data into SQL (one-time migration script)
5. Remove `safeLocalStorage` read/write calls for that key
6. Test on multiple browsers and devices to confirm no regression
7. Document in session handoff

Do not remove the KV read before the SQL backfill is complete — this avoids data loss during transition.

---

## RELATED DOCUMENTS

- `CLAUDE.md` Part D — Absolute No Browser Storage Rule (primary governance)
- `CLAUDE.md` Section 6 — Implementation Readiness Standards (includes browser storage gate)
- `SESSION_HANDOFF_2026-05-07-payroll-immutability.md` — Documents the root incident that triggered this rule

---

**Last Updated**: 2026-05-08
**Supersedes**: Version dated 2026-03-09
**Review Frequency**: Before each major release; whenever a new data store is added
**Owner**: Development Team — enforced by CLAUDE.md as a hard coding gate
