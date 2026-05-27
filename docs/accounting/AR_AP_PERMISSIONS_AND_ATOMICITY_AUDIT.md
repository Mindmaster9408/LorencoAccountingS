# AR/AP PERMISSIONS AND ATOMICITY AUDIT

**Date:** 2026-05-27  
**Scope:** Customer Invoices (AR) + Suppliers/AP routes  
**Auditor:** Copilot (audit-only, no code changes)  
**Source files inspected:**
- `accounting-ecosystem/backend/modules/accounting/routes/customer-invoices.js`
- `accounting-ecosystem/backend/modules/accounting/routes/suppliers.js`
- `accounting-ecosystem/backend/modules/accounting/middleware/auth.js`
- `accounting-ecosystem/backend/modules/accounting/index.js`

---

## 1. Executive Summary

Two distinct risk categories were identified:

**AUTH-01 — Permission coverage gaps (HIGH)**

- `customer-invoices.js` does NOT import `hasPermission()` at all. Zero of its nine routes have any accounting permission check. Any authenticated user of any role can create, post, void, and record payments for customer invoices.
- `suppliers.js` imports `hasPermission()` but only applies it to two of its seventeen routes. Critical mutation routes — including supplier payments (which post to GL), supplier creation, invoice editing (which may trigger GL correction), and PO approval — have no permission guard.

**AC-04 — Invoice creation is non-atomic (MEDIUM)**

- Both customer invoice creation and supplier invoice creation insert the header row first and lines in a separate DB call. If the lines insert fails, a header-only orphan record is left in the database.
- Both customer and supplier invoice update routes delete existing lines and re-insert. If re-insert fails, the invoice ends with zero lines.
- No Supabase transactions or post-failure header cleanup are used anywhere in either file.

**AC-03 (double-post fix) — Verified working.** The double-post guard on `POST /customer-invoices/:id/post` is correctly implemented. The supplier `POST /invoices` creation-time GL error recovery is also correctly implemented with reversal logic.

---

## 2. Customer Invoice Route Permissions

### Import status

```javascript
// Top of customer-invoices.js — NO hasPermission import
const express = require('express');
const router  = express.Router();
const { supabase } = require('../../../config/database');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');
// hasPermission is never imported
```

**`hasPermission` is not imported. No route in this file has any permission check.**

### Route-by-route audit

| # | Method | Path | hasPermission | Correct? | Risk |
|---|---|---|---|---|---|
| 1 | `GET` | `/customers` | ❌ None | Should require `ar.view` | LOW — read-only dropdown |
| 2 | `GET` | `/` | ❌ None | Should require `ar.view` | LOW — read-only |
| 3 | `GET` | `/:id` | ❌ None | Should require `ar.view` | LOW — read-only |
| 4 | `POST` | `/` | ❌ None | Should require `ar.create` | **HIGH** — creates draft invoice |
| 5 | `PUT` | `/:id` | ❌ None | Should require `ar.create` | **HIGH** — edits draft invoice |
| 6 | `POST` | `/:id/post` | ❌ None | Should require `ar.post` | **CRITICAL** — posts GL entry |
| 7 | `POST` | `/:id/void` | ❌ None | Should require `ar.post` | **CRITICAL** — reverses GL entry |
| 8 | `POST` | `/payments` | ❌ None | Should require `ar.payment` | **CRITICAL** — posts GL entry |
| 9 | `GET` | `/aging` | ❌ None | Should require `ar.view` | LOW — read-only report |

**All 9 routes are unprotected.** Any authenticated user with a valid JWT, regardless of role (`viewer`, `bookkeeper`, etc.), can currently perform any of these operations — including posting to the General Ledger and recording payments.

### PERMISSIONS map — AR entries

Inspecting the current `PERMISSIONS` object in `middleware/auth.js`:

```
'account.view', 'account.create', 'account.edit', 'account.delete'
'journal.view', 'journal.create', 'journal.edit', 'journal.post', ...
'bank.view', 'bank.manage', 'bank.import', 'bank.allocate', 'bank.reconcile'
'report.view', 'report.export'
'ai.*', 'audit.view', 'pos.*', 'ap.manage', 'diagnostics.*', 'historical.*', 'opening_balance.*'
```

**There are zero AR-specific permissions defined.** No `ar.view`, `ar.create`, `ar.post`, `ar.payment`, or equivalent exists. Adding `hasPermission()` calls to the AR routes would require new entries to be added to the PERMISSIONS map first, or existing entries to be reused (see Section 5).

---

## 3. Supplier Route Permissions

### Import status

```javascript
const { hasPermission }  = require('../middleware/auth');
```

✅ `hasPermission` IS imported. The problem is selective application.

### Route-by-route audit

| # | Method | Path | hasPermission | Correct? | Risk |
|---|---|---|---|---|---|
| 1 | `GET` | `/stats` | ❌ None | Should require `ap.manage` | LOW — aggregate read |
| 2 | `GET` | `/` | ❌ None | Should require `ap.manage` | LOW — read-only |
| 3 | `POST` | `/` | ❌ None | Should require `ap.manage` | **MEDIUM** — creates supplier record |
| 4 | `GET` | `/invoices` | ❌ None | Should require `ap.manage` | LOW — read-only |
| 5 | `POST` | `/invoices` | ✅ `ap.manage` | Correct | — |
| 6 | `GET` | `/invoices/:id` | ❌ None | Should require `ap.manage` | LOW — read-only |
| 7 | `PUT` | `/invoices/:id` | ❌ None | Should require `ap.manage` | **HIGH** — may trigger GL correction |
| 8 | `GET` | `/orders` | ❌ None | Should require `ap.manage` | LOW — read-only |
| 9 | `POST` | `/orders` | ❌ None | Should require `ap.manage` | MEDIUM — creates PO |
| 10 | `GET` | `/orders/:id` | ❌ None | Should require `ap.manage` | LOW — read-only |
| 11 | `PUT` | `/orders/:id/status` | ❌ None | Should require `ap.manage` | **MEDIUM** — approves/cancels PO |
| 12 | `GET` | `/payments` | ❌ None | Should require `ap.manage` | LOW — read-only |
| 13 | `POST` | `/payments` | ❌ None | Should require `ap.manage` | **CRITICAL** — posts GL entry |
| 14 | `GET` | `/aging` | ❌ None | Should require `ap.manage` | LOW — read-only report |
| 15 | `GET` | `/:id` | ❌ None | Should require `ap.manage` | LOW — read-only |
| 16 | `PUT` | `/:id` | ❌ None | Should require `ap.manage` | MEDIUM — edits supplier |
| 17 | `POST` | `/invoices/ocr` | ✅ `ap.manage` | Correct | — |

**2 of 17 routes are protected. 15 are unprotected**, including `POST /payments` which directly creates and posts a GL journal.

---

## 4. Current Role Exposure

The ECO → Lorenco role mapping (from `middleware/auth.js`) maps inbound ECO roles down to:

| Lorenco Role | Can currently do (AR) | Can currently do (AP) |
|---|---|---|
| `viewer` | Create invoices, post to GL, void, record payments | Record payments (GL), edit invoices (GL correction), approve POs |
| `bookkeeper` | Same as viewer | Same as viewer |
| `accountant` | Same as viewer | Same as viewer |
| `admin` | Same as viewer | Same as viewer |

Because there are no permission checks on any AR route, and only two on AP routes, the role distinction is meaningless for these modules. All authenticated users are functionally equivalent.

**The only actual protection against unauthorised AR/AP access is the top-level JWT authentication (ECO's `authenticateToken`), which runs before the module. A valid JWT of any role grants full AR/AP access.**

---

## 5. Recommended Permission Matrix

### Proposed new PERMISSIONS entries (AR)

These do not yet exist in `middleware/auth.js` and must be added before AR route guards can be wired:

| Permission Key | Allowed Roles | Notes |
|---|---|---|
| `ar.view` | `admin`, `accountant`, `bookkeeper`, `viewer` | Read-only: list, detail, aging, customer dropdown |
| `ar.create` | `admin`, `accountant`, `bookkeeper` | Create draft, edit draft, delete draft |
| `ar.post` | `admin`, `accountant` | Post to GL, void (both create/reverse journal entries) |
| `ar.payment` | `admin`, `accountant`, `bookkeeper` | Record customer payment (posts to GL) |

**Design rationale for `ar.post` restriction to admin+accountant:** Posting an invoice creates binding AR entries in the General Ledger. Voiding reverses them. These are irreversible accounting events with tax implications. Bookkeeper creates drafts; accountant/admin approves and posts.

**Design rationale for `ar.payment` including bookkeeper:** Recording a customer payment is operationally routine (cash receipts). Restricting to admin+accountant would create workflow friction without proportionate security benefit.

### Proposed AP route permission assignments

All AP routes should use the existing `ap.manage` permission: `['admin', 'accountant', 'bookkeeper']`.

No new permissions are needed for AP — `ap.manage` is the correct scope for all supplier and AP invoice operations.

---

## 6. Invoice Creation Atomicity

### Customer Invoice Creation (`POST /`)

**Current sequence:**

```
1. Duplicate guard (read-only)
2. Process and validate lines
3. Auto-generate invoice number (read-only)
4. ← INSERT customer_invoices header → invoice.id assigned
5. Build lineInserts array using invoice.id
6. ← INSERT customer_invoice_lines (separate DB call)
7. Audit log
8. Return 201
```

**Failure window:** Between steps 4 and 6.

If the Supabase insert at step 6 fails (network timeout, constraint violation, DB error), the `throw new Error(linesErr.message)` propagates to the `catch` block, which returns a 500. However, the header row inserted at step 4 is already committed to `customer_invoices`. The invoice exists with `status: 'draft'` and zero lines.

**Result:** Orphan header invoice. The customer-facing API returns an error, but the DB contains an empty draft invoice that:
- Appears in the invoice list
- Has a generated invoice number allocated
- Blocks that invoice number from future re-use (duplicate guard uses non-void invoices)
- Will confuse reconciliation

There is no rollback, no cleanup, no header deletion on lines failure.

### Customer Invoice Update (`PUT /:id`)

```
1. Fetch and validate existing invoice
2. Recalculate totals
3. ← UPDATE customer_invoices header
4. ← DELETE all customer_invoice_lines for this invoice
5. ← INSERT new customer_invoice_lines (separate DB call)
```

If step 5 fails after step 4 succeeds, the invoice has an updated header but zero lines.

### Supplier Invoice Creation (`POST /invoices`)

```
1. Validate supplier
2. Duplicate guard
3. Pre-creation GL account validation (pre-check, not a transaction guard)
4. ← INSERT supplier_invoices header → invoice.id assigned
5. ← INSERT supplier_invoice_lines
6. GL posting (attempt + reversal on failure)
```

If step 5 (lines insert) fails, the header row from step 4 exists. The GL posting block (step 6) is never reached so no journal exists. The invoice is `status: 'unpaid'` with no lines and `journal_id: null`.

**Note:** The GL failure reversal logic at step 6 is well-implemented — if lines succeed but GL fails, the invoice is cancelled and the journal reversed. But the lines-fail scenario leaves an orphan header without any cleanup.

### Supplier Invoice Update (`PUT /invoices/:id`)

```
1. VAT lock check
2. Detect accounting changes
3. [If GL correction needed]: post replacement journal, reverse original
4. ← UPDATE supplier_invoices header (includes new journal_id)
5. ← DELETE supplier_invoice_lines
6. ← INSERT new supplier_invoice_lines
```

If step 6 fails after step 5, the invoice has a new header (pointing to the corrected journal) but zero lines.

---

## 7. Header-Only Invoice Risk

**Can a header-only invoice be created today?**

Yes. In both `customer-invoices.js` and `suppliers.js` invoice creation routes, the current code:

1. Inserts the header unconditionally
2. Inserts lines in a separate Supabase call with no cleanup on failure

A transient DB error, a constraint violation on any line, or an unexpected exception after the header insert will leave an orphan header.

**Observable symptoms of an orphan invoice:**
- An invoice with `total_inc_vat = 0` or with computed totals but zero lines
- A generated invoice number allocated but the document is empty
- In the supplier case: `status = 'unpaid'` with `journal_id = null` — not backed by any GL entry, but appears in the AP ledger
- In the AR case: `status = 'draft'`, consuming an invoice number sequence slot

**Frequency risk:** Low under normal operation. Elevated under:
- Network instability between backend and Supabase
- Supabase rate limiting or quota events
- High concurrency (multiple users submitting simultaneously)
- Client retries on slow responses (user double-clicks Submit)

---

## 8. Company Scoping

Both files consistently use `req.companyId` for all DB reads and writes. The `companyId` is set by the ECO `authenticateToken` middleware before the request reaches the accounting module.

All queries filter by `companyId`:
- Header inserts: `company_id: companyId`
- Line inserts: keyed off `invoice.id` which is already company-scoped
- Reads: `.eq('company_id', companyId)` on every query
- Supplier verification: cross-checked against `company_id` before use

**Company scoping is consistently applied. No cross-company data leak risk was identified in these routes.**

One note: neither file calls `enforceCompanyScope` middleware explicitly. Company isolation is achieved entirely through consistent manual query filtering. This works, but means there is no centralised enforcement layer — a future route that accidentally omits the `.eq('company_id', companyId)` clause would have no safety net. This is a maintenance risk rather than a current vulnerability.

---

## 9. AC-03 Fix Verification

AC-03 addressed the risk of double-posting an invoice to the GL.

### Customer invoice (`POST /:id/post`) — VERIFIED ✅

The double-post guard is present and correctly ordered:

```javascript
// Double-post guard: journal_id already set means a GL entry exists for this invoice.
if (invoice.journal_id != null) {
  // Audit log then:
  return res.status(409).json({
    error: 'Invoice already has a linked journal and cannot be posted again.',
    journalId: invoice.journal_id,
  });
}
```

This runs before any GL work. A second call to `POST /:id/post` on an already-posted invoice returns 409 and logs an audit event. No duplicate journal is created.

Additionally, the post failure path includes automatic reversal: if the GL journal is created but the invoice status update fails, the journal is immediately reversed. This is robust.

### Supplier invoice creation (`POST /invoices`) — VERIFIED ✅

The supplier duplicate invoice guard (`DUPLICATE_INVOICE` errorCode) prevents the same supplier + invoice number from being created twice. This is a document-level guard, not a GL-level guard, but it achieves the same practical result for supplier invoices (which post immediately on creation).

The failure recovery (journal reversal + invoice cancellation on `journal_id` link failure) is also correctly implemented.

### Supplier invoice update (`PUT /invoices/:id`) — GL correction — VERIFIED ✅

The GL correction sequence (reverse original → post replacement) has careful error handling:
- If replacement fails: original is untouched, throw error
- If original reversal fails after replacement: attempt cleanup reversal of replacement, throw error
- If cleanup also fails: logs CRITICAL, surfaces error to caller with journal ID for manual investigation

This is a well-implemented safe-failure pattern.

---

## 10. Confirmed Risks

| ID | Severity | Description | Affected File |
|---|---|---|---|
| **AUTH-01a** | CRITICAL | `customer-invoices.js` has zero `hasPermission()` coverage on all 9 routes | `customer-invoices.js` |
| **AUTH-01b** | CRITICAL | No AR permissions exist in the PERMISSIONS map | `middleware/auth.js` |
| **AUTH-01c** | HIGH | `POST /suppliers/payments` (GL-posting route) has no permission check | `suppliers.js` |
| **AUTH-01d** | HIGH | `PUT /suppliers/invoices/:id` (may trigger GL correction) has no permission check | `suppliers.js` |
| **AUTH-01e** | MEDIUM | `POST /suppliers/orders`, `PUT /suppliers/orders/:id/status`, `POST /suppliers/`, `PUT /suppliers/:id` have no permission check | `suppliers.js` |
| **AUTH-01f** | LOW | Read-only routes (`GET /`) in both files have no permission check | both |
| **AC-04a** | MEDIUM | Customer invoice creation: header-only orphan possible if lines insert fails | `customer-invoices.js` |
| **AC-04b** | MEDIUM | Customer invoice update: zero-line invoice possible if line re-insert fails after delete | `customer-invoices.js` |
| **AC-04c** | MEDIUM | Supplier invoice creation: header-only orphan possible if lines insert fails | `suppliers.js` |
| **AC-04d** | LOW | Supplier invoice update: zero-line invoice possible if line re-insert fails after delete | `suppliers.js` |
| **SCOPE-01** | LOW | No centralised `enforceCompanyScope` middleware — cross-company isolation depends entirely on consistent manual query filtering | both |

---

## 11. Recommended Workstreams

### Workstream 1 — Add AR permissions to PERMISSIONS map (low risk, prerequisite)

File: `middleware/auth.js`

Add to the PERMISSIONS object:
```javascript
'ar.view':    ['admin', 'accountant', 'bookkeeper', 'viewer'],
'ar.create':  ['admin', 'accountant', 'bookkeeper'],
'ar.post':    ['admin', 'accountant'],
'ar.payment': ['admin', 'accountant', 'bookkeeper'],
```

This is purely additive. Existing permissions are not changed. `validatePermissionMap()` will validate the new entries on next startup.

### Workstream 2 — Wire hasPermission() into AR routes (medium risk)

File: `customer-invoices.js`

Import at top:
```javascript
const { hasPermission } = require('../middleware/auth');
```

Apply per route:
```javascript
router.get('/customers',   hasPermission('ar.view'),    ...)
router.get('/',            hasPermission('ar.view'),    ...)
router.get('/aging',       hasPermission('ar.view'),    ...)
router.get('/:id',         hasPermission('ar.view'),    ...)
router.post('/',           hasPermission('ar.create'),  ...)
router.put('/:id',         hasPermission('ar.create'),  ...)
router.post('/:id/post',   hasPermission('ar.post'),    ...)
router.post('/:id/void',   hasPermission('ar.post'),    ...)
router.post('/payments',   hasPermission('ar.payment'), ...)
```

**Regression test required:** Confirm accountant and admin roles can access all routes. Confirm viewer cannot POST. Confirm bookkeeper can create but cannot post/void.

### Workstream 3 — Wire hasPermission() into remaining AP routes (low risk)

File: `suppliers.js`

Apply `hasPermission('ap.manage')` to:
- `GET /stats`
- `GET /` (supplier list)
- `POST /` (create supplier)
- `GET /invoices`
- `GET /invoices/:id`
- `PUT /invoices/:id`
- `GET /orders`
- `POST /orders`
- `GET /orders/:id`
- `PUT /orders/:id/status`
- `GET /payments`
- `POST /payments`  ← highest priority
- `GET /aging`
- `GET /:id`
- `PUT /:id`

Already protected — leave unchanged:
- `POST /invoices` — `ap.manage` ✅
- `POST /invoices/ocr` — `ap.manage` ✅

**`ap.manage` is already defined as `['admin', 'accountant', 'bookkeeper']`. Viewer role will be blocked from all AP routes after this change.** Confirm this is the intended policy with Ruan before implementing (see Section 12).

### Workstream 4 — Fix invoice creation atomicity (AC-04) (higher risk, requires careful implementation)

**Recommended approach:** Add a cleanup step in the `catch` block of invoice creation routes. If lines insert fails, delete the orphan header before returning the error.

For customer invoice creation:
```javascript
const { error: linesErr } = await supabase.from('customer_invoice_lines').insert(lineInserts);
if (linesErr) {
  // Cleanup: delete orphan header to preserve atomicity
  await supabase.from('customer_invoices').delete().eq('id', invoice.id);
  throw new Error(linesErr.message);
}
```

For supplier invoice creation:
```javascript
const { error: linesErr } = await supabase.from('supplier_invoice_lines').insert(lineInserts);
if (linesErr) {
  await supabase.from('supplier_invoices').delete().eq('id', invoice.id);
  throw new Error(linesErr.message);
}
```

**Alternative (preferred for full correctness):** Migrate to Supabase RPC functions that execute both inserts inside a Postgres transaction. This is the correct long-term solution but requires DB migration work.

**Note on invoice update routes:** For update routes (delete lines + re-insert), the safest fix is to re-insert first, then delete old lines if re-insert succeeds. This is a more significant refactor and should be scheduled as a separate workstream.

### Workstream 5 — Centralise company scope enforcement (low priority)

Add `router.use(enforceCompanyScope)` at the top of both route files, after the authenticate middleware. This adds a redundant safety net alongside the existing manual query filtering. Not urgent, but reduces future regression risk.

---

## 12. Questions For Ruan Before Code Changes

1. **Viewer role on AR read routes:** Should `viewer` role be able to see the customer invoice list, invoice detail, and aged debtors report? The proposed `ar.view` permission includes viewer. Confirm this is correct.

2. **Bookkeeper creating AR invoices:** Should `bookkeeper` be allowed to create and edit draft customer invoices? The proposed `ar.create` includes bookkeeper. Confirm.

3. **Bookkeeper posting AR invoices:** Should `bookkeeper` be blocked from posting customer invoices to the GL and voiding them? The proposed `ar.post` restricts this to admin+accountant. Confirm.

4. **Viewer role on AP routes:** Currently, `ap.manage` is `['admin', 'accountant', 'bookkeeper']`. Adding `ap.manage` to the remaining AP read routes means **viewers cannot see the supplier list, AP invoices, or aged payables report**. Is this intended? If viewers should be able to read AP data, either a new `ap.view` permission is needed, or `ap.manage` should be split.

5. **Timing of Workstream 3 (AP read routes):** The read-only AP routes have no permission guard today. Blocking them for viewers would be a change in functional access that users might notice. Confirm this is acceptable before pilot.

6. **Atomicity priority:** Is AC-04 a blocker for pilot, or acceptable as a known risk with cleanup handled manually? The orphan invoice risk is low-frequency but real. Recommend confirming whether a quick catch-block cleanup (Workstream 4) should be done before pilot or deferred.

7. **AR permissions naming:** Are the proposed names (`ar.view`, `ar.create`, `ar.post`, `ar.payment`) acceptable, or should they follow a different convention?
