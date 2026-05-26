/**
 * deploy_migration_050.mjs
 * Codebox 01 — Pre-check + Migration 050 deployment script
 *
 * Uses DATABASE_URL (direct PostgreSQL) for DDL execution.
 * Supabase JS client cannot run raw DDL — pg client is required.
 *
 * Steps:
 *   1. Connect & verify the database has inventory_items (confirm correct DB)
 *   2. Pre-check: query for negative stock
 *   3. Apply migration 050 SQL
 *   4. Run verification queries
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env manually (dotenv not available as ESM easily)
const envFile = readFileSync(resolve(ROOT, 'accounting-ecosystem/backend/.env'), 'utf8');
const env = Object.fromEntries(
  envFile.split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
    .filter(([k]) => k)
);

const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not found in .env');
  process.exit(1);
}

const migrationSql = readFileSync(
  resolve(ROOT, 'accounting-ecosystem/database/migrations/050_inventory_stock_engine_hardening.sql'),
  'utf8'
);

async function main() {
  console.log('\n=== Codebox 01 — Migration 050 Deployment ===\n');

  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log('✅ Connected to database.');
  } catch (err) {
    console.error(`❌ Database connection failed: ${err.message}`);
    console.error('   This script requires a direct PostgreSQL connection via DATABASE_URL.');
    process.exit(1);
  }

  try {
    // STEP 1: Verify this database has inventory_items
    const { rows: tableCheck } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'inventory_items'
    `);
    if (tableCheck.length === 0) {
      console.error('❌ inventory_items table not found in this database.');
      console.error('   DATABASE_URL does not point to the inventory database.');
      console.error('   You must run migration 050 manually in the Supabase SQL Editor.');
      process.exit(1);
    }
    console.log('✅ inventory_items table found — correct database confirmed.\n');

    // STEP 2: Pre-check — negative stock
    console.log('--- STEP 2: Pre-check — negative stock ---');
    const { rows: negRows } = await client.query(`
      SELECT id, name, current_stock
      FROM inventory_items
      WHERE current_stock < 0
      ORDER BY current_stock ASC
    `);

    if (negRows.length > 0) {
      console.error(`❌ STOP: ${negRows.length} item(s) have negative stock:`);
      negRows.forEach(r => console.error(`   ID=${r.id}  name="${r.name}"  stock=${r.current_stock}`));
      console.error('\nFix these rows before applying migration 050.');
      console.error('The VALIDATE CONSTRAINT step will fail if any row has current_stock < 0.');
      process.exit(1);
    }
    console.log('✅ No negative stock rows found. Safe to proceed.\n');

    // STEP 3: Apply migration 050
    console.log('--- STEP 3: Applying migration 050 ---');
    await client.query(migrationSql);
    console.log('✅ Migration 050 applied successfully.\n');

    // STEP 4: Verify — function body contains correct column names
    console.log('--- STEP 4: Verification ---');

    const { rows: funcRows } = await client.query(`
      SELECT prosrc FROM pg_proc WHERE proname = 'adjust_inventory_stock'
    `);
    if (funcRows.length === 0) {
      console.error('❌ adjust_inventory_stock function not found after migration.');
      process.exit(1);
    }
    const funcBody = funcRows[0].prosrc;
    const hasMovementType = funcBody.includes('movement_type');
    const hasUnitCost     = funcBody.includes('unit_cost');
    const hasBadType      = /,\s*type\s*,/.test(funcBody);
    const hasBadCostPrice = /,\s*cost_price\s*,/.test(funcBody);

    console.log(`  [${hasMovementType ? 'PASS' : 'FAIL'}] Function uses 'movement_type' column name`);
    console.log(`  [${hasUnitCost     ? 'PASS' : 'FAIL'}] Function uses 'unit_cost' column name`);
    console.log(`  [${!hasBadType     ? 'PASS' : 'FAIL'}] No stale 'type' column name in INSERT`);
    console.log(`  [${!hasBadCostPrice? 'PASS' : 'FAIL'}] No stale 'cost_price' column name in INSERT`);

    // Verify constraint is now valid
    const { rows: conRows } = await client.query(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conname = 'chk_current_stock_non_negative'
    `);
    const conValid = conRows[0]?.convalidated === true;
    console.log(`  [${conValid ? 'PASS' : 'FAIL'}] chk_current_stock_non_negative is validated`);

    // Verify new index
    const { rows: idxRows } = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'stock_movements'
        AND indexname = 'idx_sm_company_item_created'
    `);
    console.log(`  [${idxRows.length > 0 ? 'PASS' : 'FAIL'}] idx_sm_company_item_created index exists`);

    const allPass = hasMovementType && hasUnitCost && !hasBadType && !hasBadCostPrice && conValid && idxRows.length > 0;
    if (!allPass) {
      console.error('\n❌ One or more verification checks failed.');
      process.exit(1);
    }

    console.log('\n✅ All verification checks passed.');
    console.log('\n=== Migration 050 deployment complete ===\n');

  } catch (err) {
    console.error(`\n❌ Deployment failed: ${err.message}`);
    if (err.detail) console.error(`   Detail: ${err.detail}`);
    if (err.hint)   console.error(`   Hint: ${err.hint}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
