# Codebox 66 — Till Layout Fix + User Product Shortcuts
## Checkout Charlie

**Status:** Implemented  
**Date:** 2026-06-25  
**Scope:** Fixed scrolling till layout; added per-user server-backed product shortcuts

---

## What Was Implemented

### 1. CSS Layout Fix — Current Sale Panel No Longer Scrolls

**Root cause:** `.products-panel` and `.cart-panel` had no `overflow: hidden` or `min-height: 0`, so CSS Grid allowed them to grow to fit their content (2600+ products = very tall). The right panel (cart/Current Sale) scrolled with the product grid.

**Fix applied to `frontend-pos/index.html` CSS:**

| Selector | Change |
|----------|--------|
| `.main-container` | Added `overflow: hidden` |
| `.till-interface` | Changed `height: 100%` → `height: calc(100vh - 50px)`; added `overflow: hidden` |
| `.till-grid` | Added `overflow: hidden` |
| `.products-panel` | Added `overflow: hidden; min-height: 0` |
| `.cart-panel` | Added `overflow: hidden; min-height: 0` |
| `.cart-summary` | Added `flex-shrink: 0` |
| `.checkout-section` | Added `flex-shrink: 0` |

**Why `min-height: 0`:** CSS Grid children default to `min-height: auto`, which allows them to grow beyond their grid track. Setting `min-height: 0` lets `overflow: hidden` take effect and constrains each panel to its grid allocation.

**Why `height: calc(100vh - 50px)` instead of `height: 100%`:** Percentage heights require an explicitly-sized parent. The old `height: 100%` depended on a fragile chain; the explicit calc is self-contained and immune to parent structure changes.

**No other layouts affected:** `.settings-layout`, `.cashUpLayout`, `.reportsLayout`, and `.dashboardLayout` are unchanged — they have their own height/scroll management.

---

### 2. Category Chips — "Produksie" Removed, Shortcuts Added

**`renderCategories()` updated:**
- Skips any category where `cat.toLowerCase() === 'produksie'` — legacy dev category, never visible to cashiers
- "All" label explicitly capitalised (was relying on `.charAt(0).toUpperCase()` which happened to work)
- "★ Shortcuts" chip always appended as the last chip

---

### 3. Product Shortcuts — Per-User, Per-Company, DB-Backed

**No localStorage. No sessionStorage. Server is source of truth.**

#### Database

New table added to `pos-schema.js` (auto-migrated on server startup):

```sql
CREATE TABLE IF NOT EXISTS pos_user_product_shortcuts (
    id          SERIAL PRIMARY KEY,
    company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sort_order  INTEGER DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, user_id, product_id)
);
```

Indexed on `(company_id, user_id)` and `(company_id, user_id, sort_order)`.

#### Backend Routes (`backend/modules/pos/routes/shortcuts.js`)

Mounted at `/api/pos/shortcuts` in `pos/index.js`.

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/api/pos/shortcuts`               | List current user's shortcut product_ids |
| `POST`   | `/api/pos/shortcuts`               | Add shortcut (idempotent upsert) |
| `DELETE` | `/api/pos/shortcuts/:product_id`   | Remove shortcut |
| `PATCH`  | `/api/pos/shortcuts/reorder`       | Update sort order |

All routes scoped to `req.companyId` + `req.user.userId` from JWT. POST validates that `product_id` belongs to `req.companyId`.

#### Frontend State

```javascript
let shortcutIds = new Set();   // in-memory only — cleared on logout, populated from server
```

**On login:** `await loadShortcuts()` fires BEFORE `loadProducts()` — guarantees correct star state on first product render.

**`loadShortcuts(reRender?)`:** Fetches `/api/pos/shortcuts`, rebuilds `shortcutIds` Set, optionally re-renders the grid with correct star state.

**`toggleShortcut(productId, btnEl)`:** POST/DELETE to server, updates `shortcutIds`, toggles `.starred` class on the button. If in Shortcuts view and a star is removed, grid re-renders immediately to drop the tile.

#### Product Card Star Button

Every product tile now has a `★` button (top-right, absolute positioned):
```html
<button class="shortcut-star [starred]"
        onclick="event.stopPropagation(); toggleShortcut(id, this)">★</button>
```

`event.stopPropagation()` prevents the delegated click on `#productsGrid` from also calling `addToCart`. The `addToCart` path via event delegation never fires when the star is clicked.

#### Shortcuts View

Clicking "★ Shortcuts" chip:
1. Sets `selectedCategory = '__shortcuts__'`
2. Immediately renders `products.filter(p => shortcutIds.has(p.id))` (instant — no server round-trip)
3. Fires `loadShortcuts(true)` in the background to refresh and re-render with latest server state

---

## Security Constraints (Enforced)

| Constraint | Implementation |
|------------|---------------|
| No localStorage/sessionStorage | `shortcutIds` is in-memory Set only |
| Always query with company_id + user_id | All DB queries scoped to JWT claims |
| Backend validates product ownership | POST checks `products.company_id = req.companyId` |
| Never trust frontend company_id | All IDs come from `req.companyId` / `req.user.userId` (JWT) |
| No cart/payment/cashup logic touched | Only product grid, categories, and shortcut state changed |
| Totals, EFT, cash-up, offline sync unchanged | Zero changes to cart, checkout, reconciliation code |

---

## Files Changed

| File | Type | Change |
|------|------|--------|
| `backend/config/pos-schema.js` | Modified | Added `pos_user_product_shortcuts` table + indexes |
| `backend/modules/pos/routes/shortcuts.js` | **New** | GET/POST/DELETE/PATCH shortcuts endpoints |
| `backend/modules/pos/index.js` | Modified | Mounted shortcuts at `/shortcuts` |
| `frontend-pos/index.html` | Modified | CSS layout fix + star button + shortcuts JS |

---

## Known Prerequisite

`pos_user_product_shortcuts` table requires `DATABASE_URL` (direct pg) for auto-migration via `ensurePosSchema()`. If `DATABASE_URL` is not set in Zeabur, the table must be created manually in the Supabase SQL editor using the DDL above.
