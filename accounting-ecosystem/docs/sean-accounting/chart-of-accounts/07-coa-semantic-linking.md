# Sean AI — Chart of Accounts Semantic Linking

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — How Sean understands accounts by meaning, not by code  
> **Last updated:** May 2026

---

## 1. The Core Problem: Account Numbers Are Meaningless Across Clients

South African accounting practice allows companies to use any chart of accounts structure. There is no enforced standard numbering.

This means:

| Account Code | Client A | Client B | Client C |
|---|---|---|---|
| 65000 | Computer Expenses | Bank Charges | Travel Allowances |
| 67000 | Bank Charges | Telephone | Computer Expenses |
| 70000 | Repairs & Maintenance | Salaries | Rent |

**Sean must NEVER hard-code account numbers.** The same code means different things across clients.

---

## 2. The Solution: Account Semantic Meaning

Sean must map allocations to **semantic account categories**, not account codes.

Sean's internal model uses semantic category labels:
- `BANK_CHARGES`
- `TELEPHONE`
- `FUEL`
- `SALARIES`
- `RENT`
- `VAT_INPUT`
- `DIRECTOR_LOAN`
- etc.

These already exist in the `backend/sean/allocations.js` engine (40+ categories with 500+ SA-specific keywords).

When Sean wants to suggest "Bank Charges" for a transaction, it:
1. Identifies the semantic category: `BANK_CHARGES`
2. Looks up which account in THIS client's Chart of Accounts is mapped to `BANK_CHARGES`
3. Returns that account's ID

---

## 3. How the Semantic Mapping Is Built

**Option A — Sean learns from history**

When an accountant allocates "FNB SERVICE FEE" to account 67000 (Client A's Bank Charges), Sean learns:
- "Bank Charges transactions for Client A → account 67000"
- Semantic category `BANK_CHARGES` → account ID [X] for Company [Y]

Over time, Sean builds a per-client semantic-to-accountID map.

**Option B — Account descriptions (preferred for new clients)**

Accountants can describe their accounts during setup or later.

Example:
```
Account: 67000
Name: Bank Charges
Description: "Bank fees, service charges, monthly account fees charged by FNB and other banks"
```

Sean parses this description and classifies the account into a semantic category at setup time.

**Option C — Manual classification**

The Chart of Accounts UI could present a "Sean account type" field — accountant selects from a standard list (Bank Charges, Telephone, Fuel, etc.).

A hybrid approach (Option B for onboarding, Option A for ongoing learning) is likely the most practical.

---

## 4. Account Description Field (Future Enhancement)

The existing `chart_of_accounts` table likely has `name` and possibly `description`. 

**Future enhancement:** Ensure a meaningful `description` field exists and surface it in the COA UI:

```
Account: Erf van Logrenberg
Type: Liability / Loan Account
Description: "Director loan account. Used when the owner (Erf van Logrenberg) 
              loans money to or from the company. Credit = owner loans to company. 
              Debit = company repays owner."
```

This description serves three purposes:
1. Accountant documentation
2. Sean semantic understanding for this client
3. Future audit context

---

## 5. Searching by Meaning, Not Code

When Sean needs to find "the bank charges account" for Client A, it should NOT:
```javascript
// WRONG — account codes vary per client
const account = await getAccountByCode(67000, companyId);
```

It should:
```javascript
// CORRECT — search by semantic category
const account = await getAccountBySemanticCategory('BANK_CHARGES', companyId);
// Falls back to keyword search if semantic mapping not yet established:
// search account names/descriptions for "bank charges", "bank fees", "service charge"
```

---

## 6. Handling Ambiguous Accounts

Some accounts are genuinely ambiguous:

- "Sundry Income" — could be various things
- "Other Expenses" — used as a catch-all
- "Suspense Account" — temporary holding account

For these, Sean should:
- Not auto-allocate to them (confidence will be low)
- Flag them as "unclear purpose" accounts
- Encourage the accountant to add a description to reduce future ambiguity

---

## 7. COA Semantic Linking to Existing Codex Categories

The `backend/sean/allocations.js` already defines 40+ `CATEGORY_*` constants. These should serve as the canonical semantic category list.

Future work:
- Create a mapping table: `sean_account_semantic_map` — `(company_id, account_id, semantic_category, confidence, source)`
- Populate from: (a) learning history, (b) account descriptions, (c) explicit manual classification
- Use this map in all Sean allocation suggestions

---

## 8. Multi-Account Categories

Some categories may span multiple accounts:
- VAT has both an input VAT account and an output VAT account
- Payroll has both a gross salary account and multiple deduction accounts

Sean must understand the directional context:
- Debit bank transaction + category `VAT_INPUT` → input VAT account
- Credit bank transaction + category `VAT_OUTPUT` → output VAT account

This requires Sean to know the transaction direction when resolving account from semantic category.
