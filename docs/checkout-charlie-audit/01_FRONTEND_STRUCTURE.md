# 01 — Frontend Structure

---

## 1. File Location

The entire POS frontend lives in one monolithic file:

```
Point of Sale/
└── POS_App/
    ├── index.html         ← 9,334-line monolithic SPA (entire app)
    ├── manifest.json      ← PWA manifest
    ├── service-worker.js  ← Offline caching + background sync (179 lines)
    ├── supabase-config.js ← Optional Supabase client config (may not be used by legacy)
    └── js/
        └── polyfills.js   ← Browser polyfills
```

There is **no separate frontend for the ecosystem POS module** (`accounting-ecosystem/backend/modules/pos/`).  
The `index.html` auto-detects its server via:
```javascript
const API_URL = window.location.origin + '/api';
```
This means it calls whichever server is hosting it.

---

## 2. Technology Stack

- **Vanilla JavaScript** — no frameworks, no bundler, no npm build step
- **Single HTML file** — all CSS, HTML, and JS inline in `index.html`
- **PWA** — service worker + `manifest.json` for installable offline-capable app
- **IndexedDB** — offline data caching and offline sale queue
- **CSS** — custom styles, no external CSS framework

---

## 3. Module-Level JavaScript State

All application state lives in JS variables (NOT localStorage):

```javascript
let token = null;              // JWT token (also stored in localStorage for persistence)
let currentUser = null;        // Logged-in user object
let currentSession = null;     // Active till session
let products = [];             // Products loaded from server
let cart = [];                 // Current sale cart items
let categories = new Set();    // Product category list
let selectedCategory = 'all';
let selectedPayment = 'CASH';
let editingProductId = null;
let currentTab = 'till';
let availableCompanies = [];
let selectedCompanyId = null;
let userRole = null;
let userPermissions = {};
let isOnline = navigator.onLine;
let db = null;                 // IndexedDB instance
```

**Key implication:** A page refresh clears cart, session, and products. The JWT token survives because it is also in localStorage.

---

## 4. Page / Screen Structure

The app has a multi-screen flow:

```
loginScreen              ← Initial login
companySelectorScreen    ← Multi-company selection (if user has >1 company)
[main POS app]           ← Tab-based interface after login
```

### Main App Tabs

| Tab | DOM id | Purpose |
|---|---|---|
| Till | `till` | Product grid, barcode scan, cart, checkout |
| Stock | `stock` | Inventory view, adjustments, stock take, daily discounts |
| Reports | `reports` | Sales, VAT, profit reports with date filter and CSV export |
| Cash Up | `cashup` | Denomination counting, session closure, variance |
| Loyalty | `loyalty` | Customer lookup, points, redemption |
| Analytics | `analytics` | Dashboard KPIs, charts, top products/cashiers |
| Settings | `settings` | Company info, till, receipt, VAT, barcode settings |
| Promotions | `promotions` | Promotions table |

---

## 5. POS Till Flow (UI Sequence)

1. Products loaded via `GET /api/pos/products` → rendered as grid cards
2. Category filter rendered from `categories` Set
3. Barcode scan or product click → `addToCart(productId, quantity)`
4. Cart renders in right panel: items, quantities, subtotals
5. Quantity up/down buttons, item removal
6. Daily discounts overlaid on product price if applicable
7. Customer search modal for account sales
8. Payment method buttons (CASH, CARD, EFT, ACCOUNT, SNAPSCAN, ZAPPER, GIFT CARD, SPLIT)
9. Cash payment: shows amount tendered + change calculation
10. SPLIT payment: allocate amounts across multiple methods
11. Checkout button → `POST /api/pos/sales` or `POST /api/pos/sales/split-payment`
12. On success: show receipt modal → optional print

---

## 6. Cart Logic

Cart is a JavaScript array (`cart = []`) of objects:
```javascript
{
  productId: number,
  productName: string,
  quantity: number,
  unitPrice: number,
  totalPrice: number,
  vatRate: number
}
```

- Adding same product increments quantity if `groupSameItems` is enabled
- Cart total is computed from sum of `item.unitPrice * item.quantity`
- VAT is computed and displayed separately
- Cart clears on: successful checkout, page refresh, logout

---

## 7. Payment Handling

### Single payment
```javascript
POST /api/pos/sales
{
  tillSessionId, items, paymentMethod, customerId
}
```

### Split payment
```javascript
POST /api/pos/sales/split-payment
{
  tillSessionId, items, customerId,
  payments: [{ method: 'CASH', amount: 100 }, { method: 'CARD', amount: 50 }]
}
```

The frontend tracks remaining balance during split payment allocation.

---

## 8. Cash-Up UI Flow

1. User navigates to Cash Up tab
2. Current open session loaded: `GET /api/pos/sessions?status=open`
3. Session sales totalled: `GET /api/pos/sessions/:id/sales`
4. Denomination entry: R200, R100, R50, R20, R10, R5, R2, R1, 50c, 20c, 10c, 5c
5. Actual cash auto-computed from denomination counts
6. Expected = opening_balance + total_sales
7. Variance = actual - expected (green if positive, red if negative)
8. Submit closes session: `POST /api/pos/sessions/:id/close`

---

## 9. Offline Functionality

### IndexedDB schema (`CheckoutCharliePOS`, version 1)

| Store | Key | Purpose | Authority |
|---|---|---|---|
| `products` | `id` | Server product cache | READ CACHE (not authoritative) |
| `customers` | `id` | Server customer cache | READ CACHE (not authoritative) |
| `offlineSales` | `tempId` (autoIncrement) | Pending offline sales queue | ⚠️ BUSINESS DATA |
| `sessionData` | `key` | Session key-value storage | Low-risk config |

### Offline sale lifecycle
1. Network fails → `isOnline = false` → show "Offline Mode" banner
2. Checkout attempted → `saveOfflineSale(saleData)` → stored in `offlineSales` store
3. `tempSaleNumber = 'OFFLINE-' + Date.now()` assigned (not a real sale number)
4. On reconnect: `syncOfflineSales()` POSTs each pending sale to `/api/pos/sales`
5. On server success: `markSaleSynced(tempId, serverSaleId)` marks it synced

**Risk:** If sync is never completed (device lost, browser cleared, app crash), the business-critical offline sales are permanently lost.

---

## 10. Service Worker

File: `POS_App/service-worker.js` (179 lines)

```
CACHE_NAME  = 'checkout-charlie-v1'
STATIC_CACHE = 'static-v1'
DATA_CACHE   = 'data-v1'

Cached static: ['/', '/index.html', '/manifest.json']
Cached API:    ['/api/pos/products', '/api/customers']
```

Strategy:
- Static files: cache-first, background refresh
- GET API calls: network-first, cache fallback
- POST/PUT/DELETE: attempt network, return `202 queued` if offline (does NOT automatically queue — main app handles queuing via IndexedDB)

Background sync: when `sync-sales` tag fires, posts `SYNC_SALES` message to all open app windows, which then trigger `syncOfflineSales()` in the main app JS.

---

## 11. Auth Flow (Frontend)

```
login() → POST /api/auth/login
  → if isSuperAdmin: localStorage.setItem('isSuperAdmin', 'true')
  → if requiresCompanySelection: show company selector screen
  → else: token = result.token, localStorage.setItem('token', token)
  → selectCompany → POST /api/auth/select-company → new JWT with companyId embedded
  → completeLogin() → load products, initialize POS
```

On logout:
```javascript
localStorage.removeItem('token');
localStorage.removeItem('isSuperAdmin');
```

---

## 12. Permission-Based UI

`userPermissions` object is populated from the login response.  
UI elements are hidden/shown based on role:

```javascript
// Example: Only show "Void" button if user has POS.VOID_SALE permission
if (userPermissions.POS?.VOID_SALE) { /* show void button */ }
```

Manager authorization required for:
- Sale voids
- Price overrides
- Returns (cashiers must provide `authorized_by_user_id`)

---

## 13. API Integration Pattern

All API calls follow:
```javascript
const response = await fetch(`${API_URL}/pos/sales`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ ... })
});
const result = await response.json();
```

`API_URL` is set once at top of script:
```javascript
const API_URL = window.location.origin + '/api';
```

This means the frontend is completely server-agnostic — it calls whatever server is hosting it.

---

## 14. Key Frontend Files

| File | Lines | Role |
|---|---|---|
| `POS_App/index.html` | 9,334 | Entire SPA: HTML + CSS + JS |
| `POS_App/service-worker.js` | 179 | Offline PWA |
| `POS_App/manifest.json` | ~20 | PWA metadata |
| `POS_App/js/polyfills.js` | small | Browser polyfills |
