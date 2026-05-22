# 36 — TIER 2 OPERATIONAL POLISH IMPLEMENTED
## Checkout Charlie — Workstream 10C

**Date:** 2026-05-22
**Status:** ✅ Implemented — pilot-ready
**Scope:** 4 Tier 2 operational polish fixes from Workstream 10A audit
**File changed:** `accounting-ecosystem/frontend-pos/index.html` only — backend unchanged

---

## What Was Fixed

### Fix 1 — Quantity Remove Behaviour (F1 from audit)

**Problem:** Clicking minus on a cart item at quantity 1 silently removed it. Under queue pressure, cashiers accidentally removed items with a misplaced tap. There was no indication, no undo, and the item had to be re-scanned.

**Approach:** Two-tap confirm pattern. No modal, no dialog — the minus button itself becomes the confirmation. Keeps flow fast for confident cashiers, safe for accidents.

**New behaviour:**
- Qty > 1: minus decrements normally (unchanged)
- Qty = 1, first tap: minus button turns red and shows `✕?` — visual confirmation that a second tap will remove
- Qty = 1, second tap within 2.5s: item removed
- Auto-cancel after 2.5s: button resets to `-`, item stays — cashier can proceed without interruption
- ✕ button (explicit remove): still removes immediately as before

**New global:**
```javascript
const pendingRemoveConfirm = new Set(); // qty-1 items awaiting second-tap remove confirmation
```

**`updateQty()` changes:**
```javascript
if (change < 0 && item.quantity + change <= 0) {
    if (pendingRemoveConfirm.has(productId)) {
        pendingRemoveConfirm.delete(productId);
        removeItem(productId);                   // second tap — confirmed remove
    } else {
        pendingRemoveConfirm.add(productId);
        // Turn button red, show ✕? — auto-reset after 2.5s
    }
    return;   // do NOT call updateCart() — preserve the confirm-state button
}
```

**`updateCart()` and `removeItem()` both call `pendingRemoveConfirm.clear()` / `.delete()`** — stale confirm state is never carried across a cart re-render.

**Both cart render functions patched** (`updateCart()` and `updateCartWithQtyInput()`) — both add `data-qty-product="${item.productId}"` to the minus button so `updateQty` can target it without a full re-render during confirm state.

**`setQty()` (direct number input) is unchanged:** typing `0` or a negative number still removes immediately — this is deliberate keyboard input, not an accidental tap.

---

### Fix 2 — Receipt Print Popup Blocker (H2 from audit)

**Problem:** `printBrowserReceipt(html)` called `window.open()` unconditionally. If the browser's popup blocker rejected the new window, `printWindow` was `null` and `printWindow.document.write(html)` threw an uncaught TypeError — silent failure with no feedback to the cashier.

**Fix:** Null check on the popup window + silent iframe fallback:

```javascript
function printBrowserReceipt(html) {
    const popup = window.open('', '_blank', 'width=400,height=600');
    if (popup) {
        // Popup allowed — use it as before
        popup.document.write(html);
        popup.document.close();
        popup.focus();
        setTimeout(() => { popup.print(); popup.close(); }, 250);
        return;
    }
    // Popup blocked — inject a hidden iframe, print from it, then remove
    showNotification('Popup blocked — printing via in-page fallback', 'info');
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:400px;height:600px;border:none;';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(() => {
        try { iframe.contentWindow.print(); } catch (e) {}
        setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 1500);
    }, 250);
}
```

**Fallback behaviour:** The browser's native print dialog fires on the current page via the iframe — no popup required. The iframe is positioned off-screen so it is invisible to the cashier. It removes itself 1.5s after printing completes. The cashier sees the "Popup blocked" notification and the print dialog opens normally.

**What is unchanged:**
- Thermal printer path (`result.method === 'thermal'`) — unaffected, never reaches `printBrowserReceipt`
- The receipt HTML content — identical, only the delivery mechanism changes when popup is blocked
- Offline receipt printing (`printOfflineReceipt`) — calls `printBrowserReceipt`, also now popup-safe

---

### Fix 3 — Post-Sale Receipt Modal Friction (V2, L2 from audit)

**Problem:** After every sale, cashiers were presented with 5 equal-weight buttons (Print, Email, SMS, WhatsApp, Done) plus a collapsible input. No clear primary action. Cashiers with thermal printers (who need zero interaction) had to click Done past the receipt options grid on every sale.

**Redesign principles:**
1. **Done is the primary CTA** — full-width primary button, always first, auto-dismisses
2. **Print is the secondary action** — half-width, visible but secondary
3. **Send options are collapsed** — single "Send…" button expands Email/SMS/WhatsApp on demand
4. **Auto-dismiss countdown** — 6-second countdown displayed in Done button; any interaction cancels it

**New layout:**
```
┌─────────────────────────────────┐
│ ✓ Sale Complete                 │
│                                 │
│ #12345                          │
│ R 450.00          CASH          │
│                                 │
│ [  Done (6s)                  ] │ ← primary, auto-closes
│ [  🖨 Print  ] [  ✉ Send…  ]   │ ← secondary
│ (collapsed Send panel)          │
└─────────────────────────────────┘
```

**Countdown behaviour:**
- Modal opens → 6s countdown displayed in Done button as `(6s)`, `(5s)`, etc.
- Countdown reaches 0 → `closeSaleCompleteModal()` called automatically
- Cashier clicks Print → `cancelSaleModalCountdown()` called → countdown stops, modal stays open
- Cashier clicks Send… → `cancelSaleModalCountdown()` called, send panel expands
- Cashier opens Email/SMS/WhatsApp input → `cancelSaleModalCountdown()` called
- Cashier clicks Done → modal closes immediately (interval cleared first)

**New globals:**
```javascript
let saleCompleteAutoClose = null; // countdown interval for sale complete modal auto-dismiss
```

**New functions:**
- `cancelSaleModalCountdown()` — stops the countdown; called by all receipt action buttons
- `toggleReceiptOptions()` — expands/collapses the Send panel; also cancels countdown

**`closeSaleCompleteModal()` updated:** Clears `saleCompleteAutoClose` interval before removing modal — prevents the interval from firing after the DOM element is gone.

**`showEmailReceiptInput()`, `showSmsReceiptInput()`, `showWhatsAppReceiptInput()`:** Each now calls `cancelSaleModalCountdown()` at entry — sending a receipt cancels auto-close.

**What is unchanged:**
- Receipt delivery API calls — identical
- `deliverReceipt()` function — identical
- `sendReceiptDelivery()` — identical
- `receiptDeliveryMethod` variable — still managed by the same functions
- `receiptDeliveryInput` / `receiptDeliveryValue` / `receiptDeliveryStatus` element IDs — preserved
- Offline sale modal (`showOfflineSaleModal`) — unchanged; that flow has different buttons

---

### Fix 4 — Recovery `prompt()` Dialogs (L1 from audit)

**Problem:** `promptAbandonItem()` and `promptAddNote()` used `window.prompt()` for manager input. `prompt()` blocks the JavaScript event loop, prevents background sync from running, and produces an inconsistent native OS dialog that varies across browsers and operating systems.

**Fix:** Both functions now call `showRecoveryInputModal()` — an in-page modal using the existing `.modal-overlay` / `.modal` CSS classes, matching the design language of every other modal in the app.

**New `showRecoveryInputModal({ title, message, placeholder, confirmLabel, confirmClass, onConfirm })`:**
- Creates a `<div id="recoveryInputModal">` in the DOM (clears any existing one first)
- Renders title, descriptive message (supports HTML — XSS-safe since `safeNum` is always `escHtml()`-escaped before being passed), a `<textarea>` for input, Cancel + Confirm buttons
- Stores `onConfirm` callback on the modal element (`modal._onConfirm`)
- Focuses the textarea automatically (50ms delay for DOM availability)
- Ctrl+Enter / Cmd+Enter submits the form
- z-index 1100 — stacks above the recovery panel (z-index 1000)

**`submitRecoveryInput()`:**
- Reads textarea value
- Calls `modal._onConfirm(text)` — the callback validates and acts
- If callback returns `false` (validation failed), modal stays open for correction
- If callback returns anything else, `closeRecoveryInputModal()` is called

**`closeRecoveryInputModal()`:** Removes the modal DOM element.

**Audit trail preserved:** `promptAbandonItem` and `promptAddNote` still pass the reason/note to `markQueueItemAbandoned()` and `addQueueNote()` respectively — those functions are unchanged. The API calls to `/pos/recovery/queue/abandon` and `/pos/recovery/queue/note` are identical. The backend still receives and records the same data.

**Validation unchanged:** Reason required for abandon (returns `false` with notification on empty input), note required for note (same). Stricter than the original `prompt()` which only showed a notification and closed — now the modal stays open so the manager can fill in the field.

---

## Files Changed

| File | Changes |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | All 4 Tier 2 fixes — see sections above |

No backend files changed. No migration required. No new CSS classes required — all reuse existing `.modal-overlay`, `.modal`, `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`.

---

## What Was NOT Changed

| Area | Reason |
|---|---|
| `markQueueItemAbandoned()` | Unchanged — only the input-gathering changed |
| `addQueueNote()` | Unchanged |
| `promptAbandonItem` / `promptAddNote` in recovery panel HTML | Still calls same functions — button `onclick` attributes unchanged |
| Remaining `prompt()` calls (cashup balance, company deletion, loyalty, void reason) | Out of scope — these are separate functional areas not in the Tier 2 list |
| `confirm()` in `clearCart()` | Out of scope — not in Tier 2 list |
| `showOfflineSaleModal()` | Not touched — offline sale flow has different buttons |
| Thermal printer path | Not touched — never reaches `printBrowserReceipt` |
| Checkout flow | Not touched |
| Sale creation, stock decrement, sessions | Not touched |
| Paytime module | Not touched |

---

## Test Criteria

| # | Test | Expected Result |
|---|---|---|
| T1 | Add item to cart, click minus once when qty is 1 | Minus turns red, shows `✕?` — item NOT removed |
| T2 | After T1, click minus again within 2.5s | Item removed |
| T3 | After T1, wait 2.5s without clicking | Button resets to `-` — item stays in cart |
| T4 | Click explicit `✕` remove button | Item removed immediately (no confirm) |
| T5 | Click `+` on another item while one item is in confirm state | Full cart re-render — confirm state cleared, pending item still in cart |
| T6 | Receipt print, popup blocker active | "Popup blocked — printing via in-page fallback" notification; print dialog opens |
| T7 | Receipt print, popup allowed | Popup window opens and prints normally |
| T8 | Offline receipt print | Prints via printBrowserReceipt — same popup/fallback logic applies |
| T9 | Sale complete — no interaction | Modal auto-closes after 6s; Done button shows countdown |
| T10 | Sale complete — click Print | Countdown cancels; modal stays open while print runs |
| T11 | Sale complete — click Send… | Countdown cancels; Email/SMS/WhatsApp options expand |
| T12 | Sale complete — click Email, fill address, click Send | Receipt delivery fires; modal stays open for confirmation |
| T13 | Sale complete — click Done immediately | Modal closes immediately; countdown interval cleared |
| T14 | Recovery — click "Mark Unrecoverable" | In-page modal appears; no OS dialog box |
| T15 | Recovery abandon — submit empty reason | Notification "Reason is required." — modal stays open |
| T16 | Recovery abandon — submit valid reason | Modal closes; `pos_audit_events` record created via `queue/abandon` API |
| T17 | Recovery — click "Add Note" | In-page modal appears; no OS dialog box |
| T18 | Recovery note — Ctrl+Enter submits | Note saved; modal closes |
| T19 | No `prompt()` in recovery section | Confirmed: `promptAbandonItem` and `promptAddNote` no longer call `prompt()` |
| T20 | Audit trail — abandon and note records | `/pos/recovery/queue/abandon` and `/pos/recovery/queue/note` still receive correct payloads |
| T21 | No localStorage/sessionStorage business data | DevTools → Application → Storage: only `token` and `isSuperAdmin` |

---

## Remaining Tier 2+ Items Not Addressed in 10C

| ID | Finding | Notes |
|---|---|---|
| V2 | No running sale total visible mid-cart | Cart shows per-item totals + grand total — this is UX enhancement for pilot feedback |
| F2 | No barcode scan confirmation | Audio/visual scan feedback — post-pilot |
| F3 | Search field not auto-focused after sale | Post-sale UX reset |
| M1 | No force-close session in recovery panel (RISK-12) | Manager gap — separate workstream needed |
| F5 | `checkoutWithFeatures()` not wired | Split payment UI activation — separate workstream |
| L2 remaining | Other `prompt()` calls (cashup, void, loyalty) | Not blocking for pilot — tracked for Tier 3 |

---

## Architecture Boundaries Preserved

- No business data written to `localStorage`, `sessionStorage`, or `indexedDB`
- All receipt delivery and audit calls remain server-authoritative
- Recovery action payload structure unchanged — backend API contracts not affected
- Checkout, sale creation, stock decrement, session flows untouched
- Paytime module not touched (no auto-trigger files modified)
- Zeabur deployment rules not affected (frontend-only change)

---

## Workstream 10C Pilot-Safe Verdict

**Quantity safety:** ✅ Accidental remove at qty 1 now requires two taps; auto-cancels after 2.5s  
**Popup print fallback:** ✅ Blocked popups silently fall back to iframe print; no uncaught TypeError  
**Post-sale flow:** ✅ Done is obvious primary CTA; 6s auto-dismiss removes friction for thermal printer users  
**Recovery modals:** ✅ No blocking `prompt()` in recovery actions; in-page modal preserves all validation and audit  

**Workstream 10C is pilot-safe.**
