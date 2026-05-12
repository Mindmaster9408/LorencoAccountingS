# PAYTIME STABILITY LOCK
## Lorenco Ecosystem — Payroll Module Governance Standard

> **Status: ACTIVE — Effective May 2026**
> **Authority: This document is a permanent governance standard. It may only be modified by an explicitly authorised change-control decision.**
> **Cross-reference: CLAUDE.md Part E · DEV_PROTOCOL.md · paytime.protected.json**

---

## TABLE OF CONTENTS

1. [Why This Exists](#1-why-this-exists)
2. [Protected Module Declaration](#2-protected-module-declaration)
3. [Protected Files Registry](#3-protected-files-registry)
4. [What Triggers Payroll Regression Testing](#4-what-triggers-payroll-regression-testing)
5. [Regression Test Suite](#5-regression-test-suite)
6. [Change Impact Note — Mandatory Format](#6-change-impact-note--mandatory-format)
7. [Shared Code Safety Protocol](#7-shared-code-safety-protocol)
8. [Finalized Payroll Immutability Rules](#8-finalized-payroll-immutability-rules)
9. [Release Safety Process](#9-release-safety-process)
10. [Prohibited Patterns](#10-prohibited-patterns)
11. [Protected Module Manifest](#11-protected-module-manifest)
12. [Governance Breach Response](#12-governance-breach-response)

---

## 1. WHY THIS EXISTS

Paytime payroll processes real client wages, tax submissions, UIF/SDL compliance, and SARS-reportable IRP5 data.

A silent regression in payroll calculations causes:
- Incorrect employee pay
- Incorrect PAYE submissions
- Incorrect UIF/SDL filings
- Invalid IRP5 certificates
- Client liability exposure
- Loss of trust from accountants and business owners

The Lorenco ecosystem now extends to multiple modules (POS, Accounting, Coaching, Sean AI, Admin). Changes in those modules can propagate into Paytime through:
- Shared auth/JWT middleware
- Shared company context
- Shared utility functions
- Shared API wrappers
- Shared frontend state management
- Shared database schemas

**Paytime must be treated as a CONTROLLED, STABILITY-LOCKED module.**

Any change — regardless of its origin — that could alter payroll behavior must be:
1. Explicitly identified
2. Audited for payroll impact
3. Regression-tested
4. Approved before deployment

---

## 2. PROTECTED MODULE DECLARATION

```
╔══════════════════════════════════════════════════════════════════╗
║          PAYTIME PAYROLL — PROTECTED / STABILITY-LOCKED          ║
║                                                                    ║
║  This module may only be changed when:                            ║
║    1. The task explicitly targets Paytime                          ║
║    2. Change impact has been audited                               ║
║    3. Payroll regression tests have been run                       ║
║    4. Approval has been given                                      ║
║                                                                    ║
║  Unrelated work may NOT silently alter payroll behavior.          ║
╚══════════════════════════════════════════════════════════════════╝
```

### What "Protected" Means in Practice

| Scenario | Action Required |
|---|---|
| Working on POS and touching `auth.js` | Run payroll regression before push |
| Working on Accounting and touching shared middleware | Run payroll regression before push |
| Working on Coaching and touching JWT handling | Run payroll regression before push |
| Working on Sean AI and touching `data-access.js` | Run payroll regression before push |
| Working directly on Paytime calculations | Run payroll regression, document impact, get approval |
| Working on Paytime UI only (no calculation logic) | Regression still required, impact note required |
| Working on unrelated frontend (Coaching, POS UI only) | Payroll regression NOT required |
| Working on unrelated backend (POS routes only) | Payroll regression NOT required |

---

## 3. PROTECTED FILES REGISTRY

The following files are designated **Payroll Core** — they may not be modified without explicit payroll change authorization and mandatory regression testing.

### Frontend — Payroll Engine Layer (CRITICAL)

| File | Protection Level | Reason |
|---|---|---|
| `frontend-payroll/js/payroll-engine.js` | **CRITICAL** | All client-side payroll calculations. Any change here directly affects every payslip generated. |
| `frontend-payroll/js/data-access.js` | **HIGH** | API abstraction layer. Changes affect all payroll data reads/writes. Also houses the KV bridge — changes can silently reroute payroll data. |
| `frontend-payroll/js/auth.js` | **HIGH** | Session/JWT management. Changes can break company context, role detection, multi-tenant isolation. |
| `frontend-payroll/js/permissions.js` | **MEDIUM** | Controls which UI elements are visible/interactive for each role. |
| `frontend-payroll/js/payroll-api.js` | **HIGH** | Direct payroll API calls. Changes affect calculation triggers and result handling. |
| `frontend-payroll/js/polyfills.js` | **HIGH** | Browser compatibility shims. Silent changes here can break calculations in some browsers. |
| `frontend-payroll/js/recon-service.js` | **HIGH** | PAYE reconciliation logic. |
| `frontend-payroll/payroll-execution.html` | **HIGH** | Execute Payroll — the only authorized finalization path. |
| `frontend-payroll/employee-detail.html` | **HIGH** | Employee payroll inputs and payslip view. |
| `frontend-payroll/payruns.html` | **HIGH** | Payslip display and period management. |

### Backend — Payroll Service Layer (CRITICAL)

| File | Protection Level | Reason |
|---|---|---|
| `backend/modules/payroll/services/PayrollCalculationService.js` | **CRITICAL** | Server-side payroll calculation engine. Any change here affects all server-calculated payroll values. |
| `backend/modules/payroll/services/PayrollDataService.js` | **CRITICAL** | Payroll data persistence and retrieval. Changes affect what data is saved/loaded for payslips. |
| `backend/modules/payroll/services/PayrollHistoryService.js` | **HIGH** | Historical payroll records. |
| `backend/modules/payroll/routes/calculate.js` | **CRITICAL** | Calculation endpoint. |
| `backend/modules/payroll/routes/payruns.js` | **CRITICAL** | Pay run management. |
| `backend/modules/payroll/routes/transactions.js` | **HIGH** | Payroll transaction data. |
| `backend/modules/payroll/routes/periods.js` | **HIGH** | Pay period management. |
| `backend/modules/payroll/routes/voluntary-tax.js` | **HIGH** | Voluntary tax overrides — affects PAYE. |
| `backend/modules/payroll/routes/recon.js` | **HIGH** | PAYE reconciliation. |
| `backend/modules/payroll/routes/employees.js` | **MEDIUM** | Employee payroll data (salary, tax config). |

### Shared Code With Payroll Impact (REQUIRES IMPACT AUDIT)

| File | Payroll Risk | Why It Matters |
|---|---|---|
| `backend/shared/routes/auth.js` | **HIGH** | JWT structure, company context, session auth — all payroll API calls depend on this |
| `backend/shared/routes/companies.js` | **HIGH** | Company data used in payroll calculations (SDL/UIF registration, pay frequency) |
| `backend/middleware/auth.js` | **HIGH** | `authenticateToken`, `requireCompany`, `requirePermission` — all payroll routes use these |
| `backend/config/permissions.js` | **MEDIUM** | Role permissions — affects who can execute/view payroll |
| `frontend-payroll/js/sidebar.js` | **LOW** | Company switching — stale context risks |

---

## 4. WHAT TRIGGERS PAYROLL REGRESSION TESTING

Payroll regression testing becomes **mandatory** before any push when ANY of the following files are modified:

### Auto-Trigger Files (always require regression)

```
frontend-payroll/js/payroll-engine.js
frontend-payroll/js/data-access.js
frontend-payroll/js/auth.js
frontend-payroll/js/payroll-api.js
frontend-payroll/js/polyfills.js
frontend-payroll/js/recon-service.js
frontend-payroll/payroll-execution.html
frontend-payroll/employee-detail.html
frontend-payroll/payruns.html
backend/modules/payroll/**
backend/shared/routes/auth.js
backend/shared/routes/companies.js
backend/middleware/auth.js
backend/config/permissions.js
```

### Judgment-Based Triggers (require impact assessment first)

If you change any of the following and the impact assessment determines payroll is affected, regression is required:

```
backend/shared/routes/employees.js
backend/shared/routes/kv.js
backend/middleware/audit.js
frontend-payroll/js/sidebar.js
frontend-payroll/company-details.html
Any shared utility function used by payroll-engine.js
Any new shared middleware mounted before payroll routes
```

### Never-Trigger (safe — no payroll regression needed)

```
frontend-pos/**
frontend-coaching/**  (unless shared utils modified)
accounting-ecosystem/docs/**
backend/modules/pos/**
backend/modules/accounting/** (unless shared tables modified)
Coaching app/**
CSS / theme files not touching payroll pages
```

---

## 5. REGRESSION TEST SUITE

The following tests must pass before any deployment that touches auto-trigger files.

These are manual verification tests until automated tests are built. Each test maps to a real scenario a client would experience.

### TEST-PAY-01: Basic Payslip Calculation

**Setup:** Employee with basic salary of R10,000. No allowances. Monthly.
**Expected:** PAYE calculated per SARS tables, UIF = 1% gross (max R177.12), SDL = 1% gross, net pay = gross − PAYE − UIF.
**Verify:** Payslip figures match manual calculation.

### TEST-PAY-02: Execute Payroll Calculation Match

**Setup:** Same employee as TEST-PAY-01.
**Expected:** Execute Payroll shows identical figures to individual payslip view.
**Verify:** No discrepancy between payslip view and execute payroll totals.

### TEST-PAY-03: PAYE Correctness — Multiple Brackets

**Setup:** Employee at R25,000/month (in higher PAYE bracket).
**Expected:** PAYE calculated using correct SARS marginal rate for the tax year.
**Verify:** PAYE ≈ expected manual calculation (within R1 for rounding).

### TEST-PAY-04: UIF Cap Enforcement

**Setup:** Employee with salary above the UIF ceiling (R17,712/month as of 2025).
**Expected:** UIF employee contribution = R177.12 (capped), not 1% of full salary.
**Verify:** UIF does not exceed the legal cap.

### TEST-PAY-05: SDL Registered vs Exempt

**Setup A:** Company with SDL registered = true. Employee R10,000.
**Expected A:** SDL = R100 (1%).
**Setup B:** Company with SDL registered = false.
**Expected B:** SDL = R0.
**Verify:** SDL respects company-level SDL registration setting.

### TEST-PAY-06: Overtime Inclusion

**Setup:** Employee with base salary R10,000. Overtime input of R1,500 added for the period.
**Expected:** Gross = R11,500. PAYE recalculated on R11,500. UIF capped or 1% of R11,500. Net adjusted accordingly.
**Verify:** Overtime is included in gross and affects tax calculations correctly.

### TEST-PAY-07: Short Time Reduction

**Setup:** Employee R10,000. Short time reduction of R800 applied.
**Expected:** Effective gross = R9,200. PAYE, UIF, SDL all calculated on R9,200.
**Verify:** Short time reduces gross and cascades through all statutory calculations.

### TEST-PAY-08: Voluntary Tax Override

**Setup:** Employee with voluntary additional PAYE of R500/month configured.
**Expected:** PAYE = standard calculated PAYE + R500. Net pay reduced by extra R500.
**Verify:** Voluntary tax adds to PAYE, not to deductions separately.

### TEST-PAY-09: Finalized Snapshot Immutability

**Setup:** Execute Payroll for a period. Finalize (lock snapshot).
**Action:** Attempt to change employee salary. Navigate back to finalized period.
**Expected:** Finalized payslip shows the ORIGINAL figures from the snapshot — not the new salary.
**Verify:** `payroll_snapshots.is_locked = true` row is the authoritative source; recalculation does not occur on locked periods.

### TEST-PAY-10: Payslip vs Execute Payroll Field Match

**Setup:** Execute payroll for a period.
**Expected:** Every field on the payslip view matches the corresponding field on the Execute Payroll summary for that employee and period.
**Verify:** No phantom totals, no missing lines.

### TEST-PAY-11: Company Switching — Correct Context

**Setup:** Two companies with different payroll configurations (Company A: SDL exempt; Company B: SDL registered).
**Action:** Login as user with access to both. View Company A payroll. Switch to Company B. View payroll.
**Expected:** Each company's payroll shows only its own employees and uses its own configuration.
**Verify:** No data leaks between companies. SDL behaves correctly per company.

### TEST-PAY-12: Multi-Tenant Safety

**Setup:** Two separate client companies. Company A has employees with salaries. Company B has employees with different salaries.
**Action:** Login as Company A user. Execute payroll.
**Expected:** Company A payroll affects ONLY Company A employees. Company B data is untouched.
**Verify:** No cross-tenant data contamination.

### TEST-PAY-13: No Browser Storage Regression

**Action:** Open browser DevTools → Application → LocalStorage / SessionStorage.
**Expected:** No payroll figures, snapshots, employee salaries, tax config, or calculation results are stored in browser storage.
**Verify:** Only `token`, `session`, `availableCompanies` (company names list), `cache_*` (offline read cache) may be present. No payroll business data.

### TEST-PAY-14: PAYE Reconciliation Integrity

**Setup:** Execute payroll for two periods. Generate PAYE reconciliation.
**Expected:** Recon totals match the sum of the payslip PAYE figures for those periods. No unexplained discrepancies.
**Verify:** Recon data is sourced from locked snapshots, not re-calculated live.

### REGRESSION PASS CRITERIA

All 14 tests must pass. A single failure blocks deployment.

If a test cannot be run (e.g., no test data), it must be documented as a known untested risk with a follow-up note — NOT silently skipped.

---

## 6. CHANGE IMPACT NOTE — MANDATORY FORMAT

Every payroll-related change must include a Change Impact Note before implementation. No exceptions.

```
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  [Describe what is being modified]

Files involved:
  [List all files being touched]

Why this change is needed:
  [Business reason or bug being fixed]

Is this an explicitly authorised Paytime task?
  [ ] Yes — task specifically targets Paytime
  [ ] No — this is a shared/other-module change with payroll side-effects

Payroll risk:
  [ ] CRITICAL — calculations, snapshots, finalization, tax
  [ ] HIGH — auth, company context, data persistence, shared services
  [ ] MEDIUM — UI, permissions, non-calculation logic
  [ ] LOW — documentation, purely additive code with no shared deps

Specific payroll areas that could be affected:
  [List: calculations / snapshots / PAYE / UIF / SDL / company context / etc.]

Regression risk:
  [ ] High — existing payroll behavior could change silently
  [ ] Medium — limited scope, reviewed dependencies
  [ ] Low — purely additive, isolated from calculation paths

Regression tests required:
  [List which TEST-PAY-XX tests must pass]

Rollback strategy:
  [git revert HEAD OR feature flag disable OR specific steps]

Confirmed payroll paths checked:
  [ ] payroll-engine.js not affected
  [ ] PayrollCalculationService.js not affected
  [ ] Finalized snapshot read path not affected
  [ ] Company context not affected
  [ ] PAYE/UIF/SDL logic not affected
─────────────────────────────────────────────────────────────
```

---

## 7. SHARED CODE SAFETY PROTOCOL

When modifying shared code, the following checklist is mandatory:

### auth.js (backend/shared/routes/auth.js)

Before changing:
- [ ] Does the login response still include `companyId` in the JWT?
- [ ] Does `selectedCompany` still resolve correctly for single-company users?
- [ ] Does `selectCompany`/`sso-launch` still return a valid JWT with `companyId`?
- [ ] Does token expiry still function (8h)?
- [ ] Is `isSuperAdmin` correctly preserved in the new token?
- [ ] Run TEST-PAY-11 and TEST-PAY-12

### auth.js (frontend-payroll/js/auth.js)

Before changing:
- [ ] Does `AUTH.getSession()` still return `{company_id, role, is_super_admin}`?
- [ ] Does `AUTH.isAuthenticated()` still correctly gate page access?
- [ ] Does `AUTH.selectCompany()` still refresh the JWT and update the session?
- [ ] Are `token` and `session` still routing to native localStorage (not KV bridge)?
- [ ] Run TEST-PAY-11

### data-access.js (frontend-payroll/js/data-access.js)

Before changing:
- [ ] Does `DataAccess.getCompanyDetails()` still call `GET /api/companies/:id`?
- [ ] Does the KV bridge `isLocalKey()` list still protect `session` and `token`?
- [ ] Does `DataAccess.saveCompanyDetails()` still send DB-column-named fields?
- [ ] Are error paths still caught without silently returning stale data for calculation inputs?
- [ ] Run TEST-PAY-13

### permissions.js (backend/config/permissions.js)

Before changing:
- [ ] Does `PAYROLL.VIEW` still include all required roles?
- [ ] Does `PAYROLL.PROCESS` still correctly restrict who can execute payroll?
- [ ] Does `COMPANIES.EDIT` still restrict company payroll settings correctly?
- [ ] Run TEST-PAY-11

### middleware/auth.js

Before changing:
- [ ] Does `authenticateToken` still attach `req.companyId` from the JWT?
- [ ] Does `requireCompany` still correctly block null-company requests?
- [ ] Does `requirePermission` still evaluate against the correct role?
- [ ] Run TEST-PAY-12

---

## 8. FINALIZED PAYROLL IMMUTABILITY RULES

These rules are permanent and non-negotiable. They may not be overridden by any future task.

### Rule F1 — Snapshot Is Authoritative Truth

Once `payroll_snapshots.is_locked = true` for a period + employee combination:

- The snapshot row is the **only** source of truth for that payslip
- No recalculation may occur for a locked period
- No code may modify a locked snapshot row
- All displays of finalized payslips must read from the snapshot

### Rule F2 — Execute Payroll Is the Only Finalization Path

The only authorized path to create a finalized payroll snapshot is:

**Execute Payroll → `POST /api/payroll/payruns` → creates `payroll_snapshots` rows → sets `is_locked = true`**

No other path may set `is_locked = true`. No frontend shortcut. No admin API. No direct DB write from application code.

### Rule F3 — No Recalculation on Locked Periods

If `payroll_snapshots.is_locked = true`:
- Backend MUST NOT recalculate the payslip
- Backend MUST return snapshot figures directly
- Frontend MUST NOT allow editing of locked period inputs
- Frontend MUST show "Finalized" status clearly

### Rule F4 — No Browser Storage for Finalized State

`is_locked` status must NEVER be derived from or stored in:
- `localStorage`
- `sessionStorage`
- `safeLocalStorage`
- KV bridge
- Any browser-side cache

It must always be read from `payroll_snapshots.is_locked` via the authenticated API.

### Rule F5 — Retroactive Changes Forbidden

No change to shared configuration (company SDL settings, employee salary, tax year config) may retroactively alter a finalized payroll snapshot. Finalized periods reflect the reality at the time of finalization.

### Rule F6 — Audit Trail Required for Finalization

Every finalization event must write an audit record containing:
- `company_id`
- `period_key`
- `employee_id`
- `user_id` (who triggered execute payroll)
- `timestamp`
- Snapshot ID reference

---

## 9. RELEASE SAFETY PROCESS

### Phase 1 — Development

- Work on `staging` branch only
- Apply the Change Impact Note before beginning
- Run affected regression tests in staging environment

### Phase 2 — Pre-Merge Audit

Before merging to `main`:

- [ ] All required regression tests passed (document test results)
- [ ] Change Impact Note completed
- [ ] No auto-trigger files modified without regression
- [ ] No browser storage added for payroll data
- [ ] Finalized payroll immutability rules preserved
- [ ] Multi-tenant safety verified (no cross-company data leak)

### Phase 3 — Staging Verification

- Deploy to staging
- Verify against the specific TEST-PAY-XX tests required by the Change Impact Note
- Use test company data — never real client data in staging

### Phase 4 — Infinite Legacy Verification

- Merge to `main` (Zeabur deploys automatically)
- Login as The Infinite Legacy / super admin
- Navigate to Paytime, verify core payroll flows work
- Check that finalized periods still show correct figures
- Verify company switching still works

### Phase 5 — Test Client Verification

- Activate for one known test client via feature flag if applicable
- Have someone on that account verify payslips look correct
- Check that previously finalized payslips are unchanged

### Phase 6 — Production Rollout

- Confirm no errors in Zeabur logs
- Confirm `/api/health` returns healthy
- Full rollout (or flag activation if feature-flagged)
- Document commit hash in session handoff

### Critical Payroll Change Documentation Requirement

For any change classified as CRITICAL or HIGH risk:

```
PAYROLL DEPLOYMENT RECORD
─────────────────────────────────────────────────────────────
Date: [YYYY-MM-DD]
Commit hash: [git hash]
Branch merged: staging → main
Change description: [what changed]
Payroll areas affected: [list]
Regression tests run: [list TEST-PAY-XX results]
Infinite Legacy verified: [ ] Yes
Test client verified: [ ] Yes / [ ] N/A
Rollback commit: [previous commit hash for revert target]
─────────────────────────────────────────────────────────────
```

---

## 10. PROHIBITED PATTERNS

The following code patterns are permanently forbidden in payroll-related files. Any code matching these patterns must be blocked and corrected before deployment.

### P1 — Business Data in Browser Storage

```javascript
// ❌ FORBIDDEN
localStorage.setItem('payslip_data_...', JSON.stringify(payslip));
sessionStorage.setItem('paye_...', value);
safeLocalStorage.setItem('emp_payroll_...', JSON.stringify(data));

// ✅ CORRECT
await fetch('/api/payroll/...', { method: 'POST', body: JSON.stringify(data) });
```

### P2 — Finalization State from Browser Storage

```javascript
// ❌ FORBIDDEN
const isLocked = localStorage.getItem('period_locked_' + companyId + '_' + period);

// ✅ CORRECT
const { data } = await GET('/payroll/periods/' + period);
const isLocked = data.is_locked === true;
```

### P3 — Silent Fallback for Calculation Inputs

```javascript
// ❌ FORBIDDEN — silently uses stale data if API fails
const salary = (await getEmployeePayroll(id)) || cachedSalary || 0;

// ✅ CORRECT — fail explicitly; do not calculate with stale inputs
const payroll = await getEmployeePayroll(id);
if (!payroll) throw new Error('Cannot calculate: payroll data unavailable');
```

### P4 — Hardcoded Company IDs

```javascript
// ❌ FORBIDDEN
if (companyId === 1) { /* Infinite Legacy special case */ }
const DEFAULT_COMPANY = 7;

// ✅ CORRECT
// Use req.companyId from JWT; never hardcode company IDs
```

### P5 — Recalculating Locked Periods

```javascript
// ❌ FORBIDDEN
// Loading payslip and recalculating regardless of lock status

// ✅ CORRECT
if (snapshot.is_locked) {
    return snapshot; // Return snapshot directly — no recalculation
}
```

### P6 — Bypassing requireCompany Middleware

```javascript
// ❌ FORBIDDEN
router.get('/calculate', handler); // No requireCompany

// ✅ CORRECT
router.get('/calculate', requireCompany, requirePermission('PAYROLL.VIEW'), handler);
```

---

## 11. PROTECTED MODULE MANIFEST

The machine-readable manifest is maintained at:

```
accounting-ecosystem/paytime.protected.json
```

This file defines:
- Protected file paths
- Required regression tests per file
- Forbidden change patterns
- Deployment gates

This manifest is intended for future CI integration. It currently serves as a reference document.

---

## 12. GOVERNANCE BREACH RESPONSE

If a regression is discovered in production payroll:

### Immediate (within 1 hour)

1. Identify the commit that introduced the regression (`git log`, `git bisect`)
2. Assess severity: Are finalized payrolls affected? Are calculations wrong for open periods?
3. If calculations wrong for open periods: Emergency feature flag disable (if feature-flagged) OR `git revert HEAD && git push origin main`
4. If finalized payrolls affected: Escalate immediately — do NOT attempt to "fix" finalized snapshots through code. Manual review of affected clients required.

### Short-term (within 24 hours)

1. Document the regression in a `SESSION_HANDOFF_YYYY-MM-DD-payroll-regression.md` file
2. Identify which regression test would have caught it
3. Add that scenario to the regression suite if not already present
4. Fix on staging, re-run full regression suite, verify, merge to main

### Prevention

1. Add the missed scenario to `paytime.protected.json`
2. Update WORKING_FEATURES_REGISTRY.md with the affected feature
3. Update this document if a new class of risk was identified

---

## RELATED DOCUMENTS

| Document | Purpose |
|---|---|
| `CLAUDE.md` Part E | Permanent operating rules for all Claude sessions |
| `DEV_PROTOCOL.md` | Day-to-day developer change-control checklist |
| `accounting-ecosystem/paytime.protected.json` | Machine-readable protected file manifest |
| `WORKING_FEATURES_REGISTRY.md` | Registry of confirmed-working features |
| `docs/paytime-release-process.md` | Feature flag rollout and staging/production strategy |
| `docs/DATA_PERSISTENCE_POLICY.md` | No browser storage policy |
| `accounting-ecosystem/docs/paytime-full-audit-report.md` | Full Paytime audit (April 2026) |

---

*This document is a permanent governance standard for the Lorenco Ecosystem.*
*Effective date: May 2026. Supersedes any informal conventions.*
*This document may only be modified through an authorised change-control decision.*
