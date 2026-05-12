# 09 — STOCK POLICY SETTINGS IMPLEMENTED
## Checkout Charlie — Workstream 3A

**Date:** 2026-05-12  
**Status:** ✅ Implemented  
**Migration:** `030_pos_stock_policy.sql`

---

## Why This Exists

Manufacturing and assembly clients often sell products before all stock transfers or production receipts are captured. Under strict stock protection (`allow_negative_stock_sales = false`), the POS blocks every sale the moment stock hits zero — even if physical inventory exists and the database just hasn't been updated yet. This makes the system unusable for these businesses.

The `allow_negative_stock_sales` setting adds a company-level toggle. Default is `false` — the existing strict protection applies to every company that has not explicitly enabled it. Only businesses that deliberately need negative stock sales can unlock it, and only a manager-level user can do so.

---

## Schema

### `company_settings` — new column

```sql
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS allow_negative_stock_sales BOOLEAN NOT NULL DEFAULT false;
```

| Column | Type | Default | Meaning |
|---|---|---|---|
| `allow_negative_stock_sales` | BOOLEAN | `false` | When `true`, sales may drive `products.stock_quantity` below zero. Strict mode applies when `false`. |

The column lives in the existing `company_settings` table (POS-specific settings, one row per company, UNIQUE on `company_id`). No new table was required.

---

## Database Functions

### `decrement_stock_v2(p_product_id INT, p_quantity INT, p_allow_negative BOOLEAN DEFAULT false)`

New function. Does NOT replace `decrement_stock` (migration 024 — left unchanged).

| Mode | Condition | Behaviour |
|---|---|---|
| `p_allow_negative = false` | Stock sufficient | Atomic decrement (identical to `decrement_stock`) |
| `p_allow_negative = false` | Stock insufficient | `RAISE EXCEPTION 'Insufficient stock...'` → rolls back |
| `p_allow_negative = true` | Any stock level | Unconditional decrement — stock may go negative |
| Either mode | Product row missing | `RAISE EXCEPTION 'Product not found'` → rolls back |

### `create_sale_atomic` — updated signature

**Old (migration 027):** 15 parameters, called `decrement_stock`  
**New (migration 030):** 16 parameters (added `p_allow_negative_stock BOOLEAN DEFAULT false`), calls `decrement_stock_v2`

The migration drops the 15-parameter overload before installing the 16-parameter version to avoid PostgREST ambiguity (`could not choose the best candidate function`).

The `DEFAULT false` on `p_allow_negative_stock` means callers that don't pass the flag get strict behaviour — backward compatible.

The function now returns `negative_stock_allowed: boolean` in the JSONB result for observability.

---

## Default Behaviour (allow_negative_stock_sales = false)

Identical to the behaviour before this workstream:

1. Backend pre-check: `stock_quantity < quantity` → `422 Stock check failed`
2. If pre-check passes, `create_sale_atomic` calls `decrement_stock_v2(..., false)`
3. `decrement_stock_v2` strict path: atomic compare-and-decrement, raises if stock insufficient
4. Frontend: `addToCart` blocks at `existing.quantity >= availableStock`
5. Frontend: `updateQty` caps at `item.maxStock`
6. No change in cashier experience

---

## Negative Stock Behaviour (allow_negative_stock_sales = true)

### Backend

1. Sales route fetches `allow_negative_stock_sales` from `company_settings` at every sale — DB-authoritative, not from frontend headers or body.
2. Pre-check passes for insufficient items (they are tracked in `negativeStockItems`).
3. `NEGATIVE_STOCK_SALE_ALLOWED` audit event fired per item that will go negative (before the RPC call).
4. `create_sale_atomic` called with `p_allow_negative_stock: true`.
5. `decrement_stock_v2` unconditionally decrements each item — stock may go negative.
6. After successful sale, `NEGATIVE_STOCK_CREATED` audit event fired per item that went negative.
7. Sale response is identical to a normal completed sale.

### Frontend

1. `loadCompanySettings()` called on login — fetches `/api/pos/settings`, stores `companyStockPolicy.allowNegativeStock`.
2. **Product tile display:**
   - `stock_quantity < 0` → `.stock-negative` class (red background, `⚠` suffix)
   - `stock_quantity === 0` AND policy allows negative → `.stock-zero-neg` class (amber, "Out of stock (neg. allowed)")
   - Normal otherwise
3. **`addToCart()`:**
   - Existing item at max stock AND policy allows negative → increment + warning toast
   - New item with stock ≤ 0 AND policy allows negative → warning toast, add to cart
   - `maxStock` set to `999999` (no meaningful frontend cap) in negative-stock mode
4. **`updateQty()`:** unchanged — `item.maxStock = 999999` prevents cap triggering in negative-stock mode

### Warning Notification

The same `showNotification(..., 'error')` function is used for the warning. The 'error' type shows a red notification — this is intentional, matching the visual severity of a negative stock sale. Future work could add a dedicated 'warning' type.

---

## API Endpoints

### GET `/api/pos/settings`
- Auth: all authenticated POS users (`SETTINGS.VIEW`)
- Returns current `company_settings` row
- Creates a default row if none exists (idempotent — handles race via `23505` catch + re-fetch)
- Response: `{ settings: { allow_negative_stock_sales: false, ... } }`

### PUT `/api/pos/settings/stock-policy`
- Auth: MANAGEMENT roles only (`SETTINGS.EDIT` — `business_owner`, `practice_manager`, `administrator`)
- Body: `{ "allow_negative_stock_sales": true }`
- Upserts `company_settings`, fires `STOCK_POLICY_CHANGED` audit event (awaited)
- Response: `{ settings: {...}, message: "Negative stock sales ENABLED..." }`
- Rejects if body value is not a boolean (type validation)

---

## Audit Events

### `STOCK_POLICY_CHANGED`
Fired when an admin changes `allow_negative_stock_sales`.

| Field | Value |
|---|---|
| `action_category` | `settings` |
| `entity_type` | `company_settings` |
| `entity_id` | company_id |
| `before_snapshot` | `{ allow_negative_stock_sales: <old value> }` |
| `after_snapshot` | `{ allow_negative_stock_sales: <new value> }` |
| `metadata` | `{ changed_by_email, changed_by_role }` |

**Awaited** in the settings route — the audit confirmation lands before the HTTP response is sent.

### `NEGATIVE_STOCK_SALE_ALLOWED`
Fired per item that will go negative — before the sale is created (pre-RPC).

| Field | Value |
|---|---|
| `action_category` | `inventory` |
| `product_id` | the product going negative |
| `metadata` | `{ product_name, current_stock, quantity_sold, projected_stock }` |

Fire-and-forget. Multiple events fire if multiple items in the same sale go negative.

### `NEGATIVE_STOCK_CREATED`
Fired per item after a successful sale confirmed stock went below zero (post-RPC, new sales only).

| Field | Value |
|---|---|
| `action_category` | `inventory` |
| `sale_id` | the confirmed sale_id |
| `product_id` | the product that went negative |
| `metadata` | `{ product_name, stock_before, quantity_sold, stock_after, sale_number }` |

Fire-and-forget. This event is the forensic record that a specific sale caused a specific product to reach a specific negative quantity.

---

## Security and Permission Rules

| Action | Required role |
|---|---|
| View company settings | Any authenticated POS user |
| Change stock policy | `business_owner`, `practice_manager`, `administrator` |
| Cashier create sale (negative stock enabled) | Same as normal sale — no extra permission |
| Cashier create sale (negative stock disabled) | Same as normal — 422 if stock insufficient |

**The frontend cannot bypass the stock policy.** The sales route fetches `allow_negative_stock_sales` from the database at every sale creation. Even if a client forges the request without the frontend, the policy check happens server-side against the `company_settings` table.

**Cashiers are never prompted to "override" stock.** When negative stock is enabled, the system transparently allows the sale with a warning. When it is not, the system blocks the sale — no cashier-level override path exists. Overrides are a future workstream (see FOLLOW-UP NOTES).

---

## Pilot Business Use Cases

### Manufacturing / Assembly
- Production receipts arrive days after the production run
- Stock is physically present but not yet in the database
- Negative stock sales allow the business to continue operations without waiting for receipts
- Finance team catches up the stock transfers in batch

### Distribution / Forwarding
- Client places order, stock is on the way, sale needs to be processed now
- Negative stock allows the POS sale to proceed; stock is corrected when goods arrive

### High-volume retail with batch stock adjustments
- Stock adjustments are done weekly rather than per-item
- Intra-week sales may go slightly negative on fast-moving items
- Weekly reconciliation brings stock back to correct levels

---

## Files Changed

| File | Change |
|---|---|
| `database/migrations/030_pos_stock_policy.sql` | NEW — ALTER TABLE, decrement_stock_v2, updated create_sale_atomic |
| `backend/modules/pos/services/posAuditLogger.js` | Added 3 new POS_EVENTS + EVENT_CATEGORY entries |
| `backend/config/permissions.js` | Added `SETTINGS: { VIEW: ALL_ROLES, EDIT: MANAGEMENT_ROLES }` |
| `backend/modules/pos/routes/settings.js` | NEW — GET /settings, PUT /settings/stock-policy |
| `backend/modules/pos/index.js` | Added `require('./routes/settings')` + mount `/settings` |
| `backend/modules/pos/routes/sales.js` | Fetch policy, conditional pre-check, pass flag to RPC, audit events |
| `frontend-pos/index.html` | CSS, companyStockPolicy var, loadCompanySettings(), addToCart, displayProductsGrid |

---

## What Was NOT Changed

- `decrement_stock` (migration 024) — completely untouched, still used as strict-mode reference
- `complete-cashup` route and recon snapshot logic — untouched
- Existing 422 response for strict mode — unchanged
- All existing product routes, inventory routes, categories — untouched
- No localStorage or sessionStorage used for the stock policy

---

## Remaining Risks and Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Negative stock visibility in management reports
- What was done: NEGATIVE_STOCK_CREATED audit events are written per sale
- Not yet confirmed: Whether the existing inventory / stock reports surface
                     products with stock_quantity < 0 visually.
- Risk if not checked: A manager looking at inventory reports may not immediately
                       see which products are in negative territory.
- Recommended next: Add a "Negative Stock" filter / warning badge to the
                    inventory tab (Workstream 3B candidate).
```

```
FOLLOW-UP NOTE
- Area: Cashier-level manager override for negative stock (future)
- What was done: No per-sale override path — policy is company-wide
- Not yet confirmed: Whether pilot businesses need a "manager pin override"
                     per transaction for strict-mode companies where one-off
                     exceptions are needed.
- Risk if not checked: Strict-mode businesses have no escape valve for urgent
                       edge cases.
- Recommended next: Design manager override flow (MANAGER_OVERRIDE_USED event
                    is already in POS_EVENTS — route not yet wired).
```

```
FOLLOW-UP NOTE
- Area: showNotification 'warning' type
- What was done: Negative stock warnings use showNotification(..., 'error')
                 because only 'success' | 'error' | 'info' types exist.
- Risk: Warning colour (red) is the same as genuine errors — cashier may
        conflate a negative stock warning with a blocking error.
- Recommended next: Add a 'warning' type (amber) to showNotification().
```

```
FOLLOW-UP NOTE
- Area: Offline mode + negative stock policy
- What was done: companyStockPolicy is loaded at login and kept in memory.
                 If the cashier goes offline after login, the in-memory policy
                 is still correct for the session.
- Risk: If the policy is changed by a manager while a cashier is offline,
        the cashier's in-memory policy will be stale until next login.
- Recommended next: Consider refreshing policy on reconnect (online event handler).
```

---

## Verification Checklist

- [x] Default company (`allow_negative_stock_sales = false`) still blocks negative stock (422)
- [x] Allowed company (`allow_negative_stock_sales = true`) permits negative stock sale
- [x] `decrement_stock_v2` with `p_allow_negative = true` decrements unconditionally
- [x] `decrement_stock_v2` with `p_allow_negative = false` identical to `decrement_stock`
- [x] `create_sale_atomic` drop + re-create avoids PostgREST overload ambiguity
- [x] `STOCK_POLICY_CHANGED` event written and awaited on PUT /settings/stock-policy
- [x] `NEGATIVE_STOCK_SALE_ALLOWED` fires before RPC, per affected item
- [x] `NEGATIVE_STOCK_CREATED` fires after RPC, per confirmed negative item
- [x] Policy fetched from DB on every sale — frontend cannot override
- [x] `loadCompanySettings()` called before `loadProducts()` in `completeLogin()`
- [x] Negative stock tile shows `.stock-negative` (red + ⚠)
- [x] Zero stock with policy enabled shows `.stock-zero-neg` (amber)
- [x] `addToCart` shows warning and allows when policy is enabled
- [x] `addToCart` blocks with 'error' when policy is disabled (unchanged)
- [x] `maxStock = 999999` prevents frontend cap in negative-stock mode
- [x] No localStorage or sessionStorage used for policy data
