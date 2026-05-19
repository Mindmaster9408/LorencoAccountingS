# Sean AI — Future COA Assist Layer

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — Sean intelligence in Chart of Accounts management  
> **Last updated:** May 2026

---

## 1. Overview

When Sean is active for a company, the Chart of Accounts module gains an optional AI assist layer.

This does not change how accounts are stored or structured. It adds:
- Contextual suggestions when creating new accounts
- Semantic classification of existing accounts
- Description quality prompting
- Account type guidance based on purpose

---

## 2. AI-Assisted Account Creation

**Scenario:** An accountant clicks "Add Account" in the Chart of Accounts.

**Without Sean:** Blank form — accountant fills in name, type, category, etc.

**With Sean active:** Accountant types a description of the account's purpose. Sean suggests:
- Account name (normalized)
- Account type (Asset / Liability / Income / Expense / Equity)
- Account grouping / parent category
- Known SA accounting standards alignment (IFRS for SMEs)
- Whether the account is VAT-sensitive
- Whether the account is payroll-linked
- Whether it's a control account (bank, debtors, creditors)

**Example:**
```
User types: "This account tracks money the owner loans to the company or takes back"

Sean suggests:
  Name:       Director's Loan Account
  Type:       Liability
  Category:   Loan Accounts
  VAT:        Not applicable
  Payroll:    Not linked
  Note:       Typical classification is under Current Liabilities if repayable within 12 months,
              Non-Current Liabilities if longer term. Consider discussing with auditor.
```

---

## 3. Account Types Sean Should Recognize

Future training data should include these account patterns common in SA SME accounting:

### Loan / Funding Accounts
- Director Loan Account
- Shareholder Loan
- Related Party Loan
- IDC / SEDA funding accounts
- Intercompany loan accounts

### VAT-Sensitive Accounts
- VAT Input (Standard Rate)
- VAT Output (Standard Rate)
- VAT Exempt Income
- Zero-Rated Revenue

### Payroll-Linked Accounts
- Salaries and Wages (expense)
- PAYE Control (liability)
- UIF Control (liability)
- SDL Payable (liability)
- Net Pay Control (liability — bridge between payroll and bank)

### Bank-Linked Accounts
- Main Operating Account
- Petty Cash
- Foreign Currency Account
- Credit Card Account

### Control / Reconciliation Accounts
- Debtors Control (linked to customer ledger)
- Creditors Control (linked to supplier ledger)
- Suspense Account (temporary — should always net to zero)

---

## 4. Description Quality Prompting

When an accountant adds an account without a description, Sean should gently prompt:

```
"Adding a description helps Sean understand this account's purpose and 
 improve auto-allocation accuracy. Would you like to add one?"
```

Short descriptions (< 10 words) should be prompted for expansion:

```
"Your description is quite brief. Describing when this account is used 
 (debit vs credit, what transactions belong here) will improve Sean's 
 suggestions significantly."
```

This is UX guidance — never mandatory, never blocking.

---

## 5. What Sean Does NOT Do in COA

Sean must not:
- Auto-create accounts without explicit user action
- Change existing account types or groupings automatically
- Delete or merge accounts
- Suggest renumbering (account codes are the accountant's domain)
- Override the accountant's classification choice

Sean assists — the accountant decides.

---

## 6. Integration Point

**Relevant file:** `frontend-accounting/chart-of-accounts.html`

Future: When Sean is active, the "Add Account" modal gains a description-first input:
```
Step 1: "What is this account for? (describe in your own words)"
Step 2: Sean suggests classification → accountant reviews → saves
```

Standard form (no Sean) remains the fallback if Sean is inactive or if the accountant skips the description step.
