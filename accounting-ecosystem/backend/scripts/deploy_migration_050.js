'use strict';
/**
 * deploy_migration_050.js
 * Run from: accounting-ecosystem/backend/
 * Usage:    node scripts/deploy_migration_050.js
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const migrationPath = path.resolve(__dirname, '../../database/migrations/050_inventory_stock_engine_hardening.sql');
const migrationSql  = fs.readFileSync(migrationPath, 'utf8');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set in .env');
  process.exit(1);
}

async function main() {
  console.log('\n=== Codebox 01 — Migration 050 Deployment ===\n');

  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log('✅ Connected to database.');
  } catch (err) {
    console.error(`❌ Connection failed: ${err.message}`);
    console.error('   Cannot reach DATABASE_URL. Migration must be applied manually in Supabase SQL Editor.');
    process.exit(1);
  }

  try {
    // STEP 1: Verify correct database (must have inventory_items)
    const { rows: tableCheck } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'inventory_items'
    `);
    if (tableCheck.length === 0) {
      console.error('❌ inventory_items not found — DATABASE_URL does not point to the inventory database.');
      console.error('   Apply migration 050 manually in the Supabase SQL Editor.');
      await client.end();
      process.exit(1);
    }
    console.log('✅ inventory_items found — correct database.\n');

    // STEP 2: Pre-check — negative stock
    console.log('--- PRE-CHECK: negative stock ---');
    const { rows: neg } = await client.query(
      `SELECT id, name, current_stock FROM inventory_items WHERE current_stock < 0 ORDER BY current_stock`
    );
    if (neg.length > 0) {
      console.error(`❌ STOP: ${neg.length} item(s) with negative stock:`);
      neg.forEach(r => console.error(`   id=${r.id}  "${r.name}"  stock=${r.current_stock}`));
      console.error('\nFix these rows before applying migration 050.');
      await client.end();
      process.exit(1);
    }
    console.log('✅ No negative stock — safe to proceed.\n');

    // STEP 3: Apply migration
    console.log('--- APPLYING migration 050 ---');
    await client.query(migrationSql);
    console.log('✅ Migration 050 applied.\n');

    // STEP 4: Verify
    console.log('--- VERIFICATION ---');

    const { rows: fn } = await client.query(
      `SELECT prosrc FROM pg_proc WHERE proname = 'adjust_inventory_stock'`
    );
    const body = fn[0]?.prosrc || '';
    const checks = [
      ["Function uses 'movement_type'",          body.includes('movement_type')],
      ["Function uses 'unit_cost'",              body.includes('unit_cost')],
      ["No stale 'type' column in INSERT",       !/,\s*type\s*,/.test(body)],
      ["No stale 'cost_price' column in INSERT", !/,\s*cost_price\s*,/.test(body)],
    ];

    const { rows: con } = await client.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'chk_current_stock_non_negative'`
    );
    checks.push(["chk_current_stock_non_negative validated", con[0]?.convalidated === true]);

    const { rows: idx } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='stock_movements' AND indexname='idx_sm_company_item_created'`
    );
    checks.push(["idx_sm_company_item_created index exists", idx.length > 0]);

    let allPass = true;
    checks.forEach(([label, pass]) => {
      console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}`);
      if (!pass) allPass = false;
    });

    if (!allPass) {
      console.error('\n❌ Verification failed — review migration output above.');
      await client.end();
      process.exit(1);
    }

    console.log('\n✅ All verification checks passed.');
    console.log('=== Migration 050 complete ===\n');

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (err.detail) console.error(`   Detail: ${err.detail}`);
    await client.end();
    process.exit(1);
  }

  await client.end();
}

main();
