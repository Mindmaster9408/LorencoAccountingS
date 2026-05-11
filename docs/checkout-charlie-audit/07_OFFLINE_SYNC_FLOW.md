# 07 — Offline / Sync Flow

---

## 1. Does Offline Exist?

**Yes.** The POS frontend is a PWA with a service worker and IndexedDB offline queue.

The offline capability is real and functional but has significant data integrity risks.

---

## 2. Architecture Overview

```
Online mode:
  Browser ←→ Server API ←→ PostgreSQL/Supabase (authoritative)

Offline mode:
  Browser ←→ IndexedDB (local queue — NOT authoritative)
  Service Worker → intercepts API calls
```

---

## 3. Service Worker Behaviour

File: `Point of Sale/POS_App/service-worker.js`

### On Install
Caches: `['/', '/index.html', '/manifest.json']` into `static-v1` cache.

### On Fetch — Static files
Cache-first strategy:
- Returns cached response immediately
- Also fetches from network in background to update cache

### On Fetch — API calls (`/api/*`)
Network-first strategy:
- **GET requests:** Try network → on success, cache response → on failure, try cache → fallback: empty response `{ products: [], offline: true }`
- **POST/PUT/DELETE requests:** Try network → if fails, return `{ queued: true, offline: true }` with HTTP 202

**Important:** The service worker's `{ queued: true }` response for offline POST is just a signal to the frontend. The service worker itself does NOT queue the data — the main app's JavaScript handles actual storage via IndexedDB.

### Background Sync
When browser fires `sync` event with tag `sync-sales`:
- Service worker sends `SYNC_SALES` message to all open app windows
- Main app JS (`syncOfflineSales()`) handles the actual sync

---

## 4. IndexedDB Schema

Database name: `CheckoutCharliePOS`, version 1

```javascript
Object Stores:

'products'     { keyPath: 'id' }
  indexes: product_code, barcode
  Purpose: Cached product list from server
  Authority: READ-ONLY CACHE — data comes from server, refreshed on login

'customers'    { keyPath: 'id' }
  Purpose: Cached customer list from server
  Authority: READ-ONLY CACHE

'offlineSales' { keyPath: 'tempId', autoIncrement: true }
  indexes: synced, createdAt
  Purpose: Pending sales that failed to reach server
  Authority: ⚠️ BUSINESS DATA — actual sale records awaiting sync

'sessionData'  { keyPath: 'key' }
  Purpose: Miscellaneous session key-value storage
  Authority: Low-risk — UI/config data
```

---

## 5. Offline Sale Queue: Detailed Flow

### Going Offline
```javascript
window.addEventListener('offline', () => {
  isOnline = false;
  updateOfflineIndicator();    // Show "Offline Mode" banner
  // Cart remains active — cashier can continue building sale
});
```

### Completing Sale While Offline
```javascript
// In checkout logic:
try {
  const response = await fetch(`${API_URL}/pos/sales`, { ... });
  // If fetch throws NetworkError:
} catch (error) {
  // fallback: save to IndexedDB
  const offlineSale = await saveOfflineSale({
    tillSessionId: currentSession?.id,
    items: cart.map(item => ({
      productId: item.productId,
      quantity: item.quantity
    })),
    paymentMethod: selectedPayment,
    // ...other sale metadata
  });
  
  // offlineSale.tempSaleNumber = 'OFFLINE-1715000000000'
  // Show receipt with offline sale number
}
```

### Pending Sale Structure in IndexedDB
```javascript
{
  tempId: 1,                           // auto-incremented, IndexedDB key
  tillSessionId: 5,
  items: [{ productId: 12, quantity: 2 }],
  paymentMethod: 'CASH',
  synced: false,
  createdAt: '2026-05-10T10:30:00.000Z',
  tempSaleNumber: 'OFFLINE-1715000000000'
}
```

### Reconnecting (Online)
```javascript
window.addEventListener('online', async () => {
  isOnline = true;
  await syncOfflineSales();   // Sync immediately on reconnect
  await loadProducts();       // Refresh product cache
});
```

### Sync Process
```javascript
async function syncOfflineSales() {
  if (!isOnline || !token) return;
  
  const pendingSales = await getPendingOfflineSales();
  // filter: synced === false
  
  for (const sale of pendingSales) {
    const response = await fetch(`${API_URL}/pos/sales`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tillSessionId: sale.tillSessionId,
        items: sale.items,
        paymentMethod: sale.paymentMethod,
        offlineCreatedAt: sale.createdAt
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      await markSaleSynced(sale.tempId, result.saleId);
      // sale.synced = true, sale.serverSaleId = result.saleId, sale.syncedAt = now
    }
  }
}
```

---

## 6. What Happens If Sync Never Completes

### Causes
- Device permanently lost or broken
- Browser storage cleared (cookies/cache clear, incognito mode, browser reinstall)
- Session token expired before sync (8-hour JWT — if offline >8 hours, token expires)
- Server was down when reconnection occurred and retry was not implemented
- App was force-closed during sync

### Consequences
| Consequence | Impact |
|---|---|
| Sale not in database | The sale never happened from an accounting perspective |
| Stock never decremented | Products appear available even though they were sold |
| Receipt shows offline number | Customer may have received a receipt for a sale that has no server record |
| Revenue not captured | Financial reporting misses this sale |
| Cashier reconciliation wrong | Their session's expected balance does not match |

### Mitigation (current state)
- None beyond the sync attempt on reconnect
- No retry mechanism if sync fails (network error during sync itself)
- No server-side duplicate detection if the same offline sale is posted twice

---

## 7. Duplicate Sale Risk

If `syncOfflineSales()` is called twice before `markSaleSynced()` completes (e.g., multiple `online` events in quick succession), the same offline sale could be posted to the server twice, creating duplicate sales records.

Current code has no idempotency key or duplicate check for offline sync.

---

## 8. Stock During Offline Period

Offline mode does NOT decrement stock on the server. If a cashier sells the last 5 units offline:
- Server still shows 5 units available
- Another cashier (online) can sell those same 5 units
- When offline sales sync: the server-side stock check will run — if stock_quantity < requested quantity, the sync will fail with 400/422

This means offline sales can fail during sync due to stock having been depleted by online sales in the interim. The failed sync is currently silently ignored (`catch (error) => console.error`).

---

## 9. Till Session During Offline Period

The `tillSessionId` used in offline sales is stored at the time the sale is captured. If the till session is closed before the offline sale syncs (e.g., end of day cash-up), the sync will fail because the server validates `status = 'open'` on the session.

There is no handling for this scenario — the offline sale will be permanently lost.

---

## 10. Conflict Resolution

**None exists currently.** The sync model is "last write wins" — offline sales are simply posted as new sales when online. There is no:
- Conflict detection
- Conflict resolution UI
- Duplicate detection
- Retry queue with exponential backoff
- Notification when a specific offline sale fails to sync

---

## 11. Service Worker Cache Invalidation

When the app is updated (`CACHE_NAME = 'checkout-charlie-v1'`), old caches are deleted on service worker `activate`:
```javascript
cacheNames.map(cacheName => {
  if (cacheName !== STATIC_CACHE && cacheName !== DATA_CACHE) {
    return caches.delete(cacheName);
  }
});
```

If the cache name is not updated after a deployment, users may receive a stale `index.html`. The Procfile/Zeabur deployment should trigger a service worker update, but this depends on the browser detecting the new service worker file.

---

## 12. Summary: Offline Risk Assessment

| Item | Status | Risk Level |
|---|---|---|
| Products cached offline | Works — server cache in IndexedDB | LOW (stale data only) |
| Sales queued offline | Works — stored in IndexedDB | HIGH (business data, can be lost) |
| Stock not decremented offline | Known gap | HIGH (inventory mismatch) |
| Session expiry during long offline | Not handled | HIGH (sync fails silently) |
| Duplicate sale on sync | No deduplication | MEDIUM |
| No retry on sync failure | Silent failure | HIGH |
| No user notification of sync failure | Silent | MEDIUM |
