# Codebox 70 — Scan Quantity + Receipt Print Readability Fix
## Checkout Charlie

**Status:** Fixed
**Date:** 2026-07-06
**Reported symptoms:**
1. Scanning the same product/barcode a second time does not increase the cart quantity.
2. Printed receipt/slip is too light, unclear, and hard to read on thermal printer.

---

## PART 1 — Duplicate Scan Quantity Fix

### Audit — is the cart merge logic itself correct?

`addToCart(product)` (`frontend-pos/index.html`) already does the right thing on paper:

```javascript
function addToCart(product) {
    const existing = cart.find(item => item.productId === product.id);
    if (existing) {
        existing.quantity++;          // merges into the same line
    } else {
        cart.push({ productId: product.id, quantity: 1, ... });  // new line
    }
    updateCart();
}
```

`searchByBarcode()` calls this exact same function that product-tile clicks call — there is no separate/duplicated increment path. Verified with an isolated logic test (extracted these functions into a standalone Node script and called `searchByBarcode()` three times with the same barcode): one cart line, quantity 1 → 2 → 3, exactly as expected. **The merge logic was never the bug.**

### Root cause — the barcode input is only cleared on a successful match

```javascript
function searchByBarcode(rawBarcode) {
    const barcode = normalizeBarcode(rawBarcode);
    const product = barcodeMap.get(barcode);
    if (product) {
        ...
        document.getElementById('barcodeInput').value = '';   // ← only cleared HERE
    } else {
        showNotification('Product not found...', 'error');    // ← NOT cleared here
    }
}
```

Any single scan that fails to resolve — an unrecognised barcode, a partial/garbled read, or a race between the debounced `input` handler (300ms) and the `keypress` Enter handler on a fast back-to-back scan — leaves the raw text sitting in the field. Because the field is never cleared on that failure path, the **next** physical scan's characters get appended onto the stale text instead of starting from empty. That produces a longer, invalid, unmatchable string, which also fails to resolve, which also isn't cleared — and the corruption cascades. Every scan after the first failure silently does nothing, which reads to the operator as "scanning the same item again doesn't increase the quantity."

Reproduced with an isolated DOM-level simulation (before the fix):

```
scan "999999999999" (unrecognised)  → cart: []   field: "999999999999"
scan "6001234567890" (real item)    → cart: []   field: "9999999999996001234567890"
scan "6001234567890" (same again)   → cart: []   field: "99999999999960012345678906001234567890"
notifications: Product not found / Product not found / Product not found
```

The cart never updates at all once one scan has failed to resolve — matching the reported symptom exactly.

### Fix — clear the input unconditionally, on both outcomes

```javascript
function searchByBarcode(rawBarcode) {
    const barcode = normalizeBarcode(rawBarcode);
    // Clear immediately — success or not-found — so a failed/garbled lookup can
    // never leave stale text for the next scan's characters to append onto.
    const input = document.getElementById('barcodeInput');
    if (input) input.value = '';
    const product = barcodeMap.get(barcode);
    if (product) {
        const existing = cart.find(item => item.productId === product.id);
        addToCart(product);
        showNotification(existing ? `Qty ${existing.quantity} × ${product.product_name}` : `Added: ${product.product_name}`, 'success');
    } else {
        showNotification(`Product not found...`, 'error');
    }
}
```

Same simulation after the fix, including a deliberate garbage scan first to prove no cross-contamination:

```
scan "999999999999" (unrecognised)  → cart: []                                field: ""
scan "6001234567890" (real item)    → cart: [{productId:501, qty:1}]          field: ""
scan "6001234567890" (same again)   → cart: [{productId:501, qty:2}]          field: ""
scan "6001234567890" (same again)   → cart: [{productId:501, qty:3}]          field: ""
```

One line, quantity increments correctly every time, regardless of any prior failed/garbled scan.

### What was NOT touched

- `addToCart()`'s merge logic, stock guard (`existing.quantity < availableStock`), and negative-stock policy branch — unchanged, verified still present and unreachable-by-regression.
- Barcode input auto-focus (`addToCart()`'s `setTimeout(..., 100)` refocus) — unchanged.
- `barcodeMap` build/lookup, `normalizeBarcode()`, `updateQty()`, `removeItem()` — unchanged.
- Sale backend/RPC, stock decrement RPC, checkout flow — untouched entirely; this was a pure frontend input-handling fix.

### Tests

| Test | Result |
|---|---|
| Scan same barcode 3 times | One line, qty 3 |
| Scan product tile + barcode same item | One line, qty increments (same `addToCart()` path either way) |
| Stock-limited item at cap in strict mode | Blocked with "Not enough stock" (unchanged guard) |
| Negative-stock-enabled company over stock | Allowed with warning notification (unchanged branch) |
| Cart total recalculates | `updateCart()` rebuilds subtotal/VAT/total from `cart` array on every call — unaffected by this fix |
| Scan an unrecognised barcode, then a real item | Real item now resolves correctly (previously would have been silently corrupted) |

---

## PART 2 — Receipt Print Readability Fix

### Root cause

The `@media print` CSS already forced `color:#000 !important` and `print-color-adjust:exact`, so the "too light" complaint wasn't really about color — it was **font weight**. The receipt body, `printBrowserReceipt()`'s wrapper, and both receipt templates rendered at normal (400) or medium (500) font-weight. On thermal printers, thin/normal-weight strokes under-transfer heat and print faint even when the underlying color is pure black. Cashier/Till — explicitly required fields — were also missing entirely from both receipt templates and were never fetched by the receipt-preview endpoint.

### Receipt template changes (`frontend-pos/index.html`)

Both `printReceiptViaBrowser()` (online, live sale) and `generateOfflineReceiptHtml()` (offline sale) were updated to the same format:

- Item lines: `{qty} x {name}` on one bold line, `@ {price}` / line total on the next — matches the requested `1 x Product Name` / ` @ Rxx.xx  Rxx.xx` layout.
- Company name bumped to 18px/900 weight; all body rows now default to 700 weight (previously unweighted).
- **Cashier** and **Till** rows added (see backend change below).
- Separators strengthened: dashed line 1px→2px, solid divider 2px→3px, all still pure black.
- **TOTAL** pulled out of the regular row list into its own 18px/900-weight line, bracketed by double dividers — now unmistakably the most prominent line on the slip.
- Subtotal/VAT rows relabeled `VAT incl.` per the requested format; payment breakdown (`paymentsHtml`/payment row) unchanged in position, now bold like everything else.
- Footer text bumped from 10px/unweighted to 11px/700.

### Backend change — Cashier/Till data (`backend/modules/pos/routes/receipts.js`)

`GET /api/receipts/preview/:saleId` didn't select cashier or till info at all. Added a follow-up query through `till_sessions` (using the sale's existing `till_session_id`), reusing the **exact same relation** already proven working elsewhere in this module (`sessions.js`, `reports.js`: `tills(till_name, till_number)`, `users:user_id(username, full_name)`):

```javascript
let cashier = null, till = null;
if (sale.till_session_id) {
  const { data: sessionData } = await supabase
    .from('till_sessions')
    .select('tills(till_name, till_number), users:user_id(username, full_name)')
    .eq('id', sale.till_session_id)
    .maybeSingle();
  if (sessionData) {
    cashier = sessionData.users?.full_name || sessionData.users?.username || null;
    till = sessionData.tills?.till_name || sessionData.tills?.till_number || null;
  }
}
```

This is additive to a read-only preview endpoint — no change to sale creation, the stock-decrement RPC, or any write path. `/receipts/print/:saleId` (the thermal-printer endpoint) was deliberately left alone — see "Remaining printer hardware notes" below.

For **offline** sales, cashier/till were already available client-side (`currentUser`, `currentSession` — both populated before checkout can even start) and are now captured directly into the offline sale record at save time, with zero network dependency:

```javascript
const saleData = {
    ...
    cashierName: currentUser?.full_name || currentUser?.username || null,
    tillName: currentSession?.tills?.till_name || currentSession?.tills?.till_number || null
};
```

### Print CSS changes

```css
@media print {
    body {
        color: #000 !important;
        background: #fff !important;
        font-family: 'Courier New', monospace;
        font-weight: 700;
    }
    #printReceiptArea {
        font-size: 13px;       /* was 12px */
        font-weight: 700;      /* was unset (400) */
        ...
    }
    #printReceiptArea * {
        color: #000 !important;
        opacity: 1 !important;
        text-shadow: none !important;
        box-shadow: none !important;
        background-image: none !important;
        ...
    }
}
```

`font-weight` is deliberately **not** forced with `!important` on the `#printReceiptArea *` wildcard rule — it inherits the 700 base, but the templates' own 900-weight TOTAL/header lines still win, preserving the visual hierarchy (TOTAL should look heavier than a regular item line, not identical to it). Opacity, text-shadow, box-shadow, and background-image are neutralised unconditionally with `!important` since a receipt should never have any of those regardless of what a future template change might add.

`printBrowserReceipt()`'s inline wrapper (used by both templates) was bumped from `font-weight:500; font-size:12px` to `font-weight:700; font-size:13px` to match.

### What was NOT touched

- Sale values, backend pricing, VAT calculation logic — untouched; only the VAT **label** text changed from `VAT (15%):` to `VAT incl.:` per the requested format, the underlying `r.sale.vat_amount` value is unchanged.
- Idempotency (`idempotencyKey` on offline sales) — untouched.
- Stock decrement RPC — untouched.
- No ESC/POS print agent was built — this fix only affects the browser `window.print()` path (`printBrowserReceipt`), which is what fires whenever no network thermal printer is configured or the app is offline.

### Tests

| Test | Result |
|---|---|
| Receipt print preview readable | Body text now bold (700) instead of default weight; all separators solid black |
| Thermal print text darker/bolder | `font-weight:700` base + explicit weights in every template row |
| TOTAL clearly visible | Isolated 18px/900-weight line between double dividers |
| VAT/payment breakdown visible | Both present, bold, unchanged position |
| Cashier/Till visible | Added to both online and offline templates |
| No console errors | `node --check` on the full extracted inline script passes; no new runtime dependencies added |
| No localStorage/sessionStorage business data | Confirmed via diff — zero new storage calls; existing `pos_paper_width` read is a pre-existing UI/print preference, not sale data |

---

## Remaining Printer Hardware Notes (not in scope this workstream)

Auditing `printReceipt()` surfaced a **separate, pre-existing** issue, out of scope for this fix per the ticket ("do not build print agent yet"):

`POST /api/receipts/print/:saleId` (used when a network thermal printer **is** configured, i.e. `activePrinterCount > 0`) returns `{ success: true, printData: {...} }`. The frontend's `printReceipt()` only checks for `result.method === 'thermal'` or `result.receiptHtml` — neither field exists in that response shape, so this path currently falls through to `showNotification(result.error || 'Print failed', 'error')` and always reports a failure even though the sale itself succeeded. This appears to be an incomplete stub for a future real ESC/POS print agent, not something this fix should touch. Flagged here so it isn't mistaken for "fixed" by this codebox — any store with a thermal printer actually registered under Settings → Receipt Printers should currently be relying on the browser-print fallback (`activePrinterCount === 0` or offline), which is the path this codebox fixed.

---

## Files Changed

| File | Change |
|------|--------|
| `accounting-ecosystem/frontend-pos/index.html` | `searchByBarcode()` — unconditional input clear; `printReceiptViaBrowser()` and `generateOfflineReceiptHtml()` — Cashier/Till rows, bolder/larger formatting, prominent TOTAL; offline `saleData` — capture `cashierName`/`tillName`; `printBrowserReceipt()` wrapper — bolder/larger; `@media print` CSS — bold base weight, shadow/opacity/gradient neutralisation |
| `accounting-ecosystem/backend/modules/pos/routes/receipts.js` | `GET /preview/:saleId` — additive `till_sessions` lookup for cashier name + till name/number |

No sale backend/RPC, stock decrement RPC, VAT calculation, or checkout flow changes.
