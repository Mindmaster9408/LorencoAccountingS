/**
 * test_inventory_company_isolation.mjs
 *
 * Codebox 01 — Company isolation test for the hardened stock engine.
 *
 * Test: Attempt to mutate stock for an item that belongs to Company A
 * while passing Company B as the companyId. The RPC must:
 *   - Return { success: false, error: 'Item not found' }
 *   - Leave Company A's stock unchanged
 *   - Leave Company A's stock_movements unchanged
 *
 * Usage:
 *   node scripts/test_inventory_company_isolation.mjs <companyA_id> <itemInA_id> <companyB_id>
 *
 * Prerequisites:
 *   1. Migration 050 applied in Supabase
 *   2. companyA has an inventory item with id=itemInA_id
 *   3. companyB is a different, valid company
 *   4. Set environment variables:
 *      SUPABASE_URL=https://xxx.supabase.co
 *      SUPABASE_SERVICE_KEY=<service_role_key>
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.');
  process.exit(1);
}

const companyA = parseInt(process.argv[2]);
const itemInA  = parseInt(process.argv[3]);
const companyB = parseInt(process.argv[4]);

if (!companyA || !itemInA || !companyB) {
  console.error('Usage: node test_inventory_company_isolation.mjs <companyA_id> <itemInA_id> <companyB_id>');
  process.exit(1);
}
if (companyA === companyB) {
  console.error('companyA and companyB must be different companies.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log('\n=== Inventory Company Isolation Test ===');
  console.log(`Company A: ${companyA}  Company B (attacker): ${companyB}  Item: ${itemInA}\n`);

  // Read Company A's starting stock
  const { data: before } = await supabase
    .from('inventory_items')
    .select('current_stock, name, company_id')
    .eq('id', itemInA)
    .single();

  if (!before) {
    console.error('Item not found.');
    process.exit(1);
  }
  if (before.company_id !== companyA) {
    console.error(`Item ${itemInA} does not belong to company ${companyA} (actual: ${before.company_id})`);
    process.exit(1);
  }

  console.log(`Item: ${before.name} (owned by company ${before.company_id})`);
  console.log(`Stock before: ${before.current_stock}`);

  // Attempt cross-company stock mutation: use companyB as the company context
  const { data, error } = await supabase.rpc('adjust_inventory_stock', {
    p_company_id:    companyB,   // wrong company
    p_item_id:       itemInA,    // item from company A
    p_delta:         -1,
    p_movement_type: 'out',
    p_warehouse_id:  null,
    p_reference:     'ISOLATION-TEST',
    p_notes:         'Cross-company isolation test — must fail',
    p_cost_price:    null,
    p_created_by:    null,
    p_source_type:   'manual',
    p_source_id:     null
  });

  const blocked = !data?.success && (data?.error === 'Item not found' || error);

  console.log(`\nRPC response: ${JSON.stringify(data)}`);
  if (error) console.log(`Transport error: ${error.message}`);

  // Read Company A's stock after the attempted cross-company mutation
  const { data: after } = await supabase
    .from('inventory_items')
    .select('current_stock')
    .eq('id', itemInA)
    .eq('company_id', companyA)
    .single();

  const stockUnchanged = parseFloat(after?.current_stock) === parseFloat(before.current_stock);

  // Confirm no rogue stock_movements row was written for this item
  const { count: rogueCount } = await supabase
    .from('stock_movements')
    .select('*', { count: 'exact', head: true })
    .eq('item_id', itemInA)
    .eq('reference', 'ISOLATION-TEST');

  console.log('\nAssertions:');
  console.log(`  [${blocked ? 'PASS' : 'FAIL'}] Cross-company mutation was rejected`);
  console.log(`  [${stockUnchanged ? 'PASS' : 'FAIL'}] Company A stock unchanged (${before.current_stock} → ${after?.current_stock})`);
  console.log(`  [${rogueCount === 0 ? 'PASS' : 'FAIL'}] No rogue stock_movements row written (count: ${rogueCount})`);

  if (!blocked || !stockUnchanged || rogueCount !== 0) {
    console.error('\nISOLATION BREACH DETECTED.');
    process.exit(1);
  }

  console.log('\nTest complete — company isolation confirmed.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
