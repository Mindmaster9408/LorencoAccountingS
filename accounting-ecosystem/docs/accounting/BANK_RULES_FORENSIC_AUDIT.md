# BANK RULES FORENSIC AUDIT

> **Date:** 2026-05-24  
> **Type:** Audit only — no code changed  
> **Scope:** Bank rules architecture for the Accounting App  
> **Source files inspected:** `bank.js`, `bank-learning.js`, `allocations.js`, `sean/routes.js`, `bank.html`, `bank-staging.html`, migrations 020 / 031 / 032 / 034 / 047, `013_sean_learning.sql`

---

## 1. Executive Summary

No `bank_rules` table exists. No per-company rule engine exists. What DOES exist is a learning pipeline — SEAN records allocation events, normalises descriptions, builds cross-company patterns, and can suggest an account code via `GET /api/sean/bank-learning/suggest`. That suggestion endpoint is wired into `bank.html` but the UI does not yet prefill the allocation form from it.

The existing codebase provides strong foundations for a bank rules feature:
- The allocation endpoint is battle-hardened (post-posting validation, journal reversal on failure, company-scoped, VAT-split, split-line support)
- Description normalisation already exists
- VAT settings are already a proper per-company table
- Transfer detection already excludes interbank transfers from the allocation flow
- The JournalService already blocks non-postable accounts at posting time

A bank rules feature can be built on top of these foundations without changing any existing behaviour.

---

## 2. Existing Bank Allocation Flow

### Import → Stage → Confirm → Live → Allocate

```
1. IMPORT
   PDF / Image / CSV → POST /api/bank/import → bank_transaction_staging
   (PDF/Image also call PdfStatementImportService / ImageStatementImportService)

2. STAGE
   BankStagingService.stageTransactions() — dedup, normalise descriptions
   DuplicateDetectionService — flags DUPLICATE_SUSPECTED rows
   BankStagingService.detectTransfers() — flags TRANSFER_DETECTED pairs
   bank_transfer_links — stores detected interbank transfer pairs

3. STAGING REVIEW (bank-staging.html)
   Accountant reviews:
   - Duplicates (green check or override)
   - Transfer pairs (confirm → DR/CR journal created)
   - UNMATCHED rows → confirm → move to bank_transactions

4. LIVE TRANSACTIONS (bank_transactions)
   Status: 'unmatched' | 'matched' | 'reconciled' | 'void'
   Only 'unmatched' rows can be allocated.

5. ALLOCATE (bank.html, Unmatched tab)
   POST /api/bank/transactions/:id/allocate
   → User selects: type (account / customer payment / supplier payment / transfer)
   → User selects: account (account type only) or customer/supplier
   → User selects: VAT setting (optional)
   → Server builds journal lines:
       Bank DR/CR (gross) + allocation account + optional VAT split
   → JournalService.createDraftJournal() → postJournal()
   → _validatePostedAllocationJournal() — post-posting integrity check
   → bank_transactions UPDATE: status='matched', allocated_account_id, vat_setting_id
   → SEAN learning event recorded (async, non-blocking, trusted sources only)

6. RECONCILE (bank-reconciliation.html)
   POST /api/bank/reconcile
   → 'matched' transactions selected → status='reconciled'
   → bank_recon_sessions row created (from migration 047)
```

### Allocation endpoint summary

**`POST /api/bank/transactions/:id/allocate`**  
- Accepts: `{ lines: [{accountId, amount, vatSettingId, vatInclusive}], description, allocationType }`
- Split lines: yes — multiple `lines` entries are supported
- VAT: resolved from `vat_settings` table; split into separate journal line (or full gross if VAT account missing, with audit log warning)
- Existing transactions: 409 if already matched
- Post-posting validation: 8 checks including journal balance, bank-side line present, company isolation
- Audit: AuditLogger.logUserAction on every successful allocation

---

## 3. Existing Sean Learning / Suggestions

### Learning pipeline (live and working)

**`bank-learning.js`** — the current SEAN bank learning module:

| Function | What it does |
|----------|-------------|
| `recordBankAllocationEvent(event)` | Records one allocation as a learning event. Trusted sources only (pdf, api). Silently ignores csv/manual. |
| `analyzePatterns()` | Groups all learning events by (normalised_description, account_code). Upserts `sean_bank_allocation_patterns`. Auto-promotes to 'proposed' when confidence ≥ 55 AND clients ≥ 2. |
| `suggestAllocation(description, bankName)` | Returns best matching approved pattern or legacy global pattern. Includes Codex article references. |
| `getPatterns()` | List patterns for Super Admin review. |
| `getProposals()` | List pending proposals. |
| `authorizeProposal()` | Promotes proposal to 'approved' (Super Admin only). |
| `rejectProposal()` | Rejects proposal, resets pattern to 'candidate'. |

**Suggestion API** — live endpoint in `sean/routes.js`:

```
GET /api/sean/bank-learning/suggest?description=<raw_description>&bankName=<bank>
→ { suggestion: { accountCode, accountName, confidence, reason, source, codexArticles } }
→ Returns null if no approved pattern matches
```

**Where the suggestion is used in bank.html:**  
The suggestion endpoint IS called from `bank.html` (via the Sean brain icon button on unmatched rows). The response prefills a suggestion UI element but does NOT automatically prefill the account dropdown. The accountant must still manually select an account. Accepting the SEAN suggestion is a separate user action, not wired to the allocation dropdown.

### What SEAN currently suggests

- Primary account CODE only (e.g. `6700` for Bank Charges)
- Confidence score (0–100)
- Reason string ("Pattern matched across N companies, X occurrences")
- Codex articles (SA tax law references relevant to the account code)
- Does NOT suggest: VAT setting, split lines, allocation type

### What SEAN does NOT currently do

- Does NOT auto-prefill the account selector
- Does NOT suggest VAT setting
- Does NOT provide per-company override rules
- Does NOT apply any rule automatically
- Does NOT have a per-company rules table

---

## 4. Existing Tables / Schema

### Tables that exist (confirmed via migrations and code)

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `bank_transactions` | Live reconciliation table | id, company_id, bank_account_id, date, description, amount, status, import_source, allocated_account_id, vat_setting_id, allocation_type, recon_session_id |
| `bank_transaction_staging` | Pre-confirmation import buffer | id, company_id, description, normalized_description, match_status, detected_type, duplicate_status, duplicate_confidence, import_batch_id |
| `bank_transfer_links` | Detected interbank transfer pairs | id, company_id, staging_id_from, staging_id_to, confirmed, journal_id |
| `bank_recon_sessions` | Formal reconciliation records | id, company_id, bank_account_id, statement_date, statement_closing_balance, cleared_balance, difference |
| `bank_accounts` | Bank account registry | id, company_id, name, ledger_account_id, is_active |
| `vat_settings` | Per-company VAT categories | id, company_id, code, name, rate, is_capital, is_active, effective_from |
| `sean_bank_learning_events` | Immutable allocation learning log | id, company_id, bank_transaction_id, import_source, raw_description, normalized_description, allocated_account_code |
| `sean_bank_allocation_patterns` | Anonymised cross-company patterns | id, normalized_description, suggested_account_code, confidence_score, clients_observed, status (candidate/proposed/approved) |
| `sean_bank_learning_proposals` | Authorization workflow for global patterns | id, pattern_id, status (pending/approved/rejected), reviewed_by |
| `sean_codex_articles` | SA tax/accounting knowledge base | id, category, title, law_reference, explanation, related_accounts, keywords |

### What does NOT exist

- `bank_rules` table — does not exist in any migration
- `company_bank_rules` table — does not exist
- Per-company suggestion override table — does not exist
- Rule priority table — does not exist

---

## 5. Description Normalisation

### Three normalisation implementations exist

**1. `bank-learning.js` — `normalizeDescription(raw)`**
```
- Lowercase
- Remove digit sequences 4+ chars (account numbers, refs)
- Remove dates (DD/MM/YY patterns)
- Remove rand amounts (R followed by digits)
- Remove punctuation (keep only a-z and spaces)
- Collapse spaces, trim
```

**2. `allocations.js` — `normalizeDescription(desc)`** (local SA intelligence layer)
```
- Lowercase
- Remove special chars except spaces
- Remove amounts (R/ZAR prefix + digits)
- Remove ISO dates (YYYY-MM-DD)
- Remove long reference numbers (6+ digits)
- Collapse spaces, trim
```

**3. `bank_transaction_staging.normalized_description`** (Migration 032)
- Populated at staging time by `BankStagingService`
- Used for fuzzy duplicate detection across batches
- The index `idx_bts_normalized_desc` covers `(company_id, bank_account_id, normalized_description)`

**Note:** These three implementations have subtle differences. A bank rules engine should adopt ONE canonical normalisation function (recommend `bank-learning.js` version as the master) and use it consistently in rules creation, matching, and learning events.

---

## 6. Where Rules Should Apply

### Recommended: Apply at confirmed `bank_transactions` level — suggestion only

```
Staging → Confirm → bank_transactions (status='unmatched')
                        ↓
                Rule engine runs on description
                        ↓
              Prefill allocation form:
              - account selector
              - VAT setting
              - allocation type
                        ↓
              User reviews and confirms
                        ↓
              POST /api/bank/transactions/:id/allocate (unchanged)
```

**Why NOT at staging:**
- Staging is for import review (duplicate detection, transfer pairing). Injecting allocation logic there couples two separate concerns.
- Staging transactions don't have a bank account ledger account resolved yet in all cases.
- Users may still reject staging rows before they enter `bank_transactions`.

**Why NOT auto-post:**
- The existing allocation endpoint has significant integrity checks (8-check post-posting validation). Auto-posting rules bypasses the human review that catches mis-categorisations.
- First version should suggest + prefill, never auto-post.

---

## 7. Suggested Rule Data Model

### New table: `bank_allocation_rules`

```sql
CREATE TABLE bank_allocation_rules (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Matching
  match_type             VARCHAR(20) NOT NULL DEFAULT 'contains'
                         CHECK (match_type IN ('exact', 'contains', 'starts_with', 'regex')),
  match_pattern          TEXT NOT NULL,          -- raw pattern as user entered it
  normalized_pattern     TEXT NOT NULL,          -- normalised version for matching
  case_sensitive         BOOLEAN NOT NULL DEFAULT FALSE,

  -- Allocation output
  allocation_type        VARCHAR(20) NOT NULL DEFAULT 'account'
                         CHECK (allocation_type IN ('account', 'customer_payment', 'supplier_payment')),
  account_id             INTEGER REFERENCES accounts(id) ON DELETE SET NULL,  -- NULL if type is AR/AP
  vat_setting_id         INTEGER REFERENCES vat_settings(id) ON DELETE SET NULL,

  -- Priority and control
  priority               INTEGER NOT NULL DEFAULT 100,  -- lower = higher priority
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,

  -- Source tracking
  source                 VARCHAR(20) NOT NULL DEFAULT 'user'
                         CHECK (source IN ('user', 'sean_accepted', 'sean_proposed')),
  sean_pattern_id        INTEGER REFERENCES sean_bank_allocation_patterns(id) ON DELETE SET NULL,

  -- Audit
  created_by_user_id     INTEGER REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_applied_at        TIMESTAMPTZ,           -- when this rule last triggered a suggestion
  apply_count            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_bar_company         ON bank_allocation_rules(company_id, is_active);
CREATE INDEX idx_bar_company_priority ON bank_allocation_rules(company_id, priority, is_active);
CREATE INDEX idx_bar_normalized       ON bank_allocation_rules(company_id, normalized_pattern)
  WHERE is_active = TRUE;
```

### No split-line support in first version

Split allocation rules are complex (percentage vs. fixed amount per line, variable total amounts). The first version should support single-line rules only. Split support is a Phase 2 workstream.

---

## 8. Suggested Matching Logic

### Recommended matching pipeline (in priority order)

```
1. Company-specific exact match  (highest confidence)
   normalized(description) = rule.normalized_pattern

2. Company-specific 'contains' match
   normalized(description) contains rule.normalized_pattern

3. Company-specific 'starts_with' match
   normalized(description) starts with rule.normalized_pattern

4. Sean approved global pattern (cross-company, confidence-weighted)
   bank-learning.suggestAllocation(description) — existing, already works

5. Sean legacy patterns from sean_patterns_global  (existing fallback)

6. Local SA keyword match via allocations.js suggestCategoryLocal()
   (returns category code, not account ID — mapping step needed)

7. No match → user selects manually
```

**Rules run on confirmed `bank_transactions`** before the allocation form is rendered. The result is used to prefill the form. It is never applied automatically.

### Conflict detection

If two company rules match the same description but point to different accounts:
- Surface a warning in the Rule Management UI ("These 2 rules both match this description")
- Do NOT block rule creation — the accountant may have valid reasons
- At runtime, use the rule with the lower `priority` number (higher priority wins)

---

## 9. VAT Handling

### Current state

The allocation endpoint already handles VAT correctly:
- `vat_setting_id` per allocation line is accepted
- VAT rate looked up from `vat_settings` table (per-company)
- Journal automatically split: ex-VAT to allocation account + VAT amount to 1400/2300
- If VAT account missing: full gross posted to allocation account + audit log warning (existing fallback)

### How to store VAT on a rule

```
bank_allocation_rules.vat_setting_id → references vat_settings(id)
```

**Important:** `vat_setting_id` is company-specific (integer FK). When SEAN suggests an account code from global patterns, it does NOT suggest a VAT setting — the VAT setting is always company-resolved. The rule data model stores the `vat_setting_id` from the company's own `vat_settings` table.

### What to NOT do

Do NOT store VAT rate directly on the rule. Rates change. The `vat_settings` table already handles effective dates and rate history. Always resolve VAT from `vat_settings` at runtime.

---

## 10. Split Allocation Handling

### Current state

The allocation endpoint already supports split lines:
```javascript
POST /api/bank/transactions/:id/allocate
body: {
  lines: [
    { accountId: 5500, amount: 869.57, vatSettingId: 1 },  // ex-VAT amount
    { accountId: 6700, amount: 130.43, vatSettingId: null } // remainder
  ]
}
// Total of all line amounts must equal bankTxn.amount
```

### Recommendation for bank rules

Phase 1: single-line rules only. The majority of transactions (fuel, bank charges, utilities, rent) map to a single account. This covers ~90% of the use case with 10% of the complexity.

Phase 2: split rule definitions with either:
- Fixed amounts per line (problem: doesn't scale when transaction total changes)
- Percentage per line (more robust: sum of percentages = 100%)

Mark Phase 2 as a tracked follow-up. Do not implement in Phase 1.

---

## 11. Transfer / Duplicate Exclusion

### Transfer exclusion

Interbank transfers are detected at staging time and recorded in `bank_transfer_links`. When confirmed, a DR/CR journal is created directly (not through the normal allocation flow). Transfer-confirmed transactions end up with `status = 'matched'` pointing to the transfer journal.

The allocation endpoint already enforces:
```javascript
if (bankTxn.status !== 'unmatched') {
  return res.status(409).json({ error: 'Transaction already allocated' });
}
```

**This means bank rules must never be applied to transactions that are not `unmatched`.** No additional guard needed beyond what exists.

### Duplicate exclusion

Suspected duplicates are flagged in staging with `duplicate_status = 'DUPLICATE_SUSPECTED'`. They are not automatically moved to `bank_transactions`. The accountant must either:
- Confirm them as real (overrides → moves to `bank_transactions`)
- Reject them (status = 'REJECTED' in staging — never enters `bank_transactions`)

Bank rules therefore never see confirmed duplicates; they are filtered at the staging gate before reaching `bank_transactions`.

---

## 12. Parent Account / Non-Postable Protection

### Current state

**In `JournalService._assertAccountsPostable()`:**
```javascript
// Checks every account referenced in journal lines
// Throws if is_postable === false
// "Select a sub-account instead: ACCOUNT_CODE (ACCOUNT_NAME)"
```

This guard fires for EVERY journal creation — including bank allocations. A rule that references a parent/header account will fail at posting time with a clear error.

**However:** The rule creation step would not be blocked — only the runtime posting would fail. This creates a bad user experience (create a rule, then every transaction it applies to fails).

### Recommended additional guard at rule creation

When `POST /api/bank/rules` is called, validate:
```javascript
const { data: acct } = await supabase.from('accounts')
  .select('is_postable')
  .eq('id', accountId)
  .eq('company_id', companyId)
  .maybeSingle();

if (!acct || acct.is_postable === false) {
  return res.status(422).json({
    error: 'The selected account is a parent/header account and cannot be used for direct postings. Select a sub-account.'
  });
}
```

This prevents saving invalid rules, not just failing at runtime.

### Frontend

The account dropdown in the allocation UI should already filter out non-postable accounts. Verify this is the case in the rules management UI too.

---

## 13. Multi-Tenant Safety

### Current state

- `bank.js` uses `req.user.companyId` throughout (set by auth middleware)
- `bank_transactions` query: `.eq('company_id', req.user.companyId)`
- Allocation update: `.eq('company_id', req.user.companyId)` (defence-in-depth)
- `bank_accounts` query: `.eq('company_id', req.user.companyId)`
- `vat_settings` query: `.eq('company_id', req.user.companyId)`

### What bank rules must enforce

Every rule read/write operation must:
- Include `.eq('company_id', companyId)` on SELECT (not just WHERE clause through auth)
- Include `.eq('company_id', companyId)` on UPDATE (defence-in-depth)
- Never expose rules from Company A to Company B

### Sean global patterns vs company rules

Sean's `sean_bank_allocation_patterns` are global (no company_id). They suggest account CODES, not account IDs. The rule engine converts a suggested code to the company's own account ID at suggestion time (lookup by code + company_id). This lookup must always succeed before a suggestion is surfaced.

---

## 14. Audit Trail Requirements

### What already exists

The `AuditLogger.logUserAction()` call in the allocation endpoint records every allocation. This includes the before/after state, journal ID, user ID, timestamp, IP, user agent.

The `sean_bank_learning_events` table is an immutable log of every learning event tied to an allocation.

### What bank rules need

| Event | Audit requirement |
|-------|------------------|
| Rule created | `BANK_RULE_CREATED` — before null, after: full rule payload |
| Rule updated | `BANK_RULE_UPDATED` — before: old rule, after: new rule |
| Rule deactivated/deleted | `BANK_RULE_DEACTIVATED` / `BANK_RULE_DELETED` |
| Rule applied (suggestion accepted) | Store `applied_rule_id` in journal metadata or bank_transaction update |
| Rule applied (suggestion ignored) | Optional — "accountant overrode suggestion" could be logged |

The journal `metadata` field already stores `bankTransactionId`. It should also store `appliedRuleId` when a rule suggestion was accepted.

---

## 15. Risks

| Risk ID | Description | Severity |
|---------|-------------|----------|
| RISK-BR-01 | `bank_allocations_*` is stored in `safeLocalStorage` (KV bridge) in `bank.html`. This is a browser storage violation per RULE D3 in CLAUDE.md. In-progress allocation selections are persisted to `safeLocalStorage` via `saveAllocationsToStorage()`. This means partially-entered allocations are stored in a browser KV store, not in SQL. | MEDIUM — UI convenience feature, not final business data. But violates D3. |
| RISK-BR-02 | SEAN `suggestAllocation()` does a full table scan of `sean_bank_allocation_patterns` and `sean_patterns_global` in JS — no indexed query. For large pattern sets this will be slow. | LOW — manageable at current scale |
| RISK-BR-03 | The three normalisation functions (bank-learning.js, allocations.js, staging) use different stripping logic. A description normalised at staging might not match the same description normalised at rule-matching time. | MEDIUM — could cause rule misses or false positives |
| RISK-BR-04 | No `GET /suggest` endpoint exists on the bank routes — only on `GET /api/sean/bank-learning/suggest`. If bank rules are added, the rule-match check should be a dedicated bank API call (not a SEAN module call) to keep the allocation flow clean and auth-consistent. | LOW — architectural |
| RISK-BR-05 | The allocation endpoint accepts `allocationType` but it is stored as a display field only — no downstream routing or validation based on it. A rule could specify an allocationType that doesn't match the journal entries. | LOW — display inconsistency only |
| RISK-BR-06 | If a rule references an account that is later archived (`is_active = false`) or converted to a parent (`is_postable = false`), the rule will fail at runtime with a journal posting error. No stale-rule detection exists yet. | MEDIUM — needs a rule validation sweep on account changes |

---

## 16. Recommended Workstreams

### Phase 1 — Per-company bank rules (single-line, suggest-only)

| WS | Title | Scope |
|----|-------|-------|
| WS-BR-01 | `bank_allocation_rules` migration | New table per data model in Section 7 |
| WS-BR-02 | Rules CRUD API | `GET/POST/PUT/DELETE /api/bank/rules` — company-scoped, postable guard, full audit |
| WS-BR-03 | Suggestion API for allocation | `GET /api/bank/rules/suggest?bankTransactionId=X` — runs matching pipeline (Sections 8+12) |
| WS-BR-04 | Prefill allocation form | `bank.html` calls suggest endpoint when allocation modal opens; prefills account + VAT + type |
| WS-BR-05 | Rule management UI | Page or panel to view/create/edit/deactivate per-company rules |
| WS-BR-06 | Fix RISK-BR-01 | Migrate `bank_allocations_*` KV bridge usage to a server-side session or drop it |

### Phase 2 — Enhancements (after Phase 1 is stable)

| WS | Title |
|----|-------|
| WS-BR-07 | Split-line rule support (percentage-based) |
| WS-BR-08 | Stale rule detection (fire alert when rule's account is archived) |
| WS-BR-09 | "Save this as a rule" button on successful allocation |
| WS-BR-10 | Normalisation unification (single canonical function) |

---

## 17. Questions For Ruan Before Code Changes

Before any code is written, Ruan must decide:

**Q1 — Auto-apply rules or always suggest?**  
The recommended first version suggests and prefills only (never auto-posts). Ruan must confirm this is the intended behaviour. If there is a confidence threshold above which auto-posting should be allowed in future, define it now (e.g. 99% exact-match + user-defined rule).

**Q2 — Where in the UI should rules be managed?**  
Options: (a) a new page `/bank-rules.html`, (b) a panel within `bank.html`, (c) a tab in settings. Which is preferred?

**Q3 — Should the accountant be able to see which rule fired?**  
If a suggestion is shown, should the UI display the matching rule ("Based on your rule: Eskom → Account 5400")? This requires wiring rule IDs back to the suggestion response.

**Q4 — Should rules be seeded from SEAN-approved global patterns?**  
When SEAN has an approved pattern for a given description, should the system offer to create a per-company rule from it? Or should global patterns stay separate from company-specific rules?

**Q5 — What happens if a transaction description partially matches two rules with the same priority?**  
Define a tiebreaker: (a) most recently created rule wins, (b) highest `apply_count` wins (most frequently used), (c) show both and let accountant choose.

**Q6 — RISK-BR-01: `bank_allocations_*` in safeLocalStorage. Is this a current production risk?**  
This stores in-progress allocation selections (account, VAT, type — not yet posted). Should this be migrated to a server-side endpoint or simply cleared on navigation (acceptable UX tradeoff for now)?

**Q7 — Does the rules UI need to support bulk import (e.g. from a CSV of rule definitions)?**  
This affects the complexity of the rules management UI and the API validation layer.

---

*Audit completed 2026-05-24. No code was changed. All findings are based on direct code inspection.*
