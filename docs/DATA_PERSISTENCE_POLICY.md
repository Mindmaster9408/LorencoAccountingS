# CRITICAL DATA PERSISTENCE POLICY

**Date**: 2026-03-09  
**Priority**: CRITICAL - Business Continuity  
**Scope**: All applications in Lorenco Accounting Ecosystem

---

## Core Rule: NO BUSINESS DATA IN LOCALSTORAGE

### Problem
If a user clears browser history/data, **all localStorage is permanently deleted**.

### Impact
Loss of localStorage = loss of all business data = catastrophic data loss.

### Policy

#### ✅ SAFE for localStorage (Non-Critical Data)
- **Session tokens** - User can re-login
- **Auth credentials** - User can re-authenticate
- **UI preferences** - Theme, language, layout preferences
- **Temporary cache** - Data that can be re-fetched from server
- **Draft form data** - As long as user is warned data is not saved permanently

#### ❌ NEVER in localStorage (Critical Business Data)
- **Payroll records** - employee data, pay runs, payslips
- **Financial transactions** - invoices, payments, receipts
- **Accounting data** - journal entries, ledgers, balances
- **POS transactions** - sales, inventory, customer orders
- **Customer/Client data** - contact info, history, documents
- **Company records** - registration, tax data, banking details
- **Historical archives** - any data requiring retention/audit trail
- **Reports** - generated reports with business metrics

---

## Implementation Strategy by Application

### ✅ Payroll App - COMPLIANT
- **Status**: Already compliant
- **Data Storage**: Supabase cloud (PostgreSQL via payroll_kv_store table)
- **localStorage Usage**: Session/token only
- **Architecture**: DataAccess abstraction layer routes all business data to cloud

### ⚠️ Point of Sale (POS) - NEEDS AUDIT
- **Status**: Unknown - requires verification
- **Action Required**: Audit data persistence strategy
- **Risk**: May be using localStorage for transactions/inventory

### ⚠️ Accounting App - NEEDS AUDIT
- **Status**: Unknown - requires verification  
- **Action Required**: Verify financial data storage location
- **Risk**: Potential localStorage usage for ledger/transactions

### ⚠️ Ecosystem Dashboard - NEEDS AUDIT
- **Status**: Multiple localStorage calls detected
- **Action Required**: Separate auth data from business data
- **Risk**: Client data may be stored locally

---

## Engineering Standards

### For ALL New Features
1. **Before storing ANY data**: Ask "What happens if localStorage is cleared?"
2. **If answer is "user loses data"**: MUST use server/cloud storage
3. **If answer is "user just re-logs in"**: localStorage is OK

### Code Review Checklist
- [ ] No `localStorage.setItem()` with business data
- [ ] Business data writes go to server API
- [ ] localStorage only used for session/preferences
- [ ] Clear documentation of what's stored where

### Architecture Pattern (Payroll Model)
```javascript
// ✅ CORRECT: Business data → Cloud
DataAccess.set('employees_123', employeeData);  // Goes to Supabase

// ✅ CORRECT: Auth data → localStorage
safeLocalStorage.setItem('session', JSON.stringify(session));

// ❌ WRONG: Business data → localStorage
localStorage.setItem('invoices', JSON.stringify(invoices));  // DATA LOSS RISK!
```

---

## Validation Actions Required

1. **Immediate (This Week)**
   - [ ] Audit POS app data persistence layer
   - [ ] Audit Accounting app data storage
   - [ ] Audit Ecosystem dashboard storage patterns
   - [ ] Document what each app stores where

2. **High Priority (Next 2 Weeks)**
   - [ ] Migrate any business data from localStorage to cloud
   - [ ] Add warnings/errors if business data localStorage detected
   - [ ] Update all documentation with this policy

3. **Ongoing**
   - [ ] Code review enforcement
   - [ ] Automated tests to detect localStorage business data
   - [ ] Developer training on data persistence policy

---

## Emergency Recovery Plan

**If localStorage was cleared and data lost:**

1. Check if cloud backups exist (Supabase, server DB)
2. Check browser backup/sync if available
3. Restore from daily server backups
4. **Prevention**: Ensure all apps follow cloud-first architecture

---

## Questions for Each App

For every application, answer:

1. **Where is business data stored?** (localStorage vs server/cloud)
2. **What happens if browser data is cleared?** (data loss vs just re-login)
3. **Is there a server/cloud backup?** (yes/no)
4. **Can user switch browsers and see same data?** (yes = cloud, no = local risk)

---

**Last Updated**: 2026-03-09  
**Review Frequency**: Before each major release  
**Owner**: Development Team + Product Owner
