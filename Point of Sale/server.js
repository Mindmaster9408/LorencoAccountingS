const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const posRoutes = require('./routes/pos');
const seanAiRoutes = require('./routes/sean-ai');
const auditRoutes = require('./routes/audit');
const vatRoutes = require('./routes/vat');
const barcodeRoutes = require('./routes/barcode');
const customersRoutes = require('./routes/customers');
const reportsRoutes = require('./routes/reports');

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * ============================================================================
 * ⚠️  CRITICAL SECTION - DO NOT MODIFY WITHOUT CAREFUL CONSIDERATION  ⚠️
 * ============================================================================
 * The initDatabase() function below handles PostgreSQL setup for Zeabur.
 * Modifying this can break the entire application.
 *
 * Last stable version: v1.0-stable-auth
 * To restore: git checkout v1.0-stable-auth -- server.js
 * ============================================================================
 */

// Auto-initialize database on startup
async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL found, skipping PostgreSQL init');
    return;
  }

  // Zeabur internal PostgreSQL doesn't need SSL
  const poolConfig = {
    connectionString: process.env.DATABASE_URL
  };

  const pool = new Pool(poolConfig);

  try {
    console.log('Checking/initializing PostgreSQL database...');

    // ========== MULTI-TENANT TABLES ==========

    // Companies table (core tenant entity)
    await pool.query(`CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      trading_name VARCHAR(255),
      registration_number VARCHAR(100),
      vat_number VARCHAR(50),
      contact_email VARCHAR(255),
      contact_phone VARCHAR(50),
      address TEXT,
      owner_user_id INTEGER,
      subscription_status VARCHAR(50) DEFAULT 'pending',
      subscription_expires_at TIMESTAMP,
      approved_at TIMESTAMP,
      approved_by_user_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Add new columns to companies if they don't exist
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_user_id INTEGER`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS approved_by_user_id INTEGER`);

    // Multi-location / Multi-company columns
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS parent_company_id INTEGER`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_location INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS location_name VARCHAR(255)`);

    // Product sharing across companies table
    await pool.query(`CREATE TABLE IF NOT EXISTS product_companies (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      stock_quantity INTEGER DEFAULT 0,
      reorder_level INTEGER DEFAULT 10,
      is_active INTEGER DEFAULT 1,
      price_override DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, company_id)
    )`);

    // Accounting Firms table
    await pool.query(`CREATE TABLE IF NOT EXISTS accounting_firms (
      id SERIAL PRIMARY KEY,
      firm_name VARCHAR(255) NOT NULL,
      registration_number VARCHAR(100),
      contact_email VARCHAR(255),
      contact_phone VARCHAR(50),
      address TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Users table (updated for multi-tenant)
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255),
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      user_type VARCHAR(50) DEFAULT 'company_user',
      accounting_firm_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Add new columns to users table if they don't exist
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type VARCHAR(50) DEFAULT 'company_user'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS accounting_firm_id INTEGER`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin INTEGER DEFAULT 0`);

    // Firm-Company Access (links accounting firms to companies they manage)
    await pool.query(`CREATE TABLE IF NOT EXISTS firm_company_access (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      granted_by_user_id INTEGER,
      is_active INTEGER DEFAULT 1,
      UNIQUE(firm_id, company_id)
    )`);

    // User-Company Access (links users to companies with specific roles)
    await pool.query(`CREATE TABLE IF NOT EXISTS user_company_access (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      role VARCHAR(50) NOT NULL,
      is_primary INTEGER DEFAULT 0,
      float_override DECIMAL(10,2),
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      granted_by_user_id INTEGER,
      is_active INTEGER DEFAULT 1,
      UNIQUE(user_id, company_id)
    )`);

    // Add float_override to user_company_access if not exists
    await pool.query(`ALTER TABLE user_company_access ADD COLUMN IF NOT EXISTS float_override DECIMAL(10,2)`);

    // Invitations table (for email invites)
    await pool.query(`CREATE TABLE IF NOT EXISTS invitations (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      company_id INTEGER NOT NULL,
      invitation_type VARCHAR(50) NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      invited_by_user_id INTEGER,
      accepted_at TIMESTAMP,
      accepted_by_user_id INTEGER,
      expires_at TIMESTAMP NOT NULL,
      is_used INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== EXISTING TABLES ==========

    // Tills table
    await pool.query(`CREATE TABLE IF NOT EXISTS tills (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      till_name VARCHAR(255) NOT NULL,
      till_number VARCHAR(50) NOT NULL,
      location VARCHAR(255),
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, till_name),
      UNIQUE(company_id, till_number)
    )`);
    await pool.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS company_id INTEGER`);

    // Till Sessions table
    await pool.query(`CREATE TABLE IF NOT EXISTS till_sessions (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      till_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      opening_balance DECIMAL(10,2) NOT NULL,
      closing_balance DECIMAL(10,2),
      expected_balance DECIMAL(10,2),
      variance DECIMAL(10,2),
      status VARCHAR(20) DEFAULT 'open',
      opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP,
      notes TEXT
    )`);
    await pool.query(`ALTER TABLE till_sessions ADD COLUMN IF NOT EXISTS company_id INTEGER`);

    // Products table
    await pool.query(`CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      product_code VARCHAR(50) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(100),
      unit_price DECIMAL(10,2) NOT NULL,
      cost_price DECIMAL(10,2),
      stock_quantity INTEGER DEFAULT 0,
      min_stock_level INTEGER DEFAULT 10,
      is_active INTEGER DEFAULT 1,
      barcode VARCHAR(100),
      requires_vat INTEGER DEFAULT 1,
      vat_rate DECIMAL(5,2) DEFAULT 15,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, product_code)
    )`);

    // Add missing columns if they don't exist (for existing tables)
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS company_id INTEGER`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(100)`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS requires_vat INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS vat_rate DECIMAL(5,2) DEFAULT 15`);

    // Sales table
    await pool.query(`CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      sale_number VARCHAR(50) NOT NULL,
      till_session_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      customer_id INTEGER,
      subtotal DECIMAL(10,2) NOT NULL,
      vat_amount DECIMAL(10,2) NOT NULL,
      total_amount DECIMAL(10,2) NOT NULL,
      payment_method VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, sale_number)
    )`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS company_id INTEGER`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INTEGER`);

    // Sale Items table
    await pool.query(`CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      sale_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      total_price DECIMAL(10,2) NOT NULL
    )`);
    await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS company_id INTEGER`);

    // Customers table
    await pool.query(`CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
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
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_id INTEGER`);

    // ========== MIGRATION: Create default company for existing data ==========
    // NOTE: This migration section has been disabled to prevent creating "Default Company" on every startup.
    // If you need to create a default company, use the admin dashboard or run this manually once.
    
    /*
    // Create default company if not exists
    const companyResult = await pool.query(`
      INSERT INTO companies (company_name, trading_name)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, ['Default Company', 'Default Company']);

    // Get the default company ID
    let defaultCompanyId = 1;
    const existingCompany = await pool.query(`SELECT id FROM companies WHERE company_name = 'Default Company'`);
    if (existingCompany.rows.length > 0) {
      defaultCompanyId = existingCompany.rows[0].id;
    }

    // Migrate existing data to default company
    await pool.query(`UPDATE tills SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
    await pool.query(`UPDATE products SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
    await pool.query(`UPDATE customers SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
    await pool.query(`UPDATE till_sessions SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
    await pool.query(`UPDATE sales SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);
    await pool.query(`UPDATE sale_items SET company_id = $1 WHERE company_id IS NULL`, [defaultCompanyId]);

    // Insert demo user if not exists (as business_owner)
    const passwordHash = bcrypt.hashSync('demo123', 10);
    await pool.query(`
      INSERT INTO users (username, password_hash, full_name, role, user_type)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (username) DO NOTHING
    `, ['demo', passwordHash, 'Demo User', 'business_owner', 'business_owner']);

    // Update existing demo user to business_owner if they exist
    await pool.query(`
      UPDATE users SET role = 'business_owner', user_type = 'business_owner'
      WHERE username = 'demo' AND user_type IS NULL OR user_type = 'company_user'
    `);

    // Get demo user ID
    const demoUserResult = await pool.query(`SELECT id FROM users WHERE username = 'demo'`);
    if (demoUserResult.rows.length > 0) {
      const demoUserId = demoUserResult.rows[0].id;

      // Link demo user to default company
      await pool.query(`
        INSERT INTO user_company_access (user_id, company_id, role, is_primary)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, company_id) DO NOTHING
      `, [demoUserId, defaultCompanyId, 'business_owner', 1]);
    }

    // Insert demo till if not exists
    await pool.query(`
      INSERT INTO tills (company_id, till_name, till_number, location)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [defaultCompanyId, 'Main Till', 'TILL-001', 'Front Counter']);
    */

    // ========== SUPER ADMIN USER ==========
    // Create super admin user (Lorenco - platform owner)
    const superAdminHash = bcrypt.hashSync('Lorenco@190409', 10);
    await pool.query(`
      INSERT INTO users (username, email, password_hash, full_name, role, user_type, is_super_admin)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (username) DO UPDATE SET is_super_admin = 1
    `, ['lorenco_admin', 'antonjvr@lorenco.co.za', superAdminHash, 'Anton (Lorenco)', 'super_admin', 'super_admin', 1]);

    // NOTE: Removed the automatic update of default company subscription status
    // This was causing issues when default company wasn't needed
    /*
    // Update default company to active subscription
    await pool.query(`
      UPDATE companies SET subscription_status = 'active' WHERE id = $1
    `, [defaultCompanyId]);
    */

    // ========== BARCODE TABLES ==========

    // Barcode Settings table
    await pool.query(`CREATE TABLE IF NOT EXISTS barcode_settings (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      company_prefix VARCHAR(10) DEFAULT '600',
      current_sequence INTEGER DEFAULT 1000,
      barcode_type VARCHAR(20) DEFAULT 'EAN13',
      auto_generate INTEGER DEFAULT 0,
      last_generated VARCHAR(50),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_by_user_id INTEGER,
      UNIQUE(company_id)
    )`);

    // Barcode History table
    await pool.query(`CREATE TABLE IF NOT EXISTS barcode_history (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      barcode VARCHAR(100) NOT NULL,
      barcode_type VARCHAR(20),
      product_id INTEGER,
      is_company_generated INTEGER DEFAULT 0,
      assigned_by_user_id INTEGER,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== SEAN AI TABLES ==========

    // Sean AI Product Knowledge table
    await pool.query(`CREATE TABLE IF NOT EXISTS sean_product_knowledge (
      id SERIAL PRIMARY KEY,
      barcode VARCHAR(100) UNIQUE,
      product_name VARCHAR(255),
      category VARCHAR(100),
      unit_of_measure VARCHAR(50),
      requires_vat INTEGER DEFAULT 1,
      vat_rate DECIMAL(5,2) DEFAULT 15,
      confidence_score DECIMAL(3,2) DEFAULT 0.5,
      times_seen INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== AUDIT & SETTINGS TABLES ==========

    // Forensic Audit Log table (Phase 1 - immutable, append-only)
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      user_id INTEGER,
      user_email VARCHAR(255) NOT NULL DEFAULT 'system',
      action_type VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id VARCHAR(100),
      field_name VARCHAR(100),
      old_value TEXT,
      new_value TEXT,
      ip_address VARCHAR(50),
      session_id VARCHAR(255),
      user_agent TEXT,
      additional_metadata TEXT DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_company ON audit_log(company_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(created_at DESC)`);

    // Legacy Audit Trail table (kept for backward compatibility)
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_trail (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      user_id INTEGER,
      event_type VARCHAR(100) NOT NULL,
      event_category VARCHAR(50),
      event_data TEXT,
      ip_address VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // VAT Settings table
    await pool.query(`CREATE TABLE IF NOT EXISTS vat_settings (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      is_vat_registered INTEGER DEFAULT 0,
      vat_number VARCHAR(50),
      vat_rate DECIMAL(5,2) DEFAULT 15,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_by_user_id INTEGER,
      UNIQUE(company_id)
    )`);

    // Company Settings table (for float amount, printer settings, etc.)
    await pool.query(`CREATE TABLE IF NOT EXISTS company_settings (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      till_float_amount DECIMAL(10,2) DEFAULT 500,
      receipt_printer_name VARCHAR(255),
      receipt_printer_ip VARCHAR(50),
      receipt_printer_port INTEGER DEFAULT 9100,
      auto_print_receipt INTEGER DEFAULT 1,
      receipt_header TEXT,
      receipt_footer TEXT,
      product_code_prefix VARCHAR(10) DEFAULT 'PRO',
      receipt_prefix VARCHAR(10) DEFAULT 'INV',
      next_receipt_number INTEGER DEFAULT 1,
      vat_rate DECIMAL(5,2) DEFAULT 15.00,
      open_drawer_on_sale INTEGER DEFAULT 1,
      group_same_items INTEGER DEFAULT 1,
      use_product_images INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_by_user_id INTEGER,
      UNIQUE(company_id)
    )`);

    // Add new columns if they don't exist (for existing databases)
    try {
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS product_code_prefix VARCHAR(10) DEFAULT 'PRO'`);
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS receipt_prefix VARCHAR(10) DEFAULT 'INV'`);
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS next_receipt_number INTEGER DEFAULT 1`);
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS vat_rate DECIMAL(5,2) DEFAULT 15.00`);
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS open_drawer_on_sale INTEGER DEFAULT 1`);
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS group_same_items INTEGER DEFAULT 1`);
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS use_product_images INTEGER DEFAULT 0`);
    } catch (e) { /* columns may already exist */ }

    // ========== PHASE 1: MULTI-PAYMENT TABLES ==========

    // Sale Payments table (split payment support)
    await pool.query(`CREATE TABLE IF NOT EXISTS sale_payments (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL,
      company_id INTEGER,
      payment_method VARCHAR(50) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      reference VARCHAR(255),
      status VARCHAR(50) DEFAULT 'completed',
      processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_by INTEGER,
      metadata TEXT DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sale_payments_company ON sale_payments(company_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sale_payments_method ON sale_payments(payment_method)`);

    // Add new columns to sales table for Phase 1
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'completed'`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_complete INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_by INTEGER`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS void_reason TEXT`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_reason TEXT`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(50)`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_email_sent INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_sms_sent INTEGER DEFAULT 0`);

    // ========== PHASE 1: CUSTOMER MANAGEMENT UPGRADES ==========

    // Add loyalty/credit columns to customers table
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_number VARCHAR(50)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS date_of_birth DATE`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS id_number VARCHAR(50)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_group VARCHAR(50) DEFAULT 'retail'`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(10,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS current_balance DECIMAL(10,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_tier VARCHAR(50) DEFAULT 'bronze'`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_consent INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT`);

    // Customer Group Pricing table
    await pool.query(`CREATE TABLE IF NOT EXISTS customer_group_pricing (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      customer_group VARCHAR(50) NOT NULL,
      product_id INTEGER NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_pricing_company ON customer_group_pricing(company_id)`);

    // Loyalty Point Transactions table
    await pool.query(`CREATE TABLE IF NOT EXISTS loyalty_point_transactions (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      points_change INTEGER NOT NULL,
      transaction_type VARCHAR(50) NOT NULL,
      description TEXT,
      sale_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loyalty_pt_customer ON loyalty_point_transactions(customer_id)`);

    // Customer Account Transactions table (credit accounts)
    await pool.query(`CREATE TABLE IF NOT EXISTS customer_account_transactions (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      transaction_type VARCHAR(50) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      balance_after DECIMAL(10,2) NOT NULL,
      sale_id INTEGER,
      payment_id INTEGER,
      due_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_account_trans_customer ON customer_account_transactions(customer_id)`);

    // ========== PHASE 1: RECEIPT DELIVERY TRACKING ==========

    // Receipt Deliveries table
    await pool.query(`CREATE TABLE IF NOT EXISTS receipt_deliveries (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL,
      company_id INTEGER,
      delivery_method VARCHAR(50) NOT NULL,
      recipient VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending',
      delivered_at TIMESTAMP,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_receipt_deliveries_sale ON receipt_deliveries(sale_id)`);

    // ========== STOCK MANAGEMENT TABLES ==========

    // Stock Adjustments table
    await pool.query(`CREATE TABLE IF NOT EXISTS stock_adjustments (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      product_id INTEGER NOT NULL,
      adjustment_type VARCHAR(50) NOT NULL,
      quantity_change INTEGER NOT NULL,
      quantity_before INTEGER,
      quantity_after INTEGER,
      reason TEXT,
      reference_number VARCHAR(100),
      adjusted_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== DAILY DISCOUNT TABLES ==========

    // Product Daily Discounts table
    await pool.query(`CREATE TABLE IF NOT EXISTS product_daily_discounts (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      discount_price DECIMAL(10,2) NOT NULL,
      original_price DECIMAL(10,2) NOT NULL,
      reason TEXT,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      created_by_user_id INTEGER,
      approved_by_user_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== PRICE OVERRIDE TABLES ==========

    // Price Override Authorization table
    await pool.query(`CREATE TABLE IF NOT EXISTS price_overrides (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      sale_id INTEGER,
      product_id INTEGER,
      original_price DECIMAL(10,2) NOT NULL,
      override_price DECIMAL(10,2) NOT NULL,
      reason TEXT,
      authorized_by_user_id INTEGER NOT NULL,
      cashier_user_id INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== SALE RETURNS TABLES ==========

    // Sale Returns table
    await pool.query(`CREATE TABLE IF NOT EXISTS sale_returns (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      original_sale_id INTEGER NOT NULL,
      return_number VARCHAR(50) NOT NULL,
      total_refund DECIMAL(10,2) NOT NULL,
      reason TEXT,
      processed_by_user_id INTEGER NOT NULL,
      authorized_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, return_number)
    )`);

    // Sale Return Items table
    await pool.query(`CREATE TABLE IF NOT EXISTS sale_return_items (
      id SERIAL PRIMARY KEY,
      return_id INTEGER NOT NULL,
      sale_item_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity_returned INTEGER NOT NULL,
      refund_amount DECIMAL(10,2) NOT NULL
    )`);

    // ========== RECEIPT PRINTERS TABLE ==========

    // Receipt Printers table
    await pool.query(`CREATE TABLE IF NOT EXISTS receipt_printers (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      printer_name VARCHAR(255) NOT NULL,
      printer_type VARCHAR(50) DEFAULT 'network',
      ip_address VARCHAR(50),
      port INTEGER DEFAULT 9100,
      is_default INTEGER DEFAULT 0,
      paper_width INTEGER DEFAULT 80,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== DAILY TILL RESET TABLE ==========

    // Daily Till Resets table
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_till_resets (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      till_id INTEGER NOT NULL,
      reset_date DATE NOT NULL,
      session_id_before INTEGER,
      reset_by_user_id INTEGER NOT NULL,
      opening_float DECIMAL(10,2),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== PHASE 1: MULTI-LOCATION HIERARCHY ==========

    // Locations table (HQ -> Region -> District -> Store -> Warehouse)
    await pool.query(`CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      parent_location_id INTEGER,
      location_code VARCHAR(50) NOT NULL,
      location_name VARCHAR(255) NOT NULL,
      location_type VARCHAR(50) NOT NULL DEFAULT 'store',
      address_line_1 VARCHAR(255),
      address_line_2 VARCHAR(255),
      city VARCHAR(100),
      state_province VARCHAR(100),
      postal_code VARCHAR(20),
      country VARCHAR(100) DEFAULT 'South Africa',
      timezone VARCHAR(50) DEFAULT 'Africa/Johannesburg',
      latitude DECIMAL(10,8),
      longitude DECIMAL(11,8),
      square_footage INTEGER,
      manager_user_id INTEGER,
      contact_phone VARCHAR(50),
      contact_email VARCHAR(255),
      operating_hours JSONB,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, location_code)
    )`);

    // Location Settings with inheritance
    await pool.query(`CREATE TABLE IF NOT EXISTS location_settings (
      id SERIAL PRIMARY KEY,
      location_id INTEGER NOT NULL,
      setting_key VARCHAR(100) NOT NULL,
      setting_value TEXT,
      inherit_from_parent INTEGER DEFAULT 1,
      updated_by_user_id INTEGER,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(location_id, setting_key)
    )`);

    // User Location Access (multi-location assignments)
    await pool.query(`CREATE TABLE IF NOT EXISTS user_location_access (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      role VARCHAR(50) NOT NULL,
      is_primary INTEGER DEFAULT 0,
      can_manage_children INTEGER DEFAULT 0,
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      granted_by_user_id INTEGER,
      is_active INTEGER DEFAULT 1,
      UNIQUE(user_id, location_id)
    )`);

    // Add location_id to existing tables if not exists
    await pool.query(`ALTER TABLE tills ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await pool.query(`ALTER TABLE till_sessions ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await pool.query(`ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS location_id INTEGER`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS home_location_id INTEGER`);

    // ========== PHASE 2: ENTERPRISE USER MANAGEMENT ==========

    // Add enterprise user fields
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_user_id INTEGER`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hire_date DATE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS termination_date DATE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_status VARCHAR(50) DEFAULT 'active'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10,2)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS salary DECIMAL(12,2)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_provider VARCHAR(50)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_external_id VARCHAR(255)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret VARCHAR(255)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url VARCHAR(500)`);

    // MFA Backup Codes
    await pool.query(`CREATE TABLE IF NOT EXISTS mfa_backup_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      is_used INTEGER DEFAULT 0,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // User Sessions (device tracking)
    await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      session_token VARCHAR(255) UNIQUE NOT NULL,
      device_type VARCHAR(50),
      device_name VARCHAR(255),
      ip_address VARCHAR(50),
      user_agent TEXT,
      location_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL
    )`);

    // Shift Schedules
    await pool.query(`CREATE TABLE IF NOT EXISTS shift_schedules (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      shift_date DATE NOT NULL,
      scheduled_start TIME NOT NULL,
      scheduled_end TIME NOT NULL,
      break_duration_minutes INTEGER DEFAULT 60,
      actual_start TIMESTAMP,
      actual_end TIMESTAMP,
      status VARCHAR(50) DEFAULT 'scheduled',
      notes TEXT,
      created_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Time Entries
    await pool.query(`CREATE TABLE IF NOT EXISTS time_entries (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      location_id INTEGER,
      shift_schedule_id INTEGER,
      clock_in TIMESTAMP NOT NULL,
      clock_out TIMESTAMP,
      break_start TIMESTAMP,
      break_end TIMESTAMP,
      total_hours DECIMAL(5,2),
      overtime_hours DECIMAL(5,2),
      entry_type VARCHAR(50) DEFAULT 'regular',
      approved_by_user_id INTEGER,
      approved_at TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // SSO Configurations
    await pool.query(`CREATE TABLE IF NOT EXISTS sso_configurations (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      provider_type VARCHAR(50) NOT NULL,
      provider_name VARCHAR(100),
      client_id VARCHAR(255),
      tenant_id VARCHAR(255),
      metadata_url VARCHAR(500),
      ldap_server VARCHAR(255),
      ldap_base_dn VARCHAR(255),
      is_active INTEGER DEFAULT 1,
      auto_provision_users INTEGER DEFAULT 0,
      default_role VARCHAR(50) DEFAULT 'cashier',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Password History
    await pool.query(`CREATE TABLE IF NOT EXISTS password_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== PHASE 3: ADVANCED INVENTORY ==========

    // Warehouses
    await pool.query(`CREATE TABLE IF NOT EXISTS warehouses (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      warehouse_code VARCHAR(50) NOT NULL,
      warehouse_name VARCHAR(255) NOT NULL,
      warehouse_type VARCHAR(50) DEFAULT 'store_backroom',
      capacity_sqft INTEGER,
      temperature_controlled INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, warehouse_code)
    )`);

    // Multi-Location Inventory
    await pool.query(`CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      warehouse_id INTEGER,
      quantity_on_hand INTEGER DEFAULT 0,
      quantity_reserved INTEGER DEFAULT 0,
      quantity_on_order INTEGER DEFAULT 0,
      quantity_in_transit INTEGER DEFAULT 0,
      reorder_point INTEGER,
      reorder_quantity INTEGER,
      max_stock_level INTEGER,
      bin_location VARCHAR(50),
      last_counted_at TIMESTAMP,
      last_received_at TIMESTAMP,
      last_sold_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, location_id, COALESCE(warehouse_id, 0))
    )`);

    // Stock Transfers
    await pool.query(`CREATE TABLE IF NOT EXISTS stock_transfers (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      transfer_number VARCHAR(50) NOT NULL,
      from_location_id INTEGER NOT NULL,
      to_location_id INTEGER NOT NULL,
      from_warehouse_id INTEGER,
      to_warehouse_id INTEGER,
      status VARCHAR(50) DEFAULT 'draft',
      requested_by_user_id INTEGER NOT NULL,
      approved_by_user_id INTEGER,
      shipped_at TIMESTAMP,
      received_at TIMESTAMP,
      expected_arrival_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, transfer_number)
    )`);

    // Stock Transfer Items
    await pool.query(`CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id SERIAL PRIMARY KEY,
      transfer_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity_requested INTEGER NOT NULL,
      quantity_shipped INTEGER,
      quantity_received INTEGER,
      variance_reason TEXT
    )`);

    // Suppliers
    await pool.query(`CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      supplier_code VARCHAR(50) NOT NULL,
      supplier_name VARCHAR(255) NOT NULL,
      contact_name VARCHAR(255),
      contact_email VARCHAR(255),
      contact_phone VARCHAR(50),
      address TEXT,
      payment_terms INTEGER DEFAULT 30,
      credit_limit DECIMAL(12,2),
      current_balance DECIMAL(12,2) DEFAULT 0,
      tax_reference VARCHAR(50),
      bank_name VARCHAR(100),
      bank_account VARCHAR(50),
      bank_branch_code VARCHAR(20),
      lead_time_days INTEGER DEFAULT 7,
      minimum_order_value DECIMAL(10,2),
      is_preferred INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, supplier_code)
    )`);

    // Product Suppliers
    await pool.query(`CREATE TABLE IF NOT EXISTS product_suppliers (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      supplier_product_code VARCHAR(100),
      supplier_product_name VARCHAR(255),
      cost_price DECIMAL(10,2) NOT NULL,
      minimum_order_quantity INTEGER DEFAULT 1,
      pack_size INTEGER DEFAULT 1,
      lead_time_days INTEGER,
      is_preferred INTEGER DEFAULT 0,
      last_ordered_at TIMESTAMP,
      UNIQUE(product_id, supplier_id)
    )`);

    // Purchase Orders
    await pool.query(`CREATE TABLE IF NOT EXISTS purchase_orders (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      po_number VARCHAR(50) NOT NULL,
      supplier_id INTEGER NOT NULL,
      delivery_location_id INTEGER NOT NULL,
      delivery_warehouse_id INTEGER,
      status VARCHAR(50) DEFAULT 'draft',
      order_date DATE,
      expected_delivery_date DATE,
      actual_delivery_date DATE,
      subtotal DECIMAL(12,2),
      tax_amount DECIMAL(12,2),
      total_amount DECIMAL(12,2),
      payment_terms INTEGER,
      notes TEXT,
      created_by_user_id INTEGER NOT NULL,
      approved_by_user_id INTEGER,
      approved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, po_number)
    )`);

    // Purchase Order Items
    await pool.query(`CREATE TABLE IF NOT EXISTS purchase_order_items (
      id SERIAL PRIMARY KEY,
      purchase_order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity_ordered INTEGER NOT NULL,
      quantity_received INTEGER DEFAULT 0,
      unit_cost DECIMAL(10,2) NOT NULL,
      total_cost DECIMAL(12,2) NOT NULL,
      notes TEXT
    )`);

    // Goods Receipts
    await pool.query(`CREATE TABLE IF NOT EXISTS goods_receipts (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      grn_number VARCHAR(50) NOT NULL,
      purchase_order_id INTEGER,
      supplier_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      warehouse_id INTEGER,
      receipt_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      received_by_user_id INTEGER NOT NULL,
      notes TEXT,
      UNIQUE(company_id, grn_number)
    )`);

    // Goods Receipt Items
    await pool.query(`CREATE TABLE IF NOT EXISTS goods_receipt_items (
      id SERIAL PRIMARY KEY,
      goods_receipt_id INTEGER NOT NULL,
      po_item_id INTEGER,
      product_id INTEGER NOT NULL,
      quantity_received INTEGER NOT NULL,
      quantity_accepted INTEGER NOT NULL,
      quantity_rejected INTEGER DEFAULT 0,
      rejection_reason TEXT,
      batch_number VARCHAR(100),
      expiry_date DATE,
      bin_location VARCHAR(50)
    )`);

    // Reorder Rules
    await pool.query(`CREATE TABLE IF NOT EXISTS reorder_rules (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER,
      product_id INTEGER,
      category VARCHAR(100),
      reorder_method VARCHAR(50) DEFAULT 'min_max',
      min_stock INTEGER,
      max_stock INTEGER,
      safety_stock INTEGER,
      review_period_days INTEGER DEFAULT 7,
      lead_time_days INTEGER,
      preferred_supplier_id INTEGER,
      auto_create_po INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== PHASE 4: ANALYTICS & LOSS PREVENTION ==========

    // Daily Sales Summary (pre-aggregated)
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_sales_summary (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      summary_date DATE NOT NULL,
      transaction_count INTEGER DEFAULT 0,
      item_count INTEGER DEFAULT 0,
      gross_sales DECIMAL(12,2) DEFAULT 0,
      discount_amount DECIMAL(12,2) DEFAULT 0,
      return_amount DECIMAL(12,2) DEFAULT 0,
      net_sales DECIMAL(12,2) DEFAULT 0,
      vat_amount DECIMAL(12,2) DEFAULT 0,
      cost_of_goods DECIMAL(12,2) DEFAULT 0,
      gross_profit DECIMAL(12,2) DEFAULT 0,
      cash_sales DECIMAL(12,2) DEFAULT 0,
      card_sales DECIMAL(12,2) DEFAULT 0,
      other_sales DECIMAL(12,2) DEFAULT 0,
      avg_transaction_value DECIMAL(10,2),
      avg_basket_size DECIMAL(10,2),
      customer_count INTEGER DEFAULT 0,
      new_customer_count INTEGER DEFAULT 0,
      calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, location_id, summary_date)
    )`);

    // Hourly Sales Summary
    await pool.query(`CREATE TABLE IF NOT EXISTS hourly_sales_summary (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      summary_date DATE NOT NULL,
      hour INTEGER NOT NULL,
      transaction_count INTEGER DEFAULT 0,
      net_sales DECIMAL(12,2) DEFAULT 0,
      item_count INTEGER DEFAULT 0,
      UNIQUE(company_id, location_id, summary_date, hour)
    )`);

    // Product Performance
    await pool.query(`CREATE TABLE IF NOT EXISTS product_performance (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      period_type VARCHAR(20) NOT NULL,
      period_start DATE NOT NULL,
      quantity_sold INTEGER DEFAULT 0,
      revenue DECIMAL(12,2) DEFAULT 0,
      cost DECIMAL(12,2) DEFAULT 0,
      profit DECIMAL(12,2) DEFAULT 0,
      return_count INTEGER DEFAULT 0,
      discount_count INTEGER DEFAULT 0,
      UNIQUE(company_id, location_id, product_id, period_type, period_start)
    )`);

    // KPI Targets
    await pool.query(`CREATE TABLE IF NOT EXISTS kpi_targets (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER,
      kpi_type VARCHAR(50) NOT NULL,
      target_value DECIMAL(12,2) NOT NULL,
      period_type VARCHAR(20) NOT NULL,
      effective_from DATE NOT NULL,
      effective_to DATE,
      created_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Scheduled Reports
    await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_reports (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      report_name VARCHAR(255) NOT NULL,
      report_type VARCHAR(50) NOT NULL,
      location_scope VARCHAR(50),
      location_ids INTEGER[],
      schedule_type VARCHAR(20) NOT NULL,
      schedule_time TIME DEFAULT '07:00:00',
      schedule_day INTEGER,
      recipients TEXT[],
      format VARCHAR(20) DEFAULT 'pdf',
      include_charts INTEGER DEFAULT 1,
      last_run_at TIMESTAMP,
      next_run_at TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      created_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Loss Prevention Rules
    await pool.query(`CREATE TABLE IF NOT EXISTS loss_prevention_rules (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      rule_name VARCHAR(255) NOT NULL,
      rule_type VARCHAR(50) NOT NULL,
      trigger_conditions JSONB NOT NULL,
      severity VARCHAR(20) DEFAULT 'warning',
      notify_roles TEXT[],
      notify_users INTEGER[],
      auto_lock_user INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Loss Prevention Alerts
    await pool.query(`CREATE TABLE IF NOT EXISTS loss_prevention_alerts (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER,
      rule_id INTEGER NOT NULL,
      triggered_by_user_id INTEGER,
      severity VARCHAR(20) NOT NULL,
      alert_type VARCHAR(50) NOT NULL,
      alert_details JSONB NOT NULL,
      transaction_ids INTEGER[],
      status VARCHAR(20) DEFAULT 'open',
      assigned_to_user_id INTEGER,
      resolution_notes TEXT,
      resolved_at TIMESTAMP,
      resolved_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Cash Variances
    await pool.query(`CREATE TABLE IF NOT EXISTS cash_variances (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      till_session_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      variance_date DATE NOT NULL,
      expected_amount DECIMAL(12,2) NOT NULL,
      actual_amount DECIMAL(12,2) NOT NULL,
      variance_amount DECIMAL(12,2) NOT NULL,
      variance_reason TEXT,
      is_investigated INTEGER DEFAULT 0,
      investigated_by_user_id INTEGER,
      investigation_notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Employee Variance Summary
    await pool.query(`CREATE TABLE IF NOT EXISTS employee_variance_summary (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      variance_count INTEGER DEFAULT 0,
      total_positive_variance DECIMAL(12,2) DEFAULT 0,
      total_negative_variance DECIMAL(12,2) DEFAULT 0,
      net_variance DECIMAL(12,2) DEFAULT 0,
      void_count INTEGER DEFAULT 0,
      refund_count INTEGER DEFAULT 0,
      discount_count INTEGER DEFAULT 0,
      calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, user_id, period_start)
    )`);

    // ========== PHASE 5: LOYALTY & PROMOTIONS ==========

    // Loyalty Programs
    await pool.query(`CREATE TABLE IF NOT EXISTS loyalty_programs (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      program_name VARCHAR(255) NOT NULL,
      points_per_currency DECIMAL(10,4) DEFAULT 1.0,
      points_value DECIMAL(10,4) DEFAULT 0.01,
      minimum_redemption INTEGER DEFAULT 100,
      points_expiry_months INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Loyalty Tiers
    await pool.query(`CREATE TABLE IF NOT EXISTS loyalty_tiers (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL,
      tier_name VARCHAR(100) NOT NULL,
      tier_order INTEGER NOT NULL,
      min_points_required INTEGER NOT NULL,
      min_spend_required DECIMAL(12,2),
      points_multiplier DECIMAL(5,2) DEFAULT 1.0,
      benefits JSONB,
      color_code VARCHAR(7),
      icon_url VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Customer Loyalty
    await pool.query(`CREATE TABLE IF NOT EXISTS customer_loyalty (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      program_id INTEGER NOT NULL,
      loyalty_number VARCHAR(50) UNIQUE,
      current_tier_id INTEGER,
      points_balance INTEGER DEFAULT 0,
      lifetime_points INTEGER DEFAULT 0,
      lifetime_spend DECIMAL(12,2) DEFAULT 0,
      tier_qualify_date DATE,
      tier_expiry_date DATE,
      enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      enrolled_location_id INTEGER,
      UNIQUE(customer_id, program_id)
    )`);

    // Loyalty Transactions
    await pool.query(`CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id SERIAL PRIMARY KEY,
      customer_loyalty_id INTEGER NOT NULL,
      transaction_type VARCHAR(50) NOT NULL,
      points INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      sale_id INTEGER,
      location_id INTEGER,
      description TEXT,
      processed_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Promotions
    await pool.query(`CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      promotion_code VARCHAR(50),
      promotion_name VARCHAR(255) NOT NULL,
      promotion_type VARCHAR(50) NOT NULL,
      description TEXT,
      rules JSONB NOT NULL,
      discount_value DECIMAL(10,2),
      discount_percentage DECIMAL(5,2),
      minimum_purchase DECIMAL(10,2),
      maximum_discount DECIMAL(10,2),
      usage_limit INTEGER,
      usage_per_customer INTEGER,
      current_usage_count INTEGER DEFAULT 0,
      start_date TIMESTAMP NOT NULL,
      end_date TIMESTAMP NOT NULL,
      day_of_week INTEGER[],
      start_time TIME,
      end_time TIME,
      location_ids INTEGER[],
      customer_tier_ids INTEGER[],
      requires_approval INTEGER DEFAULT 0,
      approval_threshold DECIMAL(10,2),
      is_stackable INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_by_user_id INTEGER,
      approved_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, promotion_code)
    )`);

    // Promotion Usage
    await pool.query(`CREATE TABLE IF NOT EXISTS promotion_usage (
      id SERIAL PRIMARY KEY,
      promotion_id INTEGER NOT NULL,
      sale_id INTEGER NOT NULL,
      customer_id INTEGER,
      discount_applied DECIMAL(10,2) NOT NULL,
      location_id INTEGER,
      applied_by_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Promotion Approvals
    await pool.query(`CREATE TABLE IF NOT EXISTS promotion_approvals (
      id SERIAL PRIMARY KEY,
      promotion_id INTEGER NOT NULL,
      sale_id INTEGER,
      requested_by_user_id INTEGER NOT NULL,
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      discount_amount DECIMAL(10,2) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      approved_by_user_id INTEGER,
      approved_at TIMESTAMP,
      rejection_reason TEXT
    )`);

    // Integration Configs
    await pool.query(`CREATE TABLE IF NOT EXISTS integration_configs (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      integration_type VARCHAR(50) NOT NULL,
      integration_name VARCHAR(100) NOT NULL,
      endpoint_url VARCHAR(500),
      api_key VARCHAR(255),
      api_secret VARCHAR(255),
      oauth_token TEXT,
      oauth_refresh_token TEXT,
      oauth_expires_at TIMESTAMP,
      sync_settings JSONB,
      mapping_config JSONB,
      last_sync_at TIMESTAMP,
      last_sync_status VARCHAR(50),
      last_sync_error TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Integration Sync Log
    await pool.query(`CREATE TABLE IF NOT EXISTS integration_sync_log (
      id SERIAL PRIMARY KEY,
      integration_config_id INTEGER NOT NULL,
      sync_type VARCHAR(50) NOT NULL,
      sync_direction VARCHAR(20) NOT NULL,
      records_processed INTEGER,
      records_succeeded INTEGER,
      records_failed INTEGER,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      status VARCHAR(50),
      error_details JSONB
    )`);

    // Webhooks
    await pool.query(`CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      webhook_name VARCHAR(100) NOT NULL,
      event_types TEXT[] NOT NULL,
      endpoint_url VARCHAR(500) NOT NULL,
      secret_key VARCHAR(255),
      headers JSONB,
      is_active INTEGER DEFAULT 1,
      retry_count INTEGER DEFAULT 3,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Webhook Deliveries
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id SERIAL PRIMARY KEY,
      webhook_id INTEGER NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      attempt_count INTEGER DEFAULT 1,
      delivered_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== SAFE DEFAULT DATA INITIALIZATION ==========
    // Only create default data if a company already exists (prevents creating orphan records)
    const existingCompanies = await pool.query(`SELECT id FROM companies WHERE is_active = 1 ORDER BY id LIMIT 1`);
    if (existingCompanies.rows.length > 0) {
      const defaultCompanyId = existingCompanies.rows[0].id;

      // Create default location for existing company (if not exists)
      await pool.query(`
        INSERT INTO locations (company_id, location_code, location_name, location_type)
        VALUES ($1, 'HQ-001', 'Head Office', 'hq')
        ON CONFLICT (company_id, location_code) DO NOTHING
      `, [defaultCompanyId]);

      // Create default barcode settings for existing company (if not exists)
      await pool.query(`
        INSERT INTO barcode_settings (company_id, company_prefix, current_sequence, barcode_type)
        VALUES ($1, '600', 1000, 'EAN13')
        ON CONFLICT (company_id) DO NOTHING
      `, [defaultCompanyId]);

      // Create default company settings for existing company (if not exists)
      await pool.query(`
        INSERT INTO company_settings (company_id, till_float_amount)
        VALUES ($1, 500.00)
        ON CONFLICT (company_id) DO NOTHING
      `, [defaultCompanyId]);
    } else {
      console.log('ℹ️  No companies found - skipping default data initialization');
    }

    console.log('✅ Database initialized successfully');
    await pool.end();
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('POS_App'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/sean', seanAiRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/vat', vatRoutes);
app.use('/api/barcode', barcodeRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/reports', reportsRoutes);

// Enterprise Routes
const locationsRoutes = require('./routes/locations');
const employeesRoutes = require('./routes/employees');
const schedulingRoutes = require('./routes/scheduling');
const inventoryRoutes = require('./routes/inventory');
const transfersRoutes = require('./routes/transfers');
const suppliersRoutes = require('./routes/suppliers');
const purchaseOrdersRoutes = require('./routes/purchase-orders');
const analyticsRoutes = require('./routes/analytics');
const lossPreventionRoutes = require('./routes/loss-prevention');
const loyaltyRoutes = require('./routes/loyalty');
const promotionsRoutes = require('./routes/promotions');
const receiptsRoutes = require('./routes/receipts');
const kvRoutes        = require('./routes/kv');

app.use('/api/locations', locationsRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/scheduling', schedulingRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/transfers', transfersRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/loss-prevention', lossPreventionRoutes);
app.use('/api/loyalty', loyaltyRoutes);
app.use('/api/promotions', promotionsRoutes);
app.use('/api/receipts', receiptsRoutes);
app.use('/api/kv', kvRoutes);

// Serve the main POS application
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'POS_App', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Initialize database then start server
initDatabase().then(() => {
  // ⚠️  LEGACY STANDALONE POS SERVER — DEPRECATED
  // This server (port 8080) uses its own PostgreSQL database and is LEGACY.
  // The AUTHORITATIVE system is:
  //   accounting-ecosystem/backend/ (port 3000)
  //   → module: pos  (MODULE_POS_ENABLED=true)
  //   → API:    /api/pos/*
  //   → DB:     Supabase (not this PostgreSQL instance)
  //
  // DO NOT run both servers against different databases in production.
  // All new POS development should target the ecosystem server.
  // Migrate data from this PostgreSQL DB to Supabase before decommissioning.
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  ⚠️  LEGACY STANDALONE POS SERVER — DEPRECATED                    ║');
  console.log('║  Authoritative system: accounting-ecosystem/backend/ (port 3000) ║');
  console.log('║  Module: pos (MODULE_POS_ENABLED=true) → /api/pos/*              ║');
  console.log('║  This server uses a separate PostgreSQL DB — NOT Supabase.        ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`POS System Server running on port ${PORT}`);
    console.log(`API available at /api`);
  });
});
