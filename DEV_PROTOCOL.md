# DEV PROTOCOL
## Lorenco Ecosystem — Developer Change-Control Standard

> **Use this document every day.**
> Before coding, during review, before push.
> Full governance detail is in `PAYTIME_STABILITY_LOCK.md`.
> Master rules are in `CLAUDE.md`.

---

## QUICK REFERENCE: BEFORE YOU CODE

```
1. What am I changing?
2. Does it touch any auto-trigger file? (see Section 2)
3. If yes → write Change Impact Note FIRST
4. Run regression tests BEFORE push
5. Document results
```

---

## SECTION 1 — ECOSYSTEM MODULE STATUS

| Module | Status | Change Rules |
|---|---|---|
| **Paytime Payroll** | 🔒 STABILITY-LOCKED | Explicit authorization + regression testing required |
| **POS / Checkout Charlie** | 🟡 ACTIVE DEVELOPMENT | Standard rules apply; audit payroll impact if sharing code |
| **Accounting** | 🟡 ACTIVE DEVELOPMENT | Standard rules apply; audit payroll impact if sharing code |
| **Coaching** | 🟡 ACTIVE DEVELOPMENT | Standard rules apply |
| **Sean AI** | 🟡 ACTIVE DEVELOPMENT | Audit payroll impact if touching shared data layer |
| **Ecosystem Dashboard** | 🟡 ACTIVE DEVELOPMENT | Audit payroll impact if touching auth/JWT |
| **Shared Backend (auth, middleware)** | ⚠️ HIGH IMPACT | Touching this requires payroll regression audit |

---

## SECTION 2 — AUTO-TRIGGER FILES

Modifying ANY of these files requires a Payroll Regression Test before push.

```
frontend-payroll/js/payroll-engine.js          ← CRITICAL
frontend-payroll/js/data-access.js             ← HIGH
frontend-payroll/js/auth.js                    ← HIGH
frontend-payroll/js/payroll-api.js             ← HIGH
frontend-payroll/js/polyfills.js               ← HIGH
frontend-payroll/js/recon-service.js           ← HIGH
frontend-payroll/payroll-execution.html        ← HIGH
frontend-payroll/employee-detail.html          ← HIGH
frontend-payroll/payruns.html                  ← HIGH
backend/modules/payroll/**                     ← CRITICAL
backend/shared/routes/auth.js                  ← HIGH
backend/shared/routes/companies.js             ← HIGH
backend/middleware/auth.js                     ← HIGH
backend/config/permissions.js                  ← MEDIUM
```

---

## SECTION 3 — PRE-CODING CHECKLIST

Complete before writing any code:

**For all tasks:**
- [ ] Have I read `WORKING_FEATURES_REGISTRY.md` for overlap with files I'm touching?
- [ ] Have I checked `CLAUDE.md` rules that apply to this task?
- [ ] Am I touching any auto-trigger files? (Section 2)

**If touching auto-trigger files:**
- [ ] Is this change explicitly authorized for Paytime?
- [ ] Have I written the Change Impact Note? (Section 5)
- [ ] Have I identified which regression tests are required?

**If touching shared auth/middleware:**
- [ ] Could this affect payroll company context?
- [ ] Could this break JWT structure that payroll depends on?
- [ ] Could this change session handling that payroll uses?

---

## SECTION 4 — CODING RULES SUMMARY

### NEVER DO

| Never | Why |
|---|---|
| Write payroll data to `localStorage` / `sessionStorage` / `safeLocalStorage` | Data loss, audit failure, multi-device divergence |
| Read `is_locked` status from browser storage | Finalization state must come from DB snapshot |
| Recalculate a locked payroll period | Finalized payroll is immutable |
| Hardcode company IDs | Breaks multi-tenant safety |
| Silently catch calculation errors and return defaults | Produces wrong payslips without any visible error |
| Skip `requireCompany` middleware on payroll routes | Breaks multi-tenant isolation |
| Bypass `requirePermission` on payroll routes | Security regression |
| Patch a payroll bug without a regression test | Risk of silent re-introduction |
| Use `safeLocalStorage` KV bridge for payroll business data | Not a relational store; no audit trail; violates Rule D3 |

### ALWAYS DO

| Always | Why |
|---|---|
| Write payroll data to backend API → SQL | Persistent, auditable, multi-device, compliant |
| Read `is_locked` from `payroll_snapshots` via API | Single source of truth |
| Include `requireCompany` on every payroll route | Multi-tenant safety |
| Test company switching after any auth/session change | Context contamination risk |
| Add `FOLLOW-UP NOTE` for anything uncertain | Documents risk, prevents silent assumptions |
| Run the full regression suite before pushing high-risk changes | Catches regressions before clients do |

---

## SECTION 5 — CHANGE IMPACT NOTE (REQUIRED FORMAT)

Copy and fill in for every non-trivial payroll change:

```
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:

Files involved:

Why this change is needed:

Is this an explicitly authorised Paytime task?
  [ ] Yes  [ ] No (shared/other-module with payroll side-effects)

Payroll risk:
  [ ] CRITICAL  [ ] HIGH  [ ] MEDIUM  [ ] LOW

Specific payroll areas that could be affected:

Regression risk:
  [ ] High  [ ] Medium  [ ] Low

Regression tests required:
  [ ] TEST-PAY-01  [ ] TEST-PAY-02  [ ] TEST-PAY-03  [ ] TEST-PAY-04
  [ ] TEST-PAY-05  [ ] TEST-PAY-06  [ ] TEST-PAY-07  [ ] TEST-PAY-08
  [ ] TEST-PAY-09  [ ] TEST-PAY-10  [ ] TEST-PAY-11  [ ] TEST-PAY-12
  [ ] TEST-PAY-13  [ ] TEST-PAY-14

Rollback strategy:

Confirmed safe:
  [ ] payroll-engine.js not affected
  [ ] PayrollCalculationService.js not affected
  [ ] Finalized snapshot read path not affected
  [ ] Company context not affected
  [ ] PAYE/UIF/SDL logic not affected
─────────────────────────────────────────────────────────────
```

---

## SECTION 6 — REGRESSION TEST QUICK REFERENCE

Full descriptions are in `PAYTIME_STABILITY_LOCK.md` Section 5.

| Test | What It Checks |
|---|---|
| TEST-PAY-01 | Basic payslip calculation (PAYE, UIF, SDL, net) |
| TEST-PAY-02 | Execute Payroll matches payslip view |
| TEST-PAY-03 | PAYE correctness across tax brackets |
| TEST-PAY-04 | UIF cap enforcement |
| TEST-PAY-05 | SDL registered vs exempt (company setting) |
| TEST-PAY-06 | Overtime inclusion in gross and tax |
| TEST-PAY-07 | Short time reduction cascades through tax |
| TEST-PAY-08 | Voluntary tax override adds to PAYE |
| TEST-PAY-09 | Finalized snapshot is immutable |
| TEST-PAY-10 | Payslip and Execute Payroll figures match exactly |
| TEST-PAY-11 | Company switching preserves correct context |
| TEST-PAY-12 | Multi-tenant: no cross-company data |
| TEST-PAY-13 | No payroll data in browser storage |
| TEST-PAY-14 | PAYE recon totals match snapshot data |

---

## SECTION 7 — SHARED CODE IMPACT QUESTIONS

Ask these before pushing changes to shared code:

**Changing `backend/shared/routes/auth.js`?**
- Does login still return `selectedCompany` with correct `companyId`?
- Does `select-company` still embed `companyId` in the new JWT?
- Does `sso-launch` still correctly resolve eco_client access?
- Run: TEST-PAY-11, TEST-PAY-12

**Changing `frontend-payroll/js/auth.js`?**
- Does `AUTH.getSession()` still return `{company_id, role}`?
- Is `token` still in native localStorage (not KV bridge)?
- Run: TEST-PAY-11, TEST-PAY-13

**Changing `frontend-payroll/js/data-access.js`?**
- Does `isLocalKey()` still protect `session` and `token`?
- Is the KV bridge still NOT being used for payroll calculation inputs?
- Run: TEST-PAY-13

**Changing `backend/middleware/auth.js`?**
- Does `authenticateToken` still set `req.companyId`?
- Does `requireCompany` still block null-company requests?
- Run: TEST-PAY-12

**Changing `backend/config/permissions.js`?**
- Does `PAYROLL.VIEW` still include all correct roles?
- Does `PAYROLL.PROCESS` still correctly restrict execution?
- Run: TEST-PAY-11

---

## SECTION 8 — PRE-PUSH CHECKLIST

Complete this before every push that touches auto-trigger files:

```
PRE-PUSH PAYROLL GATE
─────────────────────────────────────────────────────────────
Date: ___________
Task: ___________
Commit: ___________

[ ] Change Impact Note completed
[ ] Auto-trigger files checked
[ ] Payroll regression tests run:
    Tests run: ___________
    All passed: [ ] Yes  [ ] No (document failures below)

[ ] No browser storage added for payroll data
[ ] No hardcoded company IDs introduced
[ ] Finalized snapshot immutability preserved
[ ] Multi-tenant safety preserved
[ ] WORKING_FEATURES_REGISTRY.md checked for regressions

Failures / follow-ups:
  ___________

Approved to push: [ ] Yes
─────────────────────────────────────────────────────────────
```

---

## SECTION 9 — SAFE ROLLOUT FLOW

```
1. CODE (staging branch)
        ↓
2. CHANGE IMPACT NOTE (written before coding)
        ↓
3. REGRESSION TESTS (run on staging)
        ↓
4. STAGING VERIFICATION (test company in staging)
        ↓
5. MERGE TO MAIN (git merge staging)
        ↓
6. INFINITE LEGACY VERIFICATION (super admin, production)
        ↓
7. TEST CLIENT VERIFICATION (one real client, production)
        ↓
8. FULL ROLLOUT (or feature flag activation)
        ↓
9. DOCUMENT (session handoff + commit hash)
```

For hotfixes: may fix on `main` directly, but must:
- Complete pre-push checklist
- Merge fix back to `staging` immediately after
- Document as a hotfix in session handoff

---

## SECTION 10 — FINALIZATION IMMUTABILITY QUICK RULES

```
payroll_snapshots.is_locked = true
        ↓
Return snapshot figures directly
        ↓
DO NOT recalculate
DO NOT modify the row
DO NOT read from browser storage for locked status
DO NOT allow editing of locked period inputs in the UI
```

The only path to `is_locked = true` is:
**Execute Payroll → POST /api/payroll/payruns → DB snapshot**

No other path. No shortcuts. No admin overrides from application code.

---

## SECTION 11 — EMERGENCY PLAYBOOK

### Payroll regression discovered in production

1. **Identify severity** (5 min)
   - Are finalized payrolls affected? → escalate immediately
   - Are open period calculations wrong? → proceed to step 2

2. **Stop the bleeding** (10 min)
   - Feature flag: disable if feature-flagged
   - OR: `git revert HEAD --no-edit && git push origin main`

3. **Document** (immediate)
   - Create `SESSION_HANDOFF_YYYY-MM-DD-REGRESSION.md`
   - Note: affected companies, affected periods, affected calculations, commit hash

4. **Root cause** (30 min)
   - `git bisect` or `git log` to find introducing commit
   - Identify which TEST-PAY-XX test would have caught it

5. **Fix on staging** (before re-deploying)
   - Fix the issue
   - Run the full regression suite
   - Verify ALL 14 tests pass
   - Document results in the session handoff

6. **Re-deploy and verify**
   - Merge to main
   - Infinite Legacy verification
   - Confirm production payroll correct

7. **Prevention update** (next session)
   - Add missed test case to regression suite
   - Update `paytime.protected.json` if new risk class identified
   - Update `WORKING_FEATURES_REGISTRY.md`

---

*DEV_PROTOCOL.md — Lorenco Ecosystem. Effective May 2026.*
*Read before every coding session that touches Paytime or shared infrastructure.*
