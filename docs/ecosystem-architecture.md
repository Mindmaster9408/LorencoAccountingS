# Lorenco Accounting Ecosystem — Master Architecture Document

> **Living document.** Updated: March 10, 2026.  
> **Source of truth** for all future development decisions across the ecosystem.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [App Inventory](#2-app-inventory)
3. [Backend Architecture](#3-backend-architecture)
4. [API Surface Map](#4-api-surface-map)
5. [Auth & SSO Flow](#5-auth--sso-flow)
6. [Data Ownership & Storage](#6-data-ownership--storage)
7. [Cross-App Data Flows](#7-cross-app-data-flows)
8. [Shared vs Duplicated Logic](#8-shared-vs-duplicated-logic)
9. [Role-Based Access Control](#9-role-based-access-control)
10. [Module System](#10-module-system)
11. [Deployment Architecture](#11-deployment-architecture)
12. [Risk Register](#12-risk-register)
13. [Follow-Up Action Items](#13-follow-up-action-items)

---

## 1. High-Level Overview

The Lorenco ecosystem is a **multi-tenant SaaS platform** comprising four business applications and one AI layer, all backed by a single Supabase/PostgreSQL database. Apps share one unified backend server (Express.js) with module-gated routing and a single JWT-based auth system with SSO between apps.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ECOSYSTEM DASHBOARD (SSO Portal)                     │
│  login.html → dashboard.html → [click app] → sso-launch → appToken → app   │
└────────────┬────────────────┬────────────────┬──────────────┬───────────────┘
             │                │                │              │
        /accounting      /payroll           /pos          /sean
             │                │                │              │
    ┌────────▼──────┐ ┌───────▼──────┐ ┌──────▼──────┐ ┌────▼──────────────┐
    │  Lorenco      │ │  Lorenco     │ │  Checkout   │ │  SEAN AI          │
    │  Accounting   │ │  Paytime     │ │  Charlie    │ │  (frontend-sean)  │
    │  (30 pages)   │ │  Payroll     │ │  POS        │ │                   │
    └───────────────┘ └──────────────┘ └─────────────┘ └───────────────────┘
             │                │                │              │
             └────────────────┴────────────────┴──────────────┘
                                       │
                      ┌────────────────▼────────────────────┐
                      │   accounting-ecosystem/backend/      │
                      │   server.js  (Express, port 3000)    │
                      │   Single unified API server          │
                      └────────────────┬────────────────────┘
                                       │
                      ┌────────────────▼────────────────────┐
                      │         SUPABASE / POSTGRESQL        │
                      │   Single database, multi-tenant      │
                      │   All business data. Service-role.   │
                      └─────────────────────────────────────┘
```

**Separate / Legacy apps (not on ecosystem server):**
- `Payroll/` — Standalone payroll server (port 3131) — legacy, Supabase-backed
- `Point of Sale/` — Standalone POS server (port 8080) — legacy, PostgreSQL-backed
- `sean-webapp/` — Next.js SEAN AI webapp — separate deployment
- `Admin dashboard/` — Minimal admin panel — separate deployment

---

## 2. App Inventory

| App | Folder | Server | Port | Tech | Status |
|-----|--------|--------|------|------|--------|
| Ecosystem Dashboard | `frontend-ecosystem/` | `backend/server.js` | 3000 | Vanilla HTML/JS | ✅ Active |
| Lorenco Accounting | `frontend-accounting/` | `backend/server.js` | 3000 | Vanilla HTML/JS | ✅ Active |
| Lorenco Paytime Payroll | `frontend-payroll/` | `backend/server.js` | 3000 | Vanilla HTML/JS | ✅ Active |
| Checkout Charlie POS | `frontend-pos/` | `backend/server.js` | 3000 | Vanilla HTML/JS | ✅ Active |
| SEAN AI | `frontend-sean/` | `backend/server.js` | 3000 | Vanilla HTML/JS | ✅ Active |
| Coaching App | `frontend-coaching/` | `backend/server.js` | 3000 | Vanilla HTML/JS | ✅ Active |
| Standalone Payroll | `Payroll/` | `Payroll/server.js` | 3131 | Express + Supabase | ⚠️ Legacy |
| Standalone POS | `Point of Sale/` | `Point of Sale/server.js` | 8080 | Express + PostgreSQL | ⚠️ Legacy |
| Sean Webapp | `sean-webapp/` | Next.js | Varies | Next.js 14, TypeScript | 🔄 Separate |
| Admin Dashboard | `Admin dashboard/` | `server/index.js` | Varies | React + Express | ⚠️ Minimal |

### Ecosystem Frontend Pages

**Dashboard (`frontend-ecosystem/`):**
- `login.html` — Ecosystem login (enters eco_token flow)
- `dashboard.html` — App launcher + company selector + SSO
- `admin.html` — Super-admin control panel
- `client-detail.html` — Client account management

**Accounting (`frontend-accounting/`)** — 30 pages including:
`accounts`, `bank`, `bank-reconciliation`, `invoices`, `customers`, `suppliers`, `customer-receipts`, `journals`, `vat`, `vat-return`, `paye`, `paye-config`, `paye-reconciliation`, `cash-reconciliation`, `reports`, `cashflow`, `balance-sheet`, `trial-balance`, `aged-debtors`, `aged-creditors`, `sales-analysis`, `purchase-analysis`, `company`, `contacts`, `ai-settings`, `settings`, `profile`, `system-health`, `dashboard`

**Payroll (`frontend-payroll/`)** — 16 pages including:
`login`, `company-selection`, `company-dashboard`, `employee-management`, `employee-detail`, `payruns`, `payroll-items`, `reports`, `attendance`, `historical-import`, `super-admin-dashboard`, `users`, `test-suite`

---

## 3. Backend Architecture

### Main Server (`accounting-ecosystem/backend/server.js`)

**Entry:** `node backend/server.js`  
**Port:** `process.env.PORT || 3000`  
**Framework:** Express.js with helmet, morgan, cors

**Startup sequence:**
1. Load `.env`
2. Check module flags (`MODULE_POS_ENABLED`, `MODULE_PAYROLL_ENABLED`, etc.)
3. Conditionally require module routers
4. Register global middleware (helmet, cors, body-parser, morgan)
5. Register shared routes (always active)
6. Register module routes (conditionally)
7. Serve static frontend files
8. Connect to Supabase, ensure default company

**Static file routing (frontends served from single Express server):**

| URL Path | Frontend Served |
|----------|-----------------|
| `/` | `frontend-ecosystem/login.html` |
| `/dashboard` | `frontend-ecosystem/dashboard.html` |
| `/admin` | `frontend-ecosystem/admin.html` |
| `/accounting/*` | `frontend-accounting/` |
| `/payroll/*` | `frontend-payroll/` |
| `/pos/*` | `frontend-pos/` |
| `/sean/*` | `frontend-sean/` |
| `/coaching/*` | `frontend-coaching/` |

### Module Structure

```
backend/
├── server.js                         ← Entry point
├── config/
│   ├── database.js                   ← Supabase client (service-role)
│   ├── modules.js                    ← Module enable/disable flags
│   ├── permissions.js                ← RBAC definitions
│   └── seed.js                       ← Default data seeding
├── middleware/
│   ├── auth.js                       ← JWT verification, role guards
│   ├── audit.js                      ← Audit trail middleware
│   └── module-check.js               ← Blocks requests to disabled modules
├── shared/routes/
│   ├── auth.js                       ← Login, register, SSO, select-company
│   ├── companies.js                  ← Company CRUD
│   ├── users.js                      ← User management
│   ├── employees.js                  ← Shared employee records
│   ├── customers.js                  ← Shared customer records
│   ├── audit.js                      ← Audit log queries
│   └── eco-clients.js                ← Ecosystem client management
├── modules/
│   ├── accounting/                   ← Full GL, bank recon, VAT, PAYE
│   ├── payroll/                      ← Pay runs, payslips, attendance
│   ├── pos/                          ← Products, sales, tills, inventory
│   └── coaching/                     ← Coaching clients, sessions, AI
├── sean/
│   ├── routes.js                     ← SEAN AI REST endpoints
│   ├── decision-engine.js            ← Core AI allocation engine
│   ├── knowledge-base.js             ← Teach/learn from corrections
│   ├── calculations.js               ← SA tax & VAT calculations
│   ├── payroll-intelligence.js       ← SEAN × Payroll bridge
│   ├── encryption.js                 ← Per-company data encryption
│   ├── supabase-store.js             ← SEAN data persistence layer
│   └── universal-importer/           ← Bank statement import pipeline
└── inter-company/
    ├── routes.js                     ← Inter-company REST API
    ├── network.js                    ← Company relationship management
    ├── invoice-sender.js             ← Send invoices between companies
    ├── invoice-receiver.js           ← Receive & approve invoices
    └── payment-sync.js               ← Cross-company payment reconciliation
```

---

## 4. API Surface Map

All routes require `Authorization: Bearer <token>` unless noted.

### Shared Routes (Always Active)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | None | Login, returns eco_token |
| POST | `/api/auth/register` | None | Register user + company |
| POST | `/api/auth/select-company` | Token | Switch active company in token |
| POST | `/api/auth/sso-launch` | Token | Generate app-specific token |
| GET | `/api/auth/me` | Token | Get current user info |
| GET | `/api/auth/companies` | Token | List user's companies |
| GET/POST/PATCH/DELETE | `/api/companies/*` | Token | Company management |
| GET/POST/PATCH/DELETE | `/api/users/*` | Token | User management |
| GET/POST/PATCH/DELETE | `/api/employees/*` | Token | Shared employee records |
| GET/POST/PATCH/DELETE | `/api/customers/*` | None* | Customer records |
| GET | `/api/eco-clients/*` | Token | Ecosystem client list |
| GET | `/api/audit/*` | Token | Audit log reads |
| GET | `/api/health` | None | Server health + modules status |
| GET | `/api/modules` | None | Module status list |

### POS Module (`MODULE_POS_ENABLED=true`)

| Method | Path | Description |
|--------|------|-------------|
| `*` | `/api/pos/*` | Full POS operations |
| `*` | `/api/receipts/*` | Receipt management |
| `*` | `/api/barcode/*` | Barcode lookup/generation |
| `*` | `/api/inventory/*` | Inventory management |
| `*` | `/api/reports/*` | POS reports |
| GET | `/api/locations` | Stub — returns `[]` |
| GET | `/api/transfers` | Stub — returns `[]` |
| GET | `/api/purchase-orders` | Stub — returns `[]` |

**POS Sub-routes:** `products`, `categories`, `customers`, `sales`, `sessions`, `tills`, `inventory`, `receipts`, `barcodes`, `reports`

### Payroll Module (`MODULE_PAYROLL_ENABLED=true`)

| Method | Path | Description |
|--------|------|-------------|
| `*` | `/api/payroll/*` | Full payroll operations |
| `*` | `/api/payroll/sean/*` | SEAN × Payroll intelligence |

**Payroll sub-routes:** `employees`, `periods`, `transactions`, `items`, `attendance`, `kv`  
**SEAN × Payroll:** `preflight`, `optimize-tax`, `forecast`, `compliance`, `employee-cost`, `learn`

### Accounting Module (`MODULE_ACCOUNTING_ENABLED=true`)

| Method | Path | Description |
|--------|------|-------------|
| `*` | `/api/accounting/*` | Full accounting operations |

**Accounting sub-routes:** `accounts`, `bank`, `journals`, `company`, `employees`, `reports`, `vat`, `vatRecon`, `payeConfig`, `payeReconciliation`, `integrations`, `audit`, `ai`, `kv`

### SEAN AI Module (`MODULE_SEAN_ENABLED=true`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sean/suggest` | Allocation suggestion |
| POST | `/api/sean/learn` | Learn from correction |
| POST | `/api/sean/chat` | General AI chat |
| POST | `/api/sean/calculate` | SA tax/VAT calculation |
| GET | `/api/sean/categories` | Allocation categories |
| GET | `/api/sean/stats` | Usage statistics |
| GET/POST | `/api/sean/codex` | Knowledge base entries |
| POST | `/api/sean/codex/teach` | Teach new knowledge |
| GET | `/api/sean/codex/search` | Search knowledge base |
| GET/POST | `/api/sean/transactions` | Bank transactions |
| PATCH | `/api/sean/transactions/:id` | Update allocation |
| `*` | `/api/inter-company/*` | Inter-company invoice sync |

**Inter-company sub-routes:** `enable`, `find`, `relationships`, `invoices/send`, `invoices/inbox`, `invoices/sent`, `reconcile`

### Coaching Module (Auto-loaded if `COACHING_DATABASE_URL` set)

| Method | Path | Description |
|--------|------|-------------|
| `*` | `/api/coaching/auth/*` | Coaching login |
| `*` | `/api/coaching/clients/*` | Client management |
| `*` | `/api/coaching/leads/*` | Lead tracking |
| `*` | `/api/coaching/admin/*` | Admin operations |
| `*` | `/api/coaching/ai/*` | AI coaching assistant |

---

## 5. Auth & SSO Flow

### Token Architecture

All tokens are **HS256 JWT**, signed with `process.env.JWT_SECRET` (defaults to `'change-this-secret'` — **must be set in production**). Tokens expire in **8 hours**.

**JWT Payload:**
```json
{
  "userId": 1,
  "username": "admin",
  "email": "admin@company.com",
  "fullName": "Admin User",
  "companyId": 1,
  "role": "business_owner",
  "isSuperAdmin": false,
  "ssoSource": "ecosystem",      // present when launched via SSO
  "targetApp": "accounting",      // present when launched via SSO
  "iat": 1741600000,
  "exp": 1741628800
}
```

### Login Flow (Ecosystem)

```
1. User → POST /api/auth/login (username + password)
2. Server → bcrypt verify password
3. Server → fetch user's company access list
4. Server → auto-select primary company (or "The Infinite Legacy" for super_admin)
5. Server → sign JWT with companyId + role embedded
6. Client → store:
     localStorage.eco_token     = JWT token
     localStorage.eco_user      = user JSON
     localStorage.eco_companies = companies array
     localStorage.eco_super_admin = 'true' / 'false'
7. Client → redirect to dashboard.html
```

### SSO Launch Flow (Dashboard → App)

```
1. User clicks app on dashboard
2. Client → POST /api/auth/sso-launch { targetApp: 'accounting', companyId: 1 }
   Headers: Authorization: Bearer <eco_token>
3. Server → validate eco_token
4. Server → verify user has access to requested companyId
5. Server → sign new appToken with { ...userInfo, companyId, role, ssoSource: 'ecosystem', targetApp }
6. Server → audit log SSO_LAUNCH event
7. Client → store appToken:
     App-specific key:    localStorage[`${appKey}_token`]
     OR generic 'token'   localStorage.token
     OR 'auth_token'      localStorage.auth_token  (coaching)
     Marker:              localStorage.sso_source = 'ecosystem'
8. Client → window.location = '/accounting/' (or /payroll/, /pos/, etc.)
9. App → reads token from localStorage, makes API calls with Bearer token
```

### Multi-Company Switching

```
POST /api/auth/select-company { companyId: 2 }
→ Server validates user has access to company 2
→ Returns new token with updated companyId + role
→ Client updates localStorage.eco_token
```

### Company-Level Permission Check (Two Layers)

Both must pass for any module route to work:
1. **Server module flag** — `MODULE_X_ENABLED=true` env var
2. **Company modules_enabled** — `companies.modules_enabled` array in database contains the module key

```javascript
// Layer 1: Server-level (modules.js)
isModuleEnabled('pos') // checks env var

// Layer 2: Company-level (module-check middleware)
companyHasModule(supabase, companyId, 'pos') // checks DB
```

### `eco-api-interceptor.js` (Accounting Frontend Only)

The accounting frontend has `eco-api-interceptor.js` which does two things:
1. **URL rewriting**: Intercepts all `fetch()` and `XMLHttpRequest` calls, rewrites `/api/*` → `/api/accounting/*` so accounting pages work without per-page API prefixing.
2. **User shape bridging**: Maps `eco_user` shape (`userId`, `fullName`) to Lorenco accounting user shape (`id`, `firstName`, `lastName`) so accounting pages display user info correctly.

> **Note:** `eco-api-interceptor.js` exists only in `frontend-accounting/js/`. Payroll frontend does NOT have it — payroll pages use direct API paths.

---

## 6. Data Ownership & Storage

### Database Layer

**Single Supabase instance** serves all ecosystem modules.  
**Connection:** `@supabase/supabase-js` with **service-role key** (bypasses Row Level Security).  
**Multi-tenant:** All tables include `company_id` column. Every query filters by `req.companyId` from JWT.

### Data Ownership by Module

| Data Type | Owner Module | Table(s) | Accessed By |
|-----------|-------------|---------|-------------|
| Users | Shared | `users` | All modules |
| Companies | Shared | `companies`, `user_company_access` | All modules |
| Employees | Shared | `employees` | Payroll, Accounting, POS |
| Customers | Shared | `customers` | POS, Accounting |
| Audit Log | Shared | `audit_logs` | All modules (write), Accounting (display) |
| Products | POS | `products`, `categories` | POS |
| Sales | POS | `sales`, `sale_items`, `sale_payments` | POS, Accounting (via integration) |
| Inventory | POS | `inventory_adjustments` | POS |
| Tills | POS | `tills` | POS |
| Pay Periods | Payroll | `payroll_periods` | Payroll, SEAN |
| Pay Transactions | Payroll | `payroll_transactions`, `payslip_items` | Payroll, SEAN |
| Payroll Items | Payroll | `payroll_items_master` | Payroll |
| Attendance | Payroll | `attendance` | Payroll |
| Employee Bank | Payroll | `employee_bank_details` | Payroll |
| KV Store (Payroll) | Payroll | `payroll_kv_store` | Payroll frontend |
| Chart of Accounts | Accounting | `chart_of_accounts` | Accounting |
| Journal Entries | Accounting | `journal_entries`, `journal_lines` | Accounting |
| Bank Accounts | Accounting | `bank_accounts`, `bank_transactions_gl` | Accounting |
| Financial Periods | Accounting | `financial_periods` | Accounting |
| KV Store (Accounting) | Accounting | Supabase via `/api/accounting/kv` | Accounting frontend (ledger.js) |
| SEAN Codex | SEAN | `sean_codex_private`, `sean_patterns_global` | SEAN |
| SEAN Patterns | SEAN | `sean_learning_log`, `sean_knowledge_items` | SEAN |
| SEAN Transactions | SEAN | `sean_bank_transactions` | SEAN, Accounting |
| SEAN Rules | SEAN | `sean_allocation_rules` | SEAN |
| Integrations | Accounting | `integrations` | POS (push to Accounting) |
| Inter-Company | SEAN | (via supabase-store) | Inter-company module |
| Coaching Clients | Coaching | Coaching DB | Coaching |

### localStorage Usage (Session/Auth only — no business data)

| Key | App | Contains | Business Data? |
|-----|-----|----------|----------------|
| `eco_token` | Ecosystem | JWT token | ❌ Auth only |
| `eco_user` | Ecosystem | User JSON | ❌ Auth only |
| `eco_companies` | Ecosystem | Company list | ❌ Auth only |
| `eco_super_admin` | Ecosystem | Boolean flag | ❌ Auth only |
| `token` / `auth_token` | Apps | App JWT (SSO) | ❌ Auth only |
| `sso_source` | Apps | `'ecosystem'` marker | ❌ Auth only |
| `user` | Accounting | Mapped user shape | ❌ Auth only |

> **`ledger.js`** operates as a cloud bridge — all `localStorage.setItem/getItem` calls by accounting pages for business data keys are intercepted and routed to `/api/accounting/kv` (Supabase-backed). Business data never actually persists in the browser.

---

## 7. Cross-App Data Flows

### 1. POS → Accounting (Integration Push)

External or POS app pushes sales journal entries into accounting via API key auth:

```
POS sale completed
→ POST /api/accounting/integrations (X-Integration-Key: <hashed key>)
→ JournalService creates debits/credits
→ AuditLogger records action
```

- Auth: `X-Integration-Key` header (SHA-256 hashed, stored in `integrations` table)
- No direct DB coupling — clean HTTP integration boundary

### 2. SEAN × Payroll

SEAN payroll intelligence is exposed at `/api/payroll/sean/*`:

```
Payroll page request
→ /api/payroll/sean/:periodId/preflight
→ PayrollIntelligence reads employees + payroll_periods from Supabase
→ Returns tax optimisation, compliance checks, cash flow forecast
```

- Tight internal coupling: `PayrollIntelligence` directly queries `employees` and `payroll_periods` tables
- Encryption key: `SEAN_KEY_COMPANY_${companyId}` env var, fallback to default key

### 3. SEAN × Accounting (Bank Transactions)

SEAN processes unallocated bank transactions:

```
Bank statement imported
→ POST /api/sean/transactions (batch)
→ SEAN decision engine suggests allocation category
→ User confirms/corrects
→ POST /api/sean/learn (correction recorded)
→ Journal entry created in /api/accounting/journals
```

- Data bridge: `sean_bank_transactions` table is owned by SEAN module but linked to accounting

### 4. Inter-Company Invoice Sync

Companies on the platform can send invoices to each other:

```
Company A sends invoice
→ POST /api/inter-company/invoices/send { targetCompanyId, invoiceData }
→ InvoiceSender creates record in supabase-store
→ Company B sees inbox at GET /api/inter-company/invoices/inbox
→ Company B approves → AP journal entry created in their accounting
```

- Data : stored in SEAN's `supabase-store` (shared across both companies)
- Payment sync: `POST /api/inter-company/reconcile` auto-matches payments

### 5. Coaching ↔ Ecosystem

Coaching module is accessed via SSO from dashboard (`targetApp: 'coaching'`), but uses:
- **Separate DB** if `COACHING_DATABASE_URL` is set, otherwise falls back to main `DATABASE_URL`
- No direct data coupling to payroll/accounting tables

### 6. Sean Webapp ↔ Ecosystem Backend

`sean-webapp/` is a **completely separate Next.js application** with its own API routes under `app/api/`. It proxies to the ecosystem backend or has its own Supabase connection (requires investigation — see Risk #7).

---

## 8. Shared vs Duplicated Logic

### Truly Shared (Single Source)

| File | Location | Used By |
|------|----------|---------|
| `database.js` | `backend/config/` | All backend modules |
| `permissions.js` | `backend/config/` | All route guards |
| `modules.js` | `backend/config/` | server.js |
| `auth.js` middleware | `backend/middleware/` | All authenticated routes |
| `audit.js` middleware | `backend/middleware/` | All modules |
| `shared/routes/` | `backend/shared/` | Registered on all configs |
| `supabase-store.js` | `backend/sean/` | SEAN + Inter-company |

### Copied / Duplicated (Divergence Risk)

| File | Copies At | Risk |
|------|-----------|------|
| `polyfills.js` | `shared/js/` (master) + 6 app folders | Must sync after every update |
| `auth.js` (frontend) | Each of: `Payroll/Payroll_App/js/`, `accounting-ecosystem/frontend-payroll/js/` | Will diverge — different API base URLs |
| `permissions.js` (frontend) | `Payroll/Payroll_App/js/`, `accounting-ecosystem/frontend-payroll/js/` | Likely already diverged |
| `navigation.js` | `accounting-ecosystem/frontend-accounting/js/` only | Not shared |
| `payroll-engine.js` | `Payroll/Payroll_App/js/` + `accounting-ecosystem/frontend-payroll/js/` | Verified divergence — standalone vs ecosystem |

### App-Specific (Not Shared, By Design)

| File | App | Purpose |
|------|-----|---------|
| `ledger.js` | Accounting frontend | Cloud localStorage bridge for accounting pages |
| `eco-api-interceptor.js` | Accounting frontend | URL rewriting + SSO bridging |
| `payroll-engine.js` | Payroll frontend | Client-side payroll calculation |
| `sean-helper.js` | Payroll frontend | SEAN API wrapper |
| `data-access.js` | Payroll frontend | Data persistence layer (Supabase via `/api/storage/`) |

---

## 9. Role-Based Access Control

### Role Hierarchy

| Role | Level | Typical Use |
|------|-------|-------------|
| `super_admin` | 100 | Platform owner — all companies, all modules |
| `business_owner` | 95 | Full access to own company |
| `accountant` | 90 | Finance + payroll access |
| `corporate_admin` | 90 | Multi-location finance management |
| `store_manager` | 70 | Store-level POS + reporting |
| `payroll_admin` | 70 | Payroll management only |
| `assistant_manager` | 50 | Limited management |
| `shift_supervisor` | 40 | Shift-level oversight |
| `senior_cashier` | 30 | POS + basic reports |
| `cashier` | 20 | POS terminal only |
| `trainee` | 5 | Supervised access |

### Permission Categories

`COMPANIES`, `USERS`, `EMPLOYEES`, `PRODUCTS`, `CATEGORIES`, `SALES`, `INVENTORY`, `RECEIPTS`, `REPORTS`, `ANALYTICS`, `PROMOTIONS`, `LOYALTY`, `SCHEDULING`, `CUSTOMERS`, `SUPPLIERS`, `PURCHASE_ORDERS`, `BARCODES`, `PAYROLL`, `PAYE`, `LEAVE`, `ATTENDANCE`, `BANKING`, `AUDIT`, `INTEGRATIONS`, `SYSTEM`

### Guard Usage

```javascript
// Middleware guards (backend)
authenticateToken          // verify JWT — all protected routes
requireCompany             // ensure companyId is in token
requirePermission('PAYROLL.CREATE')  // check RBAC permission
requireRole(['business_owner', 'accountant'])  // check role
requireSuperAdmin          // super_admin only
requireModule('payroll')   // module must be enabled (2-layer)
```

---

## 10. Module System

Modules are **opt-in via environment variables**. Both the server flag AND the company's `modules_enabled` array must approve access.

| Module | Env Var | Route Prefix | Required Tables |
|--------|---------|--------------|-----------------|
| `pos` | `MODULE_POS_ENABLED=true` | `/api/pos` | products, categories, sales, tills, customers, inventory_adjustments |
| `payroll` | `MODULE_PAYROLL_ENABLED=true` | `/api/payroll` | payroll_periods, payroll_transactions, payslip_items, payroll_items_master, attendance, employee_bank_details |
| `accounting` | `MODULE_ACCOUNTING_ENABLED=true` | `/api/accounting` | chart_of_accounts, journal_entries, journal_lines, bank_accounts, bank_transactions_gl, financial_periods |
| `sean` | `MODULE_SEAN_ENABLED=true` | `/api/sean`, `/api/inter-company` | sean_codex_private, sean_patterns_global, sean_learning_log, sean_knowledge_items, sean_allocation_rules, sean_bank_transactions |
| `coaching` | `COACHING_DATABASE_URL` (any value) | `/api/coaching` | coaching-specific tables |

**Enabling a module for a company:**
1. Set env var on server
2. Add module key to `companies.modules_enabled` array in DB

---

## 11. Deployment Architecture

### Production (Zeabur)

All-in-one deployment — single Express server serves everything:

```
zeabur.app
├── /                  → Ecosystem login
├── /dashboard         → App launcher
├── /accounting/*      → Frontend-accounting (30 static HTML pages)
├── /payroll/*         → Frontend-payroll (16 static HTML pages)
├── /pos/*             → Frontend-pos
├── /sean/*            → Frontend-sean
├── /coaching/*        → Frontend-coaching
└── /api/*             → Backend REST API
```

**Required Environment Variables:**

```env
# Core
PORT=3000
NODE_ENV=production
JWT_SECRET=<strong-secret>

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=<service-role-key>
SUPABASE_ANON_KEY=<anon-key>

# Module Flags
MODULE_POS_ENABLED=true
MODULE_PAYROLL_ENABLED=true
MODULE_ACCOUNTING_ENABLED=true
MODULE_SEAN_ENABLED=true

# SEAN Encryption
SEAN_DEFAULT_KEY=<32-char-hex>
SEAN_KEY_COMPANY_1=<32-char-hex>  # per-company override (optional)

# Optional
COACHING_DATABASE_URL=<postgres-url>  # enables coaching module
FRONTEND_POS_URL=https://...
FRONTEND_PAYROLL_URL=https://...
FRONTEND_ACCOUNTING_URL=https://...
APP_URL=https://your-app.zeabur.app
```

**Dockerfile:** Present at `accounting-ecosystem/Dockerfile`  
**Zbpack config:** `accounting-ecosystem/zbpack.json` (Zeabur-specific build)

### Legacy Standalone Apps

| App | Port | Config | Deploy |
|-----|------|--------|--------|
| `Payroll/` | 3131 | `Payroll/config/database.js` (Supabase) | Zeabur/Heroku (Procfile present) |
| `Point of Sale/` | 8080 | PostgreSQL `DATABASE_URL` | Zeabur (Procfile present) |

### Sean Webapp

Separate Next.js deployment. Auth is `app/api/auth/login` — likely independent JWT secret and separate Supabase tables. Integration with ecosystem unclear — **needs investigation**.

---

## 12. Risk Register

### 🔴 Critical

| # | Risk | Location | Impact | Action |
|---|------|----------|--------|--------|
| R1 | ~~**JWT_SECRET defaults to `'change-this-secret'`**~~ ✅ **RESOLVED** — `server.js` now exits (`process.exit(1)`) if `NODE_ENV=production` and JWT_SECRET is default | `backend/server.js` | Anyone can forge tokens in production if env not set | ✅ Fixed |
| R2 | **Two parallel payroll systems** — `Payroll/` (port 3131) and `accounting-ecosystem/frontend-payroll/` — both write to Supabase but different API paths (`/api/storage/` vs `/api/payroll/`) | `payroll_kv_store` vs payroll module tables | Data divergence, employees in both systems won't match | Define which is authoritative. Decommission legacy or migrate data |
| R3 | **Two parallel POS systems** — `Point of Sale/` (port 8080, PostgreSQL) and `accounting-ecosystem/frontend-pos/` (Supabase) | Different databases | Sales data split across two DBs | Migrate legacy POS to ecosystem or clearly document boundary |

### 🟡 High

| # | Risk | Location | Impact | Action |
|---|------|----------|--------|--------|
| R4 | ~~**`polyfills.js` copied to 6 folders**~~ ✅ **RESOLVED** — `scripts/sync-polyfills.sh` created; run after every update to `shared/js/polyfills.js` | `shared/js/` + 6 copies | Browser bug fixes reach some apps but not others | Run `bash scripts/sync-polyfills.sh` after each update |
| R5 | ~~**`customers` route missing auth`**~~ ✅ **RESOLVED** — `authenticateToken` added to `/api/customers` | `backend/server.js` | Customer data accessible without a valid token | ✅ Fixed |
| R6 | **Inter-company data stored in SEAN's supabase-store** | `backend/inter-company/routes.js` | If SEAN module is disabled, inter-company breaks entirely | Inter-company should have own data layer |
| R7 | ~~**Sean webapp auth isolation**~~ ✅ **RESOLVED (by design)** — `sean-webapp` uses **Prisma** (own PostgreSQL via `DATABASE_URL`), **email-only login** (no password), **httpOnly cookie sessions** (30 days), and a hardcoded super-user list. Completely isolated from ecosystem JWT. No fix needed. | `sean-webapp/app/api/auth/` | None — intentionally isolated; super-users only | No action required — document as separate system |
| R8 | ~~**Coaching DB can be separate**~~ ✅ **RESOLVED (documented)** — `modules/coaching/db.js` uses `COACHING_DATABASE_URL \|\| DATABASE_URL`. If `DATABASE_URL` points to main Supabase DB, coaching shares the same DB. Set `COACHING_DATABASE_URL` separately only if you want coaching on a different DB. Both are valid — choose per-environment. | `COACHING_DATABASE_URL` | Coaching data isolated from main platform if separate DB chosen | Confirm env var strategy per environment (same DB = leave unset) |

### 🟢 Low / Monitored

| # | Risk | Location | Impact | Action |
|---|------|----------|--------|--------|
| R9 | **Service-role Supabase key bypasses RLS** | `backend/config/database.js` | Backend has unrestricted DB access | Ensure no user-controlled input can trigger arbitrary queries |
| R10 | **CORS allows all `.zeabur.app`** | `backend/server.js` | Any Zeabur-deployed app can make authenticated requests | Acceptable for now; tighten to specific domains when stable |
| R11 | **`eco-api-interceptor.js` not in payroll frontend** | `frontend-payroll/js/` | Payroll pages use hardcoded `/api/payroll/` paths — fine today | Document this is intentional, not an oversight |
| R12 | **`supabase-config.js` in POS frontend** | `frontend-pos/supabase-config.js` | Direct Supabase access from browser (anon key exposed) | Confirm this uses anon key only, no service-role in browser |

---

## 13. Follow-Up Action Items

### Immediate (Before Next Release)

- [x] **R1** — ✅ `server.js` exits with error if `JWT_SECRET` is default in production (`NODE_ENV=production`)
- [x] **R5** — ✅ `authenticateToken` added to `/api/customers` route in `backend/server.js`

### Short-Term (This Sprint)

- [x] **R4** — ✅ `scripts/sync-polyfills.sh` created — run after every `shared/js/polyfills.js` update
- [x] **R2** — ✅ Deprecation banner added to `Payroll/server.js`
- [x] **R3** — ✅ Deprecation banner added to `Point of Sale/server.js`

### Medium-Term

- [x] **R7** — ✅ Audited: sean-webapp is fully isolated (Prisma, own DB, email-only auth, cookie sessions) — no action needed
- [x] **R8** — ✅ Documented: coaching uses `COACHING_DATABASE_URL || DATABASE_URL` — choose per-environment
- [ ] **R6** — Move inter-company data store out of SEAN dependency

### Long-Term

- [ ] Consider replacing copied `polyfills.js` pattern with a proper shared build pipeline (Webpack/Vite)
- [ ] Evaluate decommissioning `Payroll/` and `Point of Sale/` legacy standalones
- [ ] Add Playwright cross-browser tests covering SSO launch flow

---

*Last updated: March 10, 2026 — Phase 6 Ecosystem Architecture Audit*
