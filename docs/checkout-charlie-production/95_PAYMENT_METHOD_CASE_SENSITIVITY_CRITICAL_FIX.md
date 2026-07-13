# Workstream 95 — Payment Method Case-Sensitivity Critical Fix

## How This Was Found

Found incidentally while building the customer "Order" (pay-later pickup) feature (Workstream 96), not while looking for it — worth recording clearly since it is more serious than the feature it was found alongside.

While designing the Order-creation endpoint's payment-method handling, a close re-read of `frontend-pos/index.html`'s real checkout button wiring (`selectPayment('CASH'|'CARD'|'ACCOUNT'|'EFT'|'SNAPSCAN'|'ZAPPER', ...)`, all called with **uppercase** literals from the payment-method button `onclick` handlers) was compared against every place `backend/modules/pos/routes/sales.js` and `backend/modules/pos/routes/reports.js` decide whether a sale is account-funded:

```js
// sales.js — the account-charge trigger, checked in four places
.filter(p => p.payment_method === 'account')

// reports.js — the report-filtering constant
const ACCOUNT_PAYMENT_METHOD = 'account';
```

`'ACCOUNT' === 'account'` is `false` in JavaScript. The real checkout button (`onclick="checkout()"` at line ~2012) sends `paymentMethod: selectedPayment` with no `payments` array, so `payment_method` flows through `normaliseSaleBody()` unchanged and lands in the single-payment fallback as `{ payment_method: 'ACCOUNT', ... }` — uppercase, never matching the lowercase check.

## Why This Matters More Than It First Appears

Workstreams 90, 91, and 93 this session proved — and fixed — real gaps in account-sale ledger posting, void reversal, and partial-return reversal. All three were live-verified as correct **by calling the API directly with lowercase `'account'`**, exactly matching what a hand-written test script would naturally send. None of those tests went through the actual browser checkout screen.

This means: every one of those fixes is correct, but a **real cashier selecting "Account" in the actual POS screen has never triggered any of them** — not the original charge-posting bug WS90 fixed, not WS91's void reversal, not WS93's return reversal — because the request never contained the lowercase string those fixes all check for. The gap was upstream of all three previous workstreams, in the one place they all share: how the browser's chosen payment method string reaches the backend.

## The Fix

`normaliseSaleBody()` in `sales.js` is the single choke point both the regular sale-creation route (`POST /`) and the new order-creation route (`POST /orders`, Workstream 96) parse their request body through. Fixed there, once, rather than touching the frontend's button labels (which are just display text) or duplicating a fix in every route:

```js
const rawMethod = body.payment_method ?? body.paymentMethod ?? 'cash';
const rawPayments = body.payments ?? null;
// ...
payment_method: typeof rawMethod === 'string' ? rawMethod.toLowerCase() : rawMethod,
payments: Array.isArray(rawPayments)
  ? rawPayments.map(p => ({
      ...p,
      payment_method: typeof (p.payment_method ?? p.method) === 'string'
        ? (p.payment_method ?? p.method).toLowerCase()
        : (p.payment_method ?? p.method),
    }))
  : rawPayments,
```

Client-supplied casing is never trusted past this one point. Confirmed via a repo-wide search that nothing in the backend compares `payment_method` against an uppercase literal — the lowercase convention (`ACCOUNT_PAYMENT_METHOD = 'account'` in reports.js, every check in sales.js) is the system's actual canonical standard; the frontend was the outlier.

## Live Verification

Ran the exact payload shape the real browser's `checkout()` function builds — `paymentMethod: 'ACCOUNT'` (uppercase), `customerId` set, no `payments` array — against the live local server connected to production Supabase:

| Step | Result |
|---|---|
| Customer balance before | R500 (carried from a prior, unrelated test) |
| Sale created with `paymentMethod: 'ACCOUNT'` | 201, `sale.payment_method` stored as `"account"` |
| Customer balance after | R1000 — **charge posted correctly** (was previously silently skipped before this fix) |
| Cleanup: void the test sale | Balance correctly reversed back to R500 |

Also confirmed via repo-wide grep: no other backend code path compares `payment_method` against an uppercase literal, so lowercasing at the boundary introduces no regression — it only fixes the one place that was already broken.

## Scope Note

Historical sales rows already stored with uppercase `payment_method` values are untouched — this fix does not rewrite history, only ensures every sale created from now on stores and is evaluated consistently. Any historical reporting that needs to account for pre-fix uppercase rows (if that data matters for a specific report) is a separate, narrower concern not addressed here — flagged as a follow-up if it becomes relevant.

## Follow-Up Note

```
FOLLOW-UP NOTE
- Area: Historical sales/sale_payments rows with uppercase payment_method values
- Dependency: Any report or query that filters payment_method with an exact
  lowercase match will not match old uppercase rows
- Confirmed now: No current report code was found doing this filtering in a
  way that silently produces wrong (as opposed to incomplete) results for
  old data — reports read from sale_payments/customer_account_transactions
  ledger data, not from filtering the sales.payment_method column directly,
  for the account-vs-cash split
- Not yet confirmed: Whether any dashboard/export outside this session's
  visibility filters on sales.payment_method with a case-sensitive match
- Risk if wrong: A report undercounting historical account sales
- Recommended next check: If a customer ever reports a mismatched historical
  total, check for exactly this case-sensitivity pattern first
```
