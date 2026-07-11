/**
 * ============================================================================
 * POS Module — Auto Schema Migration
 * ============================================================================
 * Runs on server startup to ensure all POS tables and columns exist.
 * Uses CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS
 * so it is safe to run on every startup.
 *
 * Call: await ensurePosSchema(pool)
 * where pool is a pg.Pool connected to Supabase direct PostgreSQL.
 * ============================================================================
 */

async function ensurePosSchema(pool) {
  const client = await pool.connect();
  try {
    console.log('  🔧 POS: Checking/creating schema...');

    // ── inventory_adjustments ────────────────────────────────────────────────
    // The POS code uses 'inventory_adjustments' for stock adjustment records.
    // (The original schema.sql defined 'stock_adjustments' — this table bridges
    //  the gap so code works without requiring existing data to be migrated.)
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_adjustments (
        id               SERIAL PRIMARY KEY,
        company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        product_id       INTEGER NOT NULL REFERENCES products(id),
        adjusted_by      INTEGER REFERENCES users(id),
        quantity_before  INTEGER,
        quantity_change  INTEGER NOT NULL,
        quantity_after   INTEGER,
        reason           VARCHAR(100) DEFAULT 'manual',
        notes            TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_inventory_adj_company
        ON inventory_adjustments(company_id)
    `);

    // ── pos_daily_discounts ───────────────────────────────────────────────────
    // Per-product daily/promotional discounts.
    // Replaces the hardcoded stub in pos/index.js.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_daily_discounts (
        id             SERIAL PRIMARY KEY,
        company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        product_id     INTEGER NOT NULL REFERENCES products(id),
        discount_type  VARCHAR(20) NOT NULL DEFAULT 'fixed',
        discount_value DECIMAL(10,2) NOT NULL,
        valid_from     DATE,
        valid_until    DATE,
        reason         TEXT,
        created_by     INTEGER REFERENCES users(id),
        is_active      BOOLEAN DEFAULT true,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_discounts_company
        ON pos_daily_discounts(company_id)
    `);

    // ── products: add columns the POS code expects but schema.sql omitted ────
    // Schema originally had product_name/unit_price. Code now uses those names.
    // Add sku and unit as optional columns that the backend accepts.
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(100)`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit VARCHAR(50) DEFAULT 'each'`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS brand VARCHAR(100)`);

    // ── sales: add cashier_id alias + notes ──────────────────────────────────
    // The code uses cashier_id (the acting user). Schema has user_id NOT NULL.
    // We store BOTH: user_id is set via ALTER DEFAULT or migration; cashier_id is
    // an additional denormalised column for quick cashier lookups.
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_id INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS notes TEXT`);
    // Make sale_number nullable so legacy inserts don't crash if omitted.
    // New code always generates it; this just protects old in-flight records.
    await client.query(`ALTER TABLE sales ALTER COLUMN sale_number DROP NOT NULL`).catch(() => {});

    // ── sale_items: add columns the code inserts ─────────────────────────────
    await client.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS product_name VARCHAR(255)`);
    await client.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2) DEFAULT 0`);
    await client.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS vat_rate DECIMAL(5,2) DEFAULT 15`);
    await client.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS line_total DECIMAL(10,2)`);

    // ── pos_returns ───────────────────────────────────────────────────────────
    // Sale return/refund records (Sprint 2 — created now so the schema is ready).
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_returns (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        original_sale_id    INTEGER NOT NULL REFERENCES sales(id),
        return_date         TIMESTAMPTZ DEFAULT NOW(),
        refund_amount       DECIMAL(10,2) NOT NULL,
        refund_method       VARCHAR(50) NOT NULL DEFAULT 'cash',
        reason              TEXT,
        items_json          JSONB,
        status              VARCHAR(20) DEFAULT 'completed',
        processed_by        INTEGER REFERENCES users(id),
        created_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_returns_company
        ON pos_returns(company_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_returns_sale
        ON pos_returns(original_sale_id)
    `);

    // ── customers: add columns the code inserts but schema.sql omitted ────────
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_tier VARCHAR(50) DEFAULT 'bronze'`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS current_balance DECIMAL(10,2) DEFAULT 0`);

    // ── loyalty_programs ─────────────────────────────────────────────────────
    // One program config per company. Defines earn rate and redemption rules.
    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_programs (
        id                      SERIAL PRIMARY KEY,
        company_id              INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
        name                    VARCHAR(255) NOT NULL DEFAULT 'Loyalty Program',
        points_per_rand         DECIMAL(10,4) NOT NULL DEFAULT 1,
        redemption_rate         DECIMAL(10,4) NOT NULL DEFAULT 0.01,
        min_redemption_points   INTEGER NOT NULL DEFAULT 100,
        is_active               BOOLEAN DEFAULT true,
        created_at              TIMESTAMPTZ DEFAULT NOW(),
        updated_at              TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── loyalty_transactions ─────────────────────────────────────────────────
    // Records every earn/redeem/adjust event per customer.
    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        customer_id     INTEGER NOT NULL REFERENCES customers(id),
        sale_id         INTEGER REFERENCES sales(id),
        type            VARCHAR(20) NOT NULL DEFAULT 'earn',
        points          INTEGER NOT NULL,
        balance_after   INTEGER NOT NULL,
        notes           TEXT,
        created_by      INTEGER REFERENCES users(id),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_loyalty_tx_customer
        ON loyalty_transactions(company_id, customer_id)
    `);

    // ── customer_account_transactions ─────────────────────────────────────────
    // Tracks charge/payment/adjustment on customer account (credit accounts).
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_account_transactions (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        customer_id   INTEGER NOT NULL REFERENCES customers(id),
        sale_id       INTEGER REFERENCES sales(id),
        type          VARCHAR(20) NOT NULL DEFAULT 'charge',
        amount        DECIMAL(10,2) NOT NULL,
        balance_after DECIMAL(10,2) NOT NULL,
        reference     VARCHAR(100),
        notes         TEXT,
        created_by    INTEGER REFERENCES users(id),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_customer_acct_tx
        ON customer_account_transactions(company_id, customer_id)
    `);

    // ── pos_stock_takes ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_stock_takes (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        conducted_by    INTEGER REFERENCES users(id),
        notes           TEXT,
        product_count   INTEGER DEFAULT 0,
        variance_count  INTEGER DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_stock_takes_company
        ON pos_stock_takes(company_id)
    `);

    // ── pos_stock_take_items ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_stock_take_items (
        id              SERIAL PRIMARY KEY,
        stock_take_id   INTEGER NOT NULL REFERENCES pos_stock_takes(id) ON DELETE CASCADE,
        company_id      INTEGER NOT NULL REFERENCES companies(id),
        product_id      INTEGER NOT NULL REFERENCES products(id),
        system_qty      DECIMAL(12,3) NOT NULL,
        counted_qty     DECIMAL(12,3) NOT NULL,
        variance        DECIMAL(12,3) NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── pos_supplier_receives ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_supplier_receives (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        supplier_name   VARCHAR(255) NOT NULL,
        reference       VARCHAR(100),
        notes           TEXT,
        item_count      INTEGER DEFAULT 0,
        total_quantity  INTEGER DEFAULT 0,
        received_by     INTEGER REFERENCES users(id),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_supplier_receives_company
        ON pos_supplier_receives(company_id)
    `);

    // ── pos_supplier_receive_items ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_supplier_receive_items (
        id              SERIAL PRIMARY KEY,
        receive_id      INTEGER NOT NULL REFERENCES pos_supplier_receives(id) ON DELETE CASCADE,
        company_id      INTEGER NOT NULL REFERENCES companies(id),
        product_id      INTEGER NOT NULL REFERENCES products(id),
        quantity        INTEGER NOT NULL,
        cost_price      DECIMAL(10,2),
        qty_before      INTEGER,
        qty_after       INTEGER,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── pos_stock_transfers ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_stock_transfers (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        from_location   VARCHAR(50) NOT NULL,
        to_location     VARCHAR(50) NOT NULL,
        notes           TEXT,
        item_count      INTEGER DEFAULT 0,
        affects_stock   BOOLEAN DEFAULT false,
        transferred_by  INTEGER REFERENCES users(id),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_stock_transfers_company
        ON pos_stock_transfers(company_id)
    `);

    // ── pos_stock_transfer_items ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_stock_transfer_items (
        id              SERIAL PRIMARY KEY,
        transfer_id     INTEGER NOT NULL REFERENCES pos_stock_transfers(id) ON DELETE CASCADE,
        company_id      INTEGER NOT NULL REFERENCES companies(id),
        product_id      INTEGER NOT NULL REFERENCES products(id),
        quantity        INTEGER NOT NULL,
        qty_before      INTEGER,
        qty_after       INTEGER,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── product_suppliers ─────────────────────────────────────────────────────
    // Base link table (company_id, supplier_id, product_id) already exists live
    // in production — this CREATE TABLE is defensive so other environments stay
    // in sync. Workstream 78 adds supplier-specific price-tracking columns:
    // last purchase price/date are tracked per supplier-product relationship,
    // not globally on the product, since the same item can cost differently
    // from different suppliers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_suppliers (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS supplier_sku         VARCHAR(100)`);
    await client.query(`ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS last_purchase_price  DECIMAL(10,2)`);
    await client.query(`ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS last_purchase_date   TIMESTAMPTZ`);
    await client.query(`ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS preferred_supplier    BOOLEAN DEFAULT false`);
    await client.query(`ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS notes                 TEXT`);
    await client.query(`ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW()`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_suppliers_company  ON product_suppliers(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier ON product_suppliers(company_id, supplier_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_suppliers_product  ON product_suppliers(company_id, product_id)`);

    // ── pos_supplier_returns ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_supplier_returns (
        id              SERIAL PRIMARY KEY,
        company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        supplier_id     INTEGER REFERENCES suppliers(id),
        supplier_name   VARCHAR(255) NOT NULL,
        reference       VARCHAR(100),
        notes           TEXT,
        item_count      INTEGER DEFAULT 0,
        total_quantity  INTEGER DEFAULT 0,
        total_value     DECIMAL(10,2) DEFAULT 0,
        returned_by     INTEGER REFERENCES users(id),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_supplier_returns_company
        ON pos_supplier_returns(company_id)
    `);

    // ── pos_supplier_return_items ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_supplier_return_items (
        id              SERIAL PRIMARY KEY,
        return_id       INTEGER NOT NULL REFERENCES pos_supplier_returns(id) ON DELETE CASCADE,
        company_id      INTEGER NOT NULL REFERENCES companies(id),
        product_id      INTEGER NOT NULL REFERENCES products(id),
        quantity        INTEGER NOT NULL,
        unit_cost       DECIMAL(10,2),
        reason          VARCHAR(50),
        qty_before      INTEGER,
        qty_after       INTEGER,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── suppliers / customers: company-linking foundation (Workstream 80) ────
    // A supplier or customer record can optionally represent another real
    // platform company (e.g. Pennygrow links Turkstra as a supplier). The
    // actual relationship lives in the shared inter_company_relationships
    // table (accounting's existing inter-company module, migration 001) —
    // these columns just point a supplier/customer row at that relationship
    // and cache its status for cheap list-view display. No new parallel
    // relationship table — see docs/checkout-charlie-future/
    // INTER_COMPANY_CUSTOMER_SUPPLIER_LINKING.md for the full model.
    await client.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS linked_company_id      INTEGER REFERENCES companies(id)`);
    await client.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS linked_relationship_id INTEGER`);
    await client.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS link_status             VARCHAR(20) DEFAULT 'none'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_suppliers_linked_relationship ON suppliers(linked_relationship_id)`);

    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS linked_company_id      INTEGER REFERENCES companies(id)`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS linked_relationship_id INTEGER`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS link_status             VARCHAR(20) DEFAULT 'none'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_linked_relationship ON customers(linked_relationship_id)`);

    // inter_company_relationships (accounting's shared table, migration 001) is
    // missing updated_at — needed so confirm/revoke can record when a
    // relationship's status last changed. Defensive/additive only.
    await client.query(`ALTER TABLE inter_company_relationships ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

    // ── user_pos_pins ─────────────────────────────────────────────────────────
    // Stores bcrypt-hashed PINs for PIN-eligible POS users (cashier, senior_cashier,
    // shift_supervisor, assistant_manager). One row per user per company.
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_pos_pins (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pin_hash    VARCHAR(255) NOT NULL,
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        created_by  INTEGER REFERENCES users(id),
        updated_by  INTEGER REFERENCES users(id),
        UNIQUE(company_id, user_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_pins_company_user
        ON user_pos_pins(company_id, user_id)
    `);

    // ── pos_pin_attempts ──────────────────────────────────────────────────────
    // Append-only log of PIN login attempts. >= 5 failures in 15 min = lockout.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_pin_attempts (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        user_id               INTEGER REFERENCES users(id),
        attempted_identifier  VARCHAR(255),
        success               BOOLEAN NOT NULL DEFAULT false,
        failure_reason        VARCHAR(100),
        ip_address            VARCHAR(45),
        user_agent            TEXT,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_pin_attempts_lookup
        ON pos_pin_attempts(company_id, user_id, success, created_at DESC)
    `);

    // ── pos_devices (Workstream 82 — Device Identity System) ─────────────────
    // Replaces the old client-side-only "device lock" (localStorage
    // pos_locked_company_id, never validated server-side — a real security
    // gap: any cashier could clear/edit localStorage and defeat it). This is
    // the backend-authoritative source of truth: PIN login is only permitted
    // from a device with a matching, active row here.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_devices (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        till_id               INTEGER REFERENCES tills(id),
        device_token_hash     VARCHAR(255) NOT NULL,
        device_name           VARCHAR(150) NOT NULL,
        status                VARCHAR(20) NOT NULL DEFAULT 'active',
        platform              VARCHAR(50),
        user_agent            TEXT,
        app_version           VARCHAR(50),
        registered_by         INTEGER REFERENCES users(id),
        registered_at         TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at          TIMESTAMPTZ,
        last_user_id          INTEGER REFERENCES users(id),
        pin_fail_count        INTEGER NOT NULL DEFAULT 0,
        pin_locked_until      TIMESTAMPTZ,
        pin_unlocked_at       TIMESTAMPTZ,
        revoked_by            INTEGER REFERENCES users(id),
        revoked_at            TIMESTAMPTZ,
        revoke_reason         VARCHAR(255),
        replaced_by_device_id INTEGER REFERENCES pos_devices(id),
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_devices_company ON pos_devices(company_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_devices_till    ON pos_devices(till_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_devices_token_hash ON pos_devices(device_token_hash)`);
    // device_token_hash is SHA-256 (not bcrypt) — deliberately. The device token
    // is a 256-bit random value, not a human-guessable secret like a PIN or
    // password, so it needs no salting/slow-hashing to resist brute force; it
    // needs fast, deterministic, indexable exact-match lookup instead (the
    // same reasoning GitHub/Stripe apply to API-key storage). The raw token
    // itself is returned to the client exactly once, at registration, and
    // never stored anywhere in plaintext server-side.

    // pos_pin_attempts gains device_id so lockout can be scoped per-device
    // ("Device lock. Not only user lock." — the ticket's explicit rule) in
    // addition to the existing per-user lockout, which is left unchanged.
    await client.query(`ALTER TABLE pos_pin_attempts ADD COLUMN IF NOT EXISTS device_id INTEGER REFERENCES pos_devices(id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_pin_attempts_device ON pos_pin_attempts(device_id, success, created_at DESC)`);

    // ── tills ─────────────────────────────────────────────────────────────────
    // Core table; may already exist from database/schema.sql initial deploy.
    // ADD COLUMN IF NOT EXISTS is safe to run on every startup.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tills (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        till_name   VARCHAR(255) NOT NULL,
        till_number VARCHAR(50) NOT NULL,
        location    VARCHAR(255),
        is_active   BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_id, till_number)
      )
    `);
    await client.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS is_locked               BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS locked_reason            TEXT`);
    await client.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS locked_at                TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS locked_by_email          TEXT`);
    await client.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS is_printer_degraded      BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS printer_degraded_reason  TEXT`);
    await client.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS printer_degraded_at      TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS printer_degraded_by_email TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tills_company ON tills(company_id)`);

    // ── till_sessions ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS till_sessions (
        id               SERIAL PRIMARY KEY,
        company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        till_id          INTEGER NOT NULL REFERENCES tills(id),
        user_id          INTEGER NOT NULL REFERENCES users(id),
        opening_balance  DECIMAL(10,2) NOT NULL,
        closing_balance  DECIMAL(10,2),
        expected_balance DECIMAL(10,2),
        variance         DECIMAL(10,2),
        status           VARCHAR(20) DEFAULT 'open',
        opened_at        TIMESTAMPTZ DEFAULT NOW(),
        closed_at        TIMESTAMPTZ,
        notes            TEXT
      )
    `);
    await client.query(`ALTER TABLE till_sessions ADD COLUMN IF NOT EXISTS float_amount DECIMAL(10,2)`);
    await client.query(`ALTER TABLE till_sessions ADD COLUMN IF NOT EXISTS cashup_id    INTEGER`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_till_sessions_company ON till_sessions(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_till_sessions_status  ON till_sessions(company_id, status)`);

    // ── pos_emergency_state ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_emergency_state (
        company_id         INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        sync_paused        BOOLEAN NOT NULL DEFAULT FALSE,
        sync_paused_by     TEXT,
        sync_paused_reason TEXT,
        sync_paused_at     TIMESTAMPTZ,
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── pos_user_product_shortcuts ────────────────────────────────────────────
    // Per-user, per-company shortcut products (star pinned to top of Shortcuts tab).
    // Never stored in localStorage — DB-authoritative only.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_user_product_shortcuts (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sort_order  INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_id, user_id, product_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_shortcuts_user
        ON pos_user_product_shortcuts(company_id, user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pos_shortcuts_user_order
        ON pos_user_product_shortcuts(company_id, user_id, sort_order)
    `);

    // ── pos_company_transfers ─────────────────────────────────────────────────
    // Inter-company stock transfer (Workstream 81 — Turkstra/Pennygrow v1).
    // Reuses the existing linked-company relationship (inter_company_relationships,
    // linked via suppliers/customers in Workstream 80) — this is the transfer
    // ledger, not a second relationship system. company_id is always the
    // SENDING company for a given transfer row.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_company_transfers (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        receiver_company_id   INTEGER NOT NULL REFERENCES companies(id),
        relationship_id       INTEGER,
        transfer_number       VARCHAR(50) NOT NULL,
        status                VARCHAR(30) NOT NULL DEFAULT 'draft',
        reference             VARCHAR(100),
        notes                 TEXT,
        expected_receive_date DATE,
        item_count            INTEGER DEFAULT 0,
        total_quantity_sent   INTEGER DEFAULT 0,
        sent_by               INTEGER REFERENCES users(id),
        sent_at               TIMESTAMPTZ,
        received_by           INTEGER REFERENCES users(id),
        received_at           TIMESTAMPTZ,
        rejected_by           INTEGER REFERENCES users(id),
        rejected_at           TIMESTAMPTZ,
        rejection_reason      TEXT,
        cancelled_by          INTEGER REFERENCES users(id),
        cancelled_at          TIMESTAMPTZ,
        return_requested_by   INTEGER REFERENCES users(id),
        return_requested_at   TIMESTAMPTZ,
        return_received_by    INTEGER REFERENCES users(id),
        return_received_at    TIMESTAMPTZ,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_company_transfers_sender   ON pos_company_transfers(company_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_company_transfers_receiver ON pos_company_transfers(receiver_company_id, status)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_company_transfers_number ON pos_company_transfers(company_id, transfer_number)`);

    // ── pos_company_transfer_items ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_company_transfer_items (
        id                  SERIAL PRIMARY KEY,
        transfer_id         INTEGER NOT NULL REFERENCES pos_company_transfers(id) ON DELETE CASCADE,
        company_id          INTEGER NOT NULL REFERENCES companies(id),
        product_id          INTEGER NOT NULL REFERENCES products(id),
        receiver_product_id INTEGER REFERENCES products(id),
        product_code        VARCHAR(100),
        barcode              VARCHAR(100),
        description          VARCHAR(255) NOT NULL,
        quantity_sent        INTEGER NOT NULL,
        quantity_received    INTEGER NOT NULL DEFAULT 0,
        quantity_returned    INTEGER NOT NULL DEFAULT 0,
        unit_cost            DECIMAL(10,2),
        selling_price        DECIMAL(10,2),
        match_status         VARCHAR(20) DEFAULT 'unmatched',
        return_reason        VARCHAR(30),
        notes                TEXT,
        created_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_company_transfer_items_transfer ON pos_company_transfer_items(transfer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_company_transfer_items_company  ON pos_company_transfer_items(company_id)`);

    // ── Inter-Store Transfers + Shrinkage Control (Workstream 85) ────────────
    //
    // AUDIT FINDING (before writing any of this): no locations/stores/branches
    // entity exists anywhere in this schema, and products.stock_quantity is a
    // single company-wide number, not location-scoped — confirmed live (a
    // `locations` table query 404s) and confirmed the one place in the
    // frontend that gestures at "multi-location" (#multiLocationInfo banner,
    // GET /api/pos/products/:id/stock-by-location) is dead scaffolding: the
    // banner is permanently display:none and the route's own comment reads
    // "Multi-location is a future feature" — it fabricates a single fake
    // "Main Store" row wrapping stock_quantity. Left untouched; fixing that
    // pre-existing product-stock-editing stub is a different feature from
    // inter-store TRANSFERS and out of scope here.
    //
    // This means genuine per-location stock is a real prerequisite this
    // workstream must build, not something to assume already exists.
    // product_location_stock below is deliberately NEW and ADDITIVE — it is
    // not wired into checkout or any existing report, so products.stock_quantity
    // (which checkout and every existing report depend on) is completely
    // unaffected. See the Workstream 85 doc for the full reasoning and the
    // documented limitation this implies.
    //
    // REUSE, NOT A PARALLEL ENGINE: pos_company_transfers/pos_company_transfer_items
    // (Workstream 81) already implement almost exactly the header+items,
    // status-lifecycle, sent/received-with-users-and-timestamps shape this
    // ticket asks for. Extended in place via a transfer_type discriminator
    // rather than duplicated — inter_company rows (existing, unaffected) keep
    // receiver_company_id pointing at a different company; inter_store rows
    // (new) set receiver_company_id = company_id (same company, different
    // location) and populate source_location_id/destination_location_id.

    await client.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id            SERIAL PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        location_name VARCHAR(150) NOT NULL,
        location_code VARCHAR(50),
        address       TEXT,
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_locations_company ON locations(company_id, is_active)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS product_location_stock (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        quantity    DECIMAL(12,3) NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_product_location_stock_unique ON product_location_stock(company_id, product_id, location_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_location_stock_location ON product_location_stock(location_id)`);

    // Which locations a user may act for — enforced server-side on every
    // create/dispatch/receive call, not just hidden in the UI.
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_locations (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_locations_unique ON user_locations(company_id, user_id, location_id)`);

    // pos_company_transfers — extended for inter_store use (additive; every
    // column below defaults to a value that leaves existing inter_company
    // rows/behaviour completely unchanged).
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS transfer_type            VARCHAR(20) NOT NULL DEFAULT 'inter_company'`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS source_location_id       INTEGER REFERENCES locations(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS destination_location_id  INTEGER REFERENCES locations(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS counted_by_source        INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS approved_by_source       INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS dispatched_by            INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS dispatched_at            TIMESTAMPTZ`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS transport_reference      VARCHAR(150)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS transported_by           VARCHAR(150)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS counted_by_destination   INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS approved_by_destination  INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS blind_receive            BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS total_received           INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS total_damaged            INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS total_rejected           INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS total_variance           INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS investigation_required   BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS resolved_by              INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS resolved_at              TIMESTAMPTZ`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_company_transfers_type ON pos_company_transfers(company_id, transfer_type, status)`);

    await client.query(`ALTER TABLE pos_company_transfer_items ADD COLUMN IF NOT EXISTS quantity_damaged          INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE pos_company_transfer_items ADD COLUMN IF NOT EXISTS quantity_rejected         INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE pos_company_transfer_items ADD COLUMN IF NOT EXISTS source_stock_before       DECIMAL(12,3)`);
    await client.query(`ALTER TABLE pos_company_transfer_items ADD COLUMN IF NOT EXISTS source_stock_after        DECIMAL(12,3)`);
    await client.query(`ALTER TABLE pos_company_transfer_items ADD COLUMN IF NOT EXISTS destination_stock_before  DECIMAL(12,3)`);
    await client.query(`ALTER TABLE pos_company_transfer_items ADD COLUMN IF NOT EXISTS destination_stock_after   DECIMAL(12,3)`);
    await client.query(`ALTER TABLE pos_company_transfer_items ADD COLUMN IF NOT EXISTS sender_notes              TEXT`);
    await client.query(`ALTER TABLE pos_company_transfer_items ADD COLUMN IF NOT EXISTS receiver_notes            TEXT`);

    // Append-only discrepancy/investigation history — no update or delete
    // route is ever built against this table (see store-transfers.js);
    // "resolving" a discrepancy sets resolution fields once, never edits or
    // removes the original flagged record.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_transfer_discrepancies (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        transfer_id           INTEGER NOT NULL REFERENCES pos_company_transfers(id) ON DELETE CASCADE,
        item_id               INTEGER REFERENCES pos_company_transfer_items(id),
        discrepancy_type      VARCHAR(30) NOT NULL,
        variance_quantity     INTEGER NOT NULL DEFAULT 0,
        flagged_by            INTEGER REFERENCES users(id),
        flagged_at            TIMESTAMPTZ DEFAULT NOW(),
        resolution_reason     VARCHAR(40),
        resolution_notes      TEXT,
        resolved_by           INTEGER REFERENCES users(id),
        resolved_at           TIMESTAMPTZ,
        investigation_required BOOLEAN NOT NULL DEFAULT false,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transfer_discrepancies_transfer ON pos_transfer_discrepancies(transfer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transfer_discrepancies_company  ON pos_transfer_discrepancies(company_id, resolved_at)`);

    // Company-level toggle: when true, the receiver's UI hides quantity_sent
    // until their own physical count is submitted (see store-transfers.js).
    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS blind_transfer_receiving BOOLEAN NOT NULL DEFAULT false`);

    // ── Purchase Order + Delivery Fulfilment Engine (Workstream 87) ──────────
    //
    // DESIGN PRINCIPLE (per the ticket): the Commercial transaction (Purchase
    // Order), the Logistics (Deliveries), and the Financial transaction
    // (Invoice) are three separate objects, never merged.
    //
    // Commercial — purchase_orders/purchase_order_items (new, below). Ordered
    // quantity NEVER changes after submission. Received quantity is a rollup
    // maintained by the delivery engine.
    //
    // Logistics — REUSE, NOT A PARALLEL ENGINE: pos_company_transfers/
    // pos_company_transfer_items/pos_transfer_discrepancies (Workstream 81,
    // extended for inter-store in Workstream 85) already implement exactly
    // the header+items, dispatch/receive/variance, CAS stock-adjustment shape
    // a "delivery" needs. Extended here with a third transfer_type value,
    // 'po_delivery', plus a purchase_order_id/delivery_number pair — existing
    // inter_company and inter_store rows are completely unaffected (both
    // columns are nullable and unused by those transfer types).
    //
    // Financial — REUSE, NOT A THIRD INVOICE SYSTEM: inter_company_invoices
    // (accounting-ecosystem/backend/inter-company/invoice-sender.js +
    // invoice-receiver.js) already implements a full SQL-backed invoice with
    // sender/receiver status, VAT calculation, and payment tracking. Extended
    // here with a purchase_order_id column so a generated invoice can be
    // traced back to the PO that produced it — no new invoicing logic is
    // written for this workstream, InvoiceSender.send() is called as-is.
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        supplier_id         INTEGER NOT NULL REFERENCES suppliers(id),
        supplier_company_id INTEGER NOT NULL REFERENCES companies(id),
        relationship_id     INTEGER,
        po_number           VARCHAR(50) NOT NULL,
        status              VARCHAR(30) NOT NULL DEFAULT 'draft',
        reference           VARCHAR(100),
        notes               TEXT,
        expected_date       DATE,
        invoice_timing      VARCHAR(20) NOT NULL DEFAULT 'after_final_delivery',
        item_count          INTEGER DEFAULT 0,
        total_ordered_qty   INTEGER DEFAULT 0,
        total_received_qty  INTEGER DEFAULT 0,
        invoice_id          INTEGER,
        created_by          INTEGER REFERENCES users(id),
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        submitted_by        INTEGER REFERENCES users(id),
        submitted_at        TIMESTAMPTZ,
        accepted_by         INTEGER REFERENCES users(id),
        accepted_at         TIMESTAMPTZ,
        rejected_by         INTEGER REFERENCES users(id),
        rejected_at         TIMESTAMPTZ,
        rejection_reason    TEXT,
        cancelled_by        INTEGER REFERENCES users(id),
        cancelled_at        TIMESTAMPTZ,
        cancellation_reason TEXT,
        completed_at        TIMESTAMPTZ,
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_customer ON purchase_orders(company_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_company_id, status)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_number ON purchase_orders(company_id, po_number)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id                    SERIAL PRIMARY KEY,
        purchase_order_id     INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        company_id            INTEGER NOT NULL REFERENCES companies(id),
        product_id            INTEGER REFERENCES products(id),
        supplier_product_id   INTEGER REFERENCES products(id),
        product_code          VARCHAR(100),
        barcode               VARCHAR(100),
        description           VARCHAR(255) NOT NULL,
        quantity_ordered      INTEGER NOT NULL,
        quantity_received     INTEGER NOT NULL DEFAULT 0,
        unit_cost             DECIMAL(10,2),
        notes                 TEXT,
        created_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_po_items_po      ON purchase_order_items(purchase_order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_po_items_company ON purchase_order_items(company_id)`);

    // pos_company_transfers — extended for po_delivery use (additive; both
    // columns are nullable and left untouched by inter_company/inter_store rows).
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS purchase_order_id INTEGER REFERENCES purchase_orders(id)`);
    await client.query(`ALTER TABLE pos_company_transfers ADD COLUMN IF NOT EXISTS delivery_number   INTEGER`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_company_transfers_po ON pos_company_transfers(purchase_order_id)`);

    // Company-level default for new POs — snapshotted onto purchase_orders.invoice_timing
    // at creation so a later settings change never alters an in-flight PO's behaviour.
    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS po_invoice_timing VARCHAR(20) NOT NULL DEFAULT 'after_final_delivery'`);

    // inter_company_invoices — trace an invoice back to the PO that generated it.
    await client.query(`ALTER TABLE inter_company_invoices ADD COLUMN IF NOT EXISTS purchase_order_id INTEGER REFERENCES purchase_orders(id)`);

    console.log('  ✅ POS schema ready.');
  } catch (err) {
    console.error('  ❌ POS schema migration error:', err.message);
    // Non-fatal — app can still start; individual queries may work.
  } finally {
    client.release();
  }
}

module.exports = { ensurePosSchema };
