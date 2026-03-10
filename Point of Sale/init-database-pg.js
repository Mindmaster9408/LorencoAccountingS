const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  const client = await pool.connect();

  try {
    console.log('Initializing PostgreSQL database...');

    // Users table
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✓ Users table created');

    // Tills table
    await client.query(`CREATE TABLE IF NOT EXISTS tills (
      id SERIAL PRIMARY KEY,
      till_name VARCHAR(255) UNIQUE NOT NULL,
      till_number VARCHAR(50) UNIQUE NOT NULL,
      location VARCHAR(255),
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✓ Tills table created');

    // Till Sessions table
    await client.query(`CREATE TABLE IF NOT EXISTS till_sessions (
      id SERIAL PRIMARY KEY,
      till_id INTEGER NOT NULL REFERENCES tills(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      opening_balance DECIMAL(10,2) NOT NULL,
      closing_balance DECIMAL(10,2),
      expected_balance DECIMAL(10,2),
      variance DECIMAL(10,2),
      status VARCHAR(20) DEFAULT 'open',
      opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP,
      notes TEXT
    )`);
    console.log('✓ Till sessions table created');

    // Products table
    await client.query(`CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      product_code VARCHAR(50) UNIQUE NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(100),
      unit_price DECIMAL(10,2) NOT NULL,
      cost_price DECIMAL(10,2),
      stock_quantity INTEGER DEFAULT 0,
      min_stock_level INTEGER DEFAULT 10,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✓ Products table created');

    // Sales table
    await client.query(`CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      sale_number VARCHAR(50) UNIQUE NOT NULL,
      till_session_id INTEGER NOT NULL REFERENCES till_sessions(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      subtotal DECIMAL(10,2) NOT NULL,
      vat_amount DECIMAL(10,2) NOT NULL,
      total_amount DECIMAL(10,2) NOT NULL,
      payment_method VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✓ Sales table created');

    // Sale Items table
    await client.query(`CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      total_price DECIMAL(10,2) NOT NULL
    )`);
    console.log('✓ Sale items table created');

    // Customers table
    await client.query(`CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      contact_person VARCHAR(255),
      contact_number VARCHAR(50),
      email VARCHAR(255),
      address_line_1 VARCHAR(255),
      address_line_2 VARCHAR(255),
      suburb VARCHAR(100),
      city VARCHAR(100),
      province VARCHAR(100),
      postal_code VARCHAR(20),
      tax_reference VARCHAR(50),
      company VARCHAR(255),
      customer_type VARCHAR(50) DEFAULT 'Cash Sale Customer',
      custom_field TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✓ Customers table created');

    // Insert demo user
    const passwordHash = bcrypt.hashSync('demo123', 10);
    await client.query(`
      INSERT INTO users (username, password_hash, full_name, role)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) DO NOTHING
    `, ['demo', passwordHash, 'Demo User', 'cashier']);
    console.log('✓ Demo user created (username: demo, password: demo123)');

    // Insert demo till
    await client.query(`
      INSERT INTO tills (till_name, till_number, location)
      VALUES ($1, $2, $3)
      ON CONFLICT (till_name) DO NOTHING
    `, ['Main Till', 'TILL-001', 'Front Counter']);
    console.log('✓ Demo till created');

    // Insert demo products
    const products = [
      ['PROD-001', 'Coca Cola 330ml', 'Refreshing soft drink', 'Beverages', 12.99, 8.50, 100],
      ['PROD-002', 'White Bread', 'Fresh baked bread', 'Bakery', 15.50, 10.00, 50],
      ['PROD-003', 'Milk 2L', 'Full cream milk', 'Dairy', 28.99, 22.00, 75],
      ['PROD-004', 'Cheese Slices', 'Cheddar cheese', 'Dairy', 45.99, 35.00, 30],
      ['PROD-005', 'Eggs (6 pack)', 'Free range eggs', 'Dairy', 32.99, 25.00, 40],
      ['PROD-006', 'Apples (1kg)', 'Fresh red apples', 'Produce', 24.99, 18.00, 60],
      ['PROD-007', 'Tomatoes (1kg)', 'Fresh tomatoes', 'Produce', 18.99, 12.00, 45],
      ['PROD-008', 'Potato Chips', 'Crispy chips', 'Snacks', 14.99, 9.00, 80],
      ['PROD-009', 'Chocolate Bar', 'Milk chocolate', 'Snacks', 22.99, 16.00, 120],
      ['PROD-010', 'Coffee 200g', 'Premium ground coffee', 'Beverages', 89.99, 65.00, 25]
    ];

    for (const product of products) {
      await client.query(`
        INSERT INTO products (product_code, product_name, description, category, unit_price, cost_price, stock_quantity)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (product_code) DO NOTHING
      `, product);
    }
    console.log('✓ Demo products created');

    // KV store for cloud-backed safeLocalStorage
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_kv_store (
        company_id  TEXT        NOT NULL,
        key         TEXT        NOT NULL,
        value       JSONB,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (company_id, key)
      )
    `);
    console.log('✓ KV store table ready');

    console.log('\n✅ Database initialization complete!');

  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

initDatabase();
