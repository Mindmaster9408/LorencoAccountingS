---
Type: Action Checklist
Date: April 11, 2026
Purpose: Track Paytime audit findings and required fixes
Status: Use this to prioritize work
---

# PAYTIME AUDIT CHECKLIST — QUICK REFERENCE

## ⛔ BLOCKING ISSUES (MUST FIX)

- [ ] **Audit Trail Missing** — Can't trace who changed what, when
  - File: All payroll operations
  - Priority: CRITICAL
  - Effort: 3-4 weeks
  - Blocker for: Production deployment

- [ ] **Leave Deduction Not Integrated** — Unpaid leave not deducted
  - File: `paytime/js/payroll-engine.js`
  - Priority: CRITICAL
  - Effort: 1-2 weeks
  - Blocker for: Real payroll use

- [ ] **No Approval Workflow** — One person controls all payroll
  - File: `frontend-payroll/pay-run.html` workflow
  - Priority: CRITICAL (compliance/control)
  - Effort: 1-2 weeks
  - Blocker for: Multi-operator deployments

- [ ] **No Validation on Negative/Zero Salary** — Could pay impossible amounts
  - File: `frontend-payroll/add-employee.html` (form validation)
  - Priority: CRITICAL
  - Effort: 1 week
  - Impact: High

- [ ] **No Validation Before Pay Run Finalize** — Could finalize incomplete payrun
  - File: `frontend-payroll/pay-run.html` (finalize button)
  - Priority: CRITICAL
  - Effort: 1 week
  - Impact: High

- [ ] **Permissions Only Client-Side** — Can bypass in browser console
  - File: `frontend-payroll/layouts/sidebar.html` (permission checks)
  - Priority: HIGH (security)
  - Effort: 2-3 days (move to server)
  - Impact: Security exposure

- [ ] **No Employee Duplicate Prevention** — Same person could be added twice
  - File: `frontend-payroll/add-employee.html` (validation)
  - Priority: HIGH
  - Effort: 1 day
  - Impact: High (double-pay)

- [ ] **No Error Handling on Supabase Writes** — Silent data loss
  - File: `backend/DataAccess.js` (all Supabase calls)
  - Priority: HIGH
  - Effort: 2-3 days
  - Impact: Data integrity

---

## 🚨 HIGH-PRIORITY ISSUES (FIX NEXT PHASE)

- [ ] **No Pro-Rata Calculation** — New starters/terminations wrong amounts
  - File: `paytime/js/payroll-engine.js`
  - Effort: 2-3 weeks
  - Impact: Salary calculation wrong

- [ ] **Schemaless Data Model** — Prone to corruption
  - File: `backend/database/` schema design
  - Effort: 3-4 weeks (significant rewrite)
  - Impact: Data consistency

- [ ] **No Payslip Archive** — Can't retrieve old payslips
  - File: `frontend-payroll/payslips.html`
  - Effort: 1-2 weeks
  - Impact: Compliance / audit

- [ ] **Reports Incomplete** — Missing tax withholding, IRP5, bank export
  - File: `frontend-payroll/reports.html`
  - Effort: 2-3 weeks
  - Impact: Compliance reporting

- [ ] **No Transaction Safety** — Payrun write could fail mid-operation
  - File: Backend pay run creation logic
  - Effort: 1-2 weeks
  - Impact: Data consistency

- [ ] **Bank Account Fields Not Encrypted** — Security vulnerability
  - File: `backend/DataAccess.js` (bank detail storage)
  - Effort: 1 week
  - Impact: Security

- [ ] **Dropdown UX Poor for Long Lists** — Hard to find items
  - File: `frontend-payroll/pay-run.html` (item selection)
  - Effort: 1 day
  - Impact: UX friction

---

## 📋 VALIDATION / RANGE CHECKS

- [ ] Basic Salary: Prevent negative, prevent >999,999,999
  - File: `frontend-payroll/add-employee.html`
  - Effort: 1 day

- [ ] Medical Aid Members: 0 to 20 (reasonable range)
  - File: `frontend-payroll/add-employee.html`
  - Effort: 1 day

- [ ] Tax Directive: 0-100 (percentage range)
  - File: `frontend-payroll/add-employee.html`
  - Effort: 1 day

- [ ] Payroll Item Percentage: 0-500% (flag >100%)
  - File: `frontend-payroll/add-payroll-item.html`
  - Effort: 1 day

- [ ] UIF Rate: Force 0-1, not 0-100
  - File: Calculation engine
  - Effort: 1 day

- [ ] IRP5 Code: Validate against SARS official list
  - File: `frontend-payroll/add-payroll-item.html`
  - Effort: 1-2 days

- [ ] Negative Net Pay: Alert operator, prevent finalize without override
  - File: `frontend-payroll/pay-run.html` (review step)
  - Effort: 1 day

---

## 🏗️ DATA INTEGRITY

- [ ] Add soft delete (is_active flag vs hard delete)
  - File: `backend/DataAccess.js`
  - Effort: 1 week

- [ ] Add referential integrity validation
  - File: Pay run deletion logic
  - Effort: 1 week
  - Note: Don't allow employee delete if pay runs exist

- [ ] Add unique constraint: (company_id, employee_id_number)
  - File: Database schema
  - Effort: 1 day

- [ ] Add unique constraint: (company_id, payroll_item_code)
  - File: Database schema
  - Effort: 1 day

- [ ] Make finalized payslips immutable
  - File: `backend/DataAccess.js` (prevent updates to locked payslips)
  - Effort: 1 day

- [ ] Add JSON schema validation on KV writes
  - File: `backend/DataAccess.js`
  - Effort: 1 week

---

## 🔐 SECURITY

- [ ] Move permission checks to server (not client-side)
  - File: All backend endpoints
  - Effort: 3-4 days

- [ ] Add session timeout (30 min inactivity)
  - File: Auth middleware
  - Effort: 1 day

- [ ] Encrypt bank account fields
  - File: `backend/DataAccess.js` (encryption on store/retrieve)
  - Effort: 1-2 days

- [ ] Add audit trail for sensitive data access
  - File: New audit log module
  - Effort: 1 week

- [ ] Add IP address logging
  - File: Auth/logging layer
  - Effort: 1 day

- [ ] Implement segregation of duties (two-sign-off for payrun finalize)
  - File: Approval workflow
  - Effort: 1-2 weeks

---

## 📊 REPORTING

- [ ] Build tax withholding report (monthly PAYE collected)
  - File: `frontend-payroll/reports.html`
  - Effort: 1 week

- [ ] Build employee earnings report (detail per employee)
  - File: `frontend-payroll/reports.html`
  - Effort: 1 week

- [ ] Build bank payment file export (ACH/EFT format)
  - File: New export module
  - Effort: 2 weeks

- [ ] Build IRP5 preparation report
  - File: New report module
  - Effort: 2-3 weeks

- [ ] Build year-end summary (annual totals per employee)
  - File: New report module
  - Effort: 1 week

- [ ] Add payslip YTD totals display
  - File: `frontend-payroll/payslips.html` (payslip template)
  - Effort: 1 day

---

## 🔗 INTEGRATION

- [ ] Finalize ecosystem employee sync
  - File: `backend/DataAccess.js` (employee sync logic)
  - Effort: 1 week
  - Status: Recently added, needs audit trail

- [ ] Read leave balances from leave system
  - File: Leave integration API call
  - Effort: 1 week

- [ ] Generate accounting journal entries
  - File: New accounting export module
  - Effort: 2-3 weeks

- [ ] Time & attendance integration
  - File: New time clock API integration
  - Effort: 2-3 weeks

---

## 🧪 TESTING

- [ ] Unit tests for PayrollEngine (all calculation paths)
  - File: `tests/payroll-engine.test.js`
  - Effort: 2-3 weeks

- [ ] Negative salary prevention test
  - File: `tests/validation.test.js`
  - Effort: 1 day

- [ ] Duplicate employee prevention test
  - File: `tests/duplicate-prevention.test.js`
  - Effort: 1 day

- [ ] Pro-rata calculation test
  - File: `tests/pro-rata.test.js`
  - Effort: 1 week

- [ ] Tax calculation verification (against SARS examples)
  - File: `tests/tax-calculation.test.js`
  - Effort: 1 week

- [ ] Multi-tenant isolation test
  - File: `tests/multi-tenant.test.js`
  - Effort: 1 week

- [ ] Cross-browser testing (Chrome, Firefox, Safari, Edge)
  - File: Manual/automated browser testing
  - Effort: 1 week

---

## 📱 PERFORMANCE

- [ ] Remove synchronous XHR (`xhr.open(..., false)`)
  - File: `backend/DataAccess.js`
  - Effort: 2-3 days

- [ ] Add pagination to employee lists (100 at a time)
  - File: `frontend-payroll/employees.html`
  - Effort: 1 week

- [ ] Lazy-load payroll item dropdowns
  - File: `frontend-payroll/pay-run.html`
  - Effort: 1 week

- [ ] Add progress bar for long operations
  - File: Payslip generation, report generation
  - Effort: 1 week

- [ ] Cache report results
  - File: `frontend-payroll/reports.html`
  - Effort: 1 week

---

## WHAT TO PRESERVE (DO NOT CHANGE)

✅ These are working correctly — don't touch them:

- [ ] Verify: PAYE tax calculations remain unchanged
- [ ] Verify: Company isolation logic remains unchanged
- [ ] Verify: PayrollEngine module logic remains unchanged
- [ ] Verify: Role-based permission framework remains unchanged
- [ ] Verify: UI design consistency maintained
- [ ] Verify: Overtime calculations remain unchanged
- [ ] Verify: Medical tax credit logic remains unchanged
- [ ] Verify: UIF/SDL calculations remain unchanged

---

## COMPLIANCE REQUIREMENTS

- [ ] Multi-tenant data separation (company_id scoping)
  - Status: ✅ GOOD

- [ ] PAYE tax calculation accuracy
  - Status: ✅ GOOD

- [ ] IRP5 code support
  - Status: ✅ Present, not consumed

- [ ] UIF/SDL tracking
  - Status: ✅ GOOD

- [ ] Tax rebate support
  - Status: ✅ GOOD

- [ ] Medical tax credit support
  - Status: ✅ GOOD

- [ ] Employee ID parsing
  - Status: ✅ GOOD

- [ ] Audit trail
  - Status: ❌ MISSING (CRITICAL)

- [ ] Data encryption
  - Status: ❌ MISSING

- [ ] Approval workflow
  - Status: ❌ MISSING

- [ ] Permission enforcement (server-side)
  - Status: ❌ MISSING

---

## DEPLOYMENT CHECKLIST (When Ready)

Before deploying to production:

- [ ] All CRITICAL issues fixed and tested
- [ ] Audit trail implemented and working
- [ ] Approval workflow in place
- [ ] Server-side permission checks in place
- [ ] All validation rules enforced
- [ ] Error handling in place
- [ ] Leave integration complete
- [ ] Pro-rata calculations working
- [ ] No regressions in existing calculations
- [ ] Comprehensive test suite passing
- [ ] Security audit passed
- [ ] Database encrypted and backed up
- [ ] Documentation updated
- [ ] User training completed
- [ ] Rollback plan documented

---

## QUICK STATS

| Category | Status | Grade |
|----------|--------|-------|
| Core Math | ✅ Correct | A |
| Architecture | ✅ Good | A- |
| UI/UX | ✅ Good | A- |
| Validation | ❌ Missing | F |
| Security | ⚠️ Weak | D |
| Audit Trail | ❌ Missing | F |
| Error Handling | ❌ Missing | F |
| Integration | ⚠️ Partial | C |
| Performance | ⚠️ Adequate | C |
| Testing | ❌ Missing | F |

**Overall Grade: C+ (Foundational, not production-ready)**

---

## NEXT STEPS (IN ORDER)

1. **Week 1:** Implement audit trail (immutable log system)
2. **Week 2:** Add leave integration
3. **Week 3:** Add approval workflow
4. **Week 4:** Add comprehensive validation
5. **Week 5:** Move permissions to server-side
6. **Week 6-8:** Fix data model (transaction safety, schema)
7. **Week 9-12:** Add reports, pro-rata, integration fixes

---

*Track progress using this checklist. Update as you complete items.*
