# SESSION HANDOFF — 2026-08-02 — POS: Checkout screen rework

## What was requested

Four related requests for the till screen, aimed at decluttering the top
of the cart panel and reducing unauthorized use of "Paid Out":

1. Move **Paid Out** out of its unrestricted spot in the cart header into
   the "Manage Till" flow, gated behind manager PIN authorization.
2. Put a **Discount** trigger in Paid Out's old spot — click to open,
   enter a %.
3. Move the **Customer** search/select block up to that same header area.
4. Press-and-hold the cart line's "+" button to type a quantity directly.

## What was built

| File | Change |
|---|---|
| `backend/modules/pos/routes/managerAuth.js` | Added `'payout'` to `ACTION_TYPES`, updated the error message/JSDoc. |
| `backend/modules/pos/services/managerAuthConsumer.js` (new) | Extracted `consumeManagerAuthorization()` out of `sales.js` (unchanged body) so `cashPaidOuts.js` can reuse it instead of duplicating the `pos_manager_authorizations` lookup. |
| `backend/modules/pos/routes/sales.js` | Imports `consumeManagerAuthorization` from the new shared service instead of defining it locally. Its 3 existing callers (discount, void, return) are unchanged. |
| `backend/modules/pos/routes/cashPaidOuts.js` | `POST /:id/paid-out` keeps `requirePermission('TILLS.PAID_OUT')` as the broad base gate (unchanged), and now layers manager-PIN authorization on top exactly like `authorizeManualDiscount()` does: a `SUPERVISOR_ROLES` requester self-authorizes, anyone else needs a matching unused, unexpired `pos_manager_authorizations` row (`action_type: 'payout'`) or gets a 403. |
| `frontend-pos/index.html` | **Paid Out button removed** from the cart header entirely. `manageSession()`: when a session is open, now shows a new `#manageTillModal` ("💰 Record Payout" / "🔒 Close Till") instead of immediately firing the close-session `confirm()`. "Close Till" fires the exact same close-session flow as before, just behind a button now. "Record Payout" role-checks against `SUPERVISOR_TIER_ROLES_FOR_RETURN` (same tier Void/Return already use) — self-serve if supervisor-tier, else `requestManagerPinAuth({ actionType: 'payout', ... })` then `showCashPaidOutModal()` (unchanged modal). Opening a shift (no session yet) is untouched. **Discount and Customer** moved into two new click-to-expand header popovers (`#discountPopoverWrap`/`#customerPopoverWrap`), reusing the existing `paymentMoreBtn`/`paymentMorePanel` pattern but opening downward instead of upward. The existing `#manualDiscountSection`/`#accountCustomerSection` blocks moved in the DOM as-is inside these popovers — same IDs, same inner markup, same JS (`applyManualDiscount()`, `searchAccountCustomers()`, etc.) untouched, so the 3 external call sites that directly toggle `accountCustomerSection.style.display` (`selectPayment()`, `toggleSplitPayment()` ×2) keep working unmodified. Trigger buttons show a live summary once active ("🏷️ 10% off", "👤 John Doe"). `#promoCodeSection` untouched, stays where it was. **Long-press "+"**: new `startQtyHold()`/`cancelQtyHold()`/`handleQtyPlusClick()`/`promptQuantity()` — holding "+" ~550ms opens a `prompt()` to type a quantity directly (matches the app's existing "type a number" convention used everywhere else — till balances, loyalty points, account payments); a normal tap still increments by 1. Serial-tracked cart lines are excluded (quantity is derived from scanned serials, not typed) — long-press is a no-op there, normal tap still opens the serial picker as before. |

### Design notes

- **`TILLS.PAID_OUT` permission itself is unchanged** (still every role except trainee) — the fix is layering PIN-authorization on top, the same architecture already proven for the manual discretionary discount (`SALES.CREATE` stays broad too). This was a deliberate choice to mirror an existing, working pattern rather than invent a new permission-tightening approach.
- **Bypass tier for Payout is `SUPERVISOR_ROLES`/`SUPERVISOR_TIER_ROLES_FOR_RETURN`**, not the narrower `MANAGEMENT_ROLES`/`MANAGEMENT_TIER_ROLES_FOR_DISCOUNT` — matches Void/Return (the most recent precedent for "sensitive till action" bypass), not the discount-specific narrower list.
- **Header popovers are written dark-native from the start** (`var(--surface)`/`var(--border)`/`var(--text)`) — unlike `payment-more-btn`/`payment-more-panel`, which still carry their original hardcoded light colors from before this file's dark-theme retrofit (out of scope for this change, not touched).
- **No new modal component for quantity entry** — deliberately uses `prompt()` to match this app's existing, consistent "type a number quickly" convention (confirmed via research: used for till balances, loyalty points, account payments — no custom numeric-entry modal exists anywhere in this file). The pre-existing dead code `updateCartWithQtyInput()`/`setQty()` (a full-cart-rebuild anti-pattern, unreachable, zero callers) was left untouched, not resurrected.

## Confirmed working

- `node -c` on all 4 touched/new backend files — all pass.
- `npx eslint` (scoped `no-undef`-as-error config) on all 4 — 0 errors, 0 warnings.
- All 3 inline `<script>` blocks in `frontend-pos/index.html` syntax-checked via `new Function()` extraction — 0 errors.
- No duplicate static element IDs (confirmed via scripted check; the only duplicates found are expected dynamic template-literal placeholders like `${p.id}`, not real IDs).
- Confirmed exactly one `#manualDiscountSection` and one `#accountCustomerSection` remain in the file (old copies fully removed, not just hidden).

## What was NOT tested

No live Supabase/browser access this session. Specifically untested:

- A real payout by a supervisor-tier user (should go straight through, no PIN prompt).
- A real payout by a regular cashier (should show the PIN modal, and 403 server-side if the PIN modal is somehow bypassed without a valid consumed authorization).
- The Manage Till modal's "Close Till" button still closing a session correctly end-to-end (logic is unchanged from before, but the trigger path changed).
- The Discount/Customer popovers opening/closing correctly on a real touchscreen till, including the "close on outside click" behavior and that they don't visually overlap or get clipped at the top of a real viewport.
- Long-press quantity entry on a real touch device — the 550ms threshold and touch event handling (`touchstart`/`touchend`/`touchcancel`) have never been tested against real touchscreen hardware, only reasoned about from the code.
- That `selectPayment()`/`toggleSplitPayment()`'s direct `accountCustomerSection.style.display` toggling still behaves correctly now that the element lives inside a popover panel that has its own independent open/close state.

## Deployment status

**Committed locally, NOT pushed yet** — per CLAUDE.md Rule G1, must be
freshly confirmed as quiet before pushing.

## FOLLOW-UP NOTE

- Area: Checkout screen rework (Payout/Discount/Customer/quantity)
- Dependency: real browser + touch-device access to verify the popover layout, long-press timing, and the full payout PIN-authorization round-trip.
- Not yet confirmed: whether 550ms is the right long-press threshold for this till hardware (the `.qty-btn` touch target is only 30×30px per the compact cart-item CSS — worth watching for accidental long-press triggers or missed long-presses on first live use).
- Risk if not checked: worst case for the popover relocation is a visual/layout issue (clipped panel, overlap) — not a data-integrity risk, since none of the underlying discount/customer logic changed, only its position in the DOM. Worst case for the payout gate is a legitimate cashier hitting an unexpected PIN prompt — annoying, not unsafe, since the server-side check fails closed (403) rather than open.
- Recommended next check: once pushed, on the sandbox company (Infinite Legacy — TEST, per CLAUDE.md Part H), open a till session, try Record Payout as both a regular cashier and a supervisor-tier login, and try the long-press quantity entry on the actual till tablet hardware.
