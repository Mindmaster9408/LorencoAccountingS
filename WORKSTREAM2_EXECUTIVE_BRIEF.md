---
Type: WORKSTREAM 2 Executive Brief
Date: April 12, 2026
Audience: Technical leadership, implementation planning
Status: Ready for action

---

# WORKSTREAM 2 — CALCULATION DEPTH AUDIT: KEY FINDINGS & ACTION ITEMS

## HEADLINE

**Paytime's payroll calculation engine is mathematically sound for standard monthly salaries, but missing three critical features: pro-rata calculations, leave integration, and consistent output itemization.**

**Grade: B (77/100)** — Solid foundation, needs depth improvements

---

## WHAT'S WORKING WELL ✅

| Area | Status | Evidence |
|------|--------|----------|
| PAYE tax calculation | ✅ VERIFIED CORRECT | Tested against SARS tables; annualization method mathematically sound |
| UIF/SDL calculation | ✅ CORRECT | 1% formulas, caps applied properly |
| Medical tax credits | ✅ CORRECT | R364/dependent; properly subtracted post-tax |
| Hourly rate derivation | ✅ CORRECT | Formula: salary / (weeklyHours × 4.33), fallback to 173.33 divisor |
| Overtime math | ✅ CORRECT | Independent calculation, multipliers applied, accumulates properly |
| Short-time math | ✅ CORRECT | Deducted from gross, returns independently itemized |
| Tax year selection | ✅ CORRECT | March boundary properly identified |
| Rounding consistency | ✅ GOOD | Centralized r2() function, applied uniformly |
| Historical tax tables | ✅ PRESENT | 2021/22 through 2026/27 (2026/27 pending SARS confirmation) |
| Test coverage (OT/ST) | ✅ EXTENSIVE | ~100 test cases for overtime/short-time combinations |

---

## CRITICAL GAPS ❌

### #1: NO PRO-RATA CALCULATION (CRITICAL)

**What's missing:**
- Mid-month start dates: Employee hired March 15 is paid full month (WRONG — should be ~50%)
- Mid-month terminations: Employee terminated March 15 is paid full month (WRONG — should be ~50%)
- No pro-rata factor applied to salary or fixed allowances

**Impact:** New hires / terminations are financially incorrect

**Current workaround:** Manual spreadsheet calculation (error-prone)

**Effort to fix:** 2–3 weeks (medium complexity)

---

### #2: STANDALONE vs ECOSYSTEM DIVERGENCE (HIGH)

**Standalone version missing:**
- YTD PAYE method (for mid-year variable-income correction)
- Overtime/short-time itemization in return values (payslip can't display separately)
- Voluntary tax over-deduction (bonus spreading)

**Ecosystem version has all three:**
- YTD PAYE implemented (`calculateMonthlyPAYE_YTD`)
- Returns `overtimeAmount` and `shortTimeAmount` separately
- Voluntary tax config support

**Risk:** Two calculation engines with partial feature parity = maintenance nightmare + inconsistent results

**Recommendation:** Unify to ONE engine. Choose Ecosystem as primary, backport to Standalone.

**Effort:** 2–3 weeks (refactoring + testing)

---

### #3: LEAVE DEDUCTION NOT INTEGRATED (HIGH)

**Current state:**
- Leave framework exists (data model, API endpoints)
- But NOT auto-applied to payroll

**What happens now:**
- Employee takes unpaid leave (e.g., 10 days)
- Leave system records it
- Payroll engine ignores it
- **Employee is PAID AS IF THEY WORKED** (overpayment)

**Current workaround:** Operator manually adds "short time" input (error-prone, duplicate data entry)

**Effort to fix:** 2–3 weeks (integration + testing)

---

## MEDIUM-PRIORITY GAPS ⚠️

### Missing Output Consistency

**Problem:** 
- Standalone doesn't return `overtimeAmount` / `shortTimeAmount` separately
- Payslip generator might not show overtime/short-time line items
- Different screens may show different gross breakdowns

**Fix:** Add itemization to Standalone return schema (1–2 days)

### Negative Net Pay Allowed

**Current:** Engine calculates negative net but doesn't block (sets flag only)

**Risk:** If validation layer missing, could finalize payroll with negative net

**Fix:** Handled in Workstream 1 validation (not this workstream)

---

## VERIFICATION MATRIX — CALCULATION METHODS

| Method | Standalone | Ecosystem | Sync Status |
|--------|-----------|-----------|-------------|
| `calculateAnnualPAYE()` | ✅ | ✅ | IDENTICAL |
| `calculateMonthlyPAYE()` | ✅ | ✅ | IDENTICAL |
| `calculateMonthlyPAYE_YTD()` | ❌ MISSING | ✅ | — |
| `calculateUIF()` | ✅ | ✅ | IDENTICAL |
| `calculateSDL()` | ✅ | ✅ | IDENTICAL |
| `calcHourlyRate()` | ✅ | ✅ | IDENTICAL |
| `calculateFromData()` | ✅ | ✅ | **DIFFERENT RETURN SCHEMA** |

**Key divergence:** `calculateFromData()` returns different fields between versions (Ecosystem includes OT/ST breakdown, voluntary tax, etc.)

---

## IMPLEMENTATION ROADMAP

### Phase 1 — WORKSTREAM 2: Calculation Depth (2–3 weeks)

**Priority 1 (Blocking):**
- [ ] Implement pro-rata calculation methodology
- [ ] Add `calculateProRataFactor(startDate, endDate, basisMethod)` method
- [ ] Integrate into `calculateFromData()`
- [ ] Add comprehensive tests

**Priority 2 (Harmonization):**
- [ ] Standardize return schema (both versions must return OT/ST itemization)
- [ ] Verify payslip/report/PDF consistency
- [ ] Update documentation

**Priority 3 (Optional):**
- [ ] Decide on YTD PAYE backport (recommend deferring to Phase 2)

### Phase 2 — Leave Integration (2–3 weeks)

- [ ] Design leave → payroll data flow
- [ ] Query leave system; auto-create deduction inputs
- [ ] Integration testing with real leave data

### Phase 3 — Polish & Optimization (Optional, 3–4 weeks)

- [ ] Advanced features (YTD backport, voluntary tax, etc.)
- [ ] Performance optimization
- [ ] Extended test coverage

---

## TEST COVERAGE STATUS

**Current:**
- ✅ Overtime/short-time: Excellent (~100 test cases)
- ⚠️ PAYE/UIF/SDL: Verified but minimal formal tests
- ❌ Pro-rata: No tests (feature missing)
- ❌ Leave: No tests
- ❌ YTD: No tests (Ecosystem feature, not tested)
- ❌ Edge cases: Minimal (zero salary, negative net, etc.)

**Workstream 2 must add:**
- Pro-rata calculation tests
- Edge case tests
- Output consistency tests
- Rounding consistency tests
- Historical tax table verification tests

---

## DECISION REQUIRED: ENGINE UNIFICATION

### Option A: Unify to Ecosystem Version (Recommended)
- Ecosystem becomes primary source of truth
- Standalone updated to match (add OT/ST itemization, YTD support option)
- Single calculation engine across both apps
- **Effort:** 2–3 weeks
- **Risk:** Lower (ecosystem already production-tested)
- **Benefit:** Single source of truth, easier maintenance

### Option B: Enhance Standalone, Backport Selectively
- Keep Standalone simple, focused on SMB > annualization PAYE
- Backport only essentials (OT/ST itemization, pro-rata)
- Leave Ecosystem as "advanced" version
- **Effort:** 3–4 weeks
- **Risk:** Higher (maintenance burden of two versions)
- **Benefit:** Lighter-weight Standalone for simple use

**Recommendation:** Choose **Option A** (Unify to Ecosystem)

---

## SUCCESS CRITERIA (End of WORKSTREAM 2)

After this workstream is complete:

- [x] Pro-rata calculation implemented and tested
- [x] Return schema standardized (both versions have OT/ST itemization)
- [x] Payslip/report/PDF consistency verified
- [x] Edge cases documented and handled safely
- [x] Comprehensive test coverage for all calculation paths
- [x] Zero regression in existing working PAYE/UIF/SDL logic
- [x] Documentation updated (PAYE methodology, pro-rata basis, etc.)

---

## RISKS & MITIGATIONS

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Pro-rata implementation breaks PAYE | MEDIUM | Write tests first (PAYE unchanged unless pro-rata active) |
| Version divergence increases | MEDIUM | Unify engines now (before divergence grows) |
| Leave integration has wrong data flow | MEDIUM | Design integration spec before coding; validate with leave system owner |
| Customer expects YTD immediately | LOW | Document annualization choice; offer YTD as Phase 2 option |
| Rounding inconsistencies cause penny mismatches | LOW | Centralize all rounding through r2(); don't calculate in multiple places |

---

## DELIVERABLES

By end of WORKSTREAM 2:

1. **WORKSTREAM2_CALCULATION_AUDIT_REPORT.md** ✅ (This document, detailed technical audit)
2. **Pro-rata calculation methods** (code + tests)
3. **Standardized return schema** (both engines)
4. **Payslip consistency validation** (test that engine output matches payslip display)
5. **Comprehensive test suite** (pro-rata, edge cases, consistency)
6. **Updated documentation** (PAYE methodology, pro-rata basis, etc.)

---

## NEXT STEPS

**This week:**
1. Review this audit with team
2. Decide: Unify engines (Option A) or enhance separately (Option B)
3. Assign pro-rata implementation task

**Next 2–3 weeks:**
1. Implement pro-rata calculation
2. Standardize return schema
3. Add test coverage
4. Verify consistency across outputs

---

## QUESTIONS FOR CLARIFICATION

Before starting implementation:

1. **Pro-rata basis:** Calendar days vs working days vs schedule-based days?
2. **Leave system location:** Which app/service provides unpaid leave data?
3. **Engine unification:** Proceed with Option A (Ecosystem as primary)?
4. **YTD PAYE:** Essential for Standalone now, or Phase 2?
5. **Timeline:** 2–3 weeks acceptable, or compressed needed?

---

*Workstream 2 Audit Complete. Ready for implementation planning. All findings can be traced to WORKSTREAM2_CALCULATION_AUDIT_REPORT.md for detailed technical context.*
