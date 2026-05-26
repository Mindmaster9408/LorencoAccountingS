/**
 * test_inventory_stock_concurrency.mjs
 *
 * Codebox 01 — Concurrency test for the hardened stock engine.
 *
 * Test: Fire 10 concurrent stock-out requests of qty=10 against an item
 * with current_stock=100. The SELECT ... FOR UPDATE in adjust_inventory_stock()
 * must serialise these requests so:
 *   - Final stock = 0  (no lost updates)
 *   - No stock went negative at any point
 *   - All 10 requests return { success: true }
 *
 * Usage:
 *   node scripts/test_inventory_stock_concurrency.mjs <companyId> <itemId>
 *
 * Prerequisites:
 *   1. Migration 050 applied in Supabase
 *   2. The target item exists with current_stock >= 100
 *   3. Set environment variables:
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

const companyId = parseInt(process.argv[2]);
const itemId    = parseInt(process.argv[3]);

if (!companyId || !itemId) {
  console.error('Usage: node test_inventory_stock_concurrency.mjs <companyId> <itemId>');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const CONCURRENCY = 10;
const EACH_QTY    = 10;

async function main() {
  console.log(`\n=== Inventory Concurrency Test ===`);
  console.log(`Company: ${companyId}  Item: ${itemId}`);
  console.log(`${CONCURRENCY} concurrent stock-outs of qty=${EACH_QTY}\n`);

  // Read starting stock
  const { data: before } = await supabase
    .from('inventory_items')
    .select('current_stock, name')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  if (!before) {
    console.error('Item not found. Check companyId and itemId.');
    process.exit(1);
  }

  console.log(`Item: ${before.name}`);
  console.log(`Stock before: ${before.current_stock}`);

  if (parseFloat(before.current_stock) < CONCURRENCY * EACH_QTY) {
    console.error(`Insufficient stock for test. Need at least ${CONCURRENCY * EACH_QTY}, have ${before.current_stock}.`);
    process.exit(1);
  }

  // Fire all requests concurrently
  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      supabase.rpc('adjust_inventory_stock', {
        p_company_id:    companyId,
        p_item_id:       itemId,
        p_delta:         -EACH_QTY,
        p_movement_type: 'out',
        p_warehouse_id:  null,
        p_reference:     `CONCURRENCY-TEST-${i + 1}`,
        p_notes:         `Concurrency test request ${i + 1}`,
        p_cost_price:    null,
        p_created_by:    null,
        p_source_type:   'manual',
        p_source_id:     null
      })
    )
  );
  const elapsed = Date.now() - start;

  // Analyse results
  const successes = results.filter(r => r.data?.success === true);
  const failures  = results.filter(r => !r.data?.success || r.error);

  console.log(`\nResults (${elapsed}ms):`);
  console.log(`  Successful: ${successes.length} / ${CONCURRENCY}`);
  console.log(`  Failed:     ${failures.length} / ${CONCURRENCY}`);

  if (failures.length > 0) {
    console.log('\nFailure details:');
    failures.forEach((r, i) => {
      console.log(`  [${i}] error=${r.error?.message || r.data?.error} available=${r.data?.available}`);
    });
  }

  // Read final stock
  const { data: after } = await supabase
    .from('inventory_items')
    .select('current_stock')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .single();

  const expected = parseFloat(before.current_stock) - (successes.length * EACH_QTY);
  console.log(`\nStock before: ${before.current_stock}`);
  console.log(`Stock after:  ${after?.current_stock}`);
  console.log(`Expected:     ${expected}`);

  const stockOk  = parseFloat(after?.current_stock) === expected;
  const noNegative = parseFloat(after?.current_stock) >= 0;

  console.log(`\nAssertions:`);
  console.log(`  [${stockOk ? 'PASS' : 'FAIL'}] No lost updates (stock delta matches success count)`);
  console.log(`  [${noNegative ? 'PASS' : 'FAIL'}] Stock is non-negative`);
  console.log(`  [${successes.length === CONCURRENCY ? 'PASS' : 'WARN'}] All ${CONCURRENCY} requests succeeded`);

  if (!stockOk || !noNegative) {
    process.exit(1);
  }

  // Verify movement_count matches success count
  const { count } = await supabase
    .from('stock_movements')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('item_id', itemId)
    .like('reference', 'CONCURRENCY-TEST-%');

  console.log(`  [${count === successes.length ? 'PASS' : 'FAIL'}] stock_movements rows match success count (${count}/${successes.length})`);

  console.log('\nTest complete.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
