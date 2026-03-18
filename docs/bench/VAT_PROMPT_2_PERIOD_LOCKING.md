# VAT Prompt 2 — Period Generation, Locking, and Out-of-Period Items

**Status:** Queued — not yet implemented
**Depends on:** VAT Prompt 1 (completed March 2026)
**File saved:** March 2026

---

## Standing rules (apply every session)

Follow the master rules in CLAUDE.md. Audit first, protect working features, protect multi-tenant isolation. Do NOT break current invoice flows, bank transaction allocation flow, VAT reports already built, or VAT reconciliation work already done.

---

## ROLE

Principal VAT Systems Architect, South African VAT Compliance Workflow Engineer, Accounting Data Integrity Engineer, and Period-Control/Locking Architect for the Lorenco Accounting app.

This is PROMPT 2 of a phased VAT implementation.

---

## PROMPT 2 FOCUS

1. VAT period generation and current-period logic
2. VAT locking
3. Transaction inclusion in VAT periods
4. Out-of-period transactions
5. How out-of-period items affect the CURRENT open VAT period
6. How locked periods remain untouched
7. How VAT reports, VAT reconciliation, and TB/recon differences reflect these rules

Must be built simply and safely. Do not break existing accounting flows. Do not reopen or silently alter locked VAT periods.

---

## PRIMARY OBJECTIVE

Implement VAT period control and locking so that:

1. VAT periods are generated correctly from company VAT settings
2. A VAT period can be finalized/locked
3. Once locked, that period cannot be changed by later edits to included transactions
4. Transactions/invoices/bank entries that should have belonged to a locked prior period but are captured later become OUT-OF-PERIOD items in the CURRENT open period
5. Locked periods remain untouched forever unless there is an explicit future reversal/reopen workflow (not in this prompt)
6. The current period shows out-of-period items clearly
7. VAT reports and VAT reconciliation clearly show the impact of out-of-period transactions
8. If a period is locked, all transactions that were part of that VAT period are protected from editing in the ways that would affect that VAT return

---

## HIGH-LEVEL BUSINESS RULE

If a VAT period is locked, it is locked. That VAT period must not be changed.

If a transaction/invoice/other VAT-relevant item is discovered later, and it should have belonged to a locked previous VAT period:
- it must NOT affect that locked period
- it must be brought into the CURRENT open VAT period as an OUT-OF-PERIOD transaction
- the current period must show clearly that this is an out-of-period adjustment
- VAT reconciliation/reporting for the current period must show these separately and visibly
- the prior locked period remains unchanged

Essential for compliance, audit integrity, and simplicity.

---

## PART 1 — AUDIT THE CURRENT VAT PERIOD / VAT RECON / VAT REPORT ARCHITECTURE

Before changing anything, audit the current Accounting app VAT architecture in relation to periods and locking.

Identify:

1. Whether VAT periods already exist in data model
2. Whether VAT recon already stores period data
3. Whether VAT reports already use period ranges
4. Whether VAT locking already exists partially
5. Whether any "finalize" state exists
6. How VAT reports currently determine included transactions
7. Whether bank transactions, customer invoices, supplier invoices, and other VAT-relevant items already carry VAT dates/period relevance
8. How company VAT cycle settings are currently stored
9. Whether period generation exists already
10. Whether Trial Balance/VAT recon comparisons currently depend on date filters only or real locked inclusion logic
11. Whether edit locking already exists anywhere in accounting
12. How current VAT data flows from source transaction → VAT report/recon

Determine: what exists already, what is missing, what can be reused, what must be extended carefully.

Do not guess. Audit first.

---

## PART 2 — VAT PERIOD SETTINGS INTERPRETATION

Use the company VAT settings from Prompt 1 as the source of truth.

Support at least:
- Monthly VAT periods
- Bi-monthly / every-2-month VAT periods
- Even cycle
- Odd cycle

Derive VAT periods correctly from:
- company VAT registration status
- VAT frequency
- even/odd cycle if bi-monthly
- relevant dates

Examples:
- If monthly: each month is its own VAT period
- If bi-monthly even cycle: Jan/Feb → period ending Feb; Mar/Apr → period ending Apr; etc.
- If bi-monthly odd cycle: implement consistently with the current system's date model

Important: Do not guess the month pairing logic loosely. Use the company's configured cycle model consistently. Audit the intended/current date model first.

---

## PART 3 — VAT PERIOD ENTITY / DATA MODEL

Implement or refine a proper VAT period model.

Existing `vat_periods` table (from schema audit):
- id, company_id, period_key, from_date, to_date, filing_frequency
- status (open / locked / submitted)
- locked_by_user_id, locked_at
- submitted_by_user_id, submitted_at, submission_reference
- payment_date, created_at
- UNIQUE(company_id, period_key)

Additions needed (audit first to confirm what's missing):
- `vat_cycle_type` (carry from company settings into the period for reference)
- `out_of_period_total_input` NUMERIC(15,2)
- `out_of_period_total_output` NUMERIC(15,2)
- `out_of_period_count` INTEGER
- `updated_at` TIMESTAMPTZ

The system needs a real concept of a VAT period with lock state, not only date filters.

---

## PART 4 — TRANSACTION INCLUSION IN VAT PERIODS

Determine and implement which VAT-relevant records belong to a VAT period.

VAT-relevant records include:
- customer invoices
- supplier invoices
- eligible bank transactions with VAT (from Prompt 1)
- other VAT-relevant entries if already supported

Must determine the source date used for VAT period inclusion, consistent with the current accounting/VAT model (invoice date? transaction date? tax point date? posting date?).

Implement a clear, documented rule. Do not invent inconsistent date logic.

---

## PART 5 — LOCKING A VAT PERIOD

When a VAT period is locked:

1. The VAT period is frozen
2. The set of included VAT transactions for that period is frozen
3. The VAT report for that period is frozen
4. The VAT reconciliation for that period is frozen
5. Relevant transactions that were included in that VAT period must no longer be editable in ways that would change the VAT result

Important:
- This does NOT mean all accounting data is frozen forever
- It means VAT-affecting edits for the locked VAT period must be controlled

At minimum, for included transactions in a locked period, users must not be able to:
- change VAT category
- change VAT amount
- change date in a way that changes VAT period
- delete the transaction if it would alter the locked VAT return
- edit invoice values that affect VAT
- edit bank transaction VAT allocation that affects VAT

Audit existing edit architecture and implement the safest practical lock.

---

## PART 6 — OUT-OF-PERIOD TRANSACTIONS

**This is the most important rule in Prompt 2.**

If a transaction is captured later, and based on its original date it should have belonged to a prior VAT period that is already locked:

- It must NOT alter the locked period
- Instead: it must be brought into the CURRENT open VAT period as an OUT-OF-PERIOD transaction

The current open period must clearly show:
- that the item belongs historically to an earlier period
- but it is being included now
- and it affects the current period's VAT calculation

---

## PART 7 — HOW OUT-OF-PERIOD ITEMS MUST APPEAR

The current open VAT period must clearly show out-of-period items.

Required visibility:
1. The current VAT report must identify out-of-period transactions
2. The current VAT reconciliation must identify out-of-period transactions
3. Summary required:
   - number of out-of-period items
   - total VAT effect of out-of-period items
   - whether they affect input VAT and/or output VAT
4. These items must not silently blend in with current-period normal items without visibility

Example concept: "Out-of-period adjustments included in this period: 5 items, total VAT Rxxx.xx"

---

## PART 8 — IMPACT ON TB / VAT RECON DIFFERENCE

The current period's VAT reconciliation must reflect out-of-period items.

If the current period includes out-of-period VAT items, the VAT recon should show clearly that this contributes to the difference.

Do not change the locked period. Do not restate the old period.

The current period must show that its VAT includes:
- current-period normal items
- out-of-period adjustments

Must be visible and understandable in recon.

---

## PART 9 — LOCKED PERIOD IMMUTABILITY

**Hard rule:**

Once a VAT period is locked:
- that VAT period must not be affected by newly captured prior-period items
- those items must not retroactively appear inside that period
- that locked report/recon remains exactly as it was finalized

Do not implement any hidden retroactive mutation.

Future "reopen VAT period" workflows can be considered later, but are NOT part of this prompt.

---

## PART 10 — TRANSACTION LOCKING BEHAVIOUR

For records included in a locked VAT period, the system must prevent or control edits.

At minimum this should affect:
- customer invoices
- supplier invoices
- bank transactions with VAT
- other VAT-relevant entries supported by the app

Protected behaviours:
- no changing VAT category
- no changing VAT amount
- no changing value that affects VAT
- no changing date into/out of locked VAT period
- no deleting in a way that alters the locked VAT period

If the UI permits view-only mode for locked items, use it where appropriate.
If a user attempts forbidden edits, show a clear message explaining that the VAT period is locked.

---

## PART 11 — IDENTIFYING OUT-OF-PERIOD ITEMS

Implement logic to identify when an item is out-of-period.

General rule: If the item's VAT-effective date belongs to a VAT period that is already locked, but the item is only now being brought in / finalized / made VAT-relevant, then it must be treated as out-of-period in the current open period.

Must be defined carefully based on current architecture.

Examples:
- Late supplier invoice captured now for a prior locked period
- Cash invoice found later
- Income transaction omitted previously and entered now
- Bank transaction with VAT allocated now, but dated in prior locked period

Identification must be deterministic and documented.

---

## PART 12 — CURRENT PERIOD VAT CALCULATION

The current open period's VAT calculation must include:
- A. Normal current-period VAT items
- B. Out-of-period VAT items brought into this period

The current period total can validly contain both. The system must show that clearly.

Do not silently alter old periods. Do not omit the out-of-period items from the current submission.

---

## PART 13 — SIMPLE UX REQUIREMENT

Must remain very simple for users.

Required simplicity goals:
1. Locked means locked
2. Out-of-period items are clearly labelled
3. Current VAT period shows what belongs to now and what is carried in from prior periods
4. User can understand why the current VAT recon differs
5. User is protected from editing locked items by mistake

---

## PART 14 — AUTHORIZATION / LOCK CONTROL

Locking a VAT period is sensitive.

Only appropriate authorized users can:
- lock a VAT period
- finalize a VAT period
- see/manage lock state where appropriate

Audit existing permissions and enforce consistently.

---

## PART 15 — REPORTING / RECON INTEGRITY

Do not break:
- current VAT reports
- current VAT reconciliation
- current invoice flows
- current bank VAT flow from Prompt 1
- general accounting posting

Extend safely. The current VAT report and VAT recon should become period-aware and lock-aware, not be replaced carelessly.

---

## PART 16 — TESTING REQUIREMENTS

A. VAT PERIOD GENERATION
- Monthly periods generate correctly
- Bi-monthly even periods generate correctly
- Bi-monthly odd periods generate correctly

B. LOCKING
- VAT period can be locked
- Locked period status persists
- Included items become protected from VAT-affecting edits

C. OUT-OF-PERIOD LOGIC
- Late prior-period item does not alter locked old period
- Late prior-period item appears in current open period as out-of-period
- Out-of-period summary/count/value updates correctly

D. REPORTING / RECON
- Current VAT report shows out-of-period items clearly
- Current VAT recon shows out-of-period impact clearly
- Locked historical VAT report remains unchanged

E. REGRESSION
- Current VAT reporting still works
- Current invoice and bank VAT flows still work
- Accounting posting/report flows are not broken

---

## PART 17 — DOCUMENTATION

Create or update: `docs/vat-period-locking-and-out-of-period-items.md`

Document:
1. VAT period model
2. How periods are generated
3. How lock works
4. What becomes non-editable
5. Out-of-period transaction logic
6. How out-of-period items affect the current period
7. Why locked periods remain untouched
8. How VAT recon and reports show out-of-period items
9. Follow-up items for Prompt 3

Include a CHANGE IMPACT NOTE:
```
CHANGE IMPACT NOTE
- Area being changed:
- Files/services involved:
- Current behaviour identified:
- Required behaviours to preserve:
- VAT period integrity risk:
- Reporting/recon risk:
- Safe implementation plan:
```

---

## PART 18 — IMPORTANT SAFETY RULES

- Audit before changing code
- Do not break current invoice/bank allocation VAT flows
- Do not mutate locked VAT periods
- Do not silently restate historical VAT periods
- Do not let out-of-period items alter the old locked period
- Do not allow VAT-affecting edits on included transactions in locked periods
- Keep the UX simple and clear

---

## OUTPUT REQUIRED

After implementation provide:

A. Audit findings
B. Exact files/services/components/models changed
C. VAT period model implemented/fixed
D. Locking logic implemented/fixed
E. Out-of-period transaction logic implemented/fixed
F. How current VAT report/recon now show out-of-period items
G. Authorization/permission controls applied
H. Tests added/updated
I. Documentation created
J. Follow-up notes for Prompt 3
