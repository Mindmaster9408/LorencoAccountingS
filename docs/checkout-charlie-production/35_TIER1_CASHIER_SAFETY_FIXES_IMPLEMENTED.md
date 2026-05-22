# 35 — TIER 1 CASHIER SAFETY + PILOT UX FIXES IMPLEMENTED
## Checkout Charlie — Workstream 10B

**Date:** 2026-05-22
**Status:** ✅ Implemented — pilot-ready
**Scope:** 4 Tier 1 pilot-blocking UX/safety fixes from Workstream 10A audit
**File changed:** `accounting-ecosystem/frontend-pos/index.html` only — backend unchanged

---

## What Was Fixed

### Fix 1 — Checkout Loading / Lock State

**Audit finding:** F4 (HIGH) — No loading state on checkout button. Double-tap or double-click during network latency silently creates duplicate API calls → duplicate sales.

**Root cause:** `checkout()` had no re-entry guard. The button was only re-disabled inside the cart-clear path, not at function entry. A second call initiated before the first `await` resolved would proceed to `POST /api/pos/sales` independently.

**Fix — module-level re-entry flag + try/finally button lock:**

New global variable added alongside `autoPrintEnabled`:
```javascript
let checkoutInProgress = false;  // prevents duplicate checkout execution while a request is in-flight
```

`checkout()` now opens with an immediate gate:
```javascript
async function checkout() {
    if (checkoutInProgress) return;
    // ... forceUpdatePending and cart checks (non-blocking fast paths) ...

    checkoutInProgress = true;
    const btn = document.getElementById('checkoutBtn');
    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
        // ... all checkout logic unchanged ...
    } finally {
        checkoutInProgress = false;
        btn.textContent = 'Complete Sale';
        btn.disabled = cart.length === 0 || !currentSession;
    }
}
```

**All exit paths correctly handled:**

| Path | Cart cleared? | `finally` result |
|---|---|---|
| Online success | ✅ Yes — `updateCart()` sets `disabled = true` | Consistent — `finally` also sets `disabled = true` |
| Offline save success | ✅ Yes — same `cart = []; updateCart()` | Consistent |
| Online API error | ❌ No — cart preserved for retry | Re-enabled for next attempt |
| Offline save failure | ❌ No | Re-enabled for next attempt |
| `forceUpdatePending` block | N/A — fires BEFORE lock set, early return | No `finally` needed |

**Cashier experience:** Button immediately reads "Processing..." on first tap. Any subsequent taps do nothing. After the response — success or failure — button is restored in under 100ms via `finally`.

**Split payment note:** `checkoutWithFeatures()` is currently dead code (defined but not called from any button — confirmed by grep). The lock was applied to `checkout()` which is the active call path. When `checkoutWithFeatures()` is wired, the same `checkoutInProgress` flag will apply since both functions share the same module scope.

---

### Fix 2 — Cash Drawer Trigger Logic

**Audit finding:** H1 (HIGH) — Cash drawer opens unconditionally on every sale, including card-only and EFT-only sales. Unnecessary drawer opens during peak hours create noise, distraction, and drawer wear.

**Root cause:** `printReceipt(saleId)` always sent `open_drawer: true` to the print agent. The `open_drawer_on_sale` company setting existed in the DB and the settings UI had the `settingsOpenDrawer` checkbox — but no runtime JS variable tracked it. It was never read from settings into a usable flag.

**Fix — two-part:**

**Part A — `printReceipt()` signature changed to accept options:**
```javascript
// Before:
async function printReceipt(saleId) {
    // ...
    body: JSON.stringify({ open_drawer: true })

// After:
async function printReceipt(saleId, opts = {}) {
    // ...
    body: JSON.stringify({ open_drawer: opts.openDrawer ?? false })
```

Default is now `false`. All existing call sites that do not pass `opts` (reprints from sale history, manual print from sale-complete modal, `printLastReceipt()`) default to **not** opening the drawer — correct behaviour for reprints.

**Part B — Runtime flag + conditional open at checkout:**

New global:
```javascript
let openDrawerOnSale = true;  // loaded from settings; default true preserves existing behaviour
```

Read in `loadCompanySettings()` (the initial page-load settings fetch):
```javascript
openDrawerOnSale = d.settings?.open_drawer_on_sale !== 0;
```
`undefined !== 0` evaluates to `true` — correct backward-compatible default when field is absent.

Synced in `loadGeneralSettings()` (settings panel load) and `saveGeneralSettings()` (settings panel save):
```javascript
openDrawerOnSale = settings.open_drawer_on_sale !== 0;  // on load
openDrawerOnSale = document.getElementById('settingsOpenDrawer').checked;  // on save
```

At checkout time, the auto-print call now conditionally opens the drawer:
```javascript
if (autoPrintEnabled && lastSaleId) {
    printReceipt(lastSaleId, { openDrawer: openDrawerOnSale && selectedPayment === 'CASH' });
}
```

**Drawer open decision matrix:**

| `openDrawerOnSale` | `selectedPayment` | Drawer opens? |
|---|---|---|
| `true` | `'CASH'` | ✅ Yes |
| `true` | `'CARD'` | ❌ No |
| `true` | `'EFT'` | ❌ No |
| `false` | `'CASH'` | ❌ No (company has disabled drawer) |
| `false` | Any | ❌ No |
| Any | Manual reprint | ❌ No (no `opts` passed) |

**Split payment future note:** When `checkoutWithFeatures()` is wired for split payments, the drawer condition will need `payments.some(p => p.method === 'CASH' && p.amount > 0)` to cover mixed-payment scenarios. The `openDrawerOnSale` flag is already in place — only the payment-method check needs updating at that time.

---

### Fix 3 — Blocking `alert()` Removal

**Audit finding:** L1 (HIGH) — `window.alert()` blocks the JavaScript event loop. Mid-transaction alerts freeze the UI, stall network activity, and require explicit cashier dismissal before any other code can run.

**Root cause:** 12 `alert()` calls in `index.html` across login errors, company selection errors, unimplemented sections, and registration flow.

**Fix — all 12 calls replaced with `showNotification()`:**

| Location | Old `alert()` | New `showNotification()` |
|---|---|---|
| Login — no companies | `alert(result.error \|\| 'No companies available')` | `showNotification(..., 'error')` |
| Login — auth failure | `alert(result.error)` | `showNotification(result.error \|\| 'Login failed', 'error')` |
| Login — network error | `alert('Login failed: ' + error.message)` | `showNotification('Login failed: ' + error.message, 'error')` |
| Company select — suspended | `alert('Company Suspended\\n\\n...')` | `showNotification('Company suspended — contact support to reactivate.', 'error')` |
| Company select — pending | `alert('Pending Approval\\n\\n...')` | `showNotification('Registration pending — waiting for administrator approval.', 'warning')` |
| Company select — API error | `alert(result.error \|\| 'Failed to select company')` | `showNotification(..., 'error')` |
| Company select — network error | `alert('Error selecting company: ' + error.message)` | `showNotification(..., 'error')` |
| `showTab()` — unimplemented tab | `alert(\`${tab}... To be implemented\`)` | `showNotification(\`${tab} tab coming soon\`, 'info')` |
| `showSettings()` — unimplemented section | `alert(\`${section} section - To be implemented\`)` | `showNotification(\`${section} coming soon\`, 'info')` |
| `exportProducts()` | `alert('Export Products - To be implemented')` | `showNotification('Export Products — coming soon', 'info')` |
| `importProducts()` | `alert('Import Products - To be implemented')` | `showNotification('Import Products — coming soon', 'info')` |
| Registration — success | `alert('Registration successful!\\n\\n...')` | `showNotification('Registration successful — your account is pending approval.', 'success')` |

**Verified:** Grep for `alert(` in `index.html` returns 0 matches.

---

### Fix 4 — Notification Readability + Severity-Based Timing

**Audit finding:** V1 + L2 (HIGH) — Uniform 3-second timeout for all notification types. Errors during peak operations dismissed before cashiers read them. Timer stacking caused rapid second notifications to be prematurely dismissed by the first notification's timer.

**Root cause:** Original `showNotification()` used a fixed `setTimeout(..., 3000)` with no type differentiation and no guard against rapid sequential notifications.

**Fix — severity-based durations + stacking guard:**

```javascript
function showNotification(message, type) {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = `notification ${type}`;
    notification.style.display = 'block';

    // Severity-based display duration. Errors stay visible long enough to read
    // under cashier stress; success messages clear quickly to avoid clutter.
    const durations = { success: 3000, info: 4000, warning: 5000, error: 7000 };
    const ms = durations[type] || 4000;

    // Cancel any pending hide timer so a rapid second notification is not
    // dismissed early by the first notification's timer.
    clearTimeout(notification._hideTimer);
    notification._hideTimer = setTimeout(() => {
        notification.style.display = 'none';
    }, ms);
}
```

**Duration rationale:**

| Type | Duration | Rationale |
|---|---|---|
| `success` | 3s | Cart cleared, flow continues — cashier is already scanning next item |
| `info` | 4s | Informational — no urgency, but needs a read |
| `warning` | 5s | Action may be required — needs full read before cashier proceeds |
| `error` | 7s | Under queue pressure, cashier may not see first frame — must persist |

**Stacking guard:** `notification._hideTimer` is stored directly on the DOM element. `clearTimeout()` before each new `setTimeout()` means: if notification B fires 500ms after notification A, A's 3s timer is cancelled before B's timer starts. B will dismiss itself at B's correct time, not at A's time minus 500ms.

---

## Files Changed

| File | Changes |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | All 4 Tier 1 fixes — see sections above |

No backend files changed. No migration required. No new dependencies.

---

## What Was NOT Changed

| Area | Reason |
|---|---|
| `POST /api/pos/sales` | Backend checkout logic unchanged — lock is client-side only |
| `POST /api/pos/print/receipt` | Print endpoint unchanged — `open_drawer` flag was already supported |
| Cart management, session handling, offline queue | Not touched |
| `create_sale_atomic` RPC | Not touched |
| Reconciliation, reporting, inventory management | Not touched |
| `checkoutWithFeatures()` | Dead code — not wired to any button. Lock and drawer flags are in place for when it is wired |
| Notification CSS styles | Not changed — existing `.success`, `.error`, `.warning`, `.info` classes still apply |
| Any other HTML frontend | Not touched |

---

## Test Criteria

| # | Test | Expected Result |
|---|---|---|
| T1 | Double-tap checkout button during slow network | Second tap does nothing. One sale created. |
| T2 | Checkout button text during processing | Shows "Processing..." immediately on tap |
| T3 | Checkout unlocks after online success | Button re-disabled (cart is now empty) |
| T4 | Checkout unlocks after API error | Button re-enabled with "Complete Sale" text — cashier can retry |
| T5 | Checkout unlocks after offline save | Button re-disabled (cart cleared) |
| T6 | Cash payment → auto-print enabled | Drawer opens |
| T7 | Card payment → auto-print enabled | Drawer does NOT open |
| T8 | EFT payment → auto-print enabled | Drawer does NOT open |
| T9 | Manual reprint from sale complete modal | Drawer does NOT open |
| T10 | `open_drawer_on_sale = false` in settings → cash payment | Drawer does NOT open |
| T11 | Login error | Non-blocking notification appears; no dialog box |
| T12 | Company suspended | Warning notification appears; page remains interactive |
| T13 | Click unimplemented tab | Info notification; no dialog box |
| T14 | Error notification timing | Stays visible ~7s |
| T15 | Success notification timing | Clears after ~3s |
| T16 | Rapid back-to-back notifications | Second notification shows correctly; not prematurely dismissed |
| T17 | No `alert()` calls remain | `grep -n "alert(" index.html` returns 0 results — confirmed |
| T18 | No business data in localStorage/sessionStorage | DevTools → Application → Storage: only `token` and `isSuperAdmin` |

---

## Remaining Tier 2+ UX Items (Tracked, Not Implemented)

These were identified in Workstream 10A as non-blocking for pilot. Not addressed in this workstream.

| ID | Finding | Tier | Notes |
|---|---|---|---|
| F1 | Minus at qty 1 silently removes item | 2 | Add confirmation or hard stop at qty 1 |
| H2 | `window.open()` receipt blocked by popup blockers | 2 | Browser print API is a Tier 2 item |
| V2 | No sale total displayed mid-cart | 2 | Running total visibility improvement |
| V3 | No item count badge on cart | 3 | Visual polish |
| F2 | No barcode scan feedback | 2 | Scan confirmation (beep or flash) |
| F3 | Search field not auto-focused after sale | 2 | Post-checkout UX reset |
| M1 | No force-close session in recovery panel (RISK-12) | 2 | Manager operational gap |
| M2 | Recovery panel no visible session age indicator | 3 | Operational visibility |
| L3 | Long shift UI fatigue — no break reminders | 4 | Post-pilot consideration |
| F5 | `checkoutWithFeatures()` not wired | 2 | Split payment UI not accessible via any button |

---

## Architecture Boundaries Preserved

- No business data written to `localStorage`, `sessionStorage`, or `indexedDB`
- All checkout, print, and session logic remains server-authoritative
- Offline queue behaviour unchanged
- Audit trail integrity unchanged — no audit events modified
- Company isolation preserved — no new cross-company reads
- Paytime module not touched (no auto-trigger files modified)
- Zeabur deployment rules not affected (frontend-only change)

---

## Workstream 10B Pilot-Safe Verdict

**Checkout lock:** ✅ Duplicate sale prevention active  
**Drawer control:** ✅ Cash-conditional; card/EFT sales do not open drawer  
**Alert removal:** ✅ All 12 `alert()` calls replaced; event loop no longer blocked  
**Notification timing:** ✅ Severity-based; errors visible 7s; stacking guard prevents premature dismissal  

**Workstream 10B is pilot-safe.**
