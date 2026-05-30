# ACCOUNTING IMPLEMENTATION REPORT
## ACC-HARDEN-014 — Customer / Invoice Multi-Tenant Enforcement Audit

**Date:** 2026-05-30
**Status:** Complete — 4 targeted fixes applied
**File hardened:** `backend/modules/accounting/routes/customer-invoices.js`
**Backend-only change — no frontend files modified**

---

## 1. Root Cause

The frontend customer typeahead fix (previous session) added `customerId` to the invoice creation payload. This exposed a pre-existing backend gap: `customerId` was accepted from the request body and inserted into `customer_invoices.customer_id` without any server-side verification that the customer belonged to the authenticated company. Similarly, line item `accountId` values were stored without ownership verification.

Frontend validation is never a security boundary. Any authenticated user with a valid JWT (for their own company) could craft a raw `POST /api/accounting/customer-invoices` with a `customerId` from another company. The backend would accept it and store a cross-tenant customer reference permanently.

---

## 2. Tenant Isolation Findings

### Already enforced before this workstream

| Route | Mechanism | Status |
|---|---|---|
| `GET /` | `.eq('company_id', companyId)` on query | ✅ Safe |
| `GET /customers` | `.eq('company_id', companyId)` on both POS + invoice sources | ✅ Safe |
| `GET /:id` | `.eq('company_id', companyId)` before returning invoice | ✅ Safe |
| `PUT /:id` | Initial fetch `.eq('company_id', companyId)` + `WHERE company_id = $12` in UPDATE | ✅ Safe |
| `POST /:id/post` | `.eq('company_id', companyId)` on fetch + status update | ✅ Safe |
| `POST /:id/void` | `.eq('company_id', companyId)` on fetch + void update | ✅ Safe |
| `POST /payments` | Bank account validated `.eq('company_id', companyId)`, each allocation invoice scoped | ✅ Safe |
| `GET /aging` | `.eq('company_id', companyId)` on all invoice queries | ✅ Safe |
| `req.companyId` source | JWT — set by auth middleware, not trusted from body/params | ✅ Safe |

### PUT /:id does NOT accept `customerId` in body

The update route only accepts: `customerName, invoiceNumber, reference, invoiceDate, dueDate, vatInclusive, lines, notes`. The `customer_id` column is set at creation time and cannot be changed via the edit route. This is a deliberate security property — once a customer relationship is established on an invoice, it cannot be silently switched.

---

## 3. Unsafe Queries Found

### GAP-1 — CRITICAL — POST /: customerId inserted without ownership check

**Before:**
```javascript
const { customerId, customerName, ... } = req.body;
// ...
VALUES ($1, $2, ...) -- customerId inserted directly at position $2
```

No verification that `customerId` belonged to `req.companyId`. An authenticated user for Company A could inject Company B's POS customer ID into their invoice.

**Consequence:** `customer_invoices.customer_id` would store a foreign customer reference permanently. The aged-debtors report groups by `customer_id`, so invoices for Company A would appear under Company B's customer grouping when Company A queries their own aging.

### GAP-2 — MEDIUM — POST /: line accountId not ownership-validated

**Before:**
```javascript
lineParams.push(invoice.id, l.description, l.accountId || null, ...);
```

No verification that `l.accountId` belonged to `req.companyId`. An attacker could supply a foreign company's revenue account ID. When the invoice is subsequently posted to GL, the revenue credit would reference a foreign account ID in the journal lines.

### GAP-3 — MEDIUM — PUT /:id: same line accountId gap on update path

Same as GAP-2 but on the update route. Line items are fully replaced on update, so the same injection was possible through the edit flow.

### GAP-4 — LOW — PUT /:id: post-transaction re-fetch missing company_id

**Before:**
```javascript
await supabase.from('customer_invoices').select('*').eq('id', invoiceId).single();
```

After a successful UPDATE (which already enforced `WHERE company_id = $12`), the re-fetch returned the record without re-applying `company_id`. Low risk because the UPDATE itself was company-scoped, but not defense-in-depth.

---

## 4. Validation Gaps Found

| Gap | Type | Severity | Fixed |
|---|---|---|---|
| `customerId` from body not ownership-verified on CREATE | Tenant injection | CRITICAL | ✅ |
| Line `accountId` not ownership-verified on CREATE | Cross-tenant account injection | MEDIUM | ✅ |
| Line `accountId` not ownership-verified on UPDATE | Cross-tenant account injection | MEDIUM | ✅ |
| Post-update re-fetch missing `company_id` filter | Defense-in-depth | LOW | ✅ |

---

## 5. Security Risks Identified

### Risk 1 — Cross-tenant customer reference injection (CRITICAL)
**Attack:** Authenticated user for Company A sends `POST /api/accounting/customer-invoices` with `customerId` belonging to Company B.
**Before fix:** Invoice created with Company B's customer ID stored permanently.
**After fix:** 403 `CUSTOMER_TENANT_VIOLATION`, audit logged.

### Risk 2 — Cross-tenant account injection into invoice lines (MEDIUM)
**Attack:** Authenticated user crafts invoice lines with `accountId` values from another company's chart of accounts.
**Before fix:** Foreign account IDs stored in `customer_invoice_lines`. GL post would credit revenue to a foreign account ID.
**After fix:** 403 `ACCOUNT_TENANT_VIOLATION`.

### Risk 3 — Replay/stale session (LOW — already handled)
**Why already safe:** `req.companyId` is embedded in the JWT by the server at login and company-select time. A company switch issues a new JWT. The old JWT's `companyId` is different from the new one. Every mutation verifies the JWT's `companyId` against the invoice's stored `company_id`. Stale tokens access only their original company's data.

---

## 6. What Was Hardened

### New helpers added (lines 67–104)

```javascript
async function validateCustomerId(companyId, customerId)
// Returns: null (no id), true (valid), false (foreign/invalid)

async function validateLineAccountIds(companyId, lines)
// Returns: null (all valid), [id, ...] (foreign ids found)
```

Both helpers query the database directly — they never trust frontend data.

### POST / (CREATE) — Guards at top of try block

```
Guard 1: if customerId provided → verify pos_customers WHERE id = customerId AND company_id = companyId
  On failure: 403 CUSTOMER_TENANT_VIOLATION + audit log

Guard 2: collect all distinct non-null accountIds from lines → verify all in accounts WHERE company_id = companyId
  On failure: 403 ACCOUNT_TENANT_VIOLATION
```

Both guards run before the duplicate-invoice check, before any DB transaction is opened. A bad payload is rejected cheaply.

### PUT /:id (UPDATE) — Guard after processedLines, before transaction

```
Guard: if lines provided → verify all accountIds belong to companyId
  On failure: 403 ACCOUNT_TENANT_VIOLATION
```

Runs after the status check (only draft invoices can be edited) and before the atomic UPDATE transaction.

### PUT /:id (UPDATE) — Re-fetch hardened

```javascript
// Before
.eq('id', invoiceId).single()

// After
.eq('id', invoiceId).eq('company_id', companyId).single()
```

---

## 7. What Was Intentionally NOT Changed

| Area | Reason |
|---|---|
| Invoice posting engine (`POST /:id/post`) | Already company-scoped throughout; GL accounts resolved via `findAccountByCode` which is company-scoped; no tenant gap found |
| Void engine (`POST /:id/void`) | Already company-scoped throughout; VAT period lock guard in place |
| Payment engine (`POST /payments`) | Bank account validated with `company_id`; each allocation invoice validated with `company_id`; no gap found |
| Aged debtors report (`GET /aging`) | Main query already scoped; `customerIdFilter` is further constrained within the company's own invoices |
| GL journal architecture | JournalService unchanged; journals are company-scoped at the service level |
| VAT logic | Unchanged |
| AR aging logic | Unchanged |
| Invoice numbering | Unchanged |
| `customer_invoice_lines` queries in GET /:id and POST /:id/post | Safe because parent invoice is company-validated first; lines table has no `company_id` column (scoped via invoice_id) |
| PUT /:id body schema | Does NOT accept `customerId` — this is correct; `customer_id` is immutable after creation |

---

## 8. Accounting Impact

**None.** The guards are pre-transaction rejections. No invoice rows, no journal rows, and no line rows are created before the guard passes. Existing valid invoices are completely unaffected — the guards only reject payloads that contain foreign IDs.

The `customer_id` on existing invoices is not touched.

The `account_id` on existing invoice lines is not touched.

AR ageing, customer balances, and debtor reports are unaffected.

---

## 9. VAT Impact

**None.** VAT calculation logic (`calcLineVAT`) is unchanged. VAT output posting logic (`findAccountByCode('2300', companyId)`) was already company-scoped. The line account validation only runs on the input `accountId` (the revenue account chosen by the user), not on the VAT account (which is resolved server-side by code lookup).

---

## 10. Reporting Impact

**None.** No read paths were changed. The only changes are pre-write guards on CREATE and UPDATE. All SELECT queries, aggregations, and report calculations remain identical.

---

## 11. Multi-Tenant Safety Verification

After hardening, the invariants are:

| Invariant | Mechanism |
|---|---|
| Company context from JWT only | `req.companyId` set by `authenticate` middleware |
| Customer belongs to company | `validateCustomerId` checks `pos_customers WHERE company_id = companyId` |
| Line accounts belong to company | `validateLineAccountIds` checks `accounts WHERE company_id = companyId` |
| Invoice owned by company | Every mutation: `.eq('company_id', companyId)` on fetch + write |
| Invoice immutability after post | Status guard on PUT (draft only), double-post guard on POST /:id/post |
| GL journals company-scoped | JournalService always receives `companyId` from `req.companyId` |
| Payment allocations company-scoped | Each invoice checked `.eq('company_id', companyId)` |

A manipulated frontend payload cannot cross tenants. The database remains the authority.

---

## 12. localStorage Findings

Zero `localStorage` references in `customer-invoices.js`. The route file is a pure Express router — no browser APIs, no session storage, no client-side state. All state is from `req.companyId` (JWT) and the Supabase database.

---

## 13. Security Test Results

| Test | Expected | Result |
|---|---|---|
| TEST-TENANT-01: Inject Company B's `customerId` into Company A's invoice | 403 `CUSTOMER_TENANT_VIOLATION` + audit log | ✅ Blocked |
| TEST-TENANT-02: Replay stale invoice update after company switch | Rejected (old JWT has old `companyId`; update scoped by JWT's `companyId`) | ✅ Already blocked (JWT architecture) |
| TEST-TENANT-03: Send `null` `customerId` on invoice | Invoice saved with `customer_id = null` — valid, name-only invoice | ✅ Handled correctly |
| TEST-TENANT-04: Inject foreign `accountId` in line items via DevTools | 403 `ACCOUNT_TENANT_VIOLATION` | ✅ Blocked |
| TEST-TENANT-05: Read foreign company's invoice via `GET /:id` | 404 (`.eq('company_id', companyId)` returns null → 404) | ✅ Already blocked |

---

## 14. Remaining Risks

### TOCTOU on payment allocation amounts (LOW — separate workstream)
Between the allocation validation (Step 3 of payment flow) and the `amount_paid` update (Step 6), another concurrent payment could allocate to the same invoice. This could theoretically result in `amount_paid > total_inc_vat`. This is a concurrency hazard, not a tenant security issue. Proper fix requires a `SELECT FOR UPDATE` row lock at the database level. Recommended for a dedicated concurrency hardening workstream.

### Invoice-only customer names have no ownership anchor (LOW — by design)
Customers sourced from existing invoice history (`source: 'invoice'`) have `id: null`. The invoice stores their name as a string with no FK constraint. This is by design (the feature predates POS customer IDs). These name-only customers cannot be cross-tenant-injected via `customerId` (which is null) but could theoretically be given any customer name string. No practical exploit — the name has no FK effect on accounting truth.

### `customerName` minimum length not enforced (TRIVIAL)
`customerName` passes the truthy check with a single space. This is a UX issue, not a security issue. Recommended: add `.trim()` and `length > 0` check in a future UX hardening pass.

---

## 15. Recommended Next Workstream

**ACC-HARDEN-015 — Concurrency hardening for payment allocations**

Implement `SELECT FOR UPDATE` row-level locking when updating `customer_invoices.amount_paid` during payment allocation. This prevents race conditions where two concurrent payments could both read the same outstanding balance and both apply in full, resulting in `amount_paid > total_inc_vat`.

This is a correctness issue, not a tenant security issue, so it does not block the current hardening from being deployed.
