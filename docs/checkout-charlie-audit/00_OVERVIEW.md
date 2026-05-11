# 00 — Checkout Charlie POS: Audit Overview

**Audit date:** May 2026  
**Auditor:** Claude (Principal Engineer role, Lorenco Ecosystem)  
**Audit scope:** Full deep audit of all code, routes, frontend, database, storage, and flows  
**Status:** READ-ONLY — no code was changed during this audit

---

## 1. App Purpose

Checkout Charlie is the Point-of-Sale (POS) module of the Lorenco Ecosystem.  
It enables retail businesses to:
- Sell products at a till
- Accept multiple payment types (cash, card, EFT, account, split)
- Manage products, categories, and pricing
- Manage customers and loyalty points
- Handle stock adjustments, daily discounts, and stock takes
- Close till sessions with cash-up reconciliation
- Generate sales, VAT, and profit reports
- Operate offline and sync when back online (PWA)

---

## 2. Ecosystem Role

Checkout Charlie is one of several Lorenco ecosystem apps:

```
Lorenco ECO Systum
├── accounting-ecosystem/
│   ├── backend/           ← AUTHORITATIVE backend (port 3000, Zeabur)
│   │   └── modules/pos/   ← AUTHORITATIVE POS module (Supabase DB)
│   └── frontend-coaching/ ← (not POS)
├── Point of Sale/         ← LEGACY standalone server (port 8080, DEPRECATED)
│   ├── POS_App/           ← Frontend (serves from legacy server)
│   └── routes/            ← Legacy backend routes
├── Coaching app/
├── Lorenco Accounting/
└── other apps
```

**Critical architectural fact:**  
There are **two distinct backend systems** for POS. The legacy standalone server (`Point of Sale/`) and the authoritative ecosystem server (`accounting-ecosystem/backend/modules/pos/`).  
The server.js in `Point of Sale/` explicitly warns:

> ⚠️ LEGACY STANDALONE POS SERVER — DEPRECATED  
> The AUTHORITATIVE system is: accounting-ecosystem/backend/ (port 3000)

---

## 3. High-Level Architecture Summary

| Layer | Legacy (`Point of Sale/`) | Ecosystem (`accounting-ecosystem/`) |
|---|---|---|
| Server port | 8080 | 3000 |
| Database | PostgreSQL (Zeabur-internal, SQLite-compat wrapper) | Supabase (PostgreSQL) |
| Auth | JWT, 8h expiry | JWT, via shared auth middleware |
| Frontend | `POS_App/index.html` (9,334 lines) | Same frontend, `API_URL = window.location.origin + '/api'` |
| Routes | `routes/pos.js`, `routes/reports.js`, etc. | `modules/pos/routes/sales.js`, `sessions.js`, etc. |
| Stock decrement | `UPDATE products SET stock_quantity - ?` | `supabase.rpc('decrement_stock', ...)` with manual fallback |
| VAT calc | External: `subtotal * 0.15` | Inclusive: `linePrice * (vat_rate / (100 + vat_rate))` |
| Status | **DEPRECATED** | **AUTHORITATIVE — all new work here** |

---

## 4. High-Level Findings

### What exists and appears functional
- Full POS UI with till, products, cart, payment, cash-up, stock, reports, settings tabs
- Multi-tenant company isolation (every table has `company_id`)
- JWT authentication with role-based permissions (15+ roles)
- Till session management (open, close, cash-up)
- Sale creation with stock validation and stock reduction
- Split payment support (multiple methods per sale)
- Returns/refunds with stock restoration
- Void with manager authorization
- Daily discounts on products
- Price overrides with manager authorization
- Stock adjustments (add/remove/set/damage/theft/return/stock_take)
- Customer management with loyalty points and credit accounts
- Offline-first PWA: IndexedDB queue + service worker + background sync
- Forensic audit log on all mutations (immutable append-only)
- Multiple reports: gross profit, by person, by product, VAT, daily summary

### Critical findings
1. **Two separate backends exist.** Legacy is deprecated but still has the only complete frontend (`index.html`). If both are deployed simultaneously they point to different databases — data split would silently occur.
2. **VAT calculation differs between legacy and ecosystem.** Legacy adds 15% on top (`subtotal * 0.15`). Ecosystem extracts inclusive VAT (`price * vat_rate / (100 + vat_rate)`). This produces different numbers for the same transaction.
3. **Offline sales stored in IndexedDB are real business data.** If a device never reconnects or the queue is lost, those sales are permanently gone. No server-side record, no stock decrement, no receipt. This is a data integrity risk.
4. **No dedicated frontend for the ecosystem POS module.** The `accounting-ecosystem/backend/modules/pos/` routes exist and are complete, but there is no separate, standalone frontend pointing at the ecosystem server. The old `index.html` uses `window.location.origin + '/api'` — so which server it calls depends on which server serves it.
5. **No accounting journal integration.** Sales do not post to any accounting journal. There is no visible link between POS sales and the accounting module.

---

## 5. localStorage / Browser Storage Status

**FINDING: Mostly compliant.** The POS frontend uses browser storage for:
- `localStorage('token')` — JWT auth token (PERMITTED per Rule D2)
- `localStorage('isSuperAdmin')` — UI flag (PERMITTED per Rule D2)
- `indexedDB('CheckoutCharliePOS')` — offline cache and offline sale queue

**Risk area:** IndexedDB `offlineSales` store contains real pending sales (items, payment method, till session). This is business data stored in browser storage. Once synced to the server it is removed. If never synced, it is permanently lost.

All other business state (cart, current session, products, customers) lives in **JavaScript module-level variables** — not in localStorage. This is correct for a session-scoped SPA but it means a page refresh clears cart state.

---

## 6. What Appears Stable (Do Not Touch Carelessly)

- `Point of Sale/server.js` — marked CRITICAL at the top, has SQLite-compat DB wrapper
- `Point of Sale/database.js` — marked CRITICAL, handles PostgreSQL with SQLite shim
- `Point of Sale/routes/pos.js` — full working POS flow, returns, splits, stock management
- `Point of Sale/routes/auth.js` — multi-tenant auth, company selection, super admin
- `accounting-ecosystem/backend/modules/pos/routes/sales.js` — ecosystem sale flow
- `accounting-ecosystem/backend/modules/pos/routes/sessions.js` — till sessions on Supabase
- `Point of Sale/POS_App/index.html` — entire frontend (9,334 lines)
- `Point of Sale/POS_App/service-worker.js` — offline PWA logic
- `Point of Sale/middleware/auth.js` and `config/permissions.js`

---

## 7. Critical Risks

| # | Risk | Severity |
|---|---|---|
| R1 | Two separate backends can diverge if both deployed | CRITICAL |
| R2 | VAT calculation method differs between backends | HIGH |
| R3 | Offline sales in IndexedDB = business data that can be lost | HIGH |
| R4 | No accounting integration — POS sales invisible to accounting | MEDIUM |
| R5 | Cart state in JS memory — page refresh loses in-progress sale | MEDIUM |
| R6 | Stock decrement not atomic in legacy — no transaction wrapping | MEDIUM |
| R7 | Legacy server still has active route config — risk of confusion | LOW |

---

## 8. Recommended Next Focus

1. Confirm which server (legacy vs ecosystem) the deployed POS frontend is calling
2. Document which database has live production data
3. Establish a single authoritative frontend for the ecosystem POS module
4. Align VAT calculation method between backends before processing live data
5. Implement server-side protection against offline sale loss (receipt audit trail)
6. Plan accounting journal integration

**See 11_NEXT_STEPS.md for the full recommended build order.**
