# AR/AP Forensic Fix Pack 01 — Implementation Report

> **Generated:** 2026-05-24  
> **Authorised by:** Ruan van Loggerenberg  
> **Source audit:** `docs/accounting/CUSTOMERS_SUPPLIERS_FORENSIC_AUDIT.md`  
> **Scope:** Five risk workstreams (WS-01 through WS-05) plus Aged Debtors implementation

---

## 1. Summary

This fix pack addresses five forensic audit risks identified in the AR/AP audit. All five payment and invoice GL failure modes have been eliminated. The Aged Debtors report has been implemented end-to-end (API + frontend). Multi-tenant defence-in-depth has been tightened on AR update calls. No existing functionality was removed or regressed.

---

## 2. Risks Addressed

| Risk ID | Description | Severity | Status |
|---------|-------------|----------|--------|
| RISK-AR-01 | Customer payment GL failure was silent — payment saved, GL not posted | HIGH | FIXED |
| RISK-AR-02 | VAT Output account 2300 missing → "Journal does not balance" with no useful error | MEDIUM | FIXED |
| RISK-AR-03 | No live Aged Debtors API or frontend — static stub only | HIGH | FIXED |
| RISK-AP-01 | Supplier payment GL failure was silent — payment saved, GL not posted | HIGH | FIXED |
| RISK-AP-02 | Supplier invoice created with `journal_id = null` when AP account 2000 missing | HIGH | FIXED |
| RISK-MULTI-01 | AR update calls (`PUT /:id`, `POST /:id/post`, `POST /:id/void`) lacked `company_id` filter | MEDIUM | FIXED |

---

## 3. Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `backend/modules/accounting/routes/customer-invoices.js` | Modified | 4 changes: payment STRICT GL, VAT 422, company_id defence, GET /aging endpoint |
| `backend/modules/accounting/routes/suppliers.js` | Modified | 2 changes: payment STRICT GL, invoice pre-creation AP/VAT account check |
| `frontend-accounting/aged-debtors.html` | Modified | Full replacement of static stub with live API-driven report |

---

## 4. Payment GL Failure Behaviour

### Design Decision: STRICT Mode (GL-First Ordering)

Both customer and supplier payment flows have been rewritten to **GL-first ordering**:

```
1. Validate all inputs (accounts, amounts, allocations)
2. CREATE and POST GL journal           ← FIRST
3. INSERT payment row (journal_id set)
   └─ If insert fails → reverseJournal() for cleanup
4. Apply allocations, update invoice statuses
5. Audit log
```

**Before (SILENT mode):**
```
1. Insert payment
2. Try GL journal
3. If GL fails → log warning, return HTTP 201 (silent failure)
```

**After (STRICT mode):**  
If the GL journal cannot be created or posted, the endpoint returns HTTP 500. No payment row is inserted. No allocations are applied. No invoice statuses are updated. The ledger and AR/AP sub-ledger remain in sync.

### Customer Payment (POST /payments in customer-invoices.js)

- Step 1: Validate AR account 1100 exists → 422 if not
- Step 2: Validate bank ledger account is active and `is_postable` → 422 if header account
- Step 3: Validate allocation total equals payment amount (within R0.01) → 422
- Step 4: Validate no over-allocation per invoice → 422
- Step 5: `JournalService.createDraftJournal()` + `postJournal()` — DR Bank / CR AR(1100)
- Step 6: Insert payment with `journal_id` already populated
- Step 7: Apply allocations + update `amount_paid` / `status` per invoice
- Step 8: Audit log

**Reversal path:** If payment insert fails after GL is posted, `JournalService.reverseJournal()` is called immediately. If reversal also fails, a CRITICAL log entry is written with the journal ID for manual intervention.

### Supplier Payment (POST /payments in suppliers.js)

- `bankLedgerAccountId` is now a **required** field — 422 returned if absent
- Step 1: bankLedgerAccountId required check
- Step 2: Validate AP account 2000 exists → 422 if not
- Step 3: Validate bank ledger account active + `is_postable` → 422
- Step 4: Validate allocation total equals payment amount → 422
- Step 5: Validate no over-allocation per supplier invoice → 422
- Step 6: `JournalService.createDraftJournal()` + `postJournal()` — DR AP(2000) / CR Bank
- Step 7: Insert payment with `journal_id` already populated
- Step 8: Apply allocations + update `amount_paid` / `status` per supplier invoice
- Step 9: Audit log

---

## 5. Supplier Invoice GL Protection

### Pre-Creation Account Validation

Two account checks were added at the **top** of the `POST /invoices` handler in suppliers.js, before the invoice row is inserted:

```javascript
if (totals.totalIncVat > 0) {
  const apCheck = await findAccountByCode(companyId, '2000');
  if (!apCheck) → 422: 'Accounts Payable account (code 2000) not found...'
}
if (totals.vatAmount > 0) {
  const vatCheck = await findAccountByCode(companyId, '1400');
  if (!vatCheck) → 422: 'VAT Input account (code 1400) not found...'
}
```

**Before:** The invoice row was inserted, then GL was attempted. If AP account 2000 was missing the invoice was saved with `journal_id = null`, creating a silent balance sheet gap (AP sub-ledger had the liability; GL did not).

**After:** If the required accounts are absent the invoice is never created. The user receives a clear actionable error message.

The existing silent `console.warn` for missing AP account (which was the only feedback before) has been removed.

### Customer Invoice VAT 422 Fix (POST /:id/post)

**Before (RISK-AR-02):** When VAT Output account 2300 was missing, the GL journal was assembled without a VAT credit line. The journal was imbalanced and the GL engine returned a cryptic "Journal does not balance" error.

**After:** An explicit check fires before the GL lines are assembled:

```javascript
if (totalVat > 0) {
  const vatOutputId = await findAccountByCode(companyId, '2300');
  if (!vatOutputId) {
    return res.status(422).json({
      error: 'VAT Output account (code 2300) not found. Please provision the base chart of accounts before posting VAT-bearing customer invoices.'
    });
  }
  glLines.push({ accountId: vatOutputId, debit: 0, credit: totalVat, ... });
}
```

---

## 6. Aged Debtors Implementation

### API Endpoint (GET /api/accounting/customer-invoices/aging)

New endpoint added to `customer-invoices.js`:

**Query parameters:**
- `asAt` (optional, ISO date string) — defaults to today
- `customerId` (optional, integer) — filter to a single customer
- `includeZero` (optional, boolean string) — include fully-paid customers

**Grouping strategy (per Ruan's decision):**
- Group by `customer_id` when set (FK-linked POS customers)
- Fallback to normalised `customer_name.toLowerCase().trim()` for ad-hoc customers
- Do not formalise customer FK at this stage

**Ageing buckets:**
| Bucket | Condition |
|--------|-----------|
| `current` | `due_date IS NULL` OR `daysOverdue <= 0` |
| `days30` | `1 ≤ daysOverdue ≤ 30` |
| `days60` | `31 ≤ daysOverdue ≤ 60` |
| `days90` | `61 ≤ daysOverdue ≤ 90` |
| `days90plus` | `daysOverdue > 90` |

Invoices with `status IN ('draft','void','cancelled')` are excluded. `noDueDateCount` is flagged per customer so the frontend can display a warning asterisk.

**Response shape:**
```json
{
  "asAt": "2026-05-24",
  "customers": [
    {
      "customerId": 12,
      "customerName": "Acme Corp",
      "current": 5000.00,
      "days30": 2000.00,
      "days60": 0.00,
      "days90": 0.00,
      "days90plus": 0.00,
      "total": 7000.00,
      "invoiceCount": 3,
      "noDueDateCount": 1
    }
  ],
  "totals": { "current": 5000.00, "days30": 2000.00, "days60": 0.00, "days90": 0.00, "days90plus": 0.00, "total": 7000.00 }
}
```

### Frontend (aged-debtors.html)

The static stub was fully replaced with a live implementation:

- **Controls:** As-at date (defaults to today), customer filter, include-zero toggle, Generate button
- **Live fetch:** `GET /api/accounting/customer-invoices/aging` with query params from controls
- **Table:** Per-customer row with colour coding:
  - Red text: `days90plus > 0`
  - Amber text: `days60 > 0 || days90 > 0`
  - Asterisk (*): `noDueDateCount > 0` (with tooltip "One or more invoices have no due date set")
- **Totals row:** Pinned at bottom; bold with top border
- **State management:** Loading spinner, empty state message, error banner — no alert() calls
- **No browser storage:** Company name resolved from JWT decode; all data from server
- **Export buttons:** Disabled with `title="Coming soon"` (not yet implemented)

---

## 7. Multi-Tenant Safety

Three AR update calls were missing `company_id` defence-in-depth:

| Endpoint | Call | Fix Applied |
|----------|------|-------------|
| `PUT /:id` | `update(payload).eq('id', invoiceId)` | Added `.eq('company_id', companyId)` |
| `POST /:id/post` | `update({ status: 'sent', journal_id: ... }).eq('id', id)` | Added `.eq('company_id', companyId)` |
| `POST /:id/void` | `update({ status: 'void' }).eq('id', id)` | Added `.eq('company_id', companyId)` |

The primary `req.companyId` tenant isolation enforced by auth middleware remains unchanged. These additions are a defence-in-depth layer — any accidental bypass of auth middleware cannot leak data to a different company via an invoice ID collision.

---

## 8. What Was Not Changed

The following were explicitly out of scope for this fix pack:

| Area | Reason |
|------|--------|
| `JournalService.js` | Not touched — called as a service, not modified |
| Bank import, staging, duplicate detection | Bank recon codebox scope (Part A) — already complete |
| Transfer detection, allocation journal creation | Bank recon codebox scope |
| VAT split logic | Bank recon codebox scope |
| TB / GL report source logic | No changes needed |
| Opening balances | Out of scope |
| Historical comparatives | Out of scope |
| Supplier invoice void | Explicitly deferred by Ruan |
| AP draft stage for supplier invoices | Explicitly not requested |
| Customer FK formalisation | Explicitly deferred by Ruan |
| IRP5 / Payroll | Not in scope |

---

## 9. Tests Run

> Manual integration tests performed against development environment.

| Test | Result |
|------|--------|
| Customer payment — GL account missing → payment blocked, 422 returned | PASS |
| Customer payment — bank account is header (`is_postable=false`) → 422 | PASS |
| Customer payment — allocation total mismatch → 422 | PASS |
| Customer payment — over-allocation per invoice → 422 | PASS |
| Customer payment — valid → GL posted, payment saved, invoice status updated | PASS |
| Customer invoice post — VAT 2300 missing → 422 with clear message | PASS |
| Customer invoice post — VAT 2300 present → GL posted, status = 'sent' | PASS |
| Supplier payment — bankLedgerAccountId absent → 422 | PASS |
| Supplier payment — AP account 2000 missing → 422 | PASS |
| Supplier payment — valid → GL posted DR AP/CR Bank, payment saved | PASS |
| Supplier invoice create — AP account 2000 missing → 422, no orphan row | PASS |
| Supplier invoice create — VAT 1400 missing → 422 when VAT lines present | PASS |
| Aged Debtors API — returns bucketed outstanding invoices by customer | PASS |
| Aged Debtors API — null due_date invoices → current bucket + noDueDateCount | PASS |
| Aged Debtors API — draft/void/cancelled invoices excluded | PASS |
| Aged Debtors frontend — generates live report from API | PASS |
| AR update calls — PUT/:id company_id scoped | PASS |

---

## 10. Remaining Risks

| Risk | Description | Priority |
|------|-------------|----------|
| RR-01 | `customer_payment_allocations` inserts (Step 6/7 in payment flow) do not reverse if one allocation fails mid-loop; previous allocations in the same payment remain in the DB | LOW — allocation loop already pre-validated; partial failure would require DB inspection to clean up |
| RR-02 | Aged Debtors does not yet support AP (Aged Creditors) — no equivalent `GET /aging` endpoint in suppliers.js | MEDIUM — separate workstream when needed |
| RR-03 | Export to PDF / Excel on aged-debtors.html not yet implemented | LOW — placeholders with "Coming soon" label |
| RR-04 | Supabase lacks real transactions — GL-first ordering is the safety mechanism; if the DB node handling the payment insert is unavailable after GL success, a dangling posted journal exists until `reverseJournal()` also succeeds | VERY LOW — DB node unavailability after a successful GL post would require a very specific failure window |
| RR-05 | `customer_id` FK not yet formalised — grouping by normalised name can mismatch if the same customer has slight name variations across invoices | LOW — noted in design decision; deferred by Ruan |

---

*Report generated as part of AR/AP Forensic Fix Pack 01 — 2026-05-24*
