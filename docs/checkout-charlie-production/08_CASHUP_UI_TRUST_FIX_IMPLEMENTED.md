# 08 — CASHUP UI TRUST FIX IMPLEMENTED
## Checkout Charlie — Workstream 2B

**Date:** 2026-05-12  
**Scope:** Cashier-facing cash-up display only — no backend calculation changes, no report rewrites, no cash-up flow redesign.  
**Status:** ✅ Implemented

---

## Problem Statement

Before this fix, the cash-up screen in `frontend-pos/index.html` computed and displayed figures that came from two untrustworthy sources:

1. **`till_sessions.expected_balance`** — calculated as `opening + all completed sales`, regardless of payment method. A session with R10,000 card sales and R500 cash produced `expected_balance = opening + R10,500`. The physical till drawer only ever held R500 in new cash. The cashier could never reconcile to that figure.

2. **`sales.payment_method`** — used for payment breakdown display. For split-payment sales this field records only the primary method; secondary splits were invisible.

Additionally, `completeCashUp()` had a pre-existing bug that silently swallowed success: the `/close` endpoint returns `{ session }` but the success check was `if (result.success)` — always `undefined`. Success notification never showed, `currentSessionData` was never cleared, `showTab('till')` never fired.

---

## What Was Changed

### File: `accounting-ecosystem/frontend-pos/index.html`

#### Change 1 — HTML: EFT row added to payment breakdown

Added `id="eftSales"` row to the `cashUpPaymentBreakdown` section. Previously EFT was missing from the display entirely.

Added `id="cashRefundsRow"` (hidden by default with `display: none`) for cash refunds. Only made visible when `refunds.cash > 0` — avoids showing a red row for sessions with no refunds.

#### Change 2 — HTML: Expected Cash subtitle corrected

Changed subtitle from `"Opening + Sales"` to `"Opening + Cash sales − Cash refunds"` — accurately describes the forensic formula now used.

#### Change 3 — JS: `loadCashUpSession()` replaced

The new `loadCashUpSession()`:

1. Fetches `/pos/sessions/current` for session header data (unchanged)
2. Fetches `/pos/sessions/:id/reconciliation` — the authoritative backend reconciliation endpoint built in Workstream 2A
3. Populates the display from `recon.cash_reconciliation.expected_cash_in_drawer` (not `expected_balance`)
4. Populates payment breakdown from `recon.payments` (sourced from `sale_payments` table — authoritative for split payments)
5. Shows refunds row from `recon.refunds.cash` when > 0
6. Stores `expected_cash_in_drawer` in `_reconExpectedCash` (module-level) for `calculateCashTotal()` and `completeCashUp()` to read
7. Graceful fallback: if reconciliation endpoint is unavailable, falls back to showing opening balance only with `R 0.00` placeholders — never crashes the cash-up screen

```javascript
// Module-level — set by loadCashUpSession(), read by calculateCashTotal() / completeCashUp()
let _reconExpectedCash = 0;
```

#### Change 4 — JS: `completeCashUp()` fixed

Two fixes:

**Fix A — Pre-existing success-check bug:**
```javascript
// BEFORE (broken — /close returns { session }, not { success })
if (result.success) {

// AFTER (correct)
if (result.session) {
```

**Fix B — Add `/complete-cashup` call (fire-and-forget):**

After `/close` succeeds, a non-blocking fetch to `/pos/sessions/:id/complete-cashup` is initiated:

```javascript
fetch(`${API_URL}/pos/sessions/${currentSessionData.id}/complete-cashup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
        counted_cash: totalCounted,
        counted_card: 0,
        counted_other: 0,
        notes: notes
    })
}).catch(err => console.warn('[CashUp] complete-cashup snapshot call failed (non-blocking):', err.message));
```

This call:
- Transitions session status from `closed` → `cashed_up`
- Triggers `createReconSnapshot()` (fire-and-forget in the backend handler — see `sessions.js` line 277)
- Creates the immutable `pos_recon_snapshots` record with the correct `cash_variance`
- Is non-blocking: success notification fires immediately without waiting for snapshot creation
- If the call fails: session remains at `closed` (still a valid terminal state); console.warn is logged but the cashier's workflow is unaffected

**Why `counted_card: 0, counted_other: 0`:**

The denomination counter counts physical cash only (notes and coins). Card and EFT settlements happen through terminal reconciliation (a separate process outside the POS), so `counted_card = 0` and `counted_other = 0` is semantically correct — not a placeholder.

---

## Scenario Traces

### Scenario A — Cash-only session

| Step | What Happens |
|---|---|
| Cashier opens cash-up | `loadCashUpSession()` fires |
| `/sessions/current` | Returns session with `opening_balance = 500.00` |
| `/sessions/:id/reconciliation` | Returns `paymentCash = 1200.00`, `refundCash = 0`, `expectedCashInDrawer = 1700.00` |
| Display | Expected Cash = R 1700.00 / Cash = R 1200.00 / Card = R 0.00 / EFT = R 0.00 |
| Cashier counts R 1680.00 | `calculateCashTotal()` reads `expectedCashAmount` = 1700.00, variance = −20.00 → "Short: R20.00" |
| Confirms | `/close` called → `{ session }` → `result.session` truthy |
| `/complete-cashup` (fire-and-forget) | `counted_cash = 1680`, creates snapshot with `cash_variance = −20.00` |
| UI | "Till session closed successfully" / navigate to till tab |

### Scenario B — Card-only session

| Step | What Happens |
|---|---|
| `/sessions/:id/reconciliation` | Returns `paymentCash = 0`, `paymentCard = 3500.00`, `expectedCashInDrawer = 500.00` (opening only) |
| Display | Expected Cash = R 500.00 / Cash = R 0.00 / Card = R 3500.00 |
| Cashier counts float R 500.00 | Variance = 0.00 → "Balanced: R0.00" |
| `/complete-cashup` snapshot | `cash_variance = 0.00` — correct, only physical cash was in the till |

**Key point:** Under the old formula `expected_balance = 500 + 3500 = 4000.00`. The cashier could never reconcile to R4,000 because R3,500 was settled through the card terminal. The new formula shows R500.00 — the correct physical till expectation.

### Scenario C — Mixed cash/card/EFT session

| Step | What Happens |
|---|---|
| Session | Opening R 200 / Cash sales R 800 / Card sales R 1500 / EFT sales R 600 |
| `/sessions/:id/reconciliation` | `expectedCashInDrawer = 200 + 800 = 1000.00` |
| Display | Expected Cash = R 1000.00 / Cash = R 800.00 / Card = R 1500.00 / EFT = R 600.00 |
| Cashier counts | Only the physical till; card and EFT not counted here |
| Snapshot | `cash_variance = counted − 1000.00` (not counted − 2300.00) |

### Scenario D — Cash refund session

| Step | What Happens |
|---|---|
| Session | Opening R 500 / Cash sales R 1000 / Cash refund R 150 |
| `/sessions/:id/reconciliation` | `expectedCashInDrawer = 500 + 1000 − 150 = 1350.00` |
| Display | Expected Cash = R 1350.00 / Cash = R 1000.00 / Cash Refunds row visible: −R 150.00 |
| Cashier counts | R 1350.00 exactly → Balanced |

**Key point:** Refunds are subtracted from expected physical cash because cash was physically returned to the customer from the drawer.

### Scenario E — Reconciliation endpoint unavailable (fallback)

| Step | What Happens |
|---|---|
| `/sessions/:id/reconciliation` returns non-OK | `recon = null` |
| Fallback path | `_reconExpectedCash = opening_balance`, all payment rows = R 0.00, refunds row hidden |
| Warning in console | `[CashUp] Reconciliation fetch failed — falling back to session data: <message>` |
| Cash-up remains operable | Cashier can still count and submit — at worst, variance is calculated against opening balance only |
| `/complete-cashup` still fires | Snapshot is created with whatever the cashier counted |

### Scenario F — `completeCashUp()` success path (pre-existing bug fixed)

| Before fix | After fix |
|---|---|
| `/close` returns `{ session: {...} }` | Same |
| `if (result.success)` → `undefined` → falsy | `if (result.session)` → `{...}` → truthy |
| Success notification: NEVER fired | Success notification: fires correctly |
| `currentSessionData`: NOT cleared | Cleared → next page load has no stale session |
| `showTab('till')`: NEVER called | Called → cashier returned to till tab |

---

## What Was NOT Changed

- `/pos/sessions/:id/close` backend route — untouched
- `/pos/sessions/:id/complete-cashup` backend route — untouched (already correct from Workstream 2A)
- `posReconService.js` — untouched
- `pos_recon_snapshots` migration — untouched
- All existing cash-up HTML form structure (denominations, notes field, buttons) — untouched
- All existing report pages — untouched
- `calculateCashTotal()` logic — untouched (reads `expectedCashAmount` from DOM, which is now set correctly by `loadCashUpSession()`)
- Legacy `till_sessions.variance` field — still calculated and stored by `/close` against `expected_balance` (legacy formula). The forensically correct variance lives in `pos_recon_snapshots.cash_variance`.

---

## Data Flow (After Fix)

```
Cashier opens cash-up tab
        │
        ▼
loadCashUpSession()
   ├─ GET /sessions/current          → session header display
   └─ GET /sessions/:id/reconciliation
           ├─ computeSessionRecon()  → queries sales, sale_payments, pos_returns
           ├─ expected_cash_in_drawer = opening + payment_cash − refund_cash
           ├─ payment breakdown per method (from sale_payments, not sales.payment_method)
           └─ _reconExpectedCash = expected_cash_in_drawer   [stored for variance calc]

Cashier enters denomination counts
        │
        ▼
calculateCashTotal()
   ├─ sums denominations → totalCounted
   └─ variance = totalCounted − expectedCashAmount (DOM ← _reconExpectedCash)

Cashier confirms
        │
        ▼
completeCashUp()
   ├─ POST /sessions/:id/close
   │       └─ Sets status=closed, closing_balance=totalCounted, legacy expected_balance, closed_at
   │          Returns { session }
   │
   └─ if (result.session):
           ├─ fetch /sessions/:id/complete-cashup  [fire-and-forget]
           │       ├─ Sets status=cashed_up
           │       └─ createReconSnapshot() [fire-and-forget in handler]
           │               └─ Inserts to pos_recon_snapshots (append-only)
           │                       cash_variance = totalCounted − expected_cash_in_drawer
           │
           ├─ showNotification('Till session closed successfully', 'success')
           ├─ currentSessionData = null
           └─ showTab('till')
```

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Till reconciliation variance — dual-field situation
- What was done: pos_recon_snapshots.cash_variance = correct formula (opening + cash_sales − cash_refunds)
                 till_sessions.variance = legacy formula (opening + all_sales)
- Not yet confirmed: Whether management reports currently display till_sessions.variance to managers.
                     If so, managers see the legacy (structurally wrong) figure, not the correct one.
- Risk if not checked: Managers may act on misleading variance figures in historical reports.
- Recommended next review point: Workstream 3 — review management-facing reconciliation report to
                                  surface pos_recon_snapshots.cash_variance instead of till_sessions.variance.
```

```
FOLLOW-UP NOTE
- Area: counted_card = 0 in complete-cashup payload
- What was done: Denomination counter counts physical cash only; counted_card hardcoded to 0.
- Not yet confirmed: Whether the business wants a separate card terminal reconciliation step
                     where the cashier enters the card machine batch total for cross-checking.
- Risk if not checked: Card terminal totals are not verified at the POS level — a discrepancy
                       between POS card total and terminal batch total would go undetected.
- Recommended next review point: Future workstream — card terminal reconciliation step.
```

---

## Verification Checklist

- [x] `loadCashUpSession()` calls reconciliation API before displaying expected cash
- [x] `_reconExpectedCash` set from `cr.expected_cash_in_drawer`
- [x] EFT row displayed from `recon.payments.eft`
- [x] Cash refunds row shown only when `refunds.cash > 0`
- [x] Fallback path works when reconciliation endpoint unavailable
- [x] `completeCashUp()` checks `result.session` (not `result.success`)
- [x] `completeCashUp()` fires `/complete-cashup` after `/close` succeeds
- [x] `/complete-cashup` call is fire-and-forget — does not block success notification
- [x] `counted_card: 0, counted_other: 0` — semantically correct for denomination-only count
- [x] No `localStorage` or `sessionStorage` used for any business data
- [x] No existing cash-up HTML structure changed
- [x] No report pages touched
- [x] No backend calculation changes
