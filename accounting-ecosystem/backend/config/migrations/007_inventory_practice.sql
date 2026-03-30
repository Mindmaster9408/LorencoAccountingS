-- =============================================================================
-- Migration 007: Inventory (Lorenco Storehouse) + Practice (Lorenco Practice)
-- =============================================================================
-- Run this in your Supabase SQL Editor.
-- Creates all tables for both new modules.
-- All tables are scoped to company_id for full multi-tenant isolation.
-- =============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — LORENCO STOREHOUSE (Inventory Management)
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 1.1 Warehouses ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  location     TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warehouses_company ON warehouses(company_id);

-- ─── 1.2 Inventory Items ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id               SERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sku              TEXT,
  name             TEXT NOT NULL,
  description      TEXT,
  category         TEXT,
  unit             TEXT DEFAULT 'each',
  cost_price       NUMERIC(12,2),
  sell_price       NUMERIC(12,2),
  current_stock    NUMERIC(12,3) NOT NULL DEFAULT 0,
  reorder_level    NUMERIC(12,3) DEFAULT 0,
  warehouse_id     INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_company   ON inventory_items(company_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_warehouse ON inventory_items(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_sku       ON inventory_items(company_id, sku);

-- ─── 1.3 Suppliers ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  contact_name TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  notes        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_company ON suppliers(company_id);

-- ─── 1.4 Stock Movements ─────────────────────────────────────────────────────
-- Records every stock in/out/adjustment. The backend keeps current_stock updated.
CREATE TABLE IF NOT EXISTS stock_movements (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id         INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  warehouse_id    INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  movement_type   TEXT NOT NULL CHECK (movement_type IN ('in','out','adjustment','return')),
  quantity        NUMERIC(12,3) NOT NULL,
  unit_cost       NUMERIC(12,2),
  reference       TEXT,            -- e.g. PO number, invoice, notes
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_company ON stock_movements(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item    ON stock_movements(item_id);

-- ─── 1.5 Purchase Orders ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id    INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  po_number      TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','sent','partial','received','cancelled')),
  order_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date  DATE,
  notes          TEXT,
  total_amount   NUMERIC(12,2) DEFAULT 0,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_company  ON purchase_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);

-- ─── 1.6 Purchase Order Items ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id               SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id          INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  description      TEXT NOT NULL,
  quantity         NUMERIC(12,3) NOT NULL,
  unit_cost        NUMERIC(12,2) NOT NULL DEFAULT 0,
  received_qty     NUMERIC(12,3) NOT NULL DEFAULT 0,
  line_total       NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED
);

CREATE INDEX IF NOT EXISTS idx_po_items_order ON purchase_order_items(purchase_order_id);


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — LORENCO PRACTICE (Accounting Practice Management)
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 2.1 Practice Clients ────────────────────────────────────────────────────
-- These are the accounting practice's own clients (NOT eco_clients).
CREATE TABLE IF NOT EXISTS practice_clients (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  email                 TEXT,
  phone                 TEXT,
  industry              TEXT,
  vat_number            TEXT,
  registration_number   TEXT,
  fiscal_year_end       TEXT,     -- e.g. "February", "08-31"
  address               TEXT,
  notes                 TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_practice_clients_company ON practice_clients(company_id);

-- ─── 2.2 Practice Tasks ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS practice_tasks (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id    INTEGER REFERENCES practice_clients(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  type         TEXT NOT NULL DEFAULT 'general'
                 CHECK (type IN ('general','vat_return','tax_return','annual_financial',
                                 'payroll','audit','bookkeeping','secretarial','other')),
  priority     TEXT NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low','medium','high','urgent')),
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','in_progress','review','completed','cancelled')),
  due_date     DATE,
  completed_at TIMESTAMPTZ,
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_practice_tasks_company ON practice_tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_practice_tasks_client  ON practice_tasks(client_id);
CREATE INDEX IF NOT EXISTS idx_practice_tasks_status  ON practice_tasks(company_id, status);

-- ─── 2.3 Practice Time Entries ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS practice_time_entries (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  client_id    INTEGER REFERENCES practice_clients(id) ON DELETE SET NULL,
  task_id      INTEGER REFERENCES practice_tasks(id) ON DELETE SET NULL,
  hours        NUMERIC(6,2) NOT NULL CHECK (hours > 0),
  description  TEXT,
  date         DATE NOT NULL,
  billable     BOOLEAN NOT NULL DEFAULT TRUE,
  rate         NUMERIC(10,2),     -- hourly rate at time of entry
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_practice_time_company ON practice_time_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_practice_time_client  ON practice_time_entries(client_id);
CREATE INDEX IF NOT EXISTS idx_practice_time_user    ON practice_time_entries(user_id);

-- ─── 2.4 Practice Deadlines ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS practice_deadlines (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id    INTEGER REFERENCES practice_clients(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'general'
                 CHECK (type IN ('general','vat_return','tax_return','paye','uif',
                                 'annual_financial','company_registration','other')),
  due_date     DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','completed','missed')),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_practice_deadlines_company  ON practice_deadlines(company_id);
CREATE INDEX IF NOT EXISTS idx_practice_deadlines_client   ON practice_deadlines(client_id);
CREATE INDEX IF NOT EXISTS idx_practice_deadlines_due_date ON practice_deadlines(company_id, due_date);


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — Update companies modules_enabled defaults
-- ═════════════════════════════════════════════════════════════════════════════
-- Optionally add inventory + practice to companies that already have all
-- other modules enabled. Adjust the WHERE clause to target specific companies.
-- Uncomment the block below if you want to bulk-enable for all companies:

-- UPDATE companies
--   SET modules_enabled = array_append(
--         array_append(modules_enabled, 'inventory'),
--         'practice'
--       )
-- WHERE NOT (modules_enabled @> ARRAY['inventory'])
--    OR NOT (modules_enabled @> ARRAY['practice']);


-- ─── Verification ────────────────────────────────────────────────────────────
SELECT 'warehouses'           AS tbl, COUNT(*) FROM warehouses           UNION ALL
SELECT 'inventory_items',              COUNT(*) FROM inventory_items      UNION ALL
SELECT 'suppliers',                    COUNT(*) FROM suppliers            UNION ALL
SELECT 'stock_movements',              COUNT(*) FROM stock_movements      UNION ALL
SELECT 'purchase_orders',              COUNT(*) FROM purchase_orders      UNION ALL
SELECT 'purchase_order_items',         COUNT(*) FROM purchase_order_items UNION ALL
SELECT 'practice_clients',             COUNT(*) FROM practice_clients     UNION ALL
SELECT 'practice_tasks',               COUNT(*) FROM practice_tasks       UNION ALL
SELECT 'practice_time_entries',        COUNT(*) FROM practice_time_entries UNION ALL
SELECT 'practice_deadlines',           COUNT(*) FROM practice_deadlines
ORDER BY 1;
