# 09 — Accounting Integration

---

## 1. Current State: No Integration Exists

**POS sales do NOT post to the accounting module.**

There is no visible link between:
- `Point of Sale/routes/*.js` (POS backend)
- `accounting-ecosystem/backend/modules/accounting/` (accounting backend)

POS sales exist only in POS tables: `sales`, `sale_items`, `sale_payments`.  
They do not create journal entries, ledger postings, income recognition records, or VAT liability records in any accounting system.

---

## 2. What Would Be Required for Accounting Integration

A complete accounting integration for POS would need to create, for each sale:

### Revenue Journal Entry
```
DR  Cash / Bank (or Card Receivable / Account Receivable)    R115.00
    CR  Sales Revenue (excl. VAT)                            R100.00
    CR  VAT Output Liability                                  R15.00
```

### Cost of Goods Sold Entry (if perpetual inventory)
```
DR  Cost of Goods Sold                                       R65.00
    CR  Inventory                                             R65.00
```

### On Return
```
DR  Sales Returns (revenue reversal)                         R115.00
    CR  Cash / Account                                        R115.00

DR  Inventory                                                R65.00
    CR  Cost of Goods Sold                                    R65.00
```

None of these journal entries are currently generated.

---

## 3. Ecosystem Integration Points That Exist (Infrastructure)

The ecosystem backend has an `accounting` module:
```
accounting-ecosystem/backend/modules/accounting/
```

And `integration_configs` and `integration_sync_log` tables exist:
```sql
integration_configs (company_id, integration_type, integration_name,
  endpoint_url, api_key, oauth_token, sync_settings JSONB, ...)

integration_sync_log (integration_config_id, sync_type, sync_direction,
  records_processed, records_succeeded, started_at, ...)
```

These suggest the architecture was designed to support integrations, but no POS→accounting integration has been implemented.

---

## 4. VAT Output for Tax Returns

The VAT summary report (`GET /api/reports/vat/summary`) produces daily totals of:
- Total sales
- VAT amount collected

This data could be used to prepare SARS VAT201 returns manually. However:

1. The data source is `sales.vat_amount` — accuracy depends on consistent VAT calculation
2. No VAT period locking or submission tracking exists
3. No connection to the accounting module's VAT accounts

---

## 5. Session-to-Bank Reconciliation

There is no bank reconciliation integration. The till session cash-up records:
- `opening_balance`
- `closing_balance`
- `expected_balance`
- `variance`

But this does not connect to:
- Bank statements
- Bank transaction imports
- The accounting module's bank reconciliation

For a cashier's cash receipts to reach the bank:
1. Physical cash deposit to bank
2. Manual journal entry in accounting: DR Bank, CR Cash Till
3. POS session variance would need to be investigated manually

Card/EFT payments would need:
1. Bank statement import showing card settlements
2. Manual or automated matching of POS card totals to bank settlements

---

## 6. Multi-Company / Location Accounting

The POS has multi-tenant (multi-company) support with `company_id` on all tables. However:
- Consolidated reporting across all locations is not implemented
- Inter-company transactions are not tracked
- Each company's POS data is siloed

For a business with HQ + multiple branches, there is currently no way to view combined POS performance across all branches in a single accounting view.

---

## 7. Revenue Recognition Timing

Revenue is recognized at point of sale (when `POST /api/pos/sales` succeeds). This is appropriate for retail POS. However:

- Account customer sales (credit sales) are collected later — no accounts receivable aging or payment tracking linked to accounting
- Returns reverse the revenue at return time, not at original sale period
- No deferred revenue handling

---

## 8. Cost of Goods Sold

`products.cost_price` is stored but:
- NOT automatically posted to COGS accounts when a sale occurs
- Only used in the Gross Profit report (as a reporting calculation, not an accounting entry)

For accurate COGS accounting, a journal entry would need to be created per sale line: `DR COGS, CR Inventory`.

---

## 9. What a Future Integration Should Do

To connect POS to accounting:

1. **On sale completion**: POST a journal entry payload to the accounting module
   - DR appropriate clearing account by payment method
   - CR Revenue account by product category or VAT class
   - CR VAT Output Liability

2. **On return**: Reverse the original journal entry

3. **On session close**: Reconcile cash float and create a cash movement entry
   - DR Cash Till / DR Bank (on deposit)
   - CR Opening Float

4. **On card settlement received**: Match POS card totals to bank transaction import

5. **On account sale**: Create AR entry; on payment: clear AR, DR Bank

6. **COGS**: On sale: DR COGS, CR Inventory (if perpetual inventory accounting)

7. **VAT**: Ensure VAT Output Liability is credited correctly, and VAT periods are tracked for VAT201 submissions.

---

## 10. Recommended Integration Architecture

```
POS Sale → webhook or event queue → Accounting Journal Service
  → Creates GL entries
  → Links back to sale_id (for audit trail)
  → Locks period after VAT submission
```

This would require:
- A shared `journal_entries` table or Supabase function
- A mapping table: product category → revenue account code
- A payment method → bank/clearing account mapping
- Period locking to prevent backdating after VAT submission

---

## 11. Current Risk

Without accounting integration, the business must:
- Manually enter all POS revenue into their accounting system
- Manually calculate VAT from POS VAT reports
- Manually reconcile cash-up balances to their books
- Risk of manual errors causing tax filing inaccuracies

This is a significant compliance risk for any business processing meaningful volumes of POS transactions.
