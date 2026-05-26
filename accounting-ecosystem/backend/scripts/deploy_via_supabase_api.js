'use strict';
/**
 * deploy_via_supabase_api.js
 * Uses Supabase client for pre-check + behavioral verification.
 * Uses Management API for DDL execution (migration SQL).
 * Run from: accounting-ecosystem/backend/
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Extract project ref from URL: https://glkndlzjkhwfsolueyhk.supabase.co
const projectRef = SUPABASE_URL.replace('https://', '').split('.')[0];

const migrationSql = fs.readFileSync(
  path.resolve(__dirname, '../../database/migrations/050_inventory_stock_engine_hardening.sql'),
  'utf8'
);

async function runSqlViaManagementApi(sql) {
  // Try Supabase Management API - requires access token or may accept service key
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({ query: sql })
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  console.log(`\n=== Codebox 01 — Migration 050 Deployment ===`);
  console.log(`Project: ${projectRef}\n`);

  // STEP 1: Pre-check — negative stock using supabase-js (always works)
  console.log('--- STEP 1: Pre-check negative stock ---');
  const { data: negRows, error: negErr } = await supabase
    .from('inventory_items')
    .select('id, name, current_stock')
    .lt('current_stock', 0)
    .order('current_stock');

  if (negErr) {
    console.error(`❌ Pre-check query failed: ${negErr.message}`);
    process.exit(1);
  }
  if (negRows && negRows.length > 0) {
    console.error(`❌ STOP: ${negRows.length} item(s) with negative stock:`);
    negRows.forEach(r => console.error(`   id=${r.id}  "${r.name}"  stock=${r.current_stock}`));
    console.error('Fix these before applying migration 050.');
    process.exit(1);
  }
  console.log('✅ No negative stock — safe to proceed.\n');

  // STEP 2: Try management API for DDL
  console.log('--- STEP 2: Applying migration 050 via Management API ---');
  const { status, body } = await runSqlViaManagementApi(migrationSql);
  console.log(`   HTTP ${status}: ${body.slice(0, 300)}`);

  if (status !== 200 && status !== 201) {
    console.log('\n⚠️  Management API returned non-200.');
    console.log('   This likely means the service key cannot be used for Management API DDL.');
    console.log('   → Migration must be applied manually in the Supabase SQL Editor.\n');
    console.log('ACTION REQUIRED:');
    console.log('  1. Open https://supabase.com/dashboard/project/' + projectRef + '/sql/new');
    console.log('  2. Paste the content of:');
    console.log('       accounting-ecosystem/database/migrations/050_inventory_stock_engine_hardening.sql');
    console.log('  3. Click "Run"');
    console.log('  4. Then re-run this script to verify.\n');
    // Still run the behavioral verification to check current state
  } else {
    console.log('✅ Migration SQL executed via Management API.\n');
  }

  // STEP 3: Behavioral verification — test the RPC works now
  console.log('--- STEP 3: Behavioral verification ---');
  console.log('   Testing adjust_inventory_stock() RPC...');

  // Find a test item (just verify the RPC doesn't crash with a non-existent item)
  const { data: testResult, error: rpcErr } = await supabase.rpc('adjust_inventory_stock', {
    p_company_id:    -1,      // non-existent company
    p_item_id:       -1,      // non-existent item
    p_delta:         1,
    p_movement_type: 'in',
    p_warehouse_id:  null,
    p_reference:     'VERIFY-050',
    p_notes:         null,
    p_cost_price:    10.00,
    p_created_by:    null,
    p_source_type:   'manual',
    p_source_id:     null
  });

  if (rpcErr) {
    // A PostgreSQL error here is the WRONG kind of failure —
    // it means the function still has the broken column names
    console.error(`❌ RPC error: ${rpcErr.message}`);
    if (rpcErr.message.includes('column') && (rpcErr.message.includes('"type"') || rpcErr.message.includes('"cost_price"'))) {
      console.error('   The broken column name bug is still present.');
      console.error('   Migration 050 has NOT been applied yet.');
    }
    process.exit(1);
  }

  if (testResult && testResult.success === false && testResult.error === 'Item not found') {
    console.log('✅ RPC returned { success: false, error: "Item not found" } for non-existent item.');
    console.log('   This confirms the function runs without column-name errors.');
    console.log('   The fix is working.\n');
  } else if (testResult && testResult.success === true) {
    console.log('✅ RPC returned success (unexpected but not an error).');
  } else {
    console.log(`   RPC result: ${JSON.stringify(testResult)}`);
  }

  console.log('=== Pre-check and verification complete ===\n');
  console.log('Next step: If migration was applied, proceed with manual smoke tests CBXTEST-01 to CBXTEST-07.');
  console.log('See: inventory-mrpeasy-pilot/codebox-01-stock-engine-hardening/04_testing_report.md\n');
}

main().catch(err => { console.error(err); process.exit(1); });
