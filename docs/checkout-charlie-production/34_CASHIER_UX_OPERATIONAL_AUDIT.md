# 34 — CASHIER UX + OPERATIONAL POLISH AUDIT
## Checkout Charlie — Workstream 10A

**Date:** 2026-05-22
**Audited by:** Claude — Principal Engineer audit pass
**Status:** Audit complete — no code changes made
**Scope:** `accounting-ecosystem/frontend-pos/index.html` read in full (~9400 lines)

---

## Audit Framing

This audit examines Checkout Charlie as if cashiers use it 8–12 hours daily under real retail conditions: long queues, tired staff, unstable internet, active scanners, and physical printers. The question asked on every finding is not "is this correct?" but "what happens when a tired cashier makes this mistake at 4pm on a Saturday?"

Distinction maintained throughout:
- **OPERATIONAL**: Causes real friction, data risk, or workflow break during retail operation
- **COSMETIC**: Annoyance or inconsistency that does not affect operational flow

---

## AREA 1 — CHECKOUT FLOW FRICTION

### F1 — Minus button at qty 1 silently deletes item (OPERATIONAL — HIGH)

**Code:** `updateQty(productId, -1)` → `if (item.quantity <= 0) removeItem(productId)`

A cashier scanning a busy cart who taps minus one time too many on a 1-quantity item does not get a confirmation — the item is immediately deleted. With a barcode scanner and a queue behind them, a cashier will not notice the deletion until total mismatch. The item must be re-scanned from the product grid.

**Impact:** Silent cart corruption during high-volume operation. Customer may be undercharged.

---

### F2 — Remove item (✕ button) has zero friction (OPERATIONAL — MEDIUM)

**Code:** `removeItem(productId)` — no guard, no confirmation.

The ✕ button is rendered inline in `cart-item-header` directly next to the item name. On a touch device, a fat-finger scroll attempt on a list of cart items fires a remove. No undo, no confirmation.

**Impact:** Items silently removed mid-transaction. Customer may be undercharged.

---

### F3 — Clear cart uses blocking browser `confirm()` (COSMETIC + OPERATIONAL)

**Code:** `if (!confirm('Clear all items from cart?'))`

The `confirm()` call freezes the entire browser tab. This is inconsistent with the rest of the UI which uses `showNotification()`. On Chrome on Android, browser dialogs from `confirm()` are suppressed inside iframes and may not appear at all.

**Note:** The confirmation guard is correct behaviour. The implementation mechanism is wrong.

---

### F4 — Checkout button has no loading / in-flight state (OPERATIONAL — HIGH)

**Code:** `async function checkout()` — no button disable before `await fetch(...)`, no re-enable in finally block.

A cashier who taps "Checkout" and sees no immediate visual feedback will tap again. The idempotency key in the payload (`idempotencyKey: crypto.randomUUID()`) means correctness is protected — two taps generate two keys, and both requests may succeed, creating two sales. The second sale would have the same items but a different idempotency key.

**Impact:** Potential duplicate sale creation on slow network. The idempotency key does NOT protect across two separate taps because each tap generates a new UUID.

**Same issue in `checkoutWithFeatures()`** (split payment path) — no loading state guard there either.

---

### F5 — Sale complete modal presents 4 receipt options at peak queue moment (OPERATIONAL — MEDIUM)

**Code:** `showSaleCompleteModal()` — buttons for Print Receipt, Email Receipt, SMS Receipt, WhatsApp Receipt.

Every completed sale forces the cashier to make a decision: which receipt delivery method? Under queue pressure, this adds 1–3 seconds of decision fatigue per transaction. With 150 transactions/day that is 2.5–7.5 minutes of dead time in receipt selection alone.

**What works well:** `autoPrintEnabled` flag exists. If configured, auto-print eliminates this for the most common case. The flag needs to be user-configurable and persisted per till.

---

### F6 — Split payment requires manual amount entry with no calculator assist (OPERATIONAL — MEDIUM)

**Code:** `updateSplitRemaining()` — displays remainder in real-time as cashier types.

The cashier must type the exact rand amount for each payment method. No "pay rest in cash" button. No automatic allocation of remainder. For a R287.50 split between cash and card, the cashier must type one amount, read the remainder, and type the second. Real-time remainder display is good, but allocation workflow is still slow.

---

### F7 — After every online checkout, `loadProducts()` and `rebuildBarcodeMap()` run unconditionally (OPERATIONAL — LOW)

**Code:** After `checkout()` success: `await loadProducts(); closeSaleCompleteModal();`

`loadProducts()` fetches the full product list from the server, rebuilds the product grid DOM, and calls `rebuildBarcodeMap()`. For a large product catalogue this is a noticeable pause before the cashier can scan the next item. The barcode map rebuild is only necessary if stock quantities changed in a way that affects negative-stock gating. The product grid DOM rebuild is never necessary while the cashier is on the till tab.

---

### F8 — Return flow returns all items at full quantity — no partial return UI (OPERATIONAL — MEDIUM)

**Code:** `processReturn()` sends `selectedSale.items.map(item => ({ product_id, quantity: item.quantity }))`

If a customer bought 3 items and wants to return only one, the cashier has no UI to select which items to return or adjust quantities. The return API supports partial returns (the backend accepts an `items` array with any quantities), but the frontend always returns everything.

**Impact:** Operational gap — any partial return requires a manager workaround.

---

### F9 — Return reason hardcoded to `'Customer return'` (COSMETIC)

**Code:** `body: JSON.stringify({ items, reason: 'Customer return', ... })`

No reason selection at the POS. Every return in the audit trail says "Customer return" regardless of whether it was defective goods, wrong item, or buyer's remorse. Low operational value but worth fixing for audit quality.

---

## AREA 2 — ERROR PREVENTION

### E1 — No undo for any destructive cart action (OPERATIONAL — HIGH)

No undo for: item removal, quantity reduction to zero, clear cart. In all three cases the cart state is gone. The cashier must re-scan or re-add items from the product grid. Under queue pressure this creates significant re-work.

---

### E2 — `void Sale` button appears immediately in sale detail view for non-cashier roles (OPERATIONAL — MEDIUM)

**Code:** `viewSaleDetail()` renders inline:
```javascript
<button class="btn btn-danger" onclick="voidSale(${result.sale.id}); closeSaleDetail();">Void Sale</button>
```

The Void Sale button calls `voidSale()` and simultaneously closes the detail modal. If `voidSale()` requires confirmation (checked separately — it does: `if (!confirm('...'))`), the modal closes first but the confirm fires. On mobile this creates a confusing state where the modal closes but a blocking dialog appears. The action also executes `closeSaleDetail()` unconditionally before the void is confirmed — if the cashier cancels the confirm, the modal is already closed and the sale detail is lost.

---

### E3 — Recovery panel uses `prompt()` for abandon reason and add note (OPERATIONAL — MEDIUM)

**Code:** `promptAbandonItem()` calls `prompt(...)`, `promptAddNote()` calls `prompt(...)`

Browser `prompt()` is blocking and visually foreign. On mobile, it may suppress the POS UI. For manager workflows in the recovery panel, this is a significant UX regression — the rest of the recovery panel has styled form elements.

---

### E4 — Daily till reset uses blocking `confirm()` with multi-line message (OPERATIONAL — LOW)

**Code:** `if (!confirm('This will start a fresh day...\n\nThe current session will be marked as "pending cashup"...\n\nAll sales data will be preserved.\n\nContinue?'))`

Long multi-line confirm dialog. A tired manager pressing OK without reading is entirely plausible.

---

### E5 — `deleteCustomer()` uses `confirm()` (COSMETIC)

Low-risk (customers are not deleted during live checkout) but consistent with the pattern of using browser dialogs where the UI should use its own modal system.

---

### E6 — Stock take modal loads all products with no search or filter (OPERATIONAL — MEDIUM)

**Code:** `showStockTakeModal()` renders every product in `products[]` into the modal table.

For a business with 500+ products, the stock take modal is a scrolling list with no search, no category filter, no barcode scan input. A physical stock count requires moving through the store by category or location. This modal forces the operator to scroll through an alphabetical product dump.

---

## AREA 3 — CASHIER VISIBILITY

### V1 — Notification auto-hides in 3 seconds (OPERATIONAL — HIGH)

**Code:** `setTimeout(() => { notification.style.display = 'none'; }, 3000)`

3 seconds is not enough for a cashier looking at a customer while the notification appears. Critical errors — stock blocked, session error, network fail — vanish before being read. The notification also sits at the bottom of the viewport (based on CSS position: `fixed; bottom: 20px`). Under queue pressure, the cashier's eyes are on the customer, not the bottom of the screen.

---

### V2 — Checkout button gives no explanation when disabled (OPERATIONAL — MEDIUM)

**Code:** `document.getElementById('checkoutBtn').disabled = !currentSession`

When no session is open, the checkout button is disabled but shows no tooltip or message explaining why. A new cashier has no indication they need to open a session before selling.

---

### V3 — In-memory stock decrement can drift from DB during long sessions (OPERATIONAL — MEDIUM)

**Code:** After checkout, `products` array is updated in memory but not re-fetched from server unless `loadProducts()` runs (it does after each checkout). However, during multi-till operation with concurrent sales on other tills, the cashier's displayed stock quantities can drift from actual DB quantities between their own transactions.

**Current mitigation:** `loadProducts()` runs after every successful checkout. This is correct for the cashier's own sales. **Gap:** Another till's sales don't trigger a reload on this till.

**Acceptable for pilot** (single-tab per till, single till per location) but worth documenting.

---

### V4 — No persistent visual indicator of active till/session in till header (OPERATIONAL — LOW)

The session status shows in `document.getElementById('sessionStatus')` but the till name/number is not visibly displayed during active operation. On a multi-till floor, a cashier cannot confirm which till they're operating without navigating away from the till tab.

---

### V5 — `autoPrintEnabled` has no visible on/off control for cashier or manager (OPERATIONAL — LOW)

The flag exists in JS globals. Whether it's on or off is invisible to the cashier. There is no UI to toggle it. If the print server is down, there is no fallback behavior indicator — the cashier just sees no receipt printed.

---

### V6 — Offline banner is well-implemented (WHAT WORKS WELL)

The offline banner has distinct color states (green = online, yellow = reconnecting, red = offline, orange = sync pending) and fires correctly from `updateOfflineBanner()`. The real-time queue count in the banner gives cashiers clear visibility of how many pending sales need syncing. This is a strong operational pattern.

---

### V7 — Barcode auto-refocus is correctly implemented (WHAT WORKS WELL)

`setTimeout(100)` refocus after `addToCart()`, after `closeSaleCompleteModal()`, and after `showTab('till')`. The cashier's scan workflow is uninterrupted — scan → add → scan next item → checkout → complete → scan first item of next sale. This is the most important UX pattern in a POS and it is correct.

---

## AREA 4 — LONG-SESSION USABILITY

### L1 — `alert()` used for unimplemented sections (OPERATIONAL — HIGH)

**Code locations:**
- `exportProducts()`: `alert('Export Products - To be implemented')`
- `importProducts()`: `alert('Import Products - To be implemented')`
- `showNewTransferModal()`, `showNewPOModal()`, `showNewSupplierModal()`: `showNotification(..., 'info')`
- `showInventoryTab('transfers/purchase-orders/suppliers')`: placeholder functions

`alert()` is a blocking call. Tapping an unimplemented section while the cashier is mid-transaction blocks the entire UI until dismissed. `showNotification()` (non-blocking) has already been adopted as the standard — the remaining `alert()` calls are inconsistent and risky.

**In-use sections affected:** Settings → Products tab has Export/Import buttons. A cashier accidentally tapping these during a sale freezes the UI.

---

### L2 — 3-second notification timeout insufficient for error conditions (same as V1, operational severity)

Error notifications for: failed checkout, stock blocked, network error, session error. All vanish in 3 seconds. Error states should persist until dismissed or until the condition resolves.

---

### L3 — No visual hierarchy between normal and critical state in notification (OPERATIONAL — MEDIUM)

The notification system has `type` classes (success/error/info) but all appear in the same position with the same size. A critical error ("This till already has an open session") looks identical in display weight to an informational success ("Product added"). Under fatigue, cashiers stop reading notifications if they all look the same.

---

### L4 — Cart has no sticky/pinned total row during long cart scrolling (COSMETIC)

With 10+ items in cart, the cashier scrolls to see all items but the total disappears off-screen. The totals (subtotal/VAT/total) are outside the scroll container in the cart footer — this is actually correct. Marking as cosmetic since the footer remains visible.

---

### L5 — `qty-input` fires `onchange`, not `oninput` (OPERATIONAL — LOW)

**Code:** `onchange="setQty(${item.productId}, this.value)"`

`onchange` fires when the input loses focus (blur) or Enter is pressed — not on each keystroke. A cashier who types a quantity and immediately scans the next barcode (without pressing Enter first) will have the quantity change silently discarded. `oninput` + debounce, or explicit Enter/Tab handling, would be more reliable.

---

### L6 — No keyboard shortcut for checkout or cart clear (OPERATIONAL — MEDIUM)

Keyboard-only operation is important for desktop POS. There is no documented keyboard shortcut for the most common actions:
- No F-key or keyboard shortcut to trigger checkout
- No keyboard shortcut to clear cart
- No keyboard shortcut to open new session

The barcode field receives all keyboard input correctly. But navigating between paying, confirming, and printing is mouse/touch only after the cart is built.

---

## AREA 5 — MANAGER OPERATIONAL UX

### M1 — No force-close session button in recovery panel (OPERATIONAL — HIGH)

**Code:** `renderSessionHealth()` renders a table with stale/open/pending-cashup sessions, but the only actions available are on the offline queue (Retry, Mark Unrecoverable, Add Note).

A manager who sees a stale session in the recovery panel has no button to close it from that interface. They would need to navigate to the Cash Up tab, find the session, and close it — a multi-step process that may be unintuitive under urgency. This is the documented RISK-12 from 9A.

**Workaround available:** Cash Up tab → pending cashups list → complete cashup for old sessions. But the recovery panel should have an action button directly.

---

### M2 — Cash-up flow reads expected balance from server reconciliation API (WHAT WORKS WELL)

**Code:** `_reconExpectedCash` loaded from `/pos/recon/session/:id` before `completeCashUp()`. Both `calculateCashTotal()` and `completeCashUp()` read this server-side expected value — not a client-side calculation.

This is the correct pattern. The server is authoritative for expected balance. The manager cannot manipulate the expected value by altering client-side state.

---

### M3 — Daily till reset sends only `tills[0]` (OPERATIONAL — MEDIUM)

**Code:** `body: JSON.stringify({ till_id: tillsResult.tills[0].id, notes: 'Daily reset' })`

`dailyTillReset()` fetches all tills and resets till[0] unconditionally. In a multi-till setup, this always resets the first till in the API response regardless of which till the manager is currently using. The response ordering is not documented or guaranteed.

---

### M4 — Stock take modal has no search or scan input (already noted in E6) (OPERATIONAL — MEDIUM)

For managers doing a physical stock count, the inability to search or scan a barcode in the stock take modal forces manual scrolling through the full product list. For any non-trivial product catalogue this is operationally impractical.

---

### M5 — Recovery panel `prompt()` dialogs conflict with modal UX (already noted in E3)

Noted again here because the recovery panel is a manager-primary interface. Browser `prompt()` is particularly jarring in a management context where the operator expects a styled form experience.

---

### M6 — Reports menu has 16+ report types in a flat sidebar list (COSMETIC)

No grouping (Sales | Inventory | Compliance | Sync). For a manager navigating to a specific report under time pressure, the flat list requires reading every option. Visual grouping would reduce cognitive load.

---

## AREA 6 — HARDWARE WORKFLOW READINESS

### H1 — Cash drawer opens on every sale regardless of payment method (OPERATIONAL — HIGH)

**Code:** `printReceipt()` sends `{ ..., open_drawer: true }` unconditionally.

A card payment does not require opening the cash drawer. In many retail environments, an open drawer during a card payment is a compliance/security trigger. More practically: the drawer slam sound trains cashiers to expect it on every transaction — any malfunction is harder to detect.

**Fix:** Send `open_drawer: (selectedPayment === 'CASH')` or read payment method from the completed sale result.

---

### H2 — Browser receipt (`printBrowserReceipt`) uses `window.open()` — popup blocker risk (OPERATIONAL — HIGH)

**Code:** `const receiptWindow = window.open('', '_blank', 'width=400,height=600,scrollbars=yes')`

Modern browsers block `window.open()` calls not triggered directly from a user gesture event. In some scenarios (async handler, nested call), the popup is silently blocked with no error shown to the cashier. The cashier believes a receipt was printed or opened — it was not.

**This is a silent failure.** The cashier has no indication the popup was blocked.

---

### H3 — Barcode lookup is fast and scan-ready (WHAT WORKS WELL)

The O(1) `Map` lookup for barcodes (`barcodeMap`) means scanner input is processed near-instantly regardless of product catalogue size. The 300ms debounce on the barcode input correctly separates human typing (name search) from scanner input (instantaneous 8+ digit strings). This is the correct retail pattern.

---

### H4 — Qty input `onclick="this.select()"` enables fast keyboard re-entry (WHAT WORKS WELL)

When a cashier clicks into a qty field, the existing value is selected automatically. Typing a new quantity immediately replaces the old one without needing to delete first. This saves keystrokes on high-volume quantity adjustments.

---

### H5 — Payment buttons may be too small for touch on low-resolution screens (OPERATIONAL — LOW)

The payment buttons use a `4-column grid` layout (`grid-template-columns: repeat(4, 1fr)`). On a 1024×768 screen (common retail hardware), each payment button is approximately 100px wide. This meets the 44px minimum touch target but leaves no margin for error. On a screen with a cracked or dirty surface, mis-taps are plausible.

---

### H6 — Checkout button disabled state gives no explanation (same as V2)

Cashier sees a greyed-out checkout button with no hint to open a session. First-session setup is the single highest-friction onboarding moment.

---

### H7 — No Enter-key shortcut on checkout button or numeric qty inputs (OPERATIONAL — LOW)

The barcode input responds to `keydown Enter` for immediate add-to-cart. But in the payment section, after selecting a payment method, the cashier still needs to mouse/touch the Checkout button. An Enter key or F-key shortcut on the checkout step would complete the keyboard-only flow.

---

## FINDINGS SUMMARY

### Biggest Operational Pain Points (pilot-blocking or daily friction)

| # | Finding | Severity | Category |
|---|---|---|---|
| F4 | Duplicate checkout taps possible — no loading state guard | HIGH | Checkout |
| H1 | Cash drawer opens on card sales | HIGH | Hardware |
| H2 | Browser print popup silently blocked by popup blocker | HIGH | Hardware |
| F1 | Minus at qty 1 silently removes item | HIGH | Error Prevention |
| V1/L2 | 3-second notification timeout too short for errors | HIGH | Visibility |
| L1 | `alert()` blocks UI mid-transaction for unimplemented tabs | HIGH | Usability |
| M1 | No force-close session in recovery panel | HIGH | Manager UX |

### Highest-Value UX Improvements (quick wins, high cashier impact)

| # | Finding | Effort | Cashier Impact |
|---|---|---|---|
| F4 | Disable checkout button during pending API call | LOW | Eliminates double-sale risk |
| H1 | Conditional `open_drawer` based on payment method | LOW | Correct hardware behaviour |
| V1 | Persist error notifications until dismissed | LOW | Errors no longer vanish mid-transaction |
| L1 | Replace `alert()` with `showNotification()` | LOW | Removes all UI-blocking dialogs |
| F1 | Guard qty decrement at 1: confirm or floor at 1 | LOW | Prevents silent item deletion |
| F5 | Auto-print by default, make other options secondary | MEDIUM | Eliminates post-sale friction |
| E3 | Replace `prompt()` in recovery with styled inline form | MEDIUM | Consistent manager UX |

### Fatigue-Causing UX Patterns

1. **Post-sale receipt decision modal** — 4 options, every transaction, under queue pressure
2. **3-second disappearing notifications** — cashier must constantly watch the bottom of screen
3. **Silent item deletion** via minus-at-1 — re-scanning items wastes time per error
4. **Blocking browser dialogs** (`confirm()`, `alert()`, `prompt()`) — trains cashiers to dismiss without reading
5. **No loading feedback on checkout** — forces re-tap behavior, amplified under stress

### Keyboard / Touch Readiness

| Feature | Status |
|---|---|
| Barcode auto-refocus | ✅ Correct |
| Post-sale refocus | ✅ Correct |
| Qty input auto-select on click | ✅ Correct |
| Enter key on barcode add | ✅ Correct |
| Enter/F-key shortcut for checkout | ❌ Missing |
| Touch target sizes on payment grid | ⚠ Minimum, no margin |
| `onchange` vs `oninput` on qty fields | ⚠ Change fires late |

### What Already Works Well

| Feature | Why It Works |
|---|---|
| Barcode O(1) Map lookup | Scanner latency is negligible |
| 300ms debounce on barcode input | Correctly separates scan from type |
| Offline banner color states | Clear, unambiguous connectivity status |
| Queue count in offline banner | Cashier always knows sync backlog |
| `forceUpdatePending` gate on checkout | Prevents checkout during forced update |
| Manager auth modal for returns | Cashier cannot process returns without manager |
| `autoPrintEnabled` flag exists | Auto-print path exists, just not user-configurable |
| Server-authoritative expected balance in cash-up | Cannot be manipulated client-side |
| Inline variance display in stock take | Real-time discrepancy feedback |
| Company isolation on all API calls | Multi-company context always enforced |

---

## Recommended Polish Order

### Tier 1 — Fix Before Pilot (Correctness Issues)

These are not UX preferences — they are operational correctness problems that will cause cashier incidents during pilot.

1. **F4** — Disable checkout button during `await fetch()`, re-enable in `finally`. Prevents duplicate sales.
2. **H1** — Send `open_drawer: (paymentMethod === 'CASH')` in print request. Correct hardware behaviour.
3. **L1** — Replace remaining `alert()` calls with `showNotification()`. Eliminates UI freeze mid-transaction.
4. **V1** — Error-type notifications must persist until dismissed (or until a success/info replaces them). 3-second auto-hide is only appropriate for success messages.

### Tier 2 — High-Impact Polish (First Week of Pilot)

These are real daily friction points that will generate support requests within the first week of cashier use.

5. **F1** — When `updateQty` would go below 1, ask for confirmation before `removeItem()`. Floor at 1 is the simpler path.
6. **H2** — Replace `window.open()` receipt with print server call or inject into existing window. Silent popup block is unacceptable.
7. **F5** — Make auto-print the default behaviour; collapse other receipt options behind "Other options" link.
8. **E3 / M5** — Replace `prompt()` dialogs in recovery panel with inline styled form inputs.

### Tier 3 — Operational Improvement (Second Week / Post-Pilot)

These improve cashier efficiency but will not cause incidents.

9. **M1** — Add force-close button for stale sessions directly in the recovery panel session health table.
10. **F8** — Add partial return selection UI: checkbox per item, quantity field per item in the return flow.
11. **L6 / H7** — Add keyboard shortcut for checkout (Enter or F12 when cart is non-empty and session active).
12. **M3** — Fix `dailyTillReset()` to use the active session's `till_id` rather than `tills[0].id`.
13. **L5** — Change `onchange` to `oninput` + debounce for cart qty inputs, or handle Enter explicitly.

### Tier 4 — Cosmetic / Low Urgency

14. **F3, E4, E5** — Replace remaining `confirm()` calls with styled confirmation modals.
15. **M6** — Group report sidebar into category sections.
16. **E6 / M4** — Add barcode/search input to stock take modal.
17. **V4** — Show active till name/number in till header.
18. **V5** — Add user-configurable auto-print toggle in Settings.
19. **F9** — Add return reason selection (dropdown) in return flow.
20. **L3** — Increase visual weight of error notifications vs success.

---

## Pilot-Safe Usability Verdict

**The checkout flow is operationally ready for a controlled pilot with the following conditions:**

1. The duplicate-checkout risk (F4) must be fixed before pilot — it can create duplicate sales on slow networks.
2. The cash drawer behaviour (H1) should be fixed before pilot if card payments are in use — it is a hardware-correctness issue.
3. The `alert()` calls (L1) must be fixed before pilot — they can freeze the UI mid-transaction.
4. All other findings are real friction points but will not cause data integrity problems.

Under the operational limits documented in Workstream 9A (one session per till, single-company, controlled staff), the remaining findings are tolerable for a short pilot. They are not tolerable for production rollout.

**Pilot recommendation:** Fix Tier 1 before first day. Track Tier 2 as sprint items for the first week of pilot feedback.

---

## Files Audited

| File | Lines Read |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | All (~9400 lines) |

No files were modified during this audit.
