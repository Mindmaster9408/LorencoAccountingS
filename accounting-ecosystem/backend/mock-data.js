/**
 * ============================================================================
 * MOCK DATA STORE — In-Memory Database for Testing
 * ============================================================================
 * Provides comprehensive test data for both POS (Checkout Charlie) and
 * Payroll (Lorenco Paytime) modules WITHOUT requiring Supabase.
 *
 * Toggle: MOCK_MODE=true in .env
 *
 * Test Credentials:
 *   pos@test.com              / pos123           — POS cashier (store_manager)
 *   payroll@test.com          / payroll123       — Payroll admin (payroll_admin)
 *   admin@test.com            / admin123         — Super admin (both modules)
 *   ruanvlog@lorenco.co.za    / Mindmaster@277477 — Super admin (all modules incl. SEAN)
 *
 * All data resets on server restart (in-memory only).
 * ============================================================================
 */

const bcrypt = require('bcrypt');

// ─── ID Generator ────────────────────────────────────────────────────────────
let _idCounter = 1000;
function nextId() { return ++_idCounter; }

// ─── Password Hashes (pre-computed for speed) ────────────────────────────────
// We'll generate these at init time
let passwordHashes = {};

async function initPasswords() {
  passwordHashes['pos123'] = await bcrypt.hash('pos123', 10);
  passwordHashes['payroll123'] = await bcrypt.hash('payroll123', 10);
  passwordHashes['admin123'] = await bcrypt.hash('admin123', 10);
  passwordHashes['Mindmaster@277477'] = await bcrypt.hash('Mindmaster@277477', 10);
  console.log('  🔑 Mock password hashes generated');
}

// ─── Companies ───────────────────────────────────────────────────────────────
const companies = [
  {
    id: 1,
    company_name: 'The Infinite Legacy (Pty) Ltd',
    trading_name: 'Infinite Legacy',
    registration_number: '2024/123456/07',
    tax_number: '9876543210',
    is_active: true,
    modules_enabled: ['pos', 'payroll', 'sean', 'accounting'],
    subscription_status: 'active',
    address: '123 Main Road, Cape Town, 8001',
    phone: '+27 21 555 0100',
    email: 'info@infinitelegacy.co.za',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    company_name: 'Test Branch Trading',
    trading_name: 'Test Branch',
    registration_number: '2024/654321/07',
    tax_number: '1234567890',
    is_active: true,
    modules_enabled: ['pos', 'sean', 'accounting'],
    subscription_status: 'active',
    address: '456 Second Ave, Johannesburg, 2001',
    phone: '+27 11 555 0200',
    email: 'info@testbranch.co.za',
    created_at: '2024-02-01T00:00:00.000Z',
    updated_at: '2024-02-01T00:00:00.000Z',
  }
];

// ─── Users ───────────────────────────────────────────────────────────────────
const users = [
  {
    id: 1,
    username: 'pos@test.com',
    email: 'pos@test.com',
    password_hash: null, // set during init
    full_name: 'POS Test User',
    is_active: true,
    is_super_admin: false,
    created_at: '2024-01-15T08:00:00.000Z',
  },
  {
    id: 2,
    username: 'payroll@test.com',
    email: 'payroll@test.com',
    password_hash: null,
    full_name: 'Payroll Test User',
    is_active: true,
    is_super_admin: false,
    created_at: '2024-01-15T08:00:00.000Z',
  },
  {
    id: 3,
    username: 'admin@test.com',
    email: 'admin@test.com',
    password_hash: null,
    full_name: 'Admin Super User',
    is_active: true,
    is_super_admin: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 4,
    username: 'ruanvlog@lorenco.co.za',
    email: 'ruanvlog@lorenco.co.za',
    password_hash: null,
    full_name: 'Ruan van Loggerenberg',
    is_active: true,
    is_super_admin: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
];

// ─── User ↔ Company Access ──────────────────────────────────────────────────
const userCompanyAccess = [
  { user_id: 1, company_id: 1, role: 'store_manager', is_primary: true, is_active: true },
  { user_id: 1, company_id: 2, role: 'cashier', is_primary: false, is_active: true },
  { user_id: 2, company_id: 1, role: 'payroll_admin', is_primary: true, is_active: true },
  { user_id: 3, company_id: 1, role: 'business_owner', is_primary: true, is_active: true },
  { user_id: 3, company_id: 2, role: 'business_owner', is_primary: false, is_active: true },
  { user_id: 4, company_id: 1, role: 'super_admin', is_primary: true, is_active: true },
  { user_id: 4, company_id: 2, role: 'super_admin', is_primary: false, is_active: true },
];

// ─── Categories (POS) ───────────────────────────────────────────────────────
const categories = [
  { id: 1, company_id: 1, name: 'Beverages', description: 'Hot & cold drinks', color: '#3b82f6', is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
  { id: 2, company_id: 1, name: 'Snacks', description: 'Chips, sweets, biscuits', color: '#f59e0b', is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
  { id: 3, company_id: 1, name: 'Groceries', description: 'Everyday essentials', color: '#10b981', is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
  { id: 4, company_id: 1, name: 'Dairy', description: 'Milk, cheese, yoghurt', color: '#8b5cf6', is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
  { id: 5, company_id: 1, name: 'Tobacco', description: 'Cigarettes & tobacco products', color: '#ef4444', is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
  { id: 6, company_id: 1, name: 'Toiletries', description: 'Personal care items', color: '#ec4899', is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
];

// ─── Products (POS) ──────────────────────────────────────────────────────────
const products = [
  { id: 1,  company_id: 1, name: 'Coca-Cola 500ml',     barcode: '5449000000996', sku: 'BEV-001', category_id: 1, cost_price: 8.50,   selling_price: 14.99,  stock_quantity: 120, reorder_level: 20, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 2,  company_id: 1, name: 'Fanta Orange 500ml',  barcode: '5449000000997', sku: 'BEV-002', category_id: 1, cost_price: 8.50,   selling_price: 14.99,  stock_quantity: 95,  reorder_level: 20, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 3,  company_id: 1, name: 'Sprite 500ml',        barcode: '5449000000998', sku: 'BEV-003', category_id: 1, cost_price: 8.50,   selling_price: 14.99,  stock_quantity: 80,  reorder_level: 20, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 4,  company_id: 1, name: 'Water Still 500ml',   barcode: '6001240100011', sku: 'BEV-004', category_id: 1, cost_price: 4.00,   selling_price: 9.99,   stock_quantity: 200, reorder_level: 30, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 5,  company_id: 1, name: 'Lays Original 125g',  barcode: '6009510800012', sku: 'SNK-001', category_id: 2, cost_price: 12.00,  selling_price: 21.99,  stock_quantity: 60,  reorder_level: 15, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 6,  company_id: 1, name: 'Doritos Cheese 150g', barcode: '6009510800013', sku: 'SNK-002', category_id: 2, cost_price: 14.00,  selling_price: 24.99,  stock_quantity: 45,  reorder_level: 15, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 7,  company_id: 1, name: 'KitKat 4 Finger',     barcode: '6001065000012', sku: 'SNK-003', category_id: 2, cost_price: 7.50,   selling_price: 15.99,  stock_quantity: 75,  reorder_level: 20, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 8,  company_id: 1, name: 'White Star Maize 1kg', barcode: '6001240200012', sku: 'GRC-001', category_id: 3, cost_price: 14.00,  selling_price: 22.99,  stock_quantity: 40,  reorder_level: 10, vat_inclusive: false, vat_rate: 0,  unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 9,  company_id: 1, name: 'Tastic Rice 2kg',     barcode: '6001240200013', sku: 'GRC-002', category_id: 3, cost_price: 28.00,  selling_price: 44.99,  stock_quantity: 35,  reorder_level: 10, vat_inclusive: false, vat_rate: 0,  unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 10, company_id: 1, name: 'Sunfoil Oil 750ml',   barcode: '6001240200014', sku: 'GRC-003', category_id: 3, cost_price: 22.00,  selling_price: 34.99,  stock_quantity: 28,  reorder_level: 8,  vat_inclusive: false, vat_rate: 0,  unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 11, company_id: 1, name: 'Full Cream Milk 1L',  barcode: '6001001200015', sku: 'DRY-001', category_id: 4, cost_price: 14.00,  selling_price: 21.99,  stock_quantity: 50,  reorder_level: 15, vat_inclusive: false, vat_rate: 0,  unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 12, company_id: 1, name: 'Cheddar Cheese 400g', barcode: '6001001200016', sku: 'DRY-002', category_id: 4, cost_price: 42.00,  selling_price: 64.99,  stock_quantity: 20,  reorder_level: 8,  vat_inclusive: false, vat_rate: 0,  unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 13, company_id: 1, name: 'Yoghurt Strawberry',  barcode: '6001001200017', sku: 'DRY-003', category_id: 4, cost_price: 6.50,   selling_price: 12.99,  stock_quantity: 60,  reorder_level: 15, vat_inclusive: false, vat_rate: 0,  unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 14, company_id: 1, name: 'Marlboro Red 20s',    barcode: '4820000000001', sku: 'TOB-001', category_id: 5, cost_price: 42.00,  selling_price: 62.00,  stock_quantity: 100, reorder_level: 25, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 15, company_id: 1, name: 'Colgate Toothpaste',  barcode: '6001067000015', sku: 'TOL-001', category_id: 6, cost_price: 18.00,  selling_price: 29.99,  stock_quantity: 35,  reorder_level: 10, vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 16, company_id: 1, name: 'Bread White Loaf',    barcode: '6001240300001', sku: 'GRC-004', category_id: 3, cost_price: 12.00,  selling_price: 17.99,  stock_quantity: 30,  reorder_level: 10, vat_inclusive: false, vat_rate: 0,  unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 17, company_id: 1, name: 'Eggs Large 6-pack',   barcode: '6001240300002', sku: 'GRC-005', category_id: 3, cost_price: 18.00,  selling_price: 29.99,  stock_quantity: 40,  reorder_level: 10, vat_inclusive: false, vat_rate: 0,  unit: 'pack', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 18, company_id: 1, name: 'Ricoffy 250g',        barcode: '6001240400001', sku: 'BEV-005', category_id: 1, cost_price: 38.00,  selling_price: 59.99,  stock_quantity: 25,  reorder_level: 8,  vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 19, company_id: 1, name: 'Five Roses Tea 100s', barcode: '6001240400002', sku: 'BEV-006', category_id: 1, cost_price: 32.00,  selling_price: 49.99,  stock_quantity: 30,  reorder_level: 8,  vat_inclusive: true, vat_rate: 15, unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 20, company_id: 1, name: 'Lucky Star Pilchards', barcode: '6001240500001', sku: 'GRC-006', category_id: 3, cost_price: 16.00, selling_price: 26.99,  stock_quantity: 55,  reorder_level: 12, vat_inclusive: false, vat_rate: 0,  unit: 'each', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
];

// ─── Customers (POS) ─────────────────────────────────────────────────────────
const customers = [
  { id: 1, company_id: 1, name: 'Walk-in Customer',    email: null,                     phone: null,             address: null,                             id_number: null,          customer_number: 'C-WALKIN', customer_group: 'retail',    loyalty_points: 0,    loyalty_tier: 'bronze', current_balance: 0,    notes: 'Default walk-in customer', is_active: true, created_at: '2024-01-20T00:00:00.000Z', updated_at: '2024-01-20T00:00:00.000Z' },
  { id: 2, company_id: 1, name: 'Thabo Mokwena',       email: 'thabo@email.co.za',      phone: '082 555 0001',   address: '12 Oak Street, Braamfontein',    id_number: '9001015800081', customer_number: 'C-00001',  customer_group: 'retail',    loyalty_points: 250,  loyalty_tier: 'silver', current_balance: 0,    notes: 'Regular customer',         is_active: true, created_at: '2024-02-01T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z' },
  { id: 3, company_id: 1, name: 'Aisha Patel',         email: 'aisha.patel@gmail.com',  phone: '073 555 0002',   address: '45 Longmarket St, CBD',          id_number: '8805210300088', customer_number: 'C-00002',  customer_group: 'retail',    loyalty_points: 520,  loyalty_tier: 'gold',   current_balance: -150, notes: 'Outstanding account balance', is_active: true, created_at: '2024-02-15T00:00:00.000Z', updated_at: '2024-06-15T00:00:00.000Z' },
  { id: 4, company_id: 1, name: 'Green Valley School', email: 'admin@greenvalley.edu',  phone: '021 555 0003',   address: '100 Education Drive, Pinelands', id_number: null,          customer_number: 'C-00003',  customer_group: 'wholesale', loyalty_points: 0,    loyalty_tier: 'bronze', current_balance: -2500, notes: 'School account — 30 day terms', is_active: true, created_at: '2024-03-01T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z' },
  { id: 5, company_id: 1, name: 'Sipho Dlamini',       email: 'sipho.d@outlook.com',    phone: '084 555 0004',   address: '7 Buitenkant St, Gardens',       id_number: '8507125300086', customer_number: 'C-00004',  customer_group: 'retail',    loyalty_points: 100,  loyalty_tier: 'bronze', current_balance: 0,    notes: null,                       is_active: true, created_at: '2024-04-01T00:00:00.000Z', updated_at: '2024-04-01T00:00:00.000Z' },
];

// ─── Ecosystem Clients (Cross-App) ──────────────────────────────────────────
// Central client registry — tracks which apps each client is linked to
const ecoClients = [
  { id: 1, company_id: 1, name: 'Thabo Mokwena',       email: 'thabo@email.co.za',     phone: '082 555 0001', id_number: '9001015800081', address: '12 Oak Street, Braamfontein',    client_type: 'individual', apps: ['pos', 'accounting'],                 notes: 'Regular walk-in customer, also on accounting ledger.', is_active: true, created_at: '2024-02-01T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z' },
  { id: 2, company_id: 1, name: 'Aisha Patel',         email: 'aisha.patel@gmail.com', phone: '073 555 0002', id_number: '8805210300088', address: '45 Longmarket St, CBD',          client_type: 'individual', apps: ['pos', 'accounting', 'sean'],         notes: 'Has account balance, managed by SEAN.',               is_active: true, created_at: '2024-02-15T00:00:00.000Z', updated_at: '2024-06-15T00:00:00.000Z' },
  { id: 3, company_id: 1, name: 'Green Valley School', email: 'admin@greenvalley.edu', phone: '021 555 0003', id_number: null,            address: '100 Education Drive, Pinelands', client_type: 'business',   apps: ['pos', 'payroll', 'accounting', 'sean'], notes: 'School — 30 day terms, full ecosystem.',               is_active: true, created_at: '2024-03-01T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z' },
  { id: 4, company_id: 1, name: 'Sipho Dlamini',       email: 'sipho.d@outlook.com',   phone: '084 555 0004', id_number: '8507125300086', address: '7 Buitenkant St, Gardens',       client_type: 'individual', apps: ['pos'],                               notes: null,                                                    is_active: true, created_at: '2024-04-01T00:00:00.000Z', updated_at: '2024-04-01T00:00:00.000Z' },
  { id: 5, company_id: 2, name: 'Cape Town Catering',  email: 'orders@ctcatering.co.za', phone: '021 444 5566', id_number: null,          address: '22 Strand Street, Cape Town',    client_type: 'business',   apps: ['pos', 'accounting'],                 notes: 'Branch 2 wholesale client.',                            is_active: true, created_at: '2024-05-01T00:00:00.000Z', updated_at: '2024-05-01T00:00:00.000Z' },
];

// ─── Sales + Items + Payments (POS) ──────────────────────────────────────────
const sales = [
  {
    id: 1, company_id: 1, cashier_id: 1, customer_id: 2,
    receipt_number: 'RC-20240601-A1B2', subtotal: 59.96, discount_amount: 0, vat_amount: 7.82,
    total_amount: 59.96, status: 'completed', notes: null, till_session_id: null,
    void_reason: null, voided_by: null, voided_at: null,
    created_at: '2024-06-01T09:15:00.000Z', updated_at: '2024-06-01T09:15:00.000Z',
  },
  {
    id: 2, company_id: 1, cashier_id: 1, customer_id: null,
    receipt_number: 'RC-20240601-C3D4', subtotal: 44.98, discount_amount: 5.00, vat_amount: 5.22,
    total_amount: 39.98, status: 'completed', notes: 'Staff discount', till_session_id: null,
    void_reason: null, voided_by: null, voided_at: null,
    created_at: '2024-06-01T10:30:00.000Z', updated_at: '2024-06-01T10:30:00.000Z',
  },
  {
    id: 3, company_id: 1, cashier_id: 1, customer_id: 3,
    receipt_number: 'RC-20240602-E5F6', subtotal: 129.94, discount_amount: 0, vat_amount: 8.47,
    total_amount: 129.94, status: 'voided', notes: null, till_session_id: null,
    void_reason: 'Customer changed mind', voided_by: 1, voided_at: '2024-06-02T11:00:00.000Z',
    created_at: '2024-06-02T10:45:00.000Z', updated_at: '2024-06-02T11:00:00.000Z',
  },
];

const saleItems = [
  { id: 1, sale_id: 1, product_id: 1,  product_name: 'Coca-Cola 500ml',   quantity: 2, unit_price: 14.99, discount_amount: 0, vat_rate: 15, line_total: 29.98 },
  { id: 2, sale_id: 1, product_id: 5,  product_name: 'Lays Original 125g', quantity: 1, unit_price: 21.99, discount_amount: 0, vat_rate: 15, line_total: 21.99 },
  { id: 3, sale_id: 1, product_id: 4,  product_name: 'Water Still 500ml',  quantity: 1, unit_price: 9.99,  discount_amount: 0, vat_rate: 15, line_total: 9.99 },
  { id: 4, sale_id: 2, product_id: 7,  product_name: 'KitKat 4 Finger',    quantity: 1, unit_price: 15.99, discount_amount: 0, vat_rate: 15, line_total: 15.99 },
  { id: 5, sale_id: 2, product_id: 15, product_name: 'Colgate Toothpaste', quantity: 1, unit_price: 29.99, discount_amount: 0, vat_rate: 15, line_total: 29.99 },
  { id: 6, sale_id: 3, product_id: 9,  product_name: 'Tastic Rice 2kg',    quantity: 2, unit_price: 44.99, discount_amount: 0, vat_rate: 0,  line_total: 89.98 },
  { id: 7, sale_id: 3, product_id: 16, product_name: 'Bread White Loaf',   quantity: 2, unit_price: 17.99, discount_amount: 0, vat_rate: 0,  line_total: 35.98 },
];

const salePayments = [
  { id: 1, sale_id: 1, payment_method: 'cash',  amount: 59.96, reference: null },
  { id: 2, sale_id: 2, payment_method: 'card',  amount: 39.98, reference: 'CARD-1234' },
  { id: 3, sale_id: 3, payment_method: 'cash',  amount: 129.94, reference: null },
];

// ─── Inventory Adjustments (POS) ─────────────────────────────────────────────
const inventoryAdjustments = [
  { id: 1, company_id: 1, product_id: 1, adjusted_by: 1, quantity_before: 130, quantity_change: -10, quantity_after: 120, reason: 'damaged', notes: 'Stock damaged during delivery', created_at: '2024-06-01T07:00:00.000Z' },
  { id: 2, company_id: 1, product_id: 8, adjusted_by: 1, quantity_before: 30,  quantity_change: 10,  quantity_after: 40,  reason: 'stock_received', notes: 'Monthly delivery',   created_at: '2024-06-01T07:30:00.000Z' },
];

// ─── Employees (Shared / Payroll) ────────────────────────────────────────────
const employees = [
  { id: 1,  company_id: 1, user_id: 1,    employee_number: 'EMP-001', full_name: 'POS Test User',      email: 'pos@test.com',         phone: '082 555 1001', id_number: '9501015800081', tax_number: '1234567890', position: 'Store Manager',   department: 'Retail',    start_date: '2023-06-01', basic_salary: 25000, hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2023-06-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 2,  company_id: 1, user_id: 2,    employee_number: 'EMP-002', full_name: 'Payroll Test User',   email: 'payroll@test.com',     phone: '082 555 1002', id_number: '9002025800082', tax_number: '2345678901', position: 'Payroll Admin',    department: 'Finance',   start_date: '2023-01-15', basic_salary: 30000, hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2023-01-15T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 3,  company_id: 1, user_id: 3,    employee_number: 'EMP-003', full_name: 'Admin Super User',    email: 'admin@test.com',       phone: '082 555 1003', id_number: '8505155800083', tax_number: '3456789012', position: 'Director',        department: 'Management', start_date: '2022-01-01', basic_salary: 65000, hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2022-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 4,  company_id: 1, user_id: null,  employee_number: 'EMP-004', full_name: 'Lerato Nkosi',       email: 'lerato.n@company.co.za', phone: '073 555 2001', id_number: '9803015800084', tax_number: '4567890123', position: 'Senior Cashier',   department: 'Retail',    start_date: '2023-03-01', basic_salary: 12000, hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2023-03-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 5,  company_id: 1, user_id: null,  employee_number: 'EMP-005', full_name: 'James van der Merwe', email: 'james.vdm@company.co.za', phone: '084 555 2002', id_number: '9107025800085', tax_number: '5678901234', position: 'Cashier',          department: 'Retail',    start_date: '2023-07-15', basic_salary: 9500,  hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2023-07-15T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 6,  company_id: 1, user_id: null,  employee_number: 'EMP-006', full_name: 'Fatima Abrahams',    email: 'fatima.a@company.co.za', phone: '071 555 2003', id_number: '9504105800086', tax_number: '6789012345', position: 'Cashier',          department: 'Retail',    start_date: '2024-01-08', basic_salary: 8500,  hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2024-01-08T00:00:00.000Z', updated_at: '2024-01-08T00:00:00.000Z' },
  { id: 7,  company_id: 1, user_id: null,  employee_number: 'EMP-007', full_name: 'Bongani Mthembu',    email: 'bongani.m@company.co.za', phone: '083 555 2004', id_number: '8811125800087', tax_number: '7890123456', position: 'Stock Controller', department: 'Warehouse', start_date: '2022-11-01', basic_salary: 14000, hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2022-11-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 8,  company_id: 1, user_id: null,  employee_number: 'EMP-008', full_name: 'Naledi Moloto',      email: 'naledi.m@company.co.za', phone: '079 555 2005', id_number: '9606155800088', tax_number: '8901234567', position: 'Trainee Cashier',  department: 'Retail',    start_date: '2024-06-01', basic_salary: 7000,  hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2024-06-01T00:00:00.000Z', updated_at: '2024-06-01T00:00:00.000Z' },
  { id: 9,  company_id: 1, user_id: null,  employee_number: 'EMP-009', full_name: 'Willem Botha',       email: 'willem.b@company.co.za', phone: '082 555 2006', id_number: '7702085800089', tax_number: '9012345678', position: 'Bookkeeper',       department: 'Finance',   start_date: '2022-06-01', basic_salary: 22000, hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2022-06-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 10, company_id: 1, user_id: null,  employee_number: 'EMP-010', full_name: 'Zanele Khumalo',     email: 'zanele.k@company.co.za', phone: '081 555 2007', id_number: '9909205800090', tax_number: '0123456789', position: 'Part-time Packer', department: 'Warehouse', start_date: '2024-03-15', basic_salary: 0,     hourly_rate: 55.00, payment_frequency: 'weekly',   is_active: true, created_at: '2024-03-15T00:00:00.000Z', updated_at: '2024-03-15T00:00:00.000Z' },
  { id: 11, company_id: 1, user_id: null,  employee_number: 'EMP-011', full_name: 'Pieter Joubert',     email: 'pieter.j@company.co.za', phone: '072 555 2008', id_number: '8203075800091', tax_number: null,          position: 'Delivery Driver', department: 'Logistics', start_date: '2023-09-01', basic_salary: 11000, hourly_rate: null,   payment_frequency: 'monthly', is_active: true, created_at: '2023-09-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 12, company_id: 1, user_id: null,  employee_number: 'EMP-012', full_name: 'Thandiwe Zulu',      email: 'thandi.z@company.co.za', phone: '082 555 2009', id_number: '9410135800092', tax_number: null,          position: 'Cleaner',         department: 'Operations', start_date: '2023-04-01', basic_salary: 7500,  hourly_rate: null,   payment_frequency: 'monthly', is_active: false, created_at: '2023-04-01T00:00:00.000Z', updated_at: '2024-05-01T00:00:00.000Z' },
];

// ─── Employee Bank Details (Payroll) ─────────────────────────────────────────
const employeeBankDetails = [
  { id: 1,  employee_id: 1,  bank_name: 'FNB',         account_number: '62123456789', branch_code: '250655', account_type: 'cheque',  created_at: '2023-06-01T00:00:00.000Z' },
  { id: 2,  employee_id: 2,  bank_name: 'Standard Bank', account_number: '001234567',  branch_code: '051001', account_type: 'savings', created_at: '2023-01-15T00:00:00.000Z' },
  { id: 3,  employee_id: 3,  bank_name: 'Nedbank',      account_number: '1234567890', branch_code: '198765', account_type: 'cheque',  created_at: '2022-01-01T00:00:00.000Z' },
  { id: 4,  employee_id: 4,  bank_name: 'Capitec',      account_number: '1234567891', branch_code: '470010', account_type: 'savings', created_at: '2023-03-01T00:00:00.000Z' },
  { id: 5,  employee_id: 5,  bank_name: 'FNB',          account_number: '62987654321', branch_code: '250655', account_type: 'savings', created_at: '2023-07-15T00:00:00.000Z' },
  { id: 6,  employee_id: 6,  bank_name: 'ABSA',         account_number: '4071234567', branch_code: '632005', account_type: 'savings', created_at: '2024-01-08T00:00:00.000Z' },
  { id: 7,  employee_id: 7,  bank_name: 'Standard Bank', account_number: '007654321',  branch_code: '051001', account_type: 'cheque',  created_at: '2022-11-01T00:00:00.000Z' },
  { id: 8,  employee_id: 9,  bank_name: 'FNB',          account_number: '62456789012', branch_code: '250655', account_type: 'cheque',  created_at: '2022-06-01T00:00:00.000Z' },
  { id: 9,  employee_id: 10, bank_name: 'Capitec',      account_number: '1234567999', branch_code: '470010', account_type: 'savings', created_at: '2024-03-15T00:00:00.000Z' },
  { id: 10, employee_id: 11, bank_name: 'Nedbank',      account_number: '1234567000', branch_code: '198765', account_type: 'savings', created_at: '2023-09-01T00:00:00.000Z' },
];

// ─── Payroll Items Master ────────────────────────────────────────────────────
const payrollItemsMaster = [
  { id: 1,  company_id: 1, code: 'BASIC',      name: 'Basic Salary',        item_type: 'earning',    is_taxable: true,  is_recurring: true,  default_amount: 0,    description: 'Monthly basic salary',       is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 2,  company_id: 1, code: 'OT_NORMAL',  name: 'Overtime (Normal)',   item_type: 'earning',    is_taxable: true,  is_recurring: false, default_amount: 0,    description: 'Normal overtime at 1.5x',    is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 3,  company_id: 1, code: 'OT_SUNDAY',  name: 'Overtime (Sunday)',   item_type: 'earning',    is_taxable: true,  is_recurring: false, default_amount: 0,    description: 'Sunday overtime at 2x',      is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 4,  company_id: 1, code: 'COMMISSION', name: 'Commission',          item_type: 'earning',    is_taxable: true,  is_recurring: false, default_amount: 0,    description: 'Sales commission',           is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 5,  company_id: 1, code: 'TRAVEL',     name: 'Travel Allowance',    item_type: 'earning',    is_taxable: true,  is_recurring: true,  default_amount: 2000, description: 'Monthly travel allowance',   is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 6,  company_id: 1, code: 'BONUS',      name: 'Bonus',              item_type: 'earning',    is_taxable: true,  is_recurring: false, default_amount: 0,    description: 'Performance bonus',          is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 7,  company_id: 1, code: 'PAYE',       name: 'PAYE Tax',           item_type: 'deduction',  is_taxable: false, is_recurring: true,  default_amount: 0,    description: 'Pay As You Earn income tax', is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 8,  company_id: 1, code: 'UIF_EE',     name: 'UIF Employee',       item_type: 'deduction',  is_taxable: false, is_recurring: true,  default_amount: 0,    description: 'UIF employee contribution 1%', is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 9,  company_id: 1, code: 'UIF_ER',     name: 'UIF Employer',       item_type: 'deduction',  is_taxable: false, is_recurring: true,  default_amount: 0,    description: 'UIF employer contribution 1%', is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 10, company_id: 1, code: 'PENSION',    name: 'Pension Fund',       item_type: 'deduction',  is_taxable: false, is_recurring: true,  default_amount: 0,    description: 'Company pension contribution', is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 11, company_id: 1, code: 'MED_AID',    name: 'Medical Aid',        item_type: 'deduction',  is_taxable: false, is_recurring: true,  default_amount: 0,    description: 'Medical aid contribution',     is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 12, company_id: 1, code: 'LOAN',       name: 'Staff Loan Repay',   item_type: 'deduction',  is_taxable: false, is_recurring: true,  default_amount: 0,    description: 'Staff loan repayment',         is_active: true, created_at: '2024-01-01T00:00:00.000Z' },
];

// ─── Payroll Periods ─────────────────────────────────────────────────────────
const payrollPeriods = [
  { id: 1, company_id: 1, start_date: '2024-06-01', end_date: '2024-06-30', pay_date: '2024-06-25', period_name: 'June 2024',  tax_year: '2024/2025', frequency: 'monthly', status: 'paid',   created_by: 2, approved_by: 3, approved_at: '2024-06-23T00:00:00.000Z', paid_at: '2024-06-25T00:00:00.000Z', created_at: '2024-06-01T00:00:00.000Z' },
  { id: 2, company_id: 1, start_date: '2024-07-01', end_date: '2024-07-31', pay_date: '2024-07-25', period_name: 'July 2024',  tax_year: '2024/2025', frequency: 'monthly', status: 'approved', created_by: 2, approved_by: 3, approved_at: '2024-07-22T00:00:00.000Z', paid_at: null, created_at: '2024-07-01T00:00:00.000Z' },
  { id: 3, company_id: 1, start_date: '2024-08-01', end_date: '2024-08-31', pay_date: '2024-08-25', period_name: 'August 2024', tax_year: '2024/2025', frequency: 'monthly', status: 'draft',    created_by: 2, approved_by: null, approved_at: null, paid_at: null, created_at: '2024-08-01T00:00:00.000Z' },
];

// ─── Payroll Transactions (Payslips) ─────────────────────────────────────────
const payrollTransactions = [
  { id: 1, company_id: 1, period_id: 1, employee_id: 1, basic_salary: 25000, gross_pay: 25000, net_pay: 21280, total_earnings: 25000, total_deductions: 3720, paye_tax: 2970, uif_employee: 177.12, uif_employer: 177.12, status: 'paid', notes: null, created_at: '2024-06-20T00:00:00.000Z' },
  { id: 2, company_id: 1, period_id: 1, employee_id: 4, basic_salary: 12000, gross_pay: 12000, net_pay: 10772, total_earnings: 12000, total_deductions: 1228, paye_tax: 1108, uif_employee: 120, uif_employer: 120, status: 'paid', notes: null, created_at: '2024-06-20T00:00:00.000Z' },
  { id: 3, company_id: 1, period_id: 1, employee_id: 5, basic_salary: 9500,  gross_pay: 9500,  net_pay: 8650,  total_earnings: 9500,  total_deductions: 850,  paye_tax: 755, uif_employee: 95, uif_employer: 95, status: 'paid', notes: null, created_at: '2024-06-20T00:00:00.000Z' },
  { id: 4, company_id: 1, period_id: 3, employee_id: 1, basic_salary: 25000, gross_pay: 25000, net_pay: 0,     total_earnings: 0,     total_deductions: 0,    paye_tax: 0,    uif_employee: 0,     uif_employer: 0,     status: 'draft', notes: 'Awaiting processing', created_at: '2024-08-05T00:00:00.000Z' },
];

// ─── Payslip Items ───────────────────────────────────────────────────────────
const payslipItems = [
  { id: 1,  transaction_id: 1, item_code: 'BASIC',  item_name: 'Basic Salary',  item_type: 'earning',   amount: 25000,  is_taxable: true,  is_recurring: true,  notes: null },
  { id: 2,  transaction_id: 1, item_code: 'PAYE',   item_name: 'PAYE Tax',      item_type: 'deduction', amount: 2970,   is_taxable: false, is_recurring: true,  notes: null },
  { id: 3,  transaction_id: 1, item_code: 'UIF_EE', item_name: 'UIF Employee',  item_type: 'deduction', amount: 177.12, is_taxable: false, is_recurring: true,  notes: null },
  { id: 4,  transaction_id: 1, item_code: 'PENSION', item_name: 'Pension Fund', item_type: 'deduction', amount: 572.88, is_taxable: false, is_recurring: true,  notes: null },
  { id: 5,  transaction_id: 2, item_code: 'BASIC',  item_name: 'Basic Salary',  item_type: 'earning',   amount: 12000,  is_taxable: true,  is_recurring: true,  notes: null },
  { id: 6,  transaction_id: 2, item_code: 'PAYE',   item_name: 'PAYE Tax',      item_type: 'deduction', amount: 1108,   is_taxable: false, is_recurring: true,  notes: null },
  { id: 7,  transaction_id: 2, item_code: 'UIF_EE', item_name: 'UIF Employee',  item_type: 'deduction', amount: 120,    is_taxable: false, is_recurring: true,  notes: null },
  { id: 8,  transaction_id: 3, item_code: 'BASIC',  item_name: 'Basic Salary',  item_type: 'earning',   amount: 9500,   is_taxable: true,  is_recurring: true,  notes: null },
  { id: 9,  transaction_id: 3, item_code: 'PAYE',   item_name: 'PAYE Tax',      item_type: 'deduction', amount: 755,    is_taxable: false, is_recurring: true,  notes: null },
  { id: 10, transaction_id: 3, item_code: 'UIF_EE', item_name: 'UIF Employee',  item_type: 'deduction', amount: 95,     is_taxable: false, is_recurring: true,  notes: null },
];

// ─── Attendance ──────────────────────────────────────────────────────────────
const attendance = [
  { id: 1,  company_id: 1, employee_id: 1,  date: '2024-08-01', status: 'present', clock_in: '07:55', clock_out: '17:05', hours_worked: 8.5, overtime_hours: 0.5, notes: null },
  { id: 2,  company_id: 1, employee_id: 4,  date: '2024-08-01', status: 'present', clock_in: '08:00', clock_out: '17:00', hours_worked: 8,   overtime_hours: 0,   notes: null },
  { id: 3,  company_id: 1, employee_id: 5,  date: '2024-08-01', status: 'late',    clock_in: '08:35', clock_out: '17:00', hours_worked: 7.5, overtime_hours: 0,   notes: 'Traffic' },
  { id: 4,  company_id: 1, employee_id: 6,  date: '2024-08-01', status: 'present', clock_in: '08:00', clock_out: '17:00', hours_worked: 8,   overtime_hours: 0,   notes: null },
  { id: 5,  company_id: 1, employee_id: 7,  date: '2024-08-01', status: 'present', clock_in: '06:00', clock_out: '16:00', hours_worked: 9,   overtime_hours: 1,   notes: null },
  { id: 6,  company_id: 1, employee_id: 8,  date: '2024-08-01', status: 'absent',  clock_in: null,    clock_out: null,    hours_worked: 0,   overtime_hours: 0,   notes: 'No show, no call' },
  { id: 7,  company_id: 1, employee_id: 10, date: '2024-08-01', status: 'present', clock_in: '09:00', clock_out: '14:00', hours_worked: 5,   overtime_hours: 0,   notes: 'Part-time shift' },
  { id: 8,  company_id: 1, employee_id: 11, date: '2024-08-01', status: 'leave',   clock_in: null,    clock_out: null,    hours_worked: 0,   overtime_hours: 0,   notes: 'Annual leave' },
  { id: 9,  company_id: 1, employee_id: 1,  date: '2024-08-02', status: 'present', clock_in: '07:50', clock_out: '17:10', hours_worked: 8.5, overtime_hours: 0.5, notes: null },
  { id: 10, company_id: 1, employee_id: 4,  date: '2024-08-02', status: 'present', clock_in: '08:02', clock_out: '17:00', hours_worked: 8,   overtime_hours: 0,   notes: null },
  { id: 11, company_id: 1, employee_id: 5,  date: '2024-08-02', status: 'present', clock_in: '07:58', clock_out: '17:00', hours_worked: 8,   overtime_hours: 0,   notes: null },
  { id: 12, company_id: 1, employee_id: 8,  date: '2024-08-02', status: 'half_day', clock_in: '08:00', clock_out: '12:00', hours_worked: 4,   overtime_hours: 0,   notes: 'Sick — went home early' },
];

// ─── Till Devices (POS) ──────────────────────────────────────────────────────
const tills = [
  { id: 1, company_id: 1, till_name: 'Till 1 - Main', location: 'Front Counter', is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
  { id: 2, company_id: 1, till_name: 'Till 2 - Express', location: 'Express Lane', is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
];

// ─── Till Sessions (POS) ─────────────────────────────────────────────────────
const tillSessions = [
  { id: 1, company_id: 1, till_id: 1, cashier_id: 1, opening_amount: 500, closing_amount: null, expected_amount: null, difference: null, status: 'open', opened_at: new Date().toISOString(), closed_at: null, notes: null, created_at: new Date().toISOString() },
];

// ─── Daily Discounts (POS) ───────────────────────────────────────────────────
const dailyDiscounts = [];

// ─── POS Settings ────────────────────────────────────────────────────────────
const posSettings = [
  { id: 1, company_id: 1, receipt_header: 'The Infinite Legacy (Pty) Ltd', receipt_footer: 'Thank you for your purchase!', vat_number: '9876543210', default_vat_rate: 15, currency: 'ZAR', allow_negative_stock: false, require_customer: false, auto_print_receipt: true, low_stock_threshold: 10, created_at: '2024-01-20T00:00:00.000Z' },
];

// ─── Receipt Settings (POS) ──────────────────────────────────────────────────
const receiptSettings = [
  { id: 1, company_id: 1, paper_size: '80mm', show_logo: true, show_vat_breakdown: true, show_barcode: true, header_text: 'The Infinite Legacy', footer_text: 'Thank you for your purchase!', created_at: '2024-01-20T00:00:00.000Z' },
];

// ─── Printers (POS) ──────────────────────────────────────────────────────────
const printers = [
  { id: 1, company_id: 1, name: 'Main Receipt Printer', type: 'thermal', connection: 'usb', ip_address: null, port: null, is_default: true, is_active: true, created_at: '2024-01-20T00:00:00.000Z' },
];

// ─── Leave Records (Payroll) ─────────────────────────────────────────────────
const leaveRecords = [
  { id: 1, company_id: 1, employee_id: 11, leave_type: 'annual', start_date: '2024-08-01', end_date: '2024-08-05', days: 5, status: 'approved', notes: 'Annual leave', created_at: '2024-07-25T00:00:00.000Z' },
  { id: 2, company_id: 1, employee_id: 8,  leave_type: 'sick', start_date: '2024-08-02', end_date: '2024-08-02', days: 0.5, status: 'approved', notes: 'Sick half day', created_at: '2024-08-02T12:00:00.000Z' },
];

// ─── Employee Notes (Payroll) ────────────────────────────────────────────────
const employeeNotes = [
  { id: 1, company_id: 1, employee_id: 1, note: 'Salary review scheduled for September', created_by: 2, created_at: '2024-07-15T00:00:00.000Z' },
  { id: 2, company_id: 1, employee_id: 5, note: 'Warning issued for late attendance', created_by: 2, created_at: '2024-07-20T00:00:00.000Z' },
];

// ─── Historical Records (Payroll) ────────────────────────────────────────────
const historicalRecords = [];
const historicalImportLog = [];

// ─── Narratives (Payroll) ────────────────────────────────────────────────────
const narratives = [];

// ─── Payroll Runs ────────────────────────────────────────────────────────────
const payrollRuns = [
  { id: 1, company_id: 1, period_id: 1, run_date: '2024-06-20', status: 'completed', total_gross: 46500, total_net: 40702, total_paye: 4833, total_uif_ee: 392.12, total_uif_er: 392.12, employee_count: 3, created_by: 2, created_at: '2024-06-20T00:00:00.000Z' },
];

// ─── Audit Log ───────────────────────────────────────────────────────────────
const auditLog = [
  { id: 1, company_id: 1, user_id: 1, user_email: 'pos@test.com', module: 'pos', action_type: 'CREATE', entity_type: 'sale', entity_id: '1', field_name: null, old_value: null, new_value: '{"receipt_number":"RC-20240601-A1B2","total_amount":59.96}', ip_address: '127.0.0.1', user_agent: 'Mozilla/5.0', metadata: '{}', created_at: '2024-06-01T09:15:00.000Z' },
  { id: 2, company_id: 1, user_id: 1, user_email: 'pos@test.com', module: 'pos', action_type: 'VOID', entity_type: 'sale', entity_id: '3', field_name: null, old_value: '{"status":"completed","total_amount":129.94}', new_value: '{"status":"voided","void_reason":"Customer changed mind"}', ip_address: '127.0.0.1', user_agent: 'Mozilla/5.0', metadata: '{"receipt_number":"RC-20240602-E5F6","original_amount":129.94,"reason":"Customer changed mind"}', created_at: '2024-06-02T11:00:00.000Z' },
  { id: 3, company_id: 1, user_id: 2, user_email: 'payroll@test.com', module: 'payroll', action_type: 'CREATE', entity_type: 'payroll_period', entity_id: '3', field_name: null, old_value: null, new_value: '{"period_name":"August 2024","status":"draft"}', ip_address: '127.0.0.1', user_agent: 'Mozilla/5.0', metadata: '{}', created_at: '2024-08-01T08:00:00.000Z' },
];

// ─── ACCOUNTING MODULE — Chart of Accounts ───────────────────────────────────
const chartOfAccounts = [
  // ASSETS (1000-1999)
  { id: 1,  company_id: 1, account_number: '1000', account_name: 'Bank - FNB Current Account',  account_type: 'Asset',     sub_type: 'Current Asset',     is_active: true, is_system: true,  opening_balance: 125000.00, current_balance: 148532.50, description: 'Primary business bank account', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 2,  company_id: 1, account_number: '1010', account_name: 'Petty Cash',                  account_type: 'Asset',     sub_type: 'Current Asset',     is_active: true, is_system: false, opening_balance: 2000.00,   current_balance: 1450.00,   description: 'Petty cash float', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 3,  company_id: 1, account_number: '1100', account_name: 'Trade Debtors (Accounts Receivable)', account_type: 'Asset', sub_type: 'Current Asset', is_active: true, is_system: true,  opening_balance: 45000.00,  current_balance: 67250.00,  description: 'Money owed by customers', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 4,  company_id: 1, account_number: '1200', account_name: 'Inventory',                   account_type: 'Asset',     sub_type: 'Current Asset',     is_active: true, is_system: true,  opening_balance: 85000.00,  current_balance: 92300.00,  description: 'Stock on hand', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 5,  company_id: 1, account_number: '1300', account_name: 'VAT Input (SARS)',             account_type: 'Asset',     sub_type: 'Current Asset',     is_active: true, is_system: true,  opening_balance: 0,         current_balance: 12475.00,  description: 'VAT paid on purchases', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 6,  company_id: 1, account_number: '1500', account_name: 'Equipment',                   account_type: 'Asset',     sub_type: 'Non-Current Asset', is_active: true, is_system: false, opening_balance: 65000.00,  current_balance: 65000.00,  description: 'Office & shop equipment', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 7,  company_id: 1, account_number: '1510', account_name: 'Accumulated Depreciation',    account_type: 'Asset',     sub_type: 'Non-Current Asset', is_active: true, is_system: true,  opening_balance: -15000.00, current_balance: -21500.00, description: 'Accumulated depreciation on assets', created_at: '2024-01-01T00:00:00.000Z' },
  // LIABILITIES (2000-2999)
  { id: 8,  company_id: 1, account_number: '2000', account_name: 'Trade Creditors (Accounts Payable)', account_type: 'Liability', sub_type: 'Current Liability', is_active: true, is_system: true,  opening_balance: 35000.00,  current_balance: 42800.00,  description: 'Money owed to suppliers', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 9,  company_id: 1, account_number: '2100', account_name: 'VAT Output (SARS)',           account_type: 'Liability', sub_type: 'Current Liability', is_active: true, is_system: true,  opening_balance: 0,         current_balance: 18750.00,  description: 'VAT collected on sales', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 10, company_id: 1, account_number: '2200', account_name: 'PAYE Payable',                account_type: 'Liability', sub_type: 'Current Liability', is_active: true, is_system: true,  opening_balance: 0,         current_balance: 8450.00,   description: 'PAYE tax owed to SARS', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 11, company_id: 1, account_number: '2210', account_name: 'UIF Payable',                 account_type: 'Liability', sub_type: 'Current Liability', is_active: true, is_system: true,  opening_balance: 0,         current_balance: 1250.00,   description: 'UIF contributions owed', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 12, company_id: 1, account_number: '2300', account_name: 'Loan - Business Vehicle',     account_type: 'Liability', sub_type: 'Non-Current Liability', is_active: true, is_system: false, opening_balance: 180000.00, current_balance: 165000.00, description: 'Vehicle finance', created_at: '2024-01-01T00:00:00.000Z' },
  // EQUITY (3000-3999)
  { id: 13, company_id: 1, account_number: '3000', account_name: 'Owner\'s Equity / Capital',   account_type: 'Equity',    sub_type: 'Equity',            is_active: true, is_system: true,  opening_balance: 200000.00, current_balance: 200000.00, description: 'Owner capital contribution', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 14, company_id: 1, account_number: '3100', account_name: 'Retained Earnings',           account_type: 'Equity',    sub_type: 'Equity',            is_active: true, is_system: true,  opening_balance: 52000.00,  current_balance: 52000.00,  description: 'Accumulated profits', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 15, company_id: 1, account_number: '3200', account_name: 'Drawings',                    account_type: 'Equity',    sub_type: 'Equity',            is_active: true, is_system: false, opening_balance: 0,         current_balance: -15000.00, description: 'Owner withdrawals', created_at: '2024-01-01T00:00:00.000Z' },
  // INCOME (4000-4999)
  { id: 16, company_id: 1, account_number: '4000', account_name: 'Sales Revenue',               account_type: 'Income',    sub_type: 'Revenue',           is_active: true, is_system: true,  opening_balance: 0,         current_balance: 425000.00, description: 'Product and service sales', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 17, company_id: 1, account_number: '4100', account_name: 'Service Revenue',             account_type: 'Income',    sub_type: 'Revenue',           is_active: true, is_system: false, opening_balance: 0,         current_balance: 35000.00,  description: 'Service income', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 18, company_id: 1, account_number: '4200', account_name: 'Interest Received',           account_type: 'Income',    sub_type: 'Other Income',      is_active: true, is_system: false, opening_balance: 0,         current_balance: 1250.00,   description: 'Bank interest earned', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 19, company_id: 1, account_number: '4300', account_name: 'Discount Received',           account_type: 'Income',    sub_type: 'Other Income',      is_active: true, is_system: false, opening_balance: 0,         current_balance: 3200.00,   description: 'Settlement discounts from suppliers', created_at: '2024-01-01T00:00:00.000Z' },
  // EXPENSES (5000-5999)
  { id: 20, company_id: 1, account_number: '5000', account_name: 'Cost of Sales',               account_type: 'Expense',   sub_type: 'Cost of Sales',     is_active: true, is_system: true,  opening_balance: 0,         current_balance: 212500.00, description: 'Direct cost of goods sold', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 21, company_id: 1, account_number: '5100', account_name: 'Salaries & Wages',            account_type: 'Expense',   sub_type: 'Operating Expense', is_active: true, is_system: true,  opening_balance: 0,         current_balance: 95000.00,  description: 'Employee remuneration', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 22, company_id: 1, account_number: '5200', account_name: 'Rent',                        account_type: 'Expense',   sub_type: 'Operating Expense', is_active: true, is_system: false, opening_balance: 0,         current_balance: 48000.00,  description: 'Premises rental', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 23, company_id: 1, account_number: '5300', account_name: 'Electricity & Water',         account_type: 'Expense',   sub_type: 'Operating Expense', is_active: true, is_system: false, opening_balance: 0,         current_balance: 18500.00,  description: 'Municipal charges', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 24, company_id: 1, account_number: '5400', account_name: 'Telephone & Internet',        account_type: 'Expense',   sub_type: 'Operating Expense', is_active: true, is_system: false, opening_balance: 0,         current_balance: 7200.00,   description: 'Communication costs', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 25, company_id: 1, account_number: '5500', account_name: 'Insurance',                   account_type: 'Expense',   sub_type: 'Operating Expense', is_active: true, is_system: false, opening_balance: 0,         current_balance: 12000.00,  description: 'Business insurance premiums', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 26, company_id: 1, account_number: '5600', account_name: 'Depreciation',                account_type: 'Expense',   sub_type: 'Operating Expense', is_active: true, is_system: true,  opening_balance: 0,         current_balance: 6500.00,   description: 'Asset depreciation', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 27, company_id: 1, account_number: '5700', account_name: 'Motor Vehicle Expenses',      account_type: 'Expense',   sub_type: 'Operating Expense', is_active: true, is_system: false, opening_balance: 0,         current_balance: 14800.00,  description: 'Fuel, maintenance, licensing', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 28, company_id: 1, account_number: '5800', account_name: 'Stationery & Office Supplies', account_type: 'Expense',  sub_type: 'Operating Expense', is_active: true, is_system: false, opening_balance: 0,         current_balance: 3500.00,   description: 'Office consumables', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 29, company_id: 1, account_number: '5900', account_name: 'Bank Charges',                account_type: 'Expense',   sub_type: 'Operating Expense', is_active: true, is_system: false, opening_balance: 0,         current_balance: 2800.00,   description: 'Bank fees and charges', created_at: '2024-01-01T00:00:00.000Z' },
  { id: 30, company_id: 1, account_number: '5950', account_name: 'Interest Paid',               account_type: 'Expense',   sub_type: 'Finance Cost',      is_active: true, is_system: false, opening_balance: 0,         current_balance: 9600.00,   description: 'Loan interest expenses', created_at: '2024-01-01T00:00:00.000Z' },
];

// ─── ACCOUNTING MODULE — Financial Periods ───────────────────────────────────
const financialPeriods = [
  { id: 1, company_id: 1, period_name: 'March 2024',    year: 2024, month: 3,  start_date: '2024-03-01', end_date: '2024-03-31', status: 'closed',  closed_by: 3, closed_at: '2024-04-05T10:00:00.000Z', created_at: '2024-03-01T00:00:00.000Z' },
  { id: 2, company_id: 1, period_name: 'April 2024',    year: 2024, month: 4,  start_date: '2024-04-01', end_date: '2024-04-30', status: 'closed',  closed_by: 3, closed_at: '2024-05-05T10:00:00.000Z', created_at: '2024-04-01T00:00:00.000Z' },
  { id: 3, company_id: 1, period_name: 'May 2024',      year: 2024, month: 5,  start_date: '2024-05-01', end_date: '2024-05-31', status: 'closed',  closed_by: 3, closed_at: '2024-06-05T10:00:00.000Z', created_at: '2024-05-01T00:00:00.000Z' },
  { id: 4, company_id: 1, period_name: 'June 2024',     year: 2024, month: 6,  start_date: '2024-06-01', end_date: '2024-06-30', status: 'closed',  closed_by: 3, closed_at: '2024-07-05T10:00:00.000Z', created_at: '2024-06-01T00:00:00.000Z' },
  { id: 5, company_id: 1, period_name: 'July 2024',     year: 2024, month: 7,  start_date: '2024-07-01', end_date: '2024-07-31', status: 'closed',  closed_by: 3, closed_at: '2024-08-05T10:00:00.000Z', created_at: '2024-07-01T00:00:00.000Z' },
  { id: 6, company_id: 1, period_name: 'August 2024',   year: 2024, month: 8,  start_date: '2024-08-01', end_date: '2024-08-31', status: 'open',    closed_by: null, closed_at: null, created_at: '2024-08-01T00:00:00.000Z' },
];

// ─── ACCOUNTING MODULE — Journal Entries ─────────────────────────────────────
const journalEntries = [
  { id: 1, company_id: 1, journal_number: 'JNL-2024-001', date: '2024-06-30', description: 'Monthly rent payment',          status: 'posted', type: 'general', reference: 'INV-5532',  created_by: 3, posted_by: 3, posted_at: '2024-06-30T10:00:00.000Z', period_id: 4, created_at: '2024-06-30T09:00:00.000Z' },
  { id: 2, company_id: 1, journal_number: 'JNL-2024-002', date: '2024-06-30', description: 'June salaries accrual',         status: 'posted', type: 'general', reference: 'PAY-JUN24', created_by: 3, posted_by: 3, posted_at: '2024-06-30T11:00:00.000Z', period_id: 4, created_at: '2024-06-30T10:30:00.000Z' },
  { id: 3, company_id: 1, journal_number: 'JNL-2024-003', date: '2024-07-15', description: 'Inventory purchase - Makro',    status: 'posted', type: 'general', reference: 'PO-1023',   created_by: 3, posted_by: 3, posted_at: '2024-07-15T14:00:00.000Z', period_id: 5, created_at: '2024-07-15T13:00:00.000Z' },
  { id: 4, company_id: 1, journal_number: 'JNL-2024-004', date: '2024-07-31', description: 'Monthly depreciation',          status: 'posted', type: 'general', reference: 'AUTO-DEP',  created_by: 3, posted_by: 3, posted_at: '2024-07-31T16:00:00.000Z', period_id: 5, created_at: '2024-07-31T15:30:00.000Z' },
  { id: 5, company_id: 1, journal_number: 'JNL-2024-005', date: '2024-08-01', description: 'Opening petty cash replenish',  status: 'posted', type: 'general', reference: 'PC-AUG01', created_by: 3, posted_by: 3, posted_at: '2024-08-01T08:30:00.000Z', period_id: 6, created_at: '2024-08-01T08:00:00.000Z' },
  { id: 6, company_id: 1, journal_number: 'JNL-2024-006', date: '2024-08-10', description: 'Customer invoice - ABC Trading', status: 'draft', type: 'general', reference: 'SI-1055',  created_by: 3, posted_by: null, posted_at: null, period_id: 6, created_at: '2024-08-10T09:00:00.000Z' },
  { id: 7, company_id: 1, journal_number: 'JNL-2024-007', date: '2024-08-15', description: 'Insurance premium payment',    status: 'draft',  type: 'general', reference: 'DD-INS-08', created_by: 3, posted_by: null, posted_at: null, period_id: 6, created_at: '2024-08-15T10:00:00.000Z' },
];

// ─── ACCOUNTING MODULE — Journal Lines (Double-Entry) ────────────────────────
const journalLines = [
  // JNL-001: Rent R8,000
  { id: 1,  journal_id: 1, account_id: 22, debit: 8000.00, credit: 0,       description: 'Rent expense' },
  { id: 2,  journal_id: 1, account_id: 1,  debit: 0,       credit: 8000.00, description: 'Paid from bank' },
  // JNL-002: Salaries R15,833.33
  { id: 3,  journal_id: 2, account_id: 21, debit: 15833.33, credit: 0,        description: 'Gross salaries' },
  { id: 4,  journal_id: 2, account_id: 10, debit: 0,        credit: 1408.33,  description: 'PAYE withheld' },
  { id: 5,  journal_id: 2, account_id: 11, debit: 0,        credit: 158.33,   description: 'UIF contribution' },
  { id: 6,  journal_id: 2, account_id: 1,  debit: 0,        credit: 14266.67, description: 'Net pay to bank' },
  // JNL-003: Inventory purchase R23,000 incl VAT
  { id: 7,  journal_id: 3, account_id: 4,  debit: 20000.00, credit: 0,        description: 'Inventory stock' },
  { id: 8,  journal_id: 3, account_id: 5,  debit: 3000.00,  credit: 0,        description: 'VAT input 15%' },
  { id: 9,  journal_id: 3, account_id: 8,  debit: 0,        credit: 23000.00, description: 'Owed to Makro' },
  // JNL-004: Depreciation R812.50
  { id: 10, journal_id: 4, account_id: 26, debit: 812.50,  credit: 0,       description: 'Depreciation expense' },
  { id: 11, journal_id: 4, account_id: 7,  debit: 0,       credit: 812.50,  description: 'Accum. depreciation' },
  // JNL-005: Petty cash R500
  { id: 12, journal_id: 5, account_id: 2,  debit: 500.00,  credit: 0,       description: 'Petty cash top-up' },
  { id: 13, journal_id: 5, account_id: 1,  debit: 0,       credit: 500.00,  description: 'From bank account' },
  // JNL-006: Customer invoice R28,750 incl VAT (draft)
  { id: 14, journal_id: 6, account_id: 3,  debit: 28750.00, credit: 0,        description: 'Debtors - ABC Trading' },
  { id: 15, journal_id: 6, account_id: 16, debit: 0,        credit: 25000.00, description: 'Sales revenue' },
  { id: 16, journal_id: 6, account_id: 9,  debit: 0,        credit: 3750.00,  description: 'VAT output 15%' },
  // JNL-007: Insurance R2,000 (draft)
  { id: 17, journal_id: 7, account_id: 25, debit: 2000.00, credit: 0,       description: 'Insurance premium' },
  { id: 18, journal_id: 7, account_id: 1,  debit: 0,       credit: 2000.00, description: 'Paid from bank' },
];

// ─── ACCOUNTING MODULE — Bank Accounts ───────────────────────────────────────
const bankAccounts = [
  { id: 1, company_id: 1, bank_name: 'First National Bank',     account_name: 'FNB Business Current',   account_number: '62845901234', branch_code: '250655', account_type: 'current',  linked_account_id: 1,  is_active: true, last_reconciled_date: '2024-07-31', last_reconciled_balance: 148532.50, created_at: '2024-01-01T00:00:00.000Z' },
  { id: 2, company_id: 1, bank_name: 'First National Bank',     account_name: 'FNB Savings',             account_number: '62845905678', branch_code: '250655', account_type: 'savings',  linked_account_id: null, is_active: true, last_reconciled_date: '2024-07-31', last_reconciled_balance: 50000.00, created_at: '2024-03-01T00:00:00.000Z' },
];

// ─── ACCOUNTING MODULE — Bank Transactions ───────────────────────────────────
const bankTransactions = [
  { id: 1,  bank_account_id: 1, company_id: 1, date: '2024-08-01', description: 'PETTY CASH WITHDRAWAL',        amount: -500.00,    balance: 148032.50, reference: 'ATM-001', type: 'debit',  is_reconciled: true,  allocated_account_id: 2,  journal_id: 5, created_at: '2024-08-01T08:00:00.000Z' },
  { id: 2,  bank_account_id: 1, company_id: 1, date: '2024-08-02', description: 'DEBIT ORDER - INSURANCE',       amount: -2000.00,   balance: 146032.50, reference: 'DD-INS',  type: 'debit',  is_reconciled: false, allocated_account_id: 25, journal_id: null, created_at: '2024-08-02T06:00:00.000Z' },
  { id: 3,  bank_account_id: 1, company_id: 1, date: '2024-08-03', description: 'POS DAILY TAKINGS',            amount: 15420.00,   balance: 161452.50, reference: 'POS-0803', type: 'credit', is_reconciled: false, allocated_account_id: 16, journal_id: null, created_at: '2024-08-03T17:00:00.000Z' },
  { id: 4,  bank_account_id: 1, company_id: 1, date: '2024-08-05', description: 'PAYMENT - MAKRO SUPPLIES',      amount: -8625.00,   balance: 152827.50, reference: 'EFT-1023', type: 'debit',  is_reconciled: false, allocated_account_id: 8,  journal_id: null, created_at: '2024-08-05T10:00:00.000Z' },
  { id: 5,  bank_account_id: 1, company_id: 1, date: '2024-08-07', description: 'EFT RECEIVED - ABC TRADING',    amount: 28750.00,   balance: 181577.50, reference: 'EFT-IN',  type: 'credit', is_reconciled: false, allocated_account_id: 3,  journal_id: null, created_at: '2024-08-07T09:00:00.000Z' },
  { id: 6,  bank_account_id: 1, company_id: 1, date: '2024-08-10', description: 'TELKOM - INTERNET',            amount: -899.00,    balance: 180678.50, reference: 'DD-TEL',  type: 'debit',  is_reconciled: false, allocated_account_id: 24, journal_id: null, created_at: '2024-08-10T06:00:00.000Z' },
  { id: 7,  bank_account_id: 1, company_id: 1, date: '2024-08-12', description: 'CITY OF CPT - RATES',          amount: -3250.00,   balance: 177428.50, reference: 'DD-MUN',  type: 'debit',  is_reconciled: false, allocated_account_id: 23, journal_id: null, created_at: '2024-08-12T06:00:00.000Z' },
  { id: 8,  bank_account_id: 1, company_id: 1, date: '2024-08-14', description: 'FNB SERVICE FEE',              amount: -185.50,    balance: 177243.00, reference: 'BANK-FEE', type: 'debit', is_reconciled: false, allocated_account_id: 29, journal_id: null, created_at: '2024-08-14T00:00:00.000Z' },
  { id: 9,  bank_account_id: 1, company_id: 1, date: '2024-08-15', description: 'POS DAILY TAKINGS',            amount: 12850.00,   balance: 190093.00, reference: 'POS-0815', type: 'credit', is_reconciled: false, allocated_account_id: 16, journal_id: null, created_at: '2024-08-15T17:00:00.000Z' },
  { id: 10, bank_account_id: 1, company_id: 1, date: '2024-08-15', description: 'SALARY PAYMENTS - AUG',        amount: -42500.00,  balance: 147593.00, reference: 'SAL-AUG', type: 'debit',  is_reconciled: false, allocated_account_id: 21, journal_id: null, created_at: '2024-08-15T14:00:00.000Z' },
];

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Initialize mock data — must be called once at server start
 */
async function initMockData() {
  console.log('\n🎭 Initializing MOCK DATA mode...');
  await initPasswords();
  
  // Set password hashes on users
  users[0].password_hash = passwordHashes['pos123'];
  users[1].password_hash = passwordHashes['payroll123'];
  users[2].password_hash = passwordHashes['admin123'];
  users[3].password_hash = passwordHashes['Mindmaster@277477'];

  console.log('  📦 Mock data loaded:');
  console.log(`     Companies:    ${companies.length}`);
  console.log(`     Users:        ${users.length}`);
  console.log(`     Employees:    ${employees.length}`);
  console.log(`     Products:     ${products.length}`);
  console.log(`     Categories:   ${categories.length}`);
  console.log(`     Customers:    ${customers.length}`);
  console.log(`     Sales:        ${sales.length}`);
  console.log(`     Pay Periods:  ${payrollPeriods.length}`);
  console.log(`     Payslips:     ${payrollTransactions.length}`);
  console.log(`     Attendance:   ${attendance.length}`);
  console.log(`     Payroll Items: ${payrollItemsMaster.length}`);
  console.log(`     Tills:        ${tills.length}`);
  console.log(`     Sessions:     ${tillSessions.length}`);
  console.log(`     Leave Recs:   ${leaveRecords.length}`);
  console.log(`     Payroll Runs: ${payrollRuns.length}`);
  console.log(`     Audit Entries: ${auditLog.length}`);
  console.log(`     Accounts (COA): ${chartOfAccounts.length}`);
  console.log(`     Journals:      ${journalEntries.length}`);
  console.log(`     Journal Lines: ${journalLines.length}`);
  console.log(`     Bank Accounts: ${bankAccounts.length}`);
  console.log(`     Bank Txns:     ${bankTransactions.length}`);
  console.log(`     Fin. Periods:  ${financialPeriods.length}`);
  console.log('  ✅ Mock data ready\n');
}

/**
 * Mock audit logger — stores in-memory instead of Supabase
 */
function mockAuditLog(entry) {
  const record = {
    id: nextId(),
    company_id: entry.companyId || null,
    user_id: entry.userId || null,
    user_email: entry.userEmail || 'system',
    module: entry.module || 'shared',
    action_type: entry.actionType,
    entity_type: entry.entityType,
    entity_id: entry.entityId != null ? String(entry.entityId) : null,
    field_name: entry.fieldName || null,
    old_value: entry.oldValue ? JSON.stringify(entry.oldValue) : null,
    new_value: entry.newValue ? JSON.stringify(entry.newValue) : null,
    ip_address: entry.ipAddress || '127.0.0.1',
    user_agent: entry.userAgent || null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    created_at: new Date().toISOString(),
  };
  auditLog.push(record);
  if (process.env.MOCK_LOG_AUDIT === 'true') {
    console.log(`  📋 AUDIT: ${record.action_type} ${record.entity_type} #${record.entity_id} by ${record.user_email}`);
  }
  return record;
}

/**
 * Mock audit from request — drop-in replacement for auditFromReq
 */
function mockAuditFromReq(req, actionType, entityType, entityId, extra = {}) {
  return mockAuditLog({
    companyId: req.companyId || (req.user && req.user.companyId) || null,
    userId: (req.user && req.user.userId) || null,
    userEmail: (req.user && req.user.email) || (req.user && req.user.username) || 'system',
    module: extra.module || 'shared',
    actionType, entityType, entityId,
    fieldName: extra.fieldName || null,
    oldValue: extra.oldValue || null,
    newValue: extra.newValue || null,
    ipAddress: req.ip || '127.0.0.1',
    userAgent: req.headers ? req.headers['user-agent'] : null,
    metadata: extra.metadata || {},
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  // Init
  initMockData,
  nextId,

  // Data collections (mutable)
  companies,
  users,
  userCompanyAccess,
  categories,
  products,
  customers,
  sales,
  saleItems,
  salePayments,
  inventoryAdjustments,
  employees,
  employeeBankDetails,
  payrollItemsMaster,
  payrollPeriods,
  payrollTransactions,
  payslipItems,
  attendance,
  auditLog,

  // POS extras
  tills,
  tillSessions,
  dailyDiscounts,
  posSettings,
  receiptSettings,
  printers,

  // Payroll extras
  leaveRecords,
  employeeNotes,
  historicalRecords,
  historicalImportLog,
  narratives,
  payrollRuns,

  // Accounting module
  chartOfAccounts,
  financialPeriods,
  journalEntries,
  journalLines,
  bankAccounts,
  bankTransactions,

  // Mock audit
  mockAuditLog,
  mockAuditFromReq,

  // Ecosystem clients (cross-app)
  ecoClients,
};
