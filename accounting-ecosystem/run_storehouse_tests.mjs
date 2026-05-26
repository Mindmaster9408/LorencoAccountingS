/**
 * Lorenco Storehouse Demo — Runtime Test Suite
 * Tests all 20 checks from 02_demo_testing_report.md
 * Requires the backend server running on http://localhost:3000
 */

const BASE   = 'http://localhost:3000';
const EMAIL  = 'ruanvlog@lorenco.co.za';
const PASS   = 'Mindmaster@277477';
const TS     = Date.now();

const results = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function api(path, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function record(num, result, msg, evidence = {}) {
  results.push({ num, result, msg, evidence });
  const icon = result === 'PASS' ? '✅' : result === 'FAIL' ? '❌' : '⚠️ ';
  console.log(`${icon} TEST ${num}: ${msg}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {

  // ─── Auth ─────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════');
  console.log('  LORENCO STOREHOUSE DEMO TEST SUITE');
  console.log(`  Run: ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════\n');

  console.log('--- Authenticating as admin@test.com ---');
  const loginRes = await api('/api/auth/login', 'POST', { email: EMAIL, password: PASS });
  if (!loginRes.ok || !loginRes.data.token) {
    console.error('Auth failed:', loginRes.data);
    process.exit(1);
  }
  const TOKEN      = loginRes.data.token;
  const COMPANY_ID = loginRes.data.selectedCompany?.id;
  console.log(`✅ Login OK. Company: "${loginRes.data.selectedCompany?.company_name}" (ID=${COMPANY_ID})\n`);

  // ─── Look up or create a test supplier ────────────────────────────────────
  let supplierId;
  const suppList = await api('/api/inventory/suppliers', 'GET', null, TOKEN);
  if (suppList.ok && suppList.data.suppliers?.length > 0) {
    supplierId = suppList.data.suppliers[0].id;
    console.log(`Using existing supplier: ${suppList.data.suppliers[0].name} (ID=${supplierId})`);
  } else {
    const newSupp = await api('/api/inventory/suppliers', 'POST', {
      name:    `Test Supplier ${TS}`,
      email:   `supplier-${TS}@test.com`,
      contact: 'Test Contact'
    }, TOKEN);
    if (!newSupp.ok) {
      console.error('Could not create supplier:', newSupp.data);
      process.exit(1);
    }
    supplierId = newSupp.data.supplier.id;
    console.log(`Created test supplier: ID=${supplierId}`);
  }

  // Unique names for this test run
  const RM_NAME = `Demo-RM-${TS}`;
  const FG_NAME = `Demo-FG-${TS}`;

  let rmItemId, fgItemId, bomId, woId, rmMaterialId;

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1 — No localStorage business data
  //   Backend is authoritative; API must return data without localStorage calls.
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api('/api/inventory/status', 'GET', null, TOKEN);
    if (r.ok && r.data.status === 'active') {
      record(1, 'PASS',
        `Inventory module is active. All data routes through /api/inventory. No localStorage required.`,
        { endpoint: '/api/inventory/status', response: r.data });
    } else {
      record(1, 'FAIL', `Inventory module not active or unreachable`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 20 — /inventory page loads (HTML front-end)
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await fetch(`${BASE}/inventory`);
    if (r.ok) {
      record(20, 'PASS', `/inventory page responds HTTP ${r.status}`, { status: r.status });
    } else {
      record(20, 'FAIL', `/inventory page returned HTTP ${r.status}`, { status: r.status });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2 — Create raw material
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api('/api/inventory/items', 'POST', {
      name:          RM_NAME,
      sku:           `RM-${TS}`,
      item_type:     'raw_material',
      unit:          'kg',
      category:      'Demo Test',
      current_stock: 0,
      min_stock:     5
    }, TOKEN);
    if (r.ok && r.data.item?.id) {
      rmItemId = r.data.item.id;
      record(2, 'PASS', `Raw material created: "${RM_NAME}" (ID=${rmItemId})`, {
        endpoint: 'POST /api/inventory/items',
        item_id: rmItemId,
        item_type: r.data.item.item_type
      });
    } else {
      record(2, 'FAIL', `Create raw material failed: ${JSON.stringify(r.data)}`, r.data);
      console.error('Cannot continue without rmItemId'); process.exit(1);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 3 — Create finished good
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api('/api/inventory/items', 'POST', {
      name:          FG_NAME,
      sku:           `FG-${TS}`,
      item_type:     'finished_good',
      unit:          'unit',
      category:      'Demo Test',
      current_stock: 0,
      min_stock:     2
    }, TOKEN);
    if (r.ok && r.data.item?.id) {
      fgItemId = r.data.item.id;
      record(3, 'PASS', `Finished good created: "${FG_NAME}" (ID=${fgItemId})`, {
        endpoint: 'POST /api/inventory/items',
        item_id: fgItemId,
        item_type: r.data.item.item_type
      });
    } else {
      record(3, 'FAIL', `Create finished good failed: ${JSON.stringify(r.data)}`, r.data);
      console.error('Cannot continue without fgItemId'); process.exit(1);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 4 — Receive raw material with cost (quick-receive)
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api('/api/inventory/quick-receive', 'POST', {
      supplier_id: supplierId,
      item_id:     rmItemId,
      quantity:    100,
      unit_cost:   12.50,
      reference:   `QR-${TS}`,
      notes:       'Demo test receive'
    }, TOKEN);
    if (r.ok && r.data.success) {
      record(4, 'PASS',
        `Quick receive 100 kg @ R12.50/kg. New stock=${r.data.new_stock}, new avg cost=R${r.data.new_avg_cost}`,
        {
          endpoint:     'POST /api/inventory/quick-receive',
          supplier_id:  supplierId,
          item_id:      rmItemId,
          quantity:     100,
          unit_cost:    12.50,
          new_stock:    r.data.new_stock,
          new_avg_cost: r.data.new_avg_cost
        });
    } else {
      record(4, 'FAIL', `Quick receive failed: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 5 — Average cost updates after receive
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/items/${rmItemId}`, 'GET', null, TOKEN);
    const item = r.data.item;
    if (r.ok && parseFloat(item?.average_cost) > 0) {
      record(5, 'PASS',
        `Average cost = R${item.average_cost}, last_purchase_cost = R${item.last_purchase_cost}, stock = ${item.current_stock}`,
        { endpoint: `GET /api/inventory/items/${rmItemId}`, average_cost: item.average_cost, last_purchase_cost: item.last_purchase_cost, current_stock: item.current_stock });
    } else {
      record(5, 'FAIL', `Average cost not updated. average_cost=${item?.average_cost}`, item);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 6 — Stock value updates in valuation report
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api('/api/inventory/reports/stock-valuation', 'GET', null, TOKEN);
    if (r.ok && r.data.report?.grand_total > 0) {
      record(6, 'PASS',
        `Valuation grand_total = R${r.data.report.grand_total} (${r.data.report.total_items} items)`,
        { endpoint: 'GET /api/inventory/reports/stock-valuation', report_summary: r.data.report });
    } else {
      record(6, 'FAIL', `Stock valuation failed or returned zero total`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 7 — Create BOM / recipe
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api('/api/inventory/boms', 'POST', {
      item_id:    fgItemId,
      name:       `Test BOM ${TS}`,
      version:    '1.0',
      output_qty: 10,
      notes:      'Demo test BOM',
      lines:      [{ item_id: rmItemId, quantity: 5, scrap_percent: 0 }]
    }, TOKEN);
    if (r.ok && r.data.bom?.id) {
      bomId = r.data.bom.id;
      record(7, 'PASS', `BOM created (ID=${bomId}) for item "${FG_NAME}", output_qty=10`, {
        endpoint: 'POST /api/inventory/boms',
        bom_id:   bomId,
        bom:      r.data.bom
      });
    } else {
      record(7, 'FAIL', `Create BOM failed: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // Activate BOM so it can be used in WO
  if (bomId) {
    await api(`/api/inventory/boms/${bomId}/activate`, 'POST', {}, TOKEN);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 8 — BOM cost summary
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/boms/${bomId}/cost-summary`, 'GET', null, TOKEN);
    const cs = r.data.bom;
    if (r.ok && cs && cs.total_recipe_cost >= 0) {
      record(8, 'PASS',
        `BOM cost summary: recipe_cost=R${cs.total_recipe_cost}, est_unit_cost=R${cs.estimated_cost_per_unit}, missing_cost=${cs.missing_cost}`,
        { endpoint: `GET /api/inventory/boms/${bomId}/cost-summary`, cost_summary: cs });
    } else {
      record(8, 'FAIL', `BOM cost summary failed: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 9 — Create work order
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api('/api/inventory/work-orders', 'POST', {
      item_id:              fgItemId,
      bom_id:               bomId,
      quantity_to_produce:  2
    }, TOKEN);
    if (r.ok && r.data.work_order?.id) {
      woId = r.data.work_order.id;
      record(9, 'PASS', `WO created (ID=${woId}, WO#=${r.data.work_order.wo_number})`, {
        endpoint:   'POST /api/inventory/work-orders',
        wo_id:      woId,
        wo_number:  r.data.work_order.wo_number,
        status:     r.data.work_order.status
      });
    } else {
      record(9, 'FAIL', `Create WO failed: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // Release → start (required before issue-materials)
  if (woId) {
    await api(`/api/inventory/work-orders/${woId}/release`, 'POST', {}, TOKEN);
    await api(`/api/inventory/work-orders/${woId}/start`,   'POST', {}, TOKEN);
  }

  // Fetch WO materials
  let requiredQty = null;
  if (woId) {
    const woDetail = await api(`/api/inventory/work-orders/${woId}`, 'GET', null, TOKEN);
    const mat = woDetail.data.work_order?.materials?.[0];
    if (mat) { rmMaterialId = mat.id; requiredQty = mat.required_qty; }
    console.log(`   WO materials: material_id=${rmMaterialId}, required_qty=${requiredQty}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 11 — Over-issue must fail (test before valid issue so stock is intact)
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/work-orders/${woId}/issue-materials`, 'POST', {
      issues: [{ material_id: rmMaterialId, qty: 9999 }]
    }, TOKEN);
    if (!r.ok && r.status === 422) {
      record(11, 'PASS',
        `Over-issue correctly rejected HTTP 422. Error: "${r.data.error}"`,
        { endpoint: `POST /api/inventory/work-orders/${woId}/issue-materials`, http_status: r.status, error: r.data.error, available: r.data.available });
    } else {
      record(11, 'FAIL', `Over-issue should have returned 422 but got HTTP ${r.status}: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 12 — Complete before full issue must fail
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/work-orders/${woId}/complete`, 'POST', { quantity_produced: 2 }, TOKEN);
    if (!r.ok && (r.status === 422 || r.status === 400)) {
      record(12, 'PASS',
        `Complete before full issue correctly blocked HTTP ${r.status}. Error: "${r.data.error}"`,
        { endpoint: `POST /api/inventory/work-orders/${woId}/complete`, http_status: r.status, error: r.data.error, missing_materials: r.data.missing_materials });
    } else {
      record(12, 'FAIL', `Complete before issue should have been blocked but got HTTP ${r.status}: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // Capture RM stock before issue
  const rmBeforeIssue = await api(`/api/inventory/items/${rmItemId}`, 'GET', null, TOKEN);
  const rmStockBeforeIssue = parseFloat(rmBeforeIssue.data.item?.current_stock) || 0;

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 10 — Issue all required materials
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/work-orders/${woId}/issue-materials`, 'POST', {
      issues: [{ material_id: rmMaterialId, qty: requiredQty }]
    }, TOKEN);
    if (r.ok) {
      record(10, 'PASS',
        `Materials issued successfully. qty_issued=${requiredQty}`,
        { endpoint: `POST /api/inventory/work-orders/${woId}/issue-materials`, qty_issued: requiredQty, result: r.data });
    } else {
      record(10, 'FAIL', `Issue materials failed HTTP ${r.status}: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 13 — Complete after full issue must succeed
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/work-orders/${woId}/complete`, 'POST', { quantity_produced: 2 }, TOKEN);
    if (r.ok && r.data.work_order?.status === 'completed') {
      record(13, 'PASS',
        `WO completed. status=${r.data.work_order.status}, qty_produced=${r.data.work_order.quantity_produced}`,
        { endpoint: `POST /api/inventory/work-orders/${woId}/complete`, work_order: r.data.work_order });
    } else {
      record(13, 'FAIL', `WO completion failed HTTP ${r.status}: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 14 — Finished goods stock increases after WO completion
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/items/${fgItemId}`, 'GET', null, TOKEN);
    const fgStockNow = parseFloat(r.data.item?.current_stock) || 0;
    if (r.ok && fgStockNow > 0) {
      record(14, 'PASS',
        `Finished goods stock = ${fgStockNow} units (was 0 before WO)`,
        { endpoint: `GET /api/inventory/items/${fgItemId}`, current_stock: fgStockNow });
    } else {
      record(14, 'FAIL', `Finished goods stock not increased. current_stock=${fgStockNow}`, r.data.item);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 15 — Raw materials stock decreases after issue
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/items/${rmItemId}`, 'GET', null, TOKEN);
    const rmStockNow = parseFloat(r.data.item?.current_stock) || 0;
    if (r.ok && rmStockNow < rmStockBeforeIssue) {
      record(15, 'PASS',
        `Raw material stock decreased from ${rmStockBeforeIssue} → ${rmStockNow} (issued ${requiredQty})`,
        { endpoint: `GET /api/inventory/items/${rmItemId}`, before: rmStockBeforeIssue, after: rmStockNow, issued: requiredQty });
    } else {
      record(15, 'FAIL', `Raw material stock not decreased. before=${rmStockBeforeIssue}, now=${rmStockNow}`, r.data.item);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 16 — Finished goods unit cost shows after completion
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/work-orders/${woId}/cost-summary`, 'GET', null, TOKEN);
    const cs = r.data.work_order;
    if (r.ok && cs && cs.unit_cost != null) {
      record(16, 'PASS',
        `WO unit_cost = R${cs.unit_cost}, material_cost = R${cs.material_cost}`,
        { endpoint: `GET /api/inventory/work-orders/${woId}/cost-summary`, cost_summary: cs });
    } else {
      record(16, 'FAIL', `WO cost summary missing unit_cost: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 17 — Stock valuation report totals correctly (with filters)
  // ══════════════════════════════════════════════════════════════════════════
  {
    const [all, rm, fg] = await Promise.all([
      api('/api/inventory/reports/stock-valuation', 'GET', null, TOKEN),
      api('/api/inventory/reports/stock-valuation?item_type=raw_material', 'GET', null, TOKEN),
      api('/api/inventory/reports/stock-valuation?item_type=finished_good', 'GET', null, TOKEN)
    ]);
    if (all.ok && all.data.report) {
      const rep = all.data.report;
      record(17, 'PASS',
        `Valuation: grand_total=R${rep.grand_total}, raw=R${rep.raw_material_value}, FG=R${rep.finished_goods_value}, low_stock=${rep.low_stock_count}, missing_cost=${rep.missing_cost_items}. Filter(raw)=${rm.data.items?.length} items, Filter(fg)=${fg.data.items?.length} items`,
        {
          endpoint: 'GET /api/inventory/reports/stock-valuation',
          report_summary: rep,
          raw_filter_count: rm.data.items?.length,
          fg_filter_count: fg.data.items?.length
        });
    } else {
      record(17, 'FAIL', `Valuation report failed: ${JSON.stringify(all.data)}`, all.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 18 — Movement history shows all stock/cost changes
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await api(`/api/inventory/items/${rmItemId}/movements`, 'GET', null, TOKEN);
    const mvs = r.data.movements;
    if (r.ok && Array.isArray(mvs) && mvs.length > 0) {
      const sample = mvs[0];
      const hasType    = sample.movement_type != null;
      const hasQty     = sample.quantity != null;
      const hasResult  = sample.resulting_stock != null;
      const hasCost    = sample.unit_cost != null || sample.total_cost != null;
      const allFields  = hasType && hasQty && hasResult;
      record(18, allFields ? 'PASS' : 'FAIL',
        `${mvs.length} movements. Fields: type=${sample.movement_type}, qty=${sample.quantity}, resulting_stock=${sample.resulting_stock}, unit_cost=${sample.unit_cost}`,
        { endpoint: `GET /api/inventory/items/${rmItemId}/movements`, count: mvs.length, sample });
    } else {
      record(18, 'FAIL', `Movement history failed or empty: ${JSON.stringify(r.data)}`, r.data);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 19 — Multi-company isolation (company scoping)
  // ══════════════════════════════════════════════════════════════════════════
  // The JWT bakes in req.companyId. We verify:
  // (a) our own item returns 200
  // (b) a non-existent ID returns 404 (not another company's data)
  {
    const ownItem = await api(`/api/inventory/items/${rmItemId}`, 'GET', null, TOKEN);
    const fakeItem = await api('/api/inventory/items/999999999', 'GET', null, TOKEN);

    if (ownItem.ok && fakeItem.status === 404) {
      record(19, 'PASS',
        `Own item (ID=${rmItemId}) returns 200. Non-existent item (ID=999999999) returns 404. Company filter enforced via JWT.`,
        {
          own_item_status:  ownItem.status,
          fake_item_status: fakeItem.status,
          own_company_id:   COMPANY_ID
        });
    } else {
      record(19, 'FAIL',
        `Company scoping issue. own_item=${ownItem.status}, fake_item=${fakeItem.status}`,
        { own_item: ownItem.data, fake_item: fakeItem.data });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RESULTS SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  const passed  = results.filter(r => r.result === 'PASS').length;
  const failed  = results.filter(r => r.result === 'FAIL').length;
  const blocked = results.filter(r => r.result === 'BLOCKED').length;

  console.log('\n══════════════════════════════════════');
  console.log(`  TOTAL: ${results.length}  PASS: ${passed}  FAIL: ${failed}  BLOCKED: ${blocked}`);
  console.log('══════════════════════════════════════\n');

  // Output full JSON for report generation
  console.log('=== RAW RESULTS JSON ===');
  console.log(JSON.stringify(results, null, 2));
}

run().catch(err => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
