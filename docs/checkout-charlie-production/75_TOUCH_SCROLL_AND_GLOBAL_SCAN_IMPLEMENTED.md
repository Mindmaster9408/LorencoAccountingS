# Codebox 75 — Touch Scroll Protection + Global Barcode Scan Capture
## Checkout Charlie

**Status:** Implemented and verified (11-scenario real headless-Chromium test suite — see Verify section)
**Date:** 2026-07-07
**Reported symptoms:**
1. Scrolling the product grid on touchscreen accidentally added products to the cart.
2. The barcode scanner only worked when `#barcodeInput` was explicitly clicked first.

---

## PART 1 — Touch Scroll Protection

### Root cause

The product grid's only interaction handler was a single delegated `'click'` listener on `#productsGrid`. Browsers still fire a `click` event after a touch-drag-release in many cases (the well-known "ghost click" after a scroll gesture) — so a cashier scrolling the grid with their thumb could have that scroll register as a tap on whatever tile happened to be under their finger when it lifted, silently adding it to the cart.

### Tap/scroll threshold

Added Pointer Events tracking (unifies mouse/touch/pen — no separate touch/mouse code paths) directly on `#productsGrid`:

```javascript
const SCROLL_THRESHOLD_PX = 8;
let pointerDownX = 0, pointerDownY = 0, isScrollGesture = false;

productsGrid.addEventListener('pointerdown', function(e) {
    isScrollGesture = false;
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
});
productsGrid.addEventListener('pointermove', function(e) {
    if (isScrollGesture) return;
    const dx = Math.abs(e.clientX - pointerDownX);
    const dy = Math.abs(e.clientY - pointerDownY);
    if (dx > SCROLL_THRESHOLD_PX || dy > SCROLL_THRESHOLD_PX) isScrollGesture = true;
});
```

The **existing** `'click'` handler was not replaced, only gated — it now bails out (and resets the flag) if `isScrollGesture` is true, otherwise proceeds exactly as before (same `addToCart(product)` call, same `data-product-id` lookup). `.products-grid` also gained `touch-action: pan-y`, which tells the browser vertical panning is a native gesture (so the actual scroll still feels smooth and native) while ensuring `pointermove` events keep being dispatched to JS throughout the gesture.

8px was chosen as a threshold large enough to absorb natural finger tremor during a genuine tap, small enough to catch a real scroll almost immediately — verified empirically (see Verify).

### What this does NOT change

- Mouse clicks: a real click has near-zero pointer movement between down and up, so it always passes the threshold check and adds normally — verified.
- The `.shortcut-star` button inside each tile already calls `event.stopPropagation()`, so it never reaches this handler at all — untouched.
- `addToCart()`, stock guards, negative-stock policy — completely untouched; this workstream only gates whether the existing call happens.

---

## PART 2 & 3 — Global Barcode Scan Capture + Scan vs. Typing

### Architecture

A single `document`-level `keydown` listener (`initGlobalScanCapture()`) builds an in-memory character buffer whenever the cashier is **not** actively focused in some other field and no modal is open. On `Enter`, if the buffer is long enough and arrived fast enough to plausibly be a scanner, it's handed to the exact same `searchByBarcode()` function the focused-input path already uses — same `barcodeMap` lookup, same `addToCart()`, same duplicate-scan-increments-quantity behavior, same not-found handling. No new lookup path was created; the global capture is purely a second way to *feed* the existing one.

```javascript
document.addEventListener('keydown', function(e) {
    const active = document.activeElement;
    if (active && active.id === 'barcodeInput') return;      // its own listeners already handle this keystroke
    if (isTypingContext(active) || isAnyModalOpen()) return;  // never steal from a real field or a modal
    if (e.ctrlKey || e.metaKey || e.altKey) return;           // never swallow OS/browser shortcuts

    if (e.key === 'Enter') {
        // ... finalize buffer, check length + timing, call searchByBarcode(raw)
    }
    if (e.key.length !== 1) return;   // ignores Tab/Escape/Arrow*/F-keys etc. (multi-char e.key names)
    // ... accumulate character + timestamp
});
```

### Input exclusion rules

A single `isTypingContext(el)` check covers every case the spec lists — rather than enumerating "product form," "customer form," "settings form," "payment amount field" individually, it checks the actual DOM: is the focused element an `INPUT`, `TEXTAREA`, `SELECT`, or `contentEditable`, and is it *not* `#barcodeInput` itself? Every one of those named cases is, mechanically, exactly this. Combined with `isAnyModalOpen()` (checks real computed `display` on every `.modal-overlay`, not a hardcoded list — works for every existing modal and any future one without needing this file touched again), this reliably excludes:

- Product/customer/settings edit forms (all use real `<input>`/`<select>` fields)
- Payment amount fields, split-payment rows (`.split-amount` inputs)
- Account-customer search
- Any modal, open by any of this file's several different show/hide mechanisms

### Scan vs. typing timing

- **Minimum length 4** — a barcode shorter than that is rejected outright, whether from the buffer or not.
- **Average inter-character interval ≤ 50ms** — computed from the actual timestamps of every character in the buffer (`(last - first) / (count - 1)`), not a fixed per-character check, so a single unlucky slow keystroke in the middle of an otherwise-fast scan doesn't wrongly reject it.
- **250ms idle timeout** clears the buffer if no further keys arrive — prevents a half-typed, abandoned sequence from lingering and corrupting a later scan.
- **150ms (3× the interval threshold) gap-reset** — if two keystrokes are more than 150ms apart, the earlier ones are discarded and a fresh buffer starts, so slow manual typing outside any field (e.g. an idle keypress) can't slowly accumulate into something that looks like a barcode.

Verified: 6 slow keystrokes (80ms apart) followed by Enter produced **zero** cart additions — correctly rejected as "too slow to be a scanner."

---

## PART 4 — Auto-Refocus / Scan-Ready State

### Auto-refocus

`refocusScanner()` is the single, guarded entry point — it only actually moves focus when **all** of: the Till screen is showing, no modal is open, no scan is currently mid-flight (see Known Edge Case below), and no other field is genuinely focused.

```javascript
function refocusScanner() {
    if (globalScanInProgress) return;
    const tillInterface = document.getElementById('tillInterface');
    if (!tillInterface || tillInterface.style.display === 'none') return;
    if (isAnyModalOpen()) return;
    const barcodeInput = document.getElementById('barcodeInput');
    if (!barcodeInput) return;
    const active = document.activeElement;
    if (isTypingContext(active) && active !== barcodeInput) return;
    barcodeInput.focus();
}
```

Wired at the specific points the spec names:
- **Product added** — `addToCart()`'s existing `setTimeout(..., 100)` refocus now calls `refocusScanner()` instead of an unconditional `.focus()` (the old code would have stolen focus even from an open modal — a latent bug this incidentally fixes).
- **Payment selected** — added to `selectPayment()`, except when `ACCOUNT` is chosen (that reveals a customer-search box the cashier is expected to type into next; forcing focus back to the barcode input there would fight the user).
- **Cart cleared** — added to `clearCart()`.
- **Sale complete modal dismissed** — `closeSaleCompleteModal()`'s existing raw `.focus()` now routes through `refocusScanner()`.
- **"Modal closed" (generic)** — rather than instrumenting every one of this file's 20+ `close*Modal()` functions individually (real regression risk, given how many exist and how differently some are implemented), a single debounced `document`-level `click` listener calls `refocusScanner()` 200ms after **any** click. This is safe specifically because `refocusScanner()`'s own guards mean it only ever actually acts when nothing else legitimately has focus — so it's cheap and correct to call broadly rather than exhaustively wiring every close path.

### Visible scan-ready status

A single, subtle, in-place status line (`#scanStatusIndicator`) replaced the previous static "Scan barcode or type to search products" helper text under the barcode input. `setScanStatus(text, tone)` updates it and auto-reverts to "Ready to scan" after 1.5s — never stacks, never spams. States: `Ready to scan` (idle, grey) → `Scanning…` (blue, shown the moment the global buffer starts accumulating a fast burst) → `Product added: X` / `Qty N × X` / `Unknown barcode` (green/red, then auto-reverts).

This is **deliberately separate** from the existing `showNotification()` toasts, which already fire their own "Added: X" / "Product not found" messages on every scan (both from the focused-input path and now from the global path, unchanged). Removing those in favor of the new indicator would have been a bigger behavior change than asked; the two now coexist — the toast gives a clear, momentary confirmation, the indicator gives an always-visible ambient status. Documented here as a deliberate product decision, not an oversight.

---

## Known Edge Case (found by testing, then fixed)

Initial real-browser testing surfaced a genuine gap: if `refocusScanner()`'s 200ms post-click timer fired **while a global scan was already mid-keystroke-burst**, focus could shift to `#barcodeInput` partway through, splitting the remaining characters into the input's own native value instead of the global buffer — losing the scan. Fixed with a shared `globalScanInProgress` flag, set true the instant a fast-burst buffer starts and cleared the instant it resolves (Enter, reject, or idle-timeout) — `refocusScanner()` now unconditionally bails while it's true. Re-verified after the fix: the exact scenario that failed before (product tap immediately followed by a global scan) now works correctly every time.

---

## Preserved (verified, not just asserted)

- Duplicate barcode scan (input-focused **or** global) still increments the same cart line, not a new one.
- `updateQty()`, `removeItem()`, cart compact mode (Workstream 74), split payment, `checkoutInProgress`, `forceUpdatePending`/till-lock guards — none of these were touched; `addToCart()`'s only change is what it calls at the very end (`refocusScanner()` instead of a raw `.focus()`).
- Manual search (`#barcodeInput`'s own `input`/`keypress` listeners) — untouched; the global listener explicitly defers to them whenever that field is focused.
- Offline behavior — none of this workstream touches network calls, IndexedDB, or the offline-sale path.

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | `.products-grid` gained `touch-action:pan-y`; new `.scan-status-indicator` CSS; static helper text replaced with `#scanStatusIndicator`; `#productsGrid`'s click handler gated by pointer-tracked scroll detection; new `isTypingContext()`, `isAnyModalOpen()`, `setScanStatus()`, `refocusScanner()`, `initScannerAutoRefocus()`, `initGlobalScanCapture()`; `searchByBarcode()` now also calls `setScanStatus()`; `addToCart()`, `clearCart()`, `selectPayment()`, `closeSaleCompleteModal()` now call `refocusScanner()` instead of raw/no focus handling |

No backend changes. No changes to `create_sale_atomic`, stock logic, product data model, or the checkout calculation.

---

## Verify Results (11-scenario real headless-Chromium test)

| Scenario | Result |
|---|---|
| Tapping product tile adds item | ✅ cart length 1 |
| Scroll/drag over a tile does not add it | ✅ cart length 0 |
| Fast flick scroll does not add it | ✅ cart length 0 |
| Next real tap after a scroll still works | ✅ cart length 1 (flag correctly resets) |
| Barcode scan works without clicking input | ✅ item added, status "Product added: …" |
| Duplicate global scan increments quantity | ✅ same line, qty 2 |
| Scan ignored while another field (payment amount) focused; normal typing still works | ✅ cart unchanged; field received the typed digits |
| Scan ignored while a modal is open | ✅ cart unchanged |
| Unknown barcode gives clear feedback, buffer doesn't contaminate the next scan | ✅ status "Unknown barcode", next real scan still adds correctly |
| Slow manual keystrokes (80ms apart) not treated as a scan | ✅ cart unchanged |
| Auto-refocus lands on `#barcodeInput` after a product is added (no modal, on Till screen) | ✅ confirmed |
| Console/page errors | ✅ none |
| localStorage/sessionStorage business data | ✅ confirmed via diff — zero new storage calls |

Not testable in this environment (no live server/database): checkout-completion refocus against a real sale, and settings-form exclusion against the actual product/customer/settings modals in the live app (the generic `isTypingContext`/`isAnyModalOpen` mechanism was verified against representative stand-ins — an `<input>` and a `.modal-overlay` — and works identically regardless of which specific field or modal it is, since neither check is per-element).
