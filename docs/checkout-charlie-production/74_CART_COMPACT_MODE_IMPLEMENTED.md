# Codebox 74 — Cart Compact Mode + Sticky Total/Payment Area
## Checkout Charlie

**Status:** Implemented and verified (real headless-Chromium render test — see Verify section)
**Date:** 2026-07-06
**Reported symptom:** Current Sale cart panel showed only ~2 items before the cashier had to scroll.

---

## Before / After Cart Layout

**Before** — each cart item was two stacked rows inside a padded card:
```
┌──────────────────────────────────────┐
│  Product Name                    [X] │   ← row 1: name + remove
│                                       │
│  [-]  1  [+]            R78.26       │   ← row 2: qty + total
└──────────────────────────────────────┘
```
15px padding all around, 10px margin between cards, 35px-tall qty buttons → **~105px per item**. In a typical cart panel height, only ~2 items fit before scrolling.

**After** — one flex row per item:
```
┌──────────────────────────────────────┐
│ Product Name…    [-] 1 [+]  R78.26 [X]│
└──────────────────────────────────────┘
```
6px/8px padding, 4px margin, 30px qty buttons → **~42px per item** (confirmed by direct measurement in a real browser render, see Verify section) — roughly 2.5× more items fit in the same panel height.

---

## CSS / Classes Changed

All new rules are **additively scoped under a new `.cart-item-compact` class** — nothing under the bare `.cart-item`, `.item-name`, `.qty-btn`, `.qty-display`, `.item-total`, `.item-remove`, `.cart-item-controls`, `.qty-controls`, or `.cart-item-header` selectors was modified or removed. Those base rules are still used by `updateCartWithQtyInput()` — a second cart-rendering function that exists in the file but has **zero call sites anywhere** (confirmed by grep — genuinely dead code, not something this workstream introduced or was asked to touch). Leaving the base rules untouched means that dead function's appearance is completely unaffected either way; only the active `updateCart()` path, which now renders `class="cart-item cart-item-compact"`, picks up the new compact styling via the higher-specificity `.cart-item.cart-item-compact` / `.cart-item-compact .qty-btn` etc. selectors.

New CSS block (added after `.empty-cart`):
- `.cart-item.cart-item-compact` — `display:flex; flex-wrap:wrap; align-items:center;` single-row layout, padding 15px→6px/8px, margin-bottom 10px→4px.
- `.cart-item-compact .item-name` — `flex:1 1 80px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;` — this is what makes long product names truncate with an ellipsis instead of wrapping or pushing the row wider.
- `.cart-item-compact .cart-item-controls` — wraps qty controls + total + remove button as one `flex:0 0 auto` group, so they stay together and move to their own line as a unit if the row is too narrow, rather than each piece wrapping independently.
- `.cart-item-compact .qty-btn` — 35px → 30px square (still a real touch target, not shrunk to the point of being fiddly).
- `.cart-item-compact .item-remove` — now a fixed 26×26px square (was `padding:5px 10px` with no fixed size).
- `@media (max-width:380px)` — on very narrow POS/PWA windows, `.item-name` takes the full row width and the controls group wraps below it, so nothing overflows horizontally.
- `.cart-header { flex-shrink: 0; }` — added defensively. `.cart-summary` and `.checkout-section` already had `flex-shrink: 0` (this was already correct, pre-existing structure — see Sticky Areas below); the header was the one piece of the flex chain missing it.

## Functions Touched

- **`updateCart()`** — the only function actually modified. The cart-item template string changed from the two-block (`cart-item-header` + `cart-item-controls`) markup to the single-row compact markup, and the element's class changed from `cart-item` to `cart-item cart-item-compact`. `removeItem(${item.productId})` and `updateQty(${item.productId}, ±1)` — the exact same handlers, same arguments — are still wired to the same buttons; only their position in the markup changed (remove button moved from the start of the row to the end, next to the total, matching the ticket's preferred layout).
- **`updateQty()`, `removeItem()`, `clearCart()`** — **not modified at all.** The qty-1-triggers-removal logic (`if (item.quantity <= 0) removeItem(productId);`) lives entirely in `updateQty()`, untouched.
- **Totals calculation** (`subtotal`/`vat`/`total` inside `updateCart()`) — **not modified.**
- **`checkout()`, `selectPayment()`, `toggleSplitPayment()`, `updateSplitRemaining()`** — **not touched.**

## Sticky Total/Payment Area — Already Structurally Correct

Auditing the existing CSS before making any change found that the sticky behavior the ticket asks for was **already built**, just never verified as such: `.cart-panel` is `display:flex; flex-direction:column;` inside `.till-grid` (a `display:grid; height:100%`) inside `.till-interface` (`height:calc(100vh - 50px); overflow:hidden`). Within that fixed-height column, `.cart-items` is the only child with `flex:1; overflow-y:auto`, while `.cart-summary` (totals) and `.checkout-section` (payment buttons + Complete Sale) both already had `flex-shrink:0`. That combination is exactly what pins the totals/payment footer in place while only the item list scrolls — it just wasn't obvious it was already working because the oversized cart items meant the list barely ever needed to scroll to see the effect. The only real gap found was `.cart-header` lacking `flex-shrink:0`; added it for completeness, though in practice its content never grows enough to need it.

**No JavaScript was needed for the sticky behavior** — it's pure CSS flexbox, already in place.

---

## Behaviour Preserved

- Plus button increases quantity — same `updateQty(id, 1)` call, verified.
- Minus button decreases quantity — same `updateQty(id, -1)` call, verified.
- Quantity reaching 0 via minus removes the line — same `updateQty()` internal logic, verified (10 items → 9 after minus-to-zero on the first item).
- Explicit remove (✕) button — same `removeItem()` call, verified (9 items → 8 after clicking ✕).
- Totals update immediately — unchanged calculation inside `updateCart()`.
- Selected payment method styling (`.payment-btn.selected`) — untouched, still inside the unmodified `.checkout-section`.
- Split payment button/section — untouched, still inside `.checkout-section`.
- `checkoutInProgress` lock, `forceUpdatePending`/`tillLocked` guards — none of these live in `updateCart()`, `updateQty()`, or `removeItem()`; not touched.
- No duplicate cart rows — each product still gets exactly one `.cart-item` element; the merge-by-`productId` logic in `addToCart()` (fixed in the earlier scan-quantity workstream) is completely unrelated to this rendering change and was not touched.

---

## Known UX Tradeoffs

- **Item names truncate with `title="…"` tooltip** on hover/long-press rather than wrapping to a second line — a deliberate tradeoff to keep every item to a single row. A cashier needing the full name for an ambiguous truncated item can hover (desktop/mouse) or long-press (touch, where supported) to see it via the native tooltip.
- **Quantity buttons are 30px (down from 35px)** — smaller than the 44px many touch-target guidelines recommend, but the ticket explicitly prioritized fitting more items over maximizing button size, and 30px is still a real, usable square button, not a tiny icon. If this proves too small in practice, the number is isolated to one CSS rule (`.cart-item-compact .qty-btn`) and easy to bump back up.
- **On very narrow widths (`<380px`)**, the controls group (qty + total + remove) wraps to its own line below the name — items become 2-line again in that specific case rather than overflowing horizontally. This only affects unusually narrow windows; normal POS/tablet/desktop widths stay single-line.
- **Pre-existing, not introduced by this change**: `.checkout-section` (payment buttons + split-payment panel + account-customer panel + Complete Sale) has no scroll of its own — if a cashier opens Split Payment *and* Account Customer selection simultaneously, that section grows and eats into `.cart-items`'s available space (since `.cart-items` is the only flexible region). This was already true before this workstream and is out of scope to fix here.
- **`updateCartWithQtyInput()`** — an unreachable, unused alternate cart renderer (uses an editable qty `<input>` instead of a plain quantity display) was left completely untouched, including its old two-row markup and reliance on the un-modified base CSS classes. If it's ever wired up in the future, it will render in the old (non-compact) style; that's a pre-existing fact of the codebase, not a new inconsistency introduced here.

---

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | New `.cart-item-compact` CSS block (additive, ~85 lines); `.cart-header` gained `flex-shrink:0`; `updateCart()`'s cart-item template restructured to a single compact row |

No backend files touched. No changes to `create_sale_atomic`, stock logic, totals calculation, or any report endpoint.
