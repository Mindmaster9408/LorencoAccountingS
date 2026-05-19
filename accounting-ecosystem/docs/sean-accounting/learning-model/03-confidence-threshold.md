# Sean AI — Confidence Threshold Logic

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — Sean confidence scoring model  
> **Last updated:** May 2026

---

## 1. Default Threshold

**Initial threshold: 85% (0.85)**

This is the minimum confidence score required for Sean to auto-allocate a transaction without requiring human confirmation.

The threshold is:
- Configurable by superusers per company
- Potentially configurable per module (bank allocation vs. COA assist)
- Stored in the company's Sean settings (future field)

---

## 2. Confidence Band Behavior

| Confidence | Behavior |
|---|---|
| >= 0.85 (85%) | Auto-allocate (subject to safety gates) |
| 0.65–0.84 | Suggest only — accountant must confirm |
| 0.50–0.64 | Suggest with low-confidence warning |
| < 0.50 | No suggestion — leave for manual allocation |

The 0.50 floor is a recommendation, not a hard rule. It prevents Sean from surfacing suggestions that are essentially guesses.

---

## 3. Confidence Score Sources

Sean's confidence for a bank transaction allocation is a composite score drawing from multiple signals:

### 3a — Company History (Highest Weight)
- Has this exact normalized description been allocated before by this company?
- How many times?
- Was it always to the same account, or was there variation?
- Example: "FNB SERVICE FEE" → Bank Charges × 47 times with zero corrections = very high confidence

### 3b — Superuser Confirmation (Very High Weight)
- Has a superuser (Ruan / MJ / Anton) explicitly confirmed this pattern?
- Superuser-confirmed patterns bypass the normal multi-confirmation growth curve and start at elevated confidence.
- See `learning-model/05-superuser-approval.md`

### 3c — Cross-Client Pattern (Medium Weight — Anonymized)
- Has this description pattern been confirmed across multiple clients (anonymized)?
- Example: "FNB SERVICE FEE" is a well-known SA bank charge — confirmed by dozens of companies in the ecosystem.
- Cross-client weight is applied only after superuser approval of the global pattern (CLAUDE.md Rule B6).

### 3d — Keyword Matching (Existing Engine Weight)
- The existing `backend/sean/allocations.js` already has 500+ SA-specific vendor keywords.
- These provide a baseline confidence before any learned history exists.
- Keyword match alone = moderate confidence (typically 0.65–0.75).

### 3e — Description Similarity (Medium Weight)
- Fuzzy/semantic match against known patterns even when exact match fails.
- Example: "FNB SVC FEE" should correlate to "FNB SERVICE FEE".
- Normalization rules (strip punctuation, expand abbreviations) affect this.

### 3f — Amount Heuristics (Low Weight)
- Some categories correlate to amount ranges.
- Examples: small round amounts to bank charges, large credits to income accounts.
- This is a weak signal and should only contribute marginally.

---

## 4. Confidence Growth Model

For a new client (no history):
- Sean starts with keyword/global pattern confidence only.
- First allocation: confidence is whatever keyword/cross-client matching gives (may be below threshold — suggestion only).
- After 3 confirmed allocations to the same account: confidence rises significantly.
- After 10 confirmed allocations with no corrections: confidence likely above threshold.
- After superuser confirmation: confidence elevated immediately.

For an established client (2+ years of allocations):
- Most recurring transactions (bank charges, salary payments, rent, etc.) will have very high confidence.
- Only genuinely novel transactions will need manual review.

---

## 5. Confidence Decay

Consider implementing confidence decay for:
- Patterns not seen for an extended period (e.g., 12+ months).
- Patterns that had recent corrections (confidence drops after each override).
- Accounts that have been reclassified or renamed.

This prevents stale high-confidence patterns from auto-allocating incorrectly after business changes.

---

## 6. Threshold Adjustment Rules

Superusers may raise or lower the threshold per company:

| Scenario | Recommended threshold |
|---|---|
| New client, building trust | 95% (conservative) |
| Established client, well-trained model | 85% (default) |
| High-volume low-risk transactions (e.g., fuel company) | 80% (with approval) |
| Absolute minimum (never go below) | 75% |

No threshold below 75% should be permitted. Below that level, the error rate is likely to exceed the efficiency gain.

---

## 7. Confidence vs. Bank Rule

Confidence level is irrelevant when a Bank Rule exists. Bank Rules override Sean at 100% confidence or 0%.

See `rules-and-precedence/02-bank-rules-vs-sean.md`.
