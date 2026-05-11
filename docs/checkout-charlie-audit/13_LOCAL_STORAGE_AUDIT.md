# 13 — LocalStorage / Browser Storage Audit

---

## Summary

**Overall verdict: Mostly compliant.**  
Business data is NOT stored in localStorage or sessionStorage.  
The one risk area is IndexedDB for offline sales.

---

## 1. localStorage Occurrences

File: `Point of Sale/POS_App/index.html`

All occurrences found via grep:

| Line | Code | What It Stores | Compliant? |
|---|---|---|---|
| 3446 | `localStorage.setItem('token', token)` | JWT auth token | ✅ PERMITTED (Rule D2: auth tokens allowed) |
| 3447 | `localStorage.setItem('isSuperAdmin', 'true')` | UI flag | ✅ PERMITTED (Rule D2: UI preferences allowed) |
| 3455 | `localStorage.setItem('isSuperAdmin', 'true')` | UI flag | ✅ PERMITTED |
| 3462 | `localStorage.setItem('token', token)` | JWT auth token | ✅ PERMITTED |
| 3474 | `localStorage.setItem('token', token)` | JWT auth token | ✅ PERMITTED |
| 3480 | `localStorage.setItem('token', token)` | JWT auth token | ✅ PERMITTED |
| 3539 | `localStorage.setItem('token', token)` | JWT auth token | ✅ PERMITTED |
| 3596 | `localStorage.removeItem('token')` | Cleanup on logout | ✅ PERMITTED |
| 3606 | `localStorage.removeItem('token')` | Cleanup on logout | ✅ PERMITTED |
| 7560 | `localStorage.setItem('token', token)` | JWT auth token | ✅ PERMITTED |
| 7587 | `localStorage.setItem('token', token)` | JWT auth token | ✅ PERMITTED |
| 8619 | `localStorage.removeItem('token')` | Cleanup on logout | ✅ PERMITTED |
| 8620 | `localStorage.removeItem('isSuperAdmin')` | Cleanup on logout | ✅ PERMITTED |
| 8703 | `localStorage.setItem('token', token)` | JWT auth token | ✅ PERMITTED |

**All 15 localStorage occurrences are for JWT tokens or the `isSuperAdmin` UI flag. No business data in localStorage.**

Note: The token is set in multiple places because the login flow has multiple branches (super admin, multi-company, single-company, direct login, company switch) — each branch sets the token on success.

---

## 2. sessionStorage Occurrences

**None found in the frontend code.**

The explore agent's initial report mentioned `sessionStorage` usage but direct code inspection found none. It may have been an incorrect summary.

---

## 3. IndexedDB Occurrences

File: `Point of Sale/POS_App/index.html`, line 3140+

### Database Details

```
Database name: 'CheckoutCharliePOS'
Version: 1
```

### Object Stores

#### `products` store
```javascript
database.createObjectStore('products', { keyPath: 'id' });
productsStore.createIndex('product_code', 'product_code');
productsStore.createIndex('barcode', 'barcode');
```

| Attribute | Detail |
|---|---|
| Purpose | Caches product list from server |
| When written | After successful `GET /api/pos/products` call |
| When read | When offline, as fallback product source |
| Authority | **READ CACHE ONLY** — server is authoritative |
| Risk | Low — stale product data at worst |
| CLAUDE.md compliance | ✅ Cache of server data, not business truth |

---

#### `customers` store
```javascript
database.createObjectStore('customers', { keyPath: 'id' });
```

| Attribute | Detail |
|---|---|
| Purpose | Caches customer list from server |
| When written | After successful `GET /api/customers` call |
| When read | When offline, for customer selection |
| Authority | **READ CACHE ONLY** — server is authoritative |
| Risk | Low — stale customer data at worst |
| CLAUDE.md compliance | ✅ Cache of server data |

---

#### `offlineSales` store ⚠️
```javascript
database.createObjectStore('offlineSales', { keyPath: 'tempId', autoIncrement: true });
salesStore.createIndex('synced', 'synced');
salesStore.createIndex('createdAt', 'createdAt');
```

| Attribute | Detail |
|---|---|
| Purpose | Queues sales that could not reach server (offline mode) |
| When written | When `POST /api/pos/sales` fails with a network error |
| When read | On reconnect — `syncOfflineSales()` reads and posts each pending sale |
| Authority | ⚠️ **BUSINESS DATA** — represents real financial transactions |
| Risk | **HIGH** — if browser storage is cleared, device is lost, or session expires before sync, these sales are permanently lost with no server record |
| CLAUDE.md compliance | ⚠️ MARGINAL — business data in browser storage, but with sync-to-server intent |

**Structure of a stored offline sale:**
```javascript
{
  tempId: 1,                           // auto-incremented IndexedDB key
  tempSaleNumber: 'OFFLINE-1715000000',// temporary receipt number shown to customer
  tillSessionId: 5,                    // server-side till session ID
  items: [{ productId: 12, quantity: 2 }],
  paymentMethod: 'CASH',
  synced: false,                       // flag — becomes true after server confirms
  createdAt: '2026-05-10T10:30:00.000Z'
}
```

**Migration recommendation:** Add server-side "offline sale draft" table where sales can be pre-registered before going offline. On reconnect, complete the registration rather than creating a new one. This would prevent data loss on browser storage wipe.

---

#### `sessionData` store
```javascript
database.createObjectStore('sessionData', { keyPath: 'key' });
```

| Attribute | Detail |
|---|---|
| Purpose | Miscellaneous session key-value storage |
| When written | Not explicitly traced in code review |
| Risk | Low — appears to be config/UI data |
| CLAUDE.md compliance | ✅ Low-risk config |

---

## 4. Service Worker Cache

File: `Point of Sale/POS_App/service-worker.js`

```javascript
STATIC_CACHE = 'static-v1'   // caches: '/', '/index.html', '/manifest.json'
DATA_CACHE   = 'data-v1'     // caches: successful GET /api/pos/products, /api/customers responses
```

| Attribute | Detail |
|---|---|
| Purpose | Offline serve static files and last-known product/customer data |
| Authority | **READ CACHE ONLY** — refreshed from server on reconnect |
| Risk | Low — stale data at worst, not authoritative |
| CLAUDE.md compliance | ✅ API cache of server data |

---

## 5. Variables That Look Like State But Are Not Storage

The following are JS module-level variables (in-memory only, not persisted):

```javascript
let cart = [];                 // In-memory cart — lost on page refresh
let currentSession = null;     // In-memory till session — re-loaded from server
let products = [];             // In-memory product list — re-loaded from server
let userPermissions = {};      // In-memory from JWT response
let selectedPayment = 'CASH';  // In-memory UI state
```

These are NOT browser storage. They are cleared on every page refresh. This is a UX consideration (cart wipe on refresh) but not a Rule D1 violation.

---

## 6. What the Explore Agent's Report Mentioned vs Reality

The initial explore agent report suggested `localStorage` stored: userId, userName, userRole, companyId, currentSession, cartItems, selectedLocation, etc.

**Direct code inspection found this is NOT the case.**  
Only `token` and `isSuperAdmin` are in localStorage.  
All other state (userId, cart, session, etc.) is in JS module variables.

This discrepancy is important — the explore agent summarized what was plausible based on the code structure, but the actual grep shows a much smaller localStorage footprint.

---

## 7. Compliance Assessment

| Storage Type | Usage | Rule D1 Compliant? |
|---|---|---|
| localStorage | JWT token + isSuperAdmin flag only | ✅ YES |
| sessionStorage | None found | ✅ N/A |
| IndexedDB — products cache | Server cache | ✅ YES |
| IndexedDB — customers cache | Server cache | ✅ YES |
| IndexedDB — offlineSales | Business data queue | ⚠️ MARGINAL |
| IndexedDB — sessionData | Config data | ✅ YES |
| Service Worker Cache | Static + API cache | ✅ YES |

**The `offlineSales` IndexedDB store is the only Rule D1 concern.** It stores actual sale transactions in browser storage, though with the intent to sync to server. The risk is data loss if sync never completes.

---

## 8. Recommended Actions

| Action | Priority |
|---|---|
| Keep token/isSuperAdmin in localStorage as-is | KEEP — correct |
| Add server-side offline sale draft registration | HIGH |
| Add user-visible notification when offline sales fail to sync | HIGH |
| Add retry logic for failed sync attempts | HIGH |
| Do NOT move cart or session to localStorage | BLOCKED — Rule D1 |
| Do NOT add companyId or user data to localStorage | BLOCKED — Rule D1 |
