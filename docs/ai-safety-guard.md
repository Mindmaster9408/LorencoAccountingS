# Lorenco AI Safety Guard

This file contains additional safety protections for AI-generated code.

All AI coding tools must follow these rules.

---

## 1. PROTECT ACCOUNTING DATA

The following data must never be corrupted:

• financial transactions
• invoices
• payroll records
• VAT records
• reconciliation records

AI must never delete or overwrite these without explicit instruction.

---

## 2. PROTECT MULTI-APP ECOSYSTEM

The Lorenco ecosystem contains multiple apps:

• Accounting
• Paytime
• Checkout Charlie
• Platform Control
• Sean AI

AI must ensure changes in one app do not break another.

---

## 3. PROTECT ROUTING

Routes must never be removed unless explicitly instructed.

Broken routes create dead buttons and unusable features.

---

## 4. PROTECT DATABASE STRUCTURE

Database schemas must not be changed casually.

If schema changes are required AI must:

1. explain the change
2. confirm compatibility
3. ensure migrations are safe

---

## 5. PROTECT CLIENT DATA

No client data should ever be overwritten by demo data.

Demo data must only exist in demo mode.

---

## 6. PROTECT UI CONSISTENCY

All UI must follow the Lorenco design system.

Never mix light theme and dark theme components.

---

## 7. AI MUST ALWAYS AUDIT BEFORE CODING

Before modifying code AI must:

• inspect existing code
• identify dependencies
• understand feature behavior
• confirm expected outcome

Only then may code be modified.

---

## END OF AI SAFETY GUARD
