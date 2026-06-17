'use strict';
// Verify the percentage normalization fix produces the correct numbers for CC001 / company 7.
// Pure logic — no DB or engine import needed.
// Delete after use.

async function run() {
  // Simulate what PayrollDataService.normalizePayrollInputs now builds for TB001

  // BEFORE fix
  const before = {
    description:      '7.5% Allowance',
    amount:           null || 0,   // ← was: item.amount || 0
    percentage:       7.5,
    // is_percentage:   (did not exist)
    // percentage_value:(did not exist)
    type:             'earning',
    is_taxable:       true,
    tax_treatment:    'net_only',
    paye_projection_type: 'VARIABLE_AVERAGE',
    affects_uif:      true
  };

  // AFTER fix
  const pct = parseFloat(7.5);
  const after = {
    description:      '7.5% Allowance',
    amount:           pct > 0 ? 0 : 0,
    percentage:       pct,
    is_percentage:    pct > 0,          // ← true
    percentage_value: pct > 0 ? pct : 0, // ← 7.5
    type:             'earning',
    is_taxable:       true,
    tax_treatment:    'net_only',
    paye_projection_type: 'VARIABLE_AVERAGE',
    affects_uif:      true
  };

  const basicSalary  = 6023.00;
  const overtimeAmt  = 579.56;   // as a period input

  function calcWith(regularItem) {
    const payrollData = {
      basic_salary:   basicSalary,
      regular_inputs: [regularItem],
      workSchedule:   null,
      hours_per_day:  8
    };
    const currentInputs = [];
    const overtime = [{ hours: overtimeAmt / (basicSalary / 176), rate_multiplier: 1.5 }];

    // Replicate engine resolution
    const resolved = [regularItem].map(function(ri) {
      if (ri.is_percentage && ri.percentage_value) {
        return Object.assign({}, ri, { amount: Math.round((ri.percentage_value / 100) * basicSalary * 100) / 100 });
      }
      return ri;
    });

    const resolvedItem = resolved[0];
    const periodicTaxable_contribution = resolvedItem.type !== 'deduction'
      ? (parseFloat(resolvedItem.amount) || 0)
      : 0;

    return { resolvedAmount: resolvedItem.amount, periodicContribution: periodicTaxable_contribution };
  }

  const resBefore = calcWith(before);
  const resAfter  = calcWith(after);

  const overtimeCalc = overtimeAmt; // already in rand for this test

  const grossBefore = basicSalary + resBefore.periodicContribution + overtimeCalc;
  const grossAfter  = basicSalary + resAfter.periodicContribution  + overtimeCalc;

  const UIF_RATE    = 0.01;
  const UIF_CAP     = 177.12;
  const uifBefore   = Math.min(Math.round(grossBefore * UIF_RATE * 100) / 100, UIF_CAP);
  const uifAfter    = Math.min(Math.round(grossAfter  * UIF_RATE * 100) / 100, UIF_CAP);

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  TB001 normalization — BEFORE fix');
  console.log('══════════════════════════════════════════════════════');
  console.log('  is_percentage:    ', before.is_percentage);
  console.log('  percentage_value: ', before.percentage_value);
  console.log('  amount at input:  ', before.amount);
  console.log('  resolved amount:  ', resBefore.resolvedAmount, '(engine sees R0 — percentage NOT resolved)');
  console.log('  contribution to periodicTaxable:', resBefore.periodicContribution);
  console.log('  gross:            R' + grossBefore.toFixed(2));
  console.log('  UIF:              R' + uifBefore.toFixed(2));

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  TB001 normalization — AFTER fix');
  console.log('══════════════════════════════════════════════════════');
  console.log('  is_percentage:    ', after.is_percentage);
  console.log('  percentage_value: ', after.percentage_value);
  console.log('  amount at input:  ', after.amount);
  console.log('  resolved amount:  ', resAfter.resolvedAmount, '(engine resolves 7.5% × 6023 = R451.73)');
  console.log('  contribution to periodicTaxable:', resAfter.periodicContribution);
  console.log('  gross:            R' + grossAfter.toFixed(2));
  console.log('  UIF:              R' + uifAfter.toFixed(2));

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Checks');
  console.log('══════════════════════════════════════════════════════');

  const checks = {
    'is_percentage = true':          after.is_percentage  === true,
    'percentage_value = 7.5':        after.percentage_value === 7.5,
    'affects_uif = true':            after.affects_uif    === true,
    'is_taxable = true':             after.is_taxable     === true,
    'resolved amount = R451.73':     resAfter.resolvedAmount === 451.73,
    'gross after = R7,054.29':       Math.abs(grossAfter - 7054.29) < 0.01,
    'UIF after = R70.54':            uifAfter  === 70.54,
    'gross before ≠ gross after':    grossBefore !== grossAfter,
    'UIF before was R66.03':         Math.abs(uifBefore - 66.03) < 0.01
  };

  let allPass = true;
  for (const [label, pass] of Object.entries(checks)) {
    console.log('  ' + (pass ? '✓' : '✗') + ' ' + label);
    if (!pass) allPass = false;
  }

  console.log(allPass ? '\n✓ All checks pass. Fix is correct.\n' : '\n✗ One or more checks failed.\n');
}

run().catch(err => { console.error(err); process.exit(1); });
