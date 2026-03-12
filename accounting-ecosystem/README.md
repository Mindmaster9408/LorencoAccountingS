# Accounting Ecosystem

Unified modular backend and frontends for the Lorenco business suite.

---

## ══════════════════════════════════════════════════════
## ARCHITECTURAL PRINCIPLES — READ BEFORE BUILDING ANY APP
## ══════════════════════════════════════════════════════

These rules apply to **every** app in this ecosystem (current and future),
excluding the Sean AI webapp and the Coaching app which have their own models.

### 1. Supabase-first — NEVER browser localStorage for business data

> **Rule: All business data lives in Supabase. Browser localStorage is reserved
> for auth tokens and UI preferences ONLY.**

Every frontend app MUST load `js/polyfills.js` as its **first** `<script>` tag.
This script:
- Intercepts `localStorage.*` calls so nothing is accidentally stored locally.
- Provides `window.safeLocalStorage` — a cloud-backed storage API that
  transparently writes all business data to Supabase via the `/api/<module>/kv` endpoint.
- Stores only auth tokens (`token`, `session`, etc.) and UI preferences
  (`theme`, `darkMode`, etc.) in native browser localStorage.

**When building a new app:**
```js
// ✅ CORRECT — cloud-backed, Supabase-stored
safeLocalStorage.setItem('invoices', JSON.stringify(data));

// ❌ WRONG — data stays in the browser, lost on logout or different device
localStorage.setItem('invoices', JSON.stringify(data));
```

### 2. Per-client isolation — every company's data is fully separated

> **Rule: Each company (client) has its own isolated data namespace. No two
> companies can ever see each other's data.**

Each app achieves this differently but the result is the same:

| App | Isolation method |
|-----|-----------------|
| **Paytime (Payroll)** | All storage keys prefixed with `company_id` (e.g. `employees_<uuid>`) |
| **Accounting** | `polyfills.js` auto-prefixes all keys with `acct_<companyId>_` |
| **POS (Checkout Charlie)** | All data goes via REST API; backend enforces `company_id` row-level security |
| **New apps** | Must follow one of the above two patterns — see §4 |

The user selects a company at login → `activeCompanyId` is stored in localStorage
(a LOCAL_KEY) → all subsequent data operations are scoped to that company_id automatically.

### 3. Auth model

All apps use JWT authentication against `/api/auth/*`:
- Login → receive JWT + company list → store JWT in native localStorage
- Every API call carries `Authorization: Bearer <token>`
- Backend middleware (`backend/middleware/auth.js`) validates the JWT and
  attaches `req.user` + `req.companyId` to every request
- Frontend `js/auth.js` provides `AUTH.requireAuth()`, `AUTH.getSession()`,
  `AUTH.logout()`

### 4. Rules for building a new app in this ecosystem

When a new module/app is added (e.g. "HR", "Fleet", "CRM"), it **MUST**:

1. **Start with Supabase tables** — design the schema in `database/schema.sql`
   with `company_id` foreign key on every business table before writing any frontend code.

2. **Create a backend module** in `backend/modules/<name>/` with:
   - A KV endpoint: `GET/PUT/DELETE /api/<name>/kv` (same pattern as payroll/accounting)
   - All business routes scoped to `req.companyId`

3. **Copy `polyfills.js`** from an existing app (payroll or accounting) as the
   base and update the `KV` constant to `/api/<name>/kv`.

4. **Load `polyfills.js` first** on every HTML page — before any other script.

5. **Never** use raw `localStorage` for business data — ever.
   The monkey-patch in `polyfills.js` will catch most accidental uses,
   but be intentional: always use `safeLocalStorage.*`.

6. **App structure template:**
   ```
   frontend-<name>/
   ├── js/
   │   ├── polyfills.js   ← copy from payroll, update KV constant
   │   ├── auth.js        ← copy from payroll (shared auth model)
   │   └── <feature>.js
   ├── css/
   ├── index.html         ← first script: <script src="js/polyfills.js">
   └── login.html
   ```

---

## App Directory

```
accounting-ecosystem/
├── backend/                    # Express API server
│   ├── server.js               # Entry point
│   ├── config/
│   │   ├── database.js         # Supabase connection
│   │   ├── modules.js          # Module activation config
│   │   └── permissions.js      # Unified RBAC
│   ├── middleware/
│   │   ├── auth.js             # JWT authentication
│   │   ├── audit.js            # Forensic audit logging
│   │   └── module-check.js     # Module gate middleware
│   ├── shared/routes/          # Always-active routes
│   │   ├── auth.js             # Login, register, company selection
│   │   ├── companies.js        # Company CRUD
│   │   ├── users.js            # User management
│   │   ├── employees.js        # Employee management
│   │   └── audit.js            # Audit log queries
│   └── modules/
│       ├── pos/                # Checkout Charlie POS
│       ├── payroll/            # Lorenco Paytime Payroll
│       └── accounting/         # General Accounting
├── frontend-pos/               # POS — API-driven, Supabase-backed
├── frontend-payroll/           # Payroll — KV-backed, per-company keyed
├── frontend-accounting/        # Accounting — KV-backed, auto-namespaced
├── frontend-ecosystem/         # Ecosystem navigator/dashboard
├── database/
│   └── schema.sql              # Unified Supabase schema
└── .env.example                # Environment template
```

## Modules

| Module | Name | Route Prefix | Storage |
|--------|------|-------------|---------|
| POS | Checkout Charlie | `/api/pos/*` | Supabase tables via REST API |
| Payroll | Lorenco Paytime | `/api/payroll/*` | Supabase KV, keys prefixed `company_id` |
| Accounting | General Ledger | `/api/accounting/*` | Supabase KV, keys auto-prefixed `acct_<cid>_` |

Modules are enabled/disabled via environment variables. Disabled modules return 403 for all routes.

## Quick Start

### 1. Prerequisites
- Node.js 18+
- A Supabase project (free tier works)

### 2. Setup

```bash
cd backend
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your Supabase credentials and JWT secret
```

### 3. Database

Run `database/schema.sql` in your Supabase SQL Editor to create all tables.

Then initialize default payroll items for your first company:
```sql
SELECT initialize_payroll_defaults(1);
```

### 4. Run

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

The server starts on `http://localhost:3000` by default.

### 5. Access

| URL | Description |
|-----|-------------|
| `http://localhost:3000/api/health` | Health check |
| `http://localhost:3000/api/modules` | Module status |
| `http://localhost:3000/pos` | POS frontend |
| `http://localhost:3000/payroll` | Payroll frontend |

## API Routes

### Shared (always active)
- `POST /api/auth/login` — Login
- `POST /api/auth/register` — Register new user
- `POST /api/auth/select-company` — Switch company context
- `GET /api/auth/me` — Current user info
- `GET /api/auth/companies` — User's companies
- `GET /api/companies` — Company CRUD
- `GET /api/users` — User management
- `GET /api/employees` — Employee management
- `GET /api/audit` — Audit log queries

### POS Module (`MODULE_POS_ENABLED=true`)
- `/api/pos/products` — Product CRUD
- `/api/pos/sales` — Sales CRUD + void
- `/api/pos/customers` — Customer CRUD
- `/api/pos/categories` — Category CRUD
- `/api/pos/inventory` — Stock management

### Payroll Module (`MODULE_PAYROLL_ENABLED=true`)
- `/api/payroll/employees` — Payroll-specific employee data
- `/api/payroll/periods` — Pay periods
- `/api/payroll/transactions` — Payslip processing
- `/api/payroll/items` — Master payroll items
- `/api/payroll/attendance` — Attendance & leave

## Environment Variables

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
JWT_SECRET=your-secret-min-32-chars

MODULE_POS_ENABLED=true
MODULE_PAYROLL_ENABLED=false
MODULE_ACCOUNTING_ENABLED=false

PORT=3000
NODE_ENV=development
```

## Bug Fixes (from original apps)

1. **Default company duplication** — `ensureDefaultCompany()` now checks if companies exist before creating
2. **Missing company_id filtering** — All queries filter by `company_id` from JWT token
3. **No user edit endpoint** — Added `PUT /api/users/:id` for profile/role updates

## Security

- JWT tokens with company context (8h expiry, 24h for super admin)
- bcrypt password hashing (12 salt rounds)
- Helmet security headers
- CORS with allowlisted origins
- Row Level Security (RLS) on all Supabase tables
- Forensic audit logging on all write operations
- Module-level access control (server + company level)
