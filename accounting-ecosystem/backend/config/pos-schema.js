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

    console.log('  ✅ POS schema ready.');
  } catch (err) {
    console.error('  ❌ POS schema migration error:', err.message);
    // Non-fatal — app can still start; individual queries may work.
  } finally {
    client.release();
  }
}

module.exports = { ensurePosSchema };
