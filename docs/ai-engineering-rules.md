# Lorenco Platform — AI Engineering Rules

These rules apply to ALL AI coding tools working on the Lorenco ecosystem.

This includes:

• Claude
• GitHub Copilot
• ChatGPT
• Cursor
• any future AI coding assistants

All AI tools must read this file before modifying code.

---

## 1. ALWAYS AUDIT BEFORE CHANGING CODE

AI must NEVER immediately modify code.

Before making changes:

1. Identify affected files
2. Understand how the feature works
3. Check dependencies
4. Identify shared components
5. Identify cross-app effects
6. Verify tenant isolation

Only after auditing should code be modified.

---

## 2. NEVER BREAK WORKING FEATURES

If something works, it must remain working.

AI must:

• avoid unnecessary refactoring
• preserve working logic
• avoid removing existing features unless instructed
• verify new code does not break other modules

---

## 3. MULTI-TENANT DATA SAFETY (CRITICAL)

Lorenco is a multi-company platform.

Every record MUST belong to a company.

Examples:

    customers.company_id
    suppliers.company_id
    transactions.company_id
    employees.company_id
    invoices.company_id

All queries must filter by:

    company_id

No data may appear across companies.

Switching companies must clear cached data.

Demo data must never appear in real companies.

Breaking tenant isolation is a CRITICAL ERROR.

---

## 4. GLOBAL DARK THEME RULE

The Lorenco platform uses a dark theme.

AI must never hardcode colors.

Always use shared theme components:

    PageContainer
    Panel/Card
    TableWrapper
    ReportPanel

Never create page-specific color systems.

New pages must automatically inherit the theme.

---

## 5. USE SHARED COMPONENTS

Before creating UI components, AI must check if shared ones exist.

Common shared components include:

• tables
• cards
• panels
• report layouts
• forms
• modals

Duplicate components must not be created.

---

## 6. ACCOUNTING SAFETY RULES

Accounting logic must be handled carefully.

Important systems include:

• VAT calculations
• financial reports
• reconciliation systems
• payroll calculations

AI must not guess accounting logic.

VAT must support:

• Inclusive VAT
• Exclusive VAT

Reports must remain consistent with the chart of accounts.

---

## 7. REPORTING STRUCTURE

Financial reports must follow correct accounting structures.

Supported reports include:

    Profit & Loss
    Balance Sheet
    Cash Flow
    Trial Balance
    Debtors Aging
    Creditors Aging

AI must not break financial reporting.

---

## 8. CODE QUALITY STANDARD

All generated code must be production quality.

Requirements:

• clean naming
• modular architecture
• minimal duplication
• maintainable structure
• readable logic

Avoid hacks or temporary patches.

---

## 9. DOCUMENTATION

When architecture changes are made AI must update documentation.

Documentation must be placed in:

    /docs/

Include:

• what changed
• why it changed
• architecture decisions
• future improvements

---

## 10. LONG TERM ARCHITECTURE

AI must prioritize long-term stability over quick fixes.

If the same problem appears repeatedly (theme bugs, routing bugs, data isolation), AI must fix the underlying architecture rather than patch individual pages.

---

## FINAL RULE

If AI is unsure about behaviour or architecture, it must ask questions instead of guessing.
