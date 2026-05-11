# 02 — Backend Structure

---

## 1. Two Backend Systems

### System A — Legacy Standalone (DEPRECATED)
```
Point of Sale/
├── server.js          ← Express app, port 8080, auto-creates all DB tables on startup
├── database.js        ← PostgreSQL pool with SQLite-compatibility shim
├── middleware/
│   ├── auth.js        ← JWT authentication middleware
│   └── audit.js       ← Forensic audit log helpers
├── config/
│   └── permissions.js ← Role-based permission matrix
└── routes/
    ├── auth.js        ← Login, company selection, registration (1,561 lines)
    ├── pos.js         ← Core POS: tills, sessions, sales, stock (1,947 lines)
    ├── customers.js   ← Customer CRUD + loyalty + group pricing
    ├── reports.js     ← Sales, profit, VAT reports
    ├── inventory.js   ← Multi-location inventory management
    ├── barcode.js     ← EAN13/EAN8 barcode generation + validation
    ├── vat.js         ← VAT settings + calculation
    ├── sean-ai.js     ← AI product learning + insights
    ├── audit.js       ← Audit trail query + export
    ├── locations.js   ← Multi-location hierarchy management
    ├── employees.js   ← Employee CRUD + roles
    ├── scheduling.js  ← Shift scheduling + time entries
    ├── suppliers.js   ← Supplier master data
    ├── purchase-orders.js ← PO lifecycle
    ├── transfers.js   ← Stock transfers between locations
    ├── loyalty.js     ← Loyalty programs + tiers
    ├── promotions.js  ← Promotions + discounts
    ├── loss-prevention.js ← Loss detection rules + alerts
    ├── analytics.js   ← Business intelligence + KPIs
    ├── receipts.js    ← Receipt generation + email
    └── kv.js          ← Key-value storage API
```

### System B — Ecosystem POS Module (AUTHORITATIVE)
```
accounting-ecosystem/backend/modules/pos/
├── index.js           ← Route registration
└── routes/
    ├── sales.js       ← Sale creation, void, returns (Supabase)
    ├── sessions.js    ← Till session open/close (Supabase)
    ├── tills.js       ← Till management (Supabase)
    ├── products.js    ← Product CRUD (Supabase)
    ├── customers.js   ← Customer management (Supabase)
    ├── categories.js  ← Product categories (Supabase)
    ├── inventory.js   ← Inventory management (Supabase)
    ├── discounts.js   ← Daily discounts (Supabase)
    ├── loyalty.js     ← Loyalty points (Supabase)
    ├── receipts.js    ← Receipt generation
    └── kv.js          ← Cloud KV store (NOT localStorage)
```

---

## 2. Database Connections

### Legacy (System A)
`database.js` uses `pg.Pool` with Zeabur internal PostgreSQL:
```javascript
connectionString: process.env.DATABASE_URL
// SSL only for neon.tech external connections
```

**Critical:** `database.js` provides a SQLite-compatibility shim that converts `?` placeholders to `$1, $2, ...` for PostgreSQL. This means the route code uses SQLite syntax but runs on PostgreSQL. The shim has risks (see 10_RISKS_AND_PROTECTED_AREAS.md).

### Ecosystem (System B)
Uses Supabase JS client directly:
```javascript
const { supabase } = require('../../../config/database');
// supabase.from('sales').select(...)
```

---

## 3. Server Entry Point (Legacy)

`Point of Sale/server.js` (1,544 lines):
1. Loads Express, CORS, pg, bcrypt, dotenv
2. Defines `initDatabase()` — runs `CREATE TABLE IF NOT EXISTS` for every table
3. Registers all routes under `/api/*`
4. Calls `initDatabase()` then starts on port 8080

Route mounting (legacy):
```javascript
app.use('/api/auth',             authRoutes);
app.use('/api/pos',              posRoutes);
app.use('/api/sean',             seanAiRoutes);
app.use('/api/audit',            auditRoutes);
app.use('/api/vat',              vatRoutes);
app.use('/api/barcode',          barcodeRoutes);
app.use('/api/customers',        customersRoutes);
app.use('/api/reports',          reportsRoutes);
app.use('/api/locations',        locationsRoutes);
app.use('/api/employees',        employeesRoutes);
app.use('/api/scheduling',       schedulingRoutes);
app.use('/api/inventory',        inventoryRoutes);
app.use('/api/transfers',        transfersRoutes);
app.use('/api/suppliers',        suppliersRoutes);
app.use('/api/purchase-orders',  purchaseOrdersRoutes);
app.use('/api/analytics',        analyticsRoutes);
app.use('/api/loss-prevention',  lossPreventionRoutes);
app.use('/api/loyalty',          loyaltyRoutes);
app.use('/api/promotions',       promotionsRoutes);
app.use('/api/receipts',         receiptsRoutes);
app.use('/api/kv',               kvRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'POS_App', 'index.html'));
});
```

---

## 4. Authentication Middleware

`Point of Sale/middleware/auth.js`:

```javascript
authenticateToken(req, res, next)
  // Extracts Bearer token from Authorization header
  // jwt.verify(token, JWT_SECRET) → attaches req.user
  // req.user = { userId, role, companyId, ... }

requireCompany(req, res, next)
  // Checks req.user.companyId is set
  // Returns 400 if not — tells frontend to show company selector

requirePermission('CATEGORY.ACTION')
  // Calls hasPermission(role, category, action) from permissions.js
  // Returns 403 if denied

requireRole(['role1', 'role2'])
  // Whitelist role check
  // Returns 403 if role not in list

selfOrRole(['admin'], 'userId')
  // Allows users to access own resources, or elevated roles to access any
```

All POS routes begin with:
```javascript
router.use(authenticateToken);
router.use(requireCompany);
```

---

## 5. Permission System

`Point of Sale/config/permissions.js`

### Role Hierarchy (numeric level)

```
corporate_admin    100  ← Full system access
business_owner     100
accountant          95
corporate_finance   90
corporate_ops       85
regional_manager    70
regional_analyst    65
district_manager    50
district_trainer    45
store_manager       30
admin               30
assistant_manager   25
shift_supervisor    20
senior_cashier      15
cashier             10
trainee              5
```

### Permission Categories

```
POS:            MAKE_SALE, VOID_SALE, APPLY_DISCOUNT, PRICE_OVERRIDE, SPLIT_PAYMENT
PRODUCTS:       VIEW, CREATE, EDIT, DELETE, DAILY_DISCOUNTS
CUSTOMERS:      VIEW, CREATE, EDIT, DELETE, LOYALTY
TILL:           OPEN, CLOSE, VIEW_SESSIONS, DAILY_RESET
CASHUP:         OWN, OTHERS, APPROVE, REPORTS
STOCK:          VIEW, ADJUST, STOCK_TAKE, HISTORY
INVENTORY:      VIEW, MANAGE, TRANSFER, RECEIVE
SUPPLIERS:      VIEW, CREATE, EDIT, DELETE
PURCHASE_ORDERS: VIEW, CREATE, APPROVE, RECEIVE
REPORTS:        SALES, PROFIT, VAT, CASHUP, AUDIT
ANALYTICS:      DASHBOARD, KPIS, TARGETS, TRENDS, EXPORT
LOSS_PREVENTION: VIEW_RULES, MANAGE_ALERTS, INVESTIGATE
EMPLOYEES:      VIEW, CREATE, EDIT, DELETE, ASSIGN_ROLES
SETTINGS:       COMPANY, TILL, RECEIPT, VAT, BARCODE
SALES:          VIEW, CREATE, VOID (ecosystem naming)
```

---

## 6. Route Summary — Legacy `pos.js` (1,947 lines)

### Till & Sessions
```
GET  /api/pos/tills                     ← Active tills for company
GET  /api/pos/sessions                  ← All sessions (role-filtered)
GET  /api/pos/sessions/current          ← Current open session for logged-in user
POST /api/pos/sessions/open             ← Open till session
POST /api/pos/sessions/:id/close        ← Close till session (cash-up)
GET  /api/pos/sessions/:id/sales        ← Sales for a specific session
```

### Products
```
GET    /api/pos/products                ← All active products for company
GET    /api/pos/products/next-code/:prefix ← Generate next product code
GET    /api/pos/products/with-discounts ← Products with active daily discounts
GET    /api/pos/products/:id/stock-by-location ← Multi-location stock view
PUT    /api/pos/products/:id/stock-by-location ← Update stock per location
POST   /api/pos/products                ← Create product (requires PRODUCTS.CREATE)
PUT    /api/pos/products/:id            ← Update product (requires PRODUCTS.EDIT)
DELETE /api/pos/products/:id            ← Soft delete (requires PRODUCTS.DELETE)
```

### Sales
```
POST /api/pos/sales                     ← Create sale
POST /api/pos/sales/split-payment       ← Create sale with split payments
GET  /api/pos/sales                     ← List sales (role-filtered)
GET  /api/pos/sales/search              ← Search sales by number/date/customer
GET  /api/pos/sales/:id                 ← Sale detail + items
POST /api/pos/sales/:id/void            ← Void sale (requires POS.VOID_SALE)
POST /api/pos/sales/:id/return          ← Return items (requires POS.VOID_SALE)
```

### Stock
```
GET  /api/pos/stock                     ← Stock levels (with filters)
POST /api/pos/stock/adjust              ← Stock adjustment (requires STOCK.ADJUST)
POST /api/pos/stock/bulk-update         ← Stock take (requires STOCK.STOCK_TAKE)
GET  /api/pos/stock/history             ← Adjustment history
```

### Discounts & Overrides
```
GET    /api/pos/daily-discounts         ← Active discounts
POST   /api/pos/daily-discounts         ← Create discount (requires POS.APPLY_DISCOUNT)
DELETE /api/pos/daily-discounts/:id     ← Remove discount
POST   /api/pos/price-override          ← Manager price override
GET    /api/pos/reports/cash-up/:id     ← Cash-up report for session
```

---

## 7. Route Summary — Ecosystem `modules/pos/` (AUTHORITATIVE)

```
POST /api/pos/kv/:key                   ← Cloud KV set
GET  /api/pos/kv/:key                   ← Cloud KV get

GET    /api/pos/products                ← Products (Supabase)
POST   /api/pos/products                ← Create product
PUT    /api/pos/products/:id            ← Update product
DELETE /api/pos/products/:id            ← Soft delete

GET  /api/pos/sales                     ← Sales with pagination (Supabase)
GET  /api/pos/sales/:id                 ← Sale detail
POST /api/pos/sales                     ← Create sale (prices locked to DB)
POST /api/pos/sales/:id/void            ← Void sale
POST /api/pos/sales/:id/return          ← Process return

GET  /api/pos/sessions                  ← Till sessions
POST /api/pos/sessions                  ← Open session
PUT  /api/pos/sessions/:id/close        ← Close session (cash-up)

GET  /api/pos/tills                     ← Tills
POST /api/pos/tills                     ← Create till
PUT  /api/pos/tills/:id                 ← Update till

GET    /api/pos/customers               ← Customers
POST   /api/pos/customers               ← Create customer
PUT    /api/pos/customers/:id           ← Update customer

GET    /api/pos/categories              ← Categories
POST   /api/pos/categories              ← Create category

GET    /api/pos/inventory               ← Inventory
POST   /api/pos/inventory/adjust        ← Stock adjustment

GET    /api/pos/discounts               ← Daily discounts
POST   /api/pos/discounts               ← Create discount

GET    /api/pos/loyalty/:customerId     ← Customer loyalty points
POST   /api/pos/loyalty/redeem          ← Redeem points
```

---

## 8. Audit Middleware

### Legacy
`Point of Sale/middleware/audit.js` provides `logAudit(req, action, entity, entityId, options)`:
- Inserts into `audit_log` table (immutable append-only)
- Called explicitly in routes on critical mutations (CREATE sale, VOID, RETURN, STOCK_ADJUST)
- Also inserts into legacy `audit_trail` table for backwards compat

### Ecosystem
`auditFromReq(req, action, entity, entityId, options)` from `accounting-ecosystem/backend/middleware/audit.js`:
- Writes to Supabase `audit_log` table
- Called on: sale create, sale void, sale return

---

## 9. Company/Tenant Protection

Every query filters by `company_id`. This is enforced at the route level, not middleware level (the middleware only ensures `companyId` is present in the token, not that the DB record belongs to that company — the route code must do that).

Example:
```javascript
// Cashier can only see their own sessions
if (userRole === 'cashier') {
  query += ' AND ts.user_id = ?';
  params.push(userId);
}
```

**Risk:** If a route forgets to include `company_id` in a WHERE clause, a user could access another company's data. The routes reviewed all include company_id filtering, but this must be maintained vigilantly.

---

## 10. Super Admin

A `lorenco_admin` user is created on every server startup:
```javascript
INSERT INTO users (username, email, password_hash, full_name, role, user_type, is_super_admin)
VALUES ('lorenco_admin', 'antonjvr@lorenco.co.za', ...)
ON CONFLICT (username) DO UPDATE SET is_super_admin = 1
```

Super admins get access to all companies and a `24-hour` JWT token (vs 8 hours for regular users).
