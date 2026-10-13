'use strict';

/**
 * Seed rows of payroll_tax_tables, read straight from migration 027 so tests use
 * exactly what production was seeded with (no second hand-typed copy to drift).
 */

const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', '..', 'migrations', '027_payroll_tax_tables.sql');

const NUM_COLS = [
  'primary_rebate', 'secondary_rebate', 'tertiary_rebate',
  'uif_rate', 'uif_monthly_cap', 'sdl_rate',
  'medical_credit_main', 'medical_credit_first_dep', 'medical_credit_additional'
];

function loadTaxTableSeedRows() {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const re = /\('(\d{4}\/\d{4})',\s*'([\d-]+)',\s*'([\d-]+)',\s*'(\[[^']*\])',\s*([\d.,\s]+?),\s*(TRUE|FALSE),\s*'([^']*)'\)/g;
  const rows = [];
  let m;
  while ((m = re.exec(sql))) {
    const nums = m[5].split(',').map(s => Number(s.trim()));
    if (nums.length !== NUM_COLS.length) throw new Error(`taxTableSeed: ${m[1]} has ${nums.length} numeric values`);
    const row = { tax_year: m[1], valid_from: m[2], valid_to: m[3], brackets: JSON.parse(m[4]) };
    NUM_COLS.forEach((c, i) => { row[c] = nums[i]; });
    row.confirmed = m[6] === 'TRUE';
    row.source = m[7];
    rows.push(row);
  }
  if (!rows.length) throw new Error('taxTableSeed: no rows parsed from migration 027');
  return rows;
}

module.exports = { loadTaxTableSeedRows };
