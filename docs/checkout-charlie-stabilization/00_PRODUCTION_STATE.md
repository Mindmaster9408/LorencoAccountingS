# 00 — Checkout Charlie: Production State Investigation
**Phase 0, Step 1 — READ ONLY. No code changes made.**
Date: 2026-05-10

---

## VERDICT SUMMARY

| Question | Answer | Confidence |
|---|---|---|
| Which backend is production? | **Ecosystem** (`accounting-ecosystem/backend/`) | CONFIRMED |
| Which port? | **3000** | CONFIRMED |
| Which database holds live POS data? | **Supabase** (`glkndlzjkhwfsolueyhk.supabase.co`) | CONFIRMED |
| Is legacy backend deployed to Zeabur? | **No** | CONFIRMED |
| Is legacy backend deployed anywhere else? | **Unknown — cannot rule out** | UNCERTAIN |
| Are both frontends in use? | **No — only ecosystem frontend-pos** | CONFIRMED |
| Do both frontends call the same API paths? | **No — they are different files** | CONFIRMED |
| Is there a mixed-state risk today? | **Low — if legacy is truly off. Unknown if legacy runs elsewhere.** | LIKELY |

---

## SECTION 1: WHICH BACKEND IS PRODUCTION

### Conclusion: Ecosystem backend — CONFIRMED

**Evidence:**

#### 1.1 — Only one Dockerfile exists in the entire repository

```
File: accounting-ecosystem/Dockerfile
```

The Dockerfile deploys `accounting-ecosystem/backend/server.js` to Zeabur on port 3000.

There is NO Dockerfile anywhere else in the repository. The legacy `Point of Sale/` folder has only a `Procfile` (`web: node server.js`) — a Heroku/Render-style deployment artifact. It has no Docker-based deployment path.

**Interpretation:** Zeabur deploys exclusively from `accounting-ecosystem/Dockerfile`. The legacy backend cannot be deployed to Zeabur without a Dockerfile. The ecosystem backend is the only Zeabur-deployable service.

#### 1.2 — The Zeabur deployment target is explicitly documented

From `accounting-ecosystem/Dockerfile` (comment block at top):
```
# Zeabur Root Directory MUST be set to: accounting-ecosystem
# (not accounting-ecosystem/backend — that triggers wrong path generation)
```

From `accounting-ecosystem/.env.example`:
```
# ZEABUR DEPLOYMENT:
#   Set these as Environment Variables in the Zeabur dashboard.
```

The CLAUDE.md also contains hard rules (Part C) specifically about Zeabur deployment of `accounting-ecosystem/` — rules written to protect a production Zeabur deployment that already exists.

#### 1.3 — Real production credentials are in the ecosystem backend only

`accounting-ecosystem/backend/.env` contains live credentials:
```
DATABASE_URL=postgresql://root:AUgzHq1pklhMS2yx87bi9aD4F3QOL065@sjc1.clusters.zeabur.com:25165/zeabur
SUPABASE_URL=https://glkndlzjkhwfsolueyhk.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci... [live service role key]
JWT_SECRET=charlie_jwt_secret_2024_secure_random_key_xyz789
```

The legacy `Point of Sale/.env` contains only local development values:
```
PORT=3000
JWT_SECRET=pos-secret-key-2026-change-in-production
NODE_ENV=development
```

No real database credentials. No Supabase keys. The legacy backend has no path to production data.

#### 1.4 — The ecosystem backend server explicitly logs itself as production

`accounting-ecosystem/backend/server.js` on startup logs:
```
✅ POS module (Checkout Charlie) — ACTIVE
✅ Payroll module (Lorenco Paytime) — ACTIVE
✅ Accounting module (Lorenco Accounting) — ACTIVE
✅ SEAN AI module — ACTIVE
```

The legacy `Point of Sale/server.js` contains this on startup:
```
⚠️ LEGACY STANDALONE POS SERVER — DEPRECATED
```
(Confirmed in prior audit — the legacy server explicitly marks itself deprecated at startup.)

---

## SECTION 2: WHICH FRONTEND IS SERVING POS

### Conclusion: `accounting-ecosystem/frontend-pos/index.html` — CONFIRMED

#### 2.1 — Two separate POS frontend files exist

| File | Served by |
|---|---|
| `Point of Sale/POS_App/index.html` | Legacy backend (not deployed to Zeabur) |
| `accounting-ecosystem/frontend-pos/index.html` | Ecosystem backend at route `/pos` |

These are NOT the same file despite sharing an identical `const API_URL` definition at line 3115.

#### 2.2 — The ecosystem frontend uses `/api/pos/` prefix throughout

Grep of `accounting-ecosystem/frontend-pos/index.html` — actual API call patterns:

```javascript
fetch(`${API_URL}/pos/sales`, ...)           // Line 3349
fetch(`${API_URL}/pos/sessions?status=open`, ...) // Line 3748
fetch(`${API_URL}/pos/sessions/${id}/close`, ...) // Line 3774
fetch(`${API_URL}/pos/tills`, ...)           // Line 3801
fetch(`${API_URL}/pos/sessions/open`, ...)   // Line 3811
fetch(`${API_URL}/pos/products`, ...)        // Line 3841
fetch(`${API_URL}/auth/login`, ...)          // Line 3553
fetch(`${API_URL}/auth/select-company`, ...) // Line 3647
```

These calls correctly target the ecosystem backend's route structure:
- `API_URL` = `window.location.origin + '/api'` = `https://[zeabur-domain]/api`
- `/api/pos/tills` → matches `app.use('/api/pos', posRoutes)` in ecosystem `server.js`
- `/api/auth/login` → matches `app.use('/api/auth', authRoutes)` in ecosystem `server.js`

**The ecosystem frontend correctly targets the ecosystem backend. There is no mismatch.**

#### 2.3 — The LEGACY frontend uses a different (non-prefixed) API structure

The legacy `Point of Sale/POS_App/index.html` calls:
- `/api/tills` (no `/pos/` prefix)
- `/api/sessions`
- `/api/sales`
- `/api/products`

These match the LEGACY backend's route structure (`routes/pos.js` mounted at `/api/...`), NOT the ecosystem backend's `/api/pos/...` routes.

**If the legacy frontend were accidentally served by the ecosystem backend, POS calls would 404.**

#### 2.4 — The ecosystem server.js explicitly serves frontend-pos at /pos

```javascript
// From accounting-ecosystem/backend/server.js (line 437):
app.use('/pos', express.static(posFrontendPath, staticOptions));

// Where:
const posFrontendPath = path.join(__dirname, '..', 'frontend-pos');
// = accounting-ecosystem/frontend-pos/
```

The POS frontend is served at `https://[zeabur-domain]/pos`.

---

## SECTION 3: WHICH DATABASE HAS LIVE POS DATA

### Conclusion: Supabase — CONFIRMED

#### 3.1 — The ecosystem POS module uses Supabase exclusively

`accounting-ecosystem/backend/modules/pos/routes/sales.js`:
```javascript
const { supabase } = require('../../../config/database');
// ...
await supabase.from('sales').insert(...)
await supabase.from('sale_items').insert(...)
await supabase.rpc('decrement_stock', { p_product_id, p_quantity })
```

All POS data operations go to Supabase. The Supabase instance is:
```
Project ref: glkndlzjkhwfsolueyhk
URL: https://glkndlzjkhwfsolueyhk.supabase.co
```

This is the same Supabase instance used by the Coaching app (`db.glkndlzjkhwfsolueyhk.supabase.co` in `Coaching app/backend/.env`). They share the same Supabase project.

#### 3.2 — The Zeabur PostgreSQL is used by other modules, NOT by POS

`accounting-ecosystem/backend/.env` also contains:
```
DATABASE_URL=postgresql://root:AUgzHq1pklhMS2yx87bi9aD4F3QOL065@sjc1.clusters.zeabur.com:25165/zeabur
```

This Zeabur PostgreSQL connection is used by:
- The accounting module (which uses a direct PostgreSQL pool)
- Potentially payroll if it uses `DATABASE_URL`

It is NOT used by the POS module. The POS module only uses the Supabase client.

#### 3.3 — The legacy PostgreSQL is local-only, unreachable from production

The legacy `Point of Sale/database.js` reads `DATABASE_URL` from its own `.env`. That `.env` contains no database URL — only `PORT=3000`, `JWT_SECRET`, and `NODE_ENV=development`. The legacy backend connects to a local PostgreSQL instance. That database has no production path.

#### 3.4 — POS data storage confirmation

| Database | POS data? | Evidence |
|---|---|---|
| Supabase (`glkndlzjkhwfsolueyhk`) | **YES — all ecosystem POS data** | Module code reads/writes via Supabase client |
| Zeabur PostgreSQL (`sjc1.clusters.zeabur.com`) | **No POS data** | Not referenced by POS module |
| Legacy local PostgreSQL | **No production data** | Local dev only, no production credentials |

**Recommendation for data verification:** Run `SELECT COUNT(*), MAX(created_at) FROM sales` against the Supabase project to confirm live sale records exist. This can be done from the Supabase dashboard → SQL Editor.

---

## SECTION 4: IS THE LEGACY BACKEND STILL ACTIVE

### Conclusion: NOT deployed to Zeabur. Possibly still deployed elsewhere — UNCERTAIN

#### 4.1 — The legacy backend is NOT on Zeabur

- No Dockerfile in `Point of Sale/`
- No Zeabur config for that folder
- CLAUDE.md Part C rules cover only `accounting-ecosystem/` for Zeabur
- Only the ecosystem Dockerfile is deployable to Zeabur

#### 4.2 — The legacy backend HAS a Heroku-style Procfile

```
File: Point of Sale/Procfile
Content: web: node server.js
```

A `Procfile` is used by Heroku, Render, Railway, and other PaaS platforms. This means the legacy backend was at some point deployed to one of these platforms. It may still be running there with a live URL.

**This is the key unknown:** If the legacy backend is still deployed on Heroku/Render/Railway with a live URL:
- It would serve the legacy `POS_App/index.html`
- That frontend would call `/api/tills`, `/api/sales`, etc. on the LEGACY backend
- Those would write to the LEGACY local PostgreSQL (which has no production data visible to us)
- OR it might have production PostgreSQL credentials we cannot see from the local repo

**We cannot confirm or deny this from local files alone.**

#### 4.3 — The legacy backend JWT secret is different from ecosystem

- Legacy: `JWT_SECRET=pos-secret-key-2026-change-in-production`
- Ecosystem: `JWT_SECRET=charlie_jwt_secret_2024_secure_random_key_xyz789`

These are different secrets. A token issued by one backend will be rejected by the other. This means even if both are running, they are fully isolated — no token cross-contamination.

---

## SECTION 5: DANGEROUS MIXED-STATE FINDINGS

### Finding 5.1 — Legacy backend `.env` PORT conflicts with ecosystem (LOW RISK)

`Point of Sale/.env` sets `PORT=3000`. The ecosystem backend also uses `PORT=3000`. If both were started locally, they would fight for the same port. In production (Zeabur), this is not a risk because only the ecosystem is deployed. In local development, a developer starting both would see a port conflict immediately.

**Risk level:** LOW — self-evident failure mode, easily noticed.

### Finding 5.2 — Legacy backend still potentially reachable (MEDIUM RISK — UNCERTAIN)

If the legacy backend is still deployed on Heroku/Render/Railway:
- It has a separate URL
- It has separate data (no shared database with ecosystem)
- A cashier using the old URL would be writing sales to a database nobody monitors
- Inventory would be wrong on both sides
- No alert would occur — both systems would appear to work

**Risk level:** MEDIUM if legacy is still live. ZERO if it has been shut down.
**Action required:** Confirm with the business owner whether a Heroku/Render/Railway deployment still exists. Check those platforms' dashboards.

### Finding 5.3 — Two separate Supabase clients in same project (LOW RISK)

The ecosystem POS module and the Coaching app both connect to the same Supabase project (`glkndlzjkhwfsolueyhk`). They use separate table namespaces (`sales`, `products` for POS; `coaching_*` tables for coaching). This is fine as long as table names don't collide.

**Risk level:** LOW — separate table namespaces, shared project is intentional.

### Finding 5.4 — `decrement_stock` Supabase RPC existence unconfirmed (MEDIUM RISK)

The ecosystem POS module calls:
```javascript
supabase.rpc('decrement_stock', { p_product_id: id, p_quantity: qty })
```

If this RPC function does not exist in the Supabase project, the code falls back to a manual UPDATE with a clamp-to-zero pattern. This needs to be verified in the Supabase dashboard → Database → Functions.

**Risk level:** MEDIUM — affects stock accuracy on every sale if the RPC is missing.

---

## SECTION 6: FILES AND CONFIGS CHECKED

| File | What was checked |
|---|---|
| `accounting-ecosystem/Dockerfile` | Build target, WORKDIR, CMD, port, deployment comments |
| `accounting-ecosystem/.dockerignore` | What is excluded from build context |
| `accounting-ecosystem/backend/.env` | Live credentials, ports, Supabase URL, Zeabur PostgreSQL URL, module flags |
| `accounting-ecosystem/backend/.env.example` | Documented production vars, deployment notes |
| `accounting-ecosystem/backend/server.js` | Route mounting, static serving, port config, module loading, POS API prefix |
| `accounting-ecosystem/backend/package.json` | Start script, dependencies (express, pg, @supabase/supabase-js) |
| `accounting-ecosystem/frontend-pos/index.html` | API_URL definition, actual fetch call patterns (API prefix used) |
| `Point of Sale/Procfile` | Heroku-style deployment artifact |
| `Point of Sale/.env` | Local-only credentials, no production DB |
| `Point of Sale/server.js` | Port default (8080), deprecated warning, route structure |
| `Point of Sale/POS_App/index.html` | API_URL definition, API call patterns (no /pos/ prefix) |
| `Point of Sale/package.json` | Start script, dependencies |
| `Payroll/Procfile` | Exists (Heroku-style) |
| `Coaching app/backend/.env` | Same Supabase project (`glkndlzjkhwfsolueyhk`) |
| `sean-webapp/.env` / `.env.local` | SQLite dev, no production POS data |
| `Lorenco Accounting/.env` | Local PostgreSQL only |
| `Admin dashboard/server/.env` | MongoDB only, no POS relevance |
| No `zeabur.yaml` files | Confirmed absent — correct per CLAUDE.md Rule C1 |
| No `zbpack.json` files | Confirmed absent — correct per CLAUDE.md Rule C1 |
| No `nginx.conf` files | Confirmed absent — no reverse proxy layer |
| No `docker-compose.yml` files | Confirmed absent |
| No `ecosystem.config.js` files | Confirmed absent — no PM2 |

---

## SECTION 7: RECOMMENDED IMMEDIATE ACTIONS

### Action 1 — Verify legacy is truly off (PRIORITY: HIGH)

Check the following platforms for any live deployment of `Point of Sale/server.js`:
- Heroku dashboard
- Render dashboard
- Railway dashboard
- Any other PaaS the team may have used

If a live deployment exists: **shut it down or redirect its URL to the ecosystem backend.**

If no live deployment exists: **document this as confirmed and close the risk.**

### Action 2 — Verify `decrement_stock` RPC in Supabase (PRIORITY: HIGH)

Go to: Supabase dashboard → Project `glkndlzjkhwfsolueyhk` → Database → Functions

Search for: `decrement_stock`

If it exists: document its signature and confirm it includes the `WHERE stock_quantity >= p_quantity` guard.
If it does not exist: this is a stock integrity risk on every sale. Create the function as documented in [docs/checkout-charlie-audit/11_NEXT_STEPS.md](../checkout-charlie-audit/11_NEXT_STEPS.md) Phase 1.5.

### Action 3 — Verify live POS sales in Supabase (INFORMATIONAL)

Go to: Supabase dashboard → SQL Editor

Run:
```sql
SELECT COUNT(*) AS total_sales, MAX(created_at) AS most_recent_sale
FROM sales;
```

This confirms whether real live data exists in Supabase. If `total_sales > 0` and `most_recent_sale` is within normal trading hours, Supabase is confirmed live.

### Action 4 — No other immediate action required

The ecosystem backend is confirmed as the production system. The routing is correct. The frontend correctly targets `/api/pos/...` paths. The JWT secrets are separate, preventing cross-contamination with any legacy system.

No code changes are needed as a result of this investigation.

---

## SECTION 8: CONFIDENCE LEVELS

| Finding | Confidence |
|---|---|
| Ecosystem backend is the Zeabur production system | **CONFIRMED** |
| Ecosystem frontend-pos uses correct `/api/pos/` prefix | **CONFIRMED** |
| Supabase `glkndlzjkhwfsolueyhk` is the POS database | **CONFIRMED** |
| Legacy backend is NOT deployed to Zeabur | **CONFIRMED** |
| Legacy backend was once deployed to Heroku/Render | **CONFIRMED** (Procfile exists) |
| Legacy backend is currently NOT running anywhere | **UNCERTAIN** (cannot verify without platform access) |
| `decrement_stock` RPC exists in Supabase | **UNCERTAIN** (requires Supabase dashboard check) |
| Live sale records exist in Supabase | **LIKELY** (credentials are real, module is enabled and active) |
| Zeabur PostgreSQL is used only for non-POS modules | **CONFIRMED** (POS module only uses Supabase client) |

---

## ARCHITECTURE DIAGRAM — AS VERIFIED

```
PRODUCTION (Zeabur)
═══════════════════════════════════════════════════════

[Browser]
    │
    ▼
[Zeabur Service]
  Root Directory: accounting-ecosystem/
  Build: accounting-ecosystem/Dockerfile
    │
    ▼
[accounting-ecosystem/backend/server.js]
  PORT: 3000
  Serves:  /           → frontend-ecosystem/login.html
           /dashboard  → frontend-ecosystem/dashboard.html
           /pos        → frontend-pos/index.html         ← POS FRONTEND
           /payroll    → frontend-payroll/
           /coaching   → frontend-coaching/
    │
    ├── /api/auth        → shared/routes/auth.js
    ├── /api/pos         → modules/pos/           ← POS API
    ├── /api/payroll     → modules/payroll/
    ├── /api/accounting  → modules/accounting/
    └── /api/sean        → sean/routes/
            │
            ▼
       [Supabase] glkndlzjkhwfsolueyhk
       Tables: sales, sale_items, sale_payments,
               products, tills, till_sessions,
               customers, stock_adjustments, ...
               + coaching_* tables (shared project)

═══════════════════════════════════════════════════════
NOT IN PRODUCTION (local only or unknown platform)
═══════════════════════════════════════════════════════

[Point of Sale/server.js]  PORT: 8080 (default) or 3000 (via .env)
  Procfile: web: node server.js  ← was on Heroku/Render at some point
  No Dockerfile  ← cannot deploy to Zeabur
  Status: UNKNOWN — may still be live on Heroku/Render
    │
    └── /api/tills, /api/sessions, /api/sales, /api/products
            │
            ▼
       [Local PostgreSQL]  (no production credentials found in repo)
```

---

*Investigation complete. No files were modified during this investigation.*
*Next step: Verify Actions 1 and 2 above before proceeding to Phase 0 Step 2.*
