# Sean AI — Client-Specific Learning

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — How Sean learns per-client context  
> **Last updated:** May 2026

---

## 1. Core Principle

Sean must learn at two levels simultaneously:

1. **Client-specific** — patterns that are true for THIS company only
2. **Global (anonymized)** — patterns that are likely true across many companies

These two layers must remain strictly separate. Client-specific knowledge is encrypted and private. Global knowledge is anonymized before storage.

---

## 2. Why Client-Specific Learning Is Critical

The same description text can mean different things for different clients.

**Example:**

| Description | Client | What it means |
|---|---|---|
| "Erf van Logrenberg" | Client A (a specific company) | Director loan repayment from owner to company |
| "Erf van Logrenberg" | Client B (different company) | This is irrelevant — this name would never appear |

"Erf van Logrenberg" is a person or entity name that is meaningful only in the context of Client A's relationship with that person. Globally, it means nothing.

**Sean must learn:**
> For Client A: "Erf van Logrenberg" maps to the Director Loan Account.

This must NEVER be propagated globally. It is client-sensitive and private.

---

## 3. How the Private Codex Works (Existing Pattern)

The existing `backend/sean/encryption.js` already establishes the pattern for client-specific encrypted storage:
- Each company gets a unique AES-256-CBC encryption key.
- Company-specific allocation patterns are stored encrypted in `sean_codex_private`.
- The key is required to read or write this data.
- Even the admin cannot read a company's private codex without the key.

Future bank allocation learning follows this same pattern:
- "Erf van Logrenberg → Director Loan Account" is stored in the private codex, encrypted.
- When Sean analyses a transaction for Client A, it decrypts and checks the private codex first.
- If found → high-confidence allocation, no global check needed.

---

## 4. Examples of Client-Specific Patterns That Must Stay Private

| Type | Example | Why private |
|---|---|---|
| Director / owner names | "Erf van Logrenberg" | Specific to one company's ownership structure |
| Internal funding descriptions | "IDC Transfer" | Company-specific financing arrangement |
| Shareholder loan references | "JvS Loan Repayment" | Personal name, private |
| Intercompany transfers | "Lorenco Services Inv" | Specific to an inter-entity relationship |
| Client-specific vendor patterns | "Bosman & Bosman" | Specific supplier in a specific region/industry |
| Custom GL accounts with unusual names | "Sundry Receipts" (but mapped to a specific liability) | Company chose unusual naming |

These patterns must be learned per-client and must not be used to train global models.

---

## 5. What CAN Be Shared Globally (Anonymized)

Only generic, non-client-identifying patterns are eligible for global promotion:

| Eligible for global | Example |
|---|---|
| Major SA bank fee descriptions | "FNB SERVICE FEE", "STANDARD BANK CHARGES", "ABSA MONTHLY FEE" |
| National retailer descriptions | "WOOLWORTHS", "CHECKERS", "PICK N PAY" |
| National fuel brands | "ENGEN", "SHELL", "BP", "SASOL" |
| National utility providers | "ESKOM", "CITY POWER", "RAND WATER" |
| Common payroll-related descriptions | "PAYE", "UIF CONTRIBUTION", "SDL" |
| Standard banking patterns | "INTERNET BANKING FEE", "SMS NOTIFICATION" |

These are patterns that mean the same thing for essentially every client in South Africa.

---

## 6. Description Normalization Before Learning

Before storing a learned pattern (private or global), the description must be normalized:

1. Strip account numbers (PII — never store raw)
2. Strip amounts embedded in descriptions
3. Uppercase
4. Remove special characters that are noise
5. Collapse repeated spaces

Example:
```
Raw:    "FNB CHEQUE ACC 1234567890 SERVICE FEE MAY26"
Stored: "FNB CHEQUE ACC SERVICE FEE"
```

Normalization rules should be documented and versioned so that old stored patterns remain matchable as normalization rules evolve.

---

## 7. Confidence Weighting: Private vs Global

When scoring a suggestion for a client:

```
private_codex_confidence   = 0.0–1.0  (if match found in client's private codex)
global_pattern_confidence  = 0.0–1.0  (if match found in global patterns)
keyword_confidence         = 0.0–1.0  (from existing allocations.js engine)

final_confidence = MAX(
    private_codex_confidence,              ← always wins if high enough
    weighted_blend(global_pattern_confidence, keyword_confidence)
)
```

Private codex confidence always takes precedence if it produces a clear result. This ensures client-specific knowledge is not diluted by global patterns that may be less accurate for this client's context.

---

## 8. When Client Context Must NOT Propagate Globally

Never allow these to enter global pattern consideration:
- Any pattern where the normalized description contains a proper noun (person name, company name)
- Any pattern flagged as private by the accountant
- Any pattern where fewer than 2 clients (excluding the source) have confirmed the same pattern

The 2-client rule ensures that "global" means actually global — at least 2 other clients must have confirmed the same pattern before it's considered ecosystem knowledge.
