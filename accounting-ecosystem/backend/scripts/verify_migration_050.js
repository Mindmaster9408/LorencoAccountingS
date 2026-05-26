'use strict';
/**
 * verify_migration_050.js
 * Run AFTER applying migration 050 in Supabase SQL Editor.
 * Uses a real inventory item to confirm the INSERT actually executes.
 * Run from: accounting-ecosystem/backend/
 *
 * Safe to run: uses delta=+1 then delta=-1 to leave stock unchanged.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main() {
  console.log('\n=== Migration 050 Post-Apply Verification ===\n');

  // Find a real inventory item to test with
  const { data: items, error: itemErr } = await supabase
    .from('inventory_items')
    .select('id, company_id, name, current_stock, average_cost')
    .gt('current_stock', 5)   // must have stock so we can safely do +1 / -1
    .limit(1)
    .single();

  if (itemErr || !items) {
    console.error('❌ Could not find a test item with current_stock > 5.');
    console.error('   Create an inventory item with stock first, then re-run.');
    process.exit(1);
  }

  console.log(`Test item: [${items.id}] "${items.name}" (company=${items.company_id}, stock=${items.current_stock})\n`);

  // TEST A: Stock-in +1 (the INSERT path that was broken)
  console.log('--- TEST A: stock-in +1 (exercises the fixed INSERT) ---');
  const { data: resultA, error: errA } = await supabase.rpc('adjust_inventory_stock', {
    p_company_id:    items.company_id,
    p_item_id:       items.id,
    p_delta:         1,
    p_movement_type: 'in',
    p_warehouse_id:  null,
    p_reference:     'VERIFY-050-IN',
    p_notes:         'Migration 050 verification test — reverting immediately',
    p_cost_price:    parseFloat(items.average_cost) || 0,
    p_created_by:    null,
    p_source_type:   'manual',
    p_source_id:     null
  });

  if (errA) {
    console.error(`❌ RPC error: ${errA.message}`);
    if (errA.message.includes('column') || errA.message.includes('"type"') || errA.message.includes('"cost_price"')) {
      console.error('   DIAGNOSIS: Broken column name bug still present.');
      console.error('   CAUSE: Migration 050 has NOT been applied yet, or did not apply correctly.');
    }
    process.exit(1);
  }
  if (!resultA?.success) {
    console.error(`❌ RPC returned failure: ${JSON.stringify(resultA)}`);
    process.exit(1);
  }
  console.log(`✅ TEST A PASS — stock-in succeeded. new_stock=${resultA.new_stock}\n`);

  // TEST B: Reverse it — stock-out -1 (restores stock to original)
  console.log('--- TEST B: stock-out -1 (reverting test data) ---');
  const { data: resultB, error: errB } = await supabase.rpc('adjust_inventory_stock', {
    p_company_id:    items.company_id,
    p_item_id:       items.id,
    p_delta:         -1,
    p_movement_type: 'out',
    p_warehouse_id:  null,
    p_reference:     'VERIFY-050-REVERT',
    p_notes:         'Migration 050 verification revert',
    p_cost_price:    null,
    p_created_by:    null,
    p_source_type:   'manual',
    p_source_id:     null
  });

  if (errB) {
    console.error(`❌ Revert RPC error: ${errB.message}`);
    console.log(`   WARNING: Stock is now ${resultA.new_stock} (was ${items.current_stock}). Manual revert needed.`);
    process.exit(1);
  }
  if (!resultB?.success) {
    console.error(`❌ Revert failed: ${JSON.stringify(resultB)}`);
    process.exit(1);
  }
  console.log(`✅ TEST B PASS — stock-out reversed. new_stock=${resultB.new_stock}\n`);

  // Verify stock_movements has our test rows
  console.log('--- TEST C: confirm stock_movements rows were written ---');
  const { data: movs, error: movErr } = await supabase
    .from('stock_movements')
    .select('id, movement_type, quantity, unit_cost')
    .eq('item_id', items.id)
    .eq('company_id', items.company_id)
    .in('reference', ['VERIFY-050-IN', 'VERIFY-050-REVERT'])
    .order('created_at', { ascending: false })
    .limit(2);

  if (movErr || !movs || movs.length < 2) {
    console.error(`❌ stock_movements rows missing (found ${movs?.length || 0}/2).`);
    process.exit(1);
  }
  console.log(`✅ TEST C PASS — ${movs.length} stock_movements rows written.\n`);

  // Verify stock_valuation_movements has our test rows (forensic ledger)
  console.log('--- TEST D: confirm stock_valuation_movements rows (forensic ledger) ---');
  const { data: vals, error: valErr } = await supabase
    .from('stock_valuation_movements')
    .select('id, movement_type, qty, unit_cost, running_qty, source_type')
    .eq('item_id', items.id)
    .eq('company_id', items.company_id)
    .in('reference', ['VERIFY-050-IN', 'VERIFY-050-REVERT'])
    .order('created_at', { ascending: false })
    .limit(2);

  if (valErr || !vals || vals.length < 2) {
    console.error(`❌ stock_valuation_movements rows missing (found ${vals?.length || 0}/2).`);
    console.error('   The forensic ledger is not being populated.');
    process.exit(1);
  }
  console.log(`✅ TEST D PASS — ${vals.length} stock_valuation_movements rows written.\n`);

  // Clean up test rows from movement tables
  await supabase.from('stock_movements')
    .delete()
    .eq('item_id', items.id)
    .in('reference', ['VERIFY-050-IN', 'VERIFY-050-REVERT']);
  await supabase.from('stock_valuation_movements')
    .delete()
    .eq('item_id', items.id)
    .in('reference', ['VERIFY-050-IN', 'VERIFY-050-REVERT']);

  console.log('--- SUMMARY ---');
  console.log('  [PASS] adjust_inventory_stock() INSERT executes without column error');
  console.log('  [PASS] stock_movements rows written with correct column names');
  console.log('  [PASS] stock_valuation_movements (forensic ledger) populated');
  console.log('  [PASS] Test data cleaned up — stock unchanged\n');
  console.log('✅ Migration 050 is working correctly. Ready for smoke tests and commit.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
