# Codebox 76 — Simplify Visible Payment Methods
## Checkout Charlie

**Status:** Implemented and verified (real headless-Chromium test — see Verify section)
**Date:** 2026-07-07
**Reported symptom:** The checkout payment area showed 8 buttons at once (Cash, Card, EFT, Account, SnapScan, Zapper, Gift Card, Split), taking too much space and slowing checkout.

---

## Old Layout

```
┌────────┬────────┬────────┬────────┐
│ 💵Cash │ 💳Card │ 🏦EFT  │ 👤Acct │
├────────┼────────┼────────┼────────┤
│📱Snap  │ ⚡Zapper│🎁Gift  │ ✂️Split│
└────────┴────────┴────────┴────────┘
```
Single 4-column grid, all 8 methods equally weighted and equally small (`padding: 8px 4px; font-size: 11px`).

## New Layout

```
┌──────────────┬──────────────┐
│   💵 Cash     │   💳 Card     │
├──────────────┼──────────────┤
│  👤 Account   │  ✂️ Split     │
└──────────────┴──────────────┘
┌──────────────────────────────┐
│           ⋯ More              │
└──────────────────────────────┘
        ↑ click opens ↑
┌──────────────────────────────┐
│  🏦 EFT       │  📱 SnapScan  │
├──────────────┼──────────────┤
│  ⚡ Zapper    │  🎁 Gift Card │
└──────────────────────────────┘
```
2×2 grid of larger buttons (`padding: 14px 8px; font-size: 13px`, icon bumped from 18px to 22px) for the 4 standard methods, plus a dashed "More" button below that opens an upward-sliding popover (`.payment-more-panel`, positioned `bottom: calc(100% + 6px)` so it doesn't collide with the Complete Sale button beneath it) containing the 4 secondary methods in their own 2×2 grid.

## Primary Methods (always visible)

Cash, Card, Account, Split — unchanged `onclick="selectPayment(...)"` / `onclick="toggleSplitPayment()"` handlers, unchanged `payment-btn` class and `selectPayment()` value strings (`'CASH'`, `'CARD'`, `'ACCOUNT'`). Only the CSS (`.payment-methods-primary`) and the surrounding HTML changed.

## Secondary Methods (behind "More")

EFT, SnapScan, Zapper, Gift Card — same buttons, same `onclick="selectPayment('EFT', this)"` etc., same `'EFT'` / `'SNAPSCAN'` / `'ZAPPER'` / `'GIFT_CARD'` value strings sent to `checkout()` and ultimately the backend. They were **moved**, not deleted, into `#paymentMorePanel`. Nothing about how a selection is processed changed — `selectPayment()`'s core logic (`selectedPayment = method`, deselect-all-then-select-one, close split payment, show/hide account section) is untouched; two lines were **added** to it, not replaced.

### Visible confirmation without the panel staying open

Since the secondary buttons disappear from view again once the popover closes, `selectPayment()` now also calls `syncPaymentMoreButton(method)`, which — only when the method is one of the 4 secondary ones — puts the "More" button into its own `.selected` state and swaps its label to show which one is active (e.g. "🏦 EFT" instead of "⋯ More"). Choosing a primary method or Split resets it back to neutral. This was verified directly (see Verify).

## Behaviour Preserved

- **Selected method styling** — same `.payment-btn.selected` mechanism, same "deselect all `.payment-btn` then select the one clicked" line in `selectPayment()`, completely unchanged. Secondary buttons keep the `.payment-btn` class specifically so this logic keeps working uniformly across all 8 methods without a separate code path.
- **Cash drawer logic** — `selectPayment()`/`checkout()`/`printReceipt()` were not touched beyond the two additive lines described above; whatever currently decides drawer-opening behavior (unrelated to this UI change) sees the exact same `selectedPayment` value strings it always did.
- **Split payment flow** — `toggleSplitPayment()` unchanged except for one added line (`syncPaymentMoreButton(null)`) that clears the More button's secondary-selected state when Split is activated, so the UI can't show two methods "selected" at once.
- **Account payment flow** — `selectPayment('ACCOUNT', ...)` still reveals `#accountCustomerSection` exactly as before; Account is one of the 4 always-visible primary buttons, not moved.
- **Totals, `checkoutInProgress`, Complete Sale button state, offline behaviour** — none of these are touched by this workstream at all.
- **Compact cart mode (Workstream 74)** and **global barcode scan capture (Workstream 75)** — neither the cart item markup/CSS nor the scan-capture/auto-refocus logic were touched. `refocusScanner()` is still called from `selectPayment()` for non-ACCOUNT methods, unchanged.

## No Backend Changes

Payment method values sent through `checkout()` to `POST /api/pos/sales` (and from there into `sale_payments`) are byte-identical strings to before — `'CASH'`, `'CARD'`, `'EFT'`, `'ACCOUNT'`, `'SNAPSCAN'`, `'ZAPPER'`, `'GIFT_CARD'`. This workstream only changed which DOM element the cashier clicks to set `selectedPayment` to one of them; the value itself, and everything downstream of it, is unchanged.

## Known Future Enhancement

**Company-configurable payment methods.** Which 4 methods count as "primary" is currently hardcoded (Cash/Card/Account/Split always visible; EFT/SnapScan/Zapper/Gift Card always behind More). Different stores likely have different actual usage patterns — a store that rarely takes Account payments but frequently uses SnapScan would benefit from choosing its own primary set. This would need a company-level setting (similar to the existing `company_settings` used elsewhere in this module) plus a small settings UI to reorder/promote methods, and was out of scope for this workstream (frontend-only, no new settings/backend surface requested). Documented here as the natural next step, not built.

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | New `.payment-methods-primary`, `.payment-more-btn`, `.payment-more-panel` CSS; payment-methods HTML restructured into a primary 2×2 grid + secondary popover; new `syncPaymentMoreButton()`, `toggleMorePayments()`, and a click-outside-closes listener; `selectPayment()` gained 2 lines (sync More button, close panel); `toggleSplitPayment()` gained 1 line (reset More button) |

No backend changes. No changes to `create_sale_atomic`, `sale_payments` logic, or any report endpoint.

---

## Verify Results (real headless-Chromium test)

| Scenario | Result |
|---|---|
| Only 4 primary buttons visible by default, secondary panel hidden | ✅ 4 visible, panel `display:none` |
| Cash selectable | ✅ `selectedPayment === 'CASH'` |
| Card selectable, shows `.selected` | ✅ confirmed |
| Account selectable, reveals customer section | ✅ `accountCustomerSection` becomes visible |
| Split selectable, activates split section | ✅ `splitPaymentMode === true`, section gets `.active` |
| More/Other opens secondary method selector | ✅ panel gains `.open` |
| EFT selectable from More/Other; panel closes after; More button shows "🏦 EFT" and `.selected` | ✅ all confirmed |
| SnapScan selectable from More/Other | ✅ `selectedPayment === 'SNAPSCAN'` |
| Zapper selectable from More/Other | ✅ `selectedPayment === 'ZAPPER'` |
| Gift Card selectable from More/Other | ✅ `selectedPayment === 'GIFT_CARD'` |
| Selecting a primary method after a secondary one resets the More button to neutral | ✅ `.selected` removed, label back to "⋯ More" |
| Click outside the popover closes it | ✅ confirmed |
| Console/page errors | ✅ none |
| localStorage/sessionStorage business data | ✅ confirmed via diff — zero new storage calls |

Not independently re-tested in this environment (no live server/database; unchanged code paths, verified by direct read instead): Complete Sale end-to-end against a real backend, cash-drawer-opens-only-for-cash (logic lives in `checkout()`/`printReceipt()`, neither of which this workstream touched), and the full split-payment allocation flow beyond activating the section (its internal amount-entry logic was not touched).
