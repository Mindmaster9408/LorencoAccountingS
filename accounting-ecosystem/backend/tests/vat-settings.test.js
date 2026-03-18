'use strict';

/**
 * ============================================================================
 * Tests — VAT Settings and Bank Transaction VAT
 * ============================================================================
 *
 * Coverage:
 *   A. VAT calculation helpers (bankVatSplit)
 *   B. VAT settings seed defaults logic
 *   C. Company VAT fields (is_vat_registered, vat_cycle_type, vat_registered_date)
 *   D. Bank transaction VAT — allocation line splitting
 *   E. Safety rules: CUSTOMER/SUPPLIER types must not carry vatSettingId
 *   F. Regression: zero-rate VAT produces no VAT journal line
 * ============================================================================
 */

// ─── A. VAT calculation helper (mirrors bank.js logic) ───────────────────────

/**
 * Calculates ex-VAT and VAT amounts from a gross amount.
 * vatInclusive = true  → gross already includes VAT (split out)
 * vatInclusive = false → gross is ex-VAT (add VAT on top)
 */
function bankVatSplit(grossAmount, vatRate, vatInclusive = true) {
  const rate = parseFloat(vatRate);
  if (isNaN(rate) || rate <= 0) {
    return { exVat: grossAmount, vatAmt: 0 };
  }
  if (vatInclusive) {
    const exVat  = Math.round((grossAmount / (1 + rate / 100)) * 100) / 100;
    const vatAmt = Math.round((grossAmount - exVat) * 100) / 100;
    return { exVat, vatAmt };
  } else {
    const exVat  = Math.round(grossAmount * 100) / 100;
    const vatAmt = Math.round((grossAmount * rate / 100) * 100) / 100;
    return { exVat, vatAmt };
  }
}

describe('A. bankVatSplit — VAT calculation helper', () => {
  test('inclusive: R115 @ 15% → R100 ex-VAT + R15 VAT', () => {
    const { exVat, vatAmt } = bankVatSplit(115, 15, true);
    expect(exVat).toBe(100);
    expect(vatAmt).toBe(15);
  });

  test('inclusive: R114 @ 15% → rounded correctly', () => {
    const { exVat, vatAmt } = bankVatSplit(114, 15, true);
    expect(exVat + vatAmt).toBe(114); // must sum to gross
  });

  test('exclusive: R100 @ 15% → R100 ex-VAT + R15 VAT', () => {
    const { exVat, vatAmt } = bankVatSplit(100, 15, false);
    expect(exVat).toBe(100);
    expect(vatAmt).toBe(15);
  });

  test('zero rate: 0% → full amount ex-VAT, R0 VAT', () => {
    const { exVat, vatAmt } = bankVatSplit(100, 0, true);
    expect(exVat).toBe(100);
    expect(vatAmt).toBe(0);
  });

  test('old rate: R114 @ 14% inclusive', () => {
    const { exVat, vatAmt } = bankVatSplit(114, 14, true);
    expect(exVat).toBe(100);
    expect(vatAmt).toBe(14);
  });

  test('invalid rate (NaN) → treat as no-VAT', () => {
    const { exVat, vatAmt } = bankVatSplit(115, NaN, true);
    expect(exVat).toBe(115);
    expect(vatAmt).toBe(0);
  });

  test('negative rate → treat as no-VAT', () => {
    const { exVat, vatAmt } = bankVatSplit(115, -5, true);
    expect(exVat).toBe(115);
    expect(vatAmt).toBe(0);
  });

  test('rounding: amounts always sum to gross within 1 cent', () => {
    // Test several amounts that cause rounding edge cases
    const amounts = [99.99, 123.45, 1000.00, 57.23, 8.50];
    for (const gross of amounts) {
      const { exVat, vatAmt } = bankVatSplit(gross, 15, true);
      // exVat + vatAmt may differ from gross by at most 1 cent due to rounding
      expect(Math.abs(exVat + vatAmt - gross)).toBeLessThanOrEqual(0.01);
    }
  });
});


// ─── B. VAT settings seed defaults ───────────────────────────────────────────

const SA_DEFAULT_VAT_CATEGORIES = [
  { code: 'standard',         name: 'Standard Rate (15%)',           rate: 15, is_capital: false, is_active: true  },
  { code: 'standard_capital', name: 'Standard Rate — Capital (15%)', rate: 15, is_capital: true,  is_active: true  },
  { code: 'zero',             name: 'Zero Rated (0%)',               rate: 0,  is_capital: false, is_active: true  },
  { code: 'exempt',           name: 'Exempt',                        rate: 0,  is_capital: false, is_active: true  },
  { code: 'old_rate',         name: 'Old Rate (14%)',                rate: 14, is_capital: false, is_active: false },
  { code: 'old_rate_capital', name: 'Old Rate — Capital (14%)',      rate: 14, is_capital: true,  is_active: false },
];

describe('B. SA default VAT categories', () => {
  test('exactly 6 default categories are defined', () => {
    expect(SA_DEFAULT_VAT_CATEGORIES.length).toBe(6);
  });

  test('standard rate is 15% and active', () => {
    const std = SA_DEFAULT_VAT_CATEGORIES.find(c => c.code === 'standard');
    expect(std).toBeDefined();
    expect(std.rate).toBe(15);
    expect(std.is_active).toBe(true);
    expect(std.is_capital).toBe(false);
  });

  test('zero-rated category has rate 0 and is active', () => {
    const zero = SA_DEFAULT_VAT_CATEGORIES.find(c => c.code === 'zero');
    expect(zero).toBeDefined();
    expect(zero.rate).toBe(0);
    expect(zero.is_active).toBe(true);
  });

  test('old rate is 14% and inactive (historical)', () => {
    const old = SA_DEFAULT_VAT_CATEGORIES.find(c => c.code === 'old_rate');
    expect(old).toBeDefined();
    expect(old.rate).toBe(14);
    expect(old.is_active).toBe(false);
  });

  test('capital variants are marked is_capital = true', () => {
    const caps = SA_DEFAULT_VAT_CATEGORIES.filter(c => c.is_capital);
    expect(caps.length).toBe(2);
    const codes = caps.map(c => c.code).sort();
    expect(codes).toEqual(['old_rate_capital', 'standard_capital']);
  });

  test('all codes are unique', () => {
    const codes = SA_DEFAULT_VAT_CATEGORIES.map(c => c.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  test('no category has a rate above 100', () => {
    SA_DEFAULT_VAT_CATEGORIES.forEach(c => {
      expect(c.rate).toBeLessThanOrEqual(100);
      expect(c.rate).toBeGreaterThanOrEqual(0);
    });
  });
});


// ─── C. Company VAT field validation rules ────────────────────────────────────

/**
 * Simulates the frontend validation rule:
 * If isVatRegistered = true, vatNumber must be provided.
 */
function validateVatRegistration({ isVatRegistered, vatNumber, vatPeriod }) {
  const errors = [];
  if (isVatRegistered) {
    if (!vatNumber || vatNumber.trim() === '') {
      errors.push('VAT Number is required when company is VAT registered');
    }
    if (!vatPeriod) {
      errors.push('VAT submission frequency is required when company is VAT registered');
    }
  }
  return errors;
}

describe('C. Company VAT registration validation', () => {
  test('VAT not registered — no errors', () => {
    const errors = validateVatRegistration({ isVatRegistered: false, vatNumber: '', vatPeriod: '' });
    expect(errors.length).toBe(0);
  });

  test('VAT registered without number — error', () => {
    const errors = validateVatRegistration({ isVatRegistered: true, vatNumber: '', vatPeriod: 'monthly' });
    expect(errors).toContain('VAT Number is required when company is VAT registered');
  });

  test('VAT registered without period — error', () => {
    const errors = validateVatRegistration({ isVatRegistered: true, vatNumber: '4012345678', vatPeriod: '' });
    expect(errors).toContain('VAT submission frequency is required when company is VAT registered');
  });

  test('VAT registered with all fields — no errors', () => {
    const errors = validateVatRegistration({
      isVatRegistered: true,
      vatNumber: '4012345678',
      vatPeriod: 'bi-monthly'
    });
    expect(errors.length).toBe(0);
  });
});

describe('C2. VAT cycle type rules', () => {
  function cycleMonthsForType(cycleType) {
    // even months: Feb(2), Apr(4), Jun(6), Aug(8), Oct(10), Dec(12)
    // odd months:  Jan(1), Mar(3), May(5), Jul(7), Sep(9), Nov(11)
    if (cycleType === 'even') return [2, 4, 6, 8, 10, 12];
    if (cycleType === 'odd')  return [1, 3, 5, 7, 9, 11];
    return [];
  }

  test('even cycle has 6 months', () => {
    expect(cycleMonthsForType('even').length).toBe(6);
  });

  test('odd cycle has 6 months', () => {
    expect(cycleMonthsForType('odd').length).toBe(6);
  });

  test('even + odd cycles cover all 12 months', () => {
    const all = [...cycleMonthsForType('even'), ...cycleMonthsForType('odd')].sort((a, b) => a - b);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('no overlap between even and odd cycles', () => {
    const even = new Set(cycleMonthsForType('even'));
    const odd  = cycleMonthsForType('odd');
    odd.forEach(m => expect(even.has(m)).toBe(false));
  });
});


// ─── D. Bank transaction VAT allocation line splitting ────────────────────────

/**
 * Simulates the journal line building logic from bank.js allocate endpoint.
 * Returns the list of journal lines that would be created.
 */
function buildBankJournalLines(bankTxnAmount, ledgerAccountId, allocationLines, vatSettingMap) {
  const lines = [];
  const isMoneyIn = bankTxnAmount > 0;

  // Bank account line (full gross)
  lines.push({
    accountId:   ledgerAccountId,
    debit:       isMoneyIn ? Math.abs(bankTxnAmount) : 0,
    credit:      isMoneyIn ? 0 : Math.abs(bankTxnAmount),
    description: 'Bank'
  });

  for (const line of allocationLines) {
    const gross = Math.round(Number(line.amount) * 100) / 100;
    const vs = line.vatSettingId ? vatSettingMap[line.vatSettingId] : null;

    if (vs && vs.rate > 0) {
      const vatInclusive = line.vatInclusive !== false;
      let exVat, vatAmt;
      if (vatInclusive) {
        exVat  = Math.round((gross / (1 + vs.rate / 100)) * 100) / 100;
        vatAmt = Math.round((gross - exVat) * 100) / 100;
      } else {
        exVat  = gross;
        vatAmt = Math.round((gross * vs.rate / 100) * 100) / 100;
      }

      // Allocation account at ex-VAT
      lines.push({
        accountId: line.accountId,
        debit:  isMoneyIn ? 0 : exVat,
        credit: isMoneyIn ? exVat : 0,
        description: 'Expense ex-VAT'
      });

      // VAT account
      const vatAccountId = isMoneyIn ? 2300 : 1400; // mock IDs
      lines.push({
        accountId: vatAccountId,
        debit:  isMoneyIn ? 0 : vatAmt,
        credit: isMoneyIn ? vatAmt : 0,
        description: `VAT ${vs.rate}%`
      });
    } else {
      // No VAT — full gross to allocation account
      lines.push({
        accountId: line.accountId,
        debit:  isMoneyIn ? 0 : gross,
        credit: isMoneyIn ? gross : 0,
        description: 'Allocation'
      });
    }
  }

  return lines;
}

describe('D. Bank transaction VAT line splitting', () => {
  const STD_VAT = { id: 1, code: 'standard', rate: 15, is_capital: false };
  const ZERO_VAT = { id: 2, code: 'zero', rate: 0, is_capital: false };
  const vatMap = { 1: STD_VAT, 2: ZERO_VAT };

  test('payment out with 15% VAT inclusive → 3 journal lines', () => {
    // R115 bank charge, VAT inclusive
    const lines = buildBankJournalLines(-115, 1010, [
      { accountId: 6100, amount: 115, vatSettingId: 1, vatInclusive: true }
    ], vatMap);

    expect(lines.length).toBe(3);
    const bankLine   = lines[0];
    const expenseLine = lines[1];
    const vatLine    = lines[2];

    expect(bankLine.credit).toBe(115);     // bank credited for full gross
    expect(expenseLine.debit).toBe(100);   // expense debited at ex-VAT
    expect(vatLine.debit).toBe(15);        // VAT Input debited
    expect(vatLine.accountId).toBe(1400);  // VAT Input account
  });

  test('receipt in with 15% VAT inclusive → VAT Output credited', () => {
    // R115 rental income received, VAT inclusive
    const lines = buildBankJournalLines(115, 1010, [
      { accountId: 4600, amount: 115, vatSettingId: 1, vatInclusive: true }
    ], vatMap);

    expect(lines.length).toBe(3);
    const vatLine = lines[2];
    expect(vatLine.credit).toBe(15);       // VAT Output credited
    expect(vatLine.accountId).toBe(2300);  // VAT Output account
  });

  test('payment out with zero-rated VAT → 2 journal lines (no VAT line)', () => {
    const lines = buildBankJournalLines(-100, 1010, [
      { accountId: 6100, amount: 100, vatSettingId: 2, vatInclusive: true }
    ], vatMap);

    expect(lines.length).toBe(2); // bank + allocation only
    expect(lines[1].debit).toBe(100);
  });

  test('payment out with no VAT setting → 2 journal lines', () => {
    const lines = buildBankJournalLines(-200, 1010, [
      { accountId: 6200, amount: 200 } // no vatSettingId
    ], vatMap);

    expect(lines.length).toBe(2);
    expect(lines[1].debit).toBe(200); // full amount to allocation account
  });

  test('journal lines debit total = credit total (balanced)', () => {
    const lines = buildBankJournalLines(-115, 1010, [
      { accountId: 6100, amount: 115, vatSettingId: 1, vatInclusive: true }
    ], vatMap);

    const totalDebit  = lines.reduce((s, l) => s + (l.debit  || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThanOrEqual(0.01);
  });

  test('exclusive VAT: R100 ex-VAT @ 15% → expense=100, VAT=15, bank=115', () => {
    const lines = buildBankJournalLines(-115, 1010, [
      { accountId: 6100, amount: 100, vatSettingId: 1, vatInclusive: false }
    ], vatMap);

    const expenseLine = lines[1];
    const vatLine     = lines[2];
    expect(expenseLine.debit).toBe(100);
    expect(vatLine.debit).toBe(15);
  });
});


// ─── E. Safety rules: CUSTOMER/SUPPLIER allocation types ─────────────────────

describe('E. VAT eligibility safeguards', () => {
  /**
   * Simulates the frontend guard: vatSettingId is only applied when
   * allocationType === 'account'. Customer/supplier payment allocations
   * must NOT carry VAT (invoice already has it).
   */
  function resolveVatSettingId(allocationType, isVatRegistered, selectedVatId) {
    if (allocationType !== 'account') return null;   // HARD RULE: only ACCOUNT type
    if (!isVatRegistered) return null;               // company not VAT registered
    return selectedVatId || null;
  }

  test('customer type → vatSettingId is null regardless', () => {
    expect(resolveVatSettingId('customer', true, 1)).toBeNull();
  });

  test('supplier type → vatSettingId is null regardless', () => {
    expect(resolveVatSettingId('supplier', true, 1)).toBeNull();
  });

  test('transfer type → vatSettingId is null', () => {
    expect(resolveVatSettingId('transfer', true, 1)).toBeNull();
  });

  test('vat type (paying SARS) → vatSettingId is null', () => {
    expect(resolveVatSettingId('vat', true, 1)).toBeNull();
  });

  test('account type + VAT registered + setting selected → vatSettingId returned', () => {
    expect(resolveVatSettingId('account', true, 3)).toBe(3);
  });

  test('account type + company NOT VAT registered → vatSettingId is null', () => {
    expect(resolveVatSettingId('account', false, 1)).toBeNull();
  });

  test('account type + VAT registered + no setting selected → null', () => {
    expect(resolveVatSettingId('account', true, null)).toBeNull();
  });
});


// ─── F. Regression: existing flows unchanged ─────────────────────────────────

describe('F. Regression — existing flows unaffected', () => {
  test('bank allocation without vatSettingId behaves identically to before', () => {
    // Old behaviour: full gross to allocation account
    const lines = buildBankJournalLines(-500, 1010, [
      { accountId: 6000, amount: 500 } // no vatSettingId
    ], {});

    expect(lines.length).toBe(2);
    expect(lines[0].credit).toBe(500); // bank credited for full gross
    expect(lines[1].debit).toBe(500);  // allocation account debited for full gross
  });

  test('multiple allocation lines without VAT all work', () => {
    const lines = buildBankJournalLines(-300, 1010, [
      { accountId: 6000, amount: 200 },
      { accountId: 6100, amount: 100 },
    ], {});

    expect(lines.length).toBe(3); // 1 bank + 2 allocation
    const totalAllocated = lines.slice(1).reduce((s, l) => s + l.debit, 0);
    expect(totalAllocated).toBe(300);
  });

  test('positive bank amount (receipt) without VAT → credits allocation account', () => {
    const lines = buildBankJournalLines(1000, 1010, [
      { accountId: 4000, amount: 1000 }
    ], {});

    expect(lines[0].debit).toBe(1000);  // bank debited
    expect(lines[1].credit).toBe(1000); // income credited
  });
});
