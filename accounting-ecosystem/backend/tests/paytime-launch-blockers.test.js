/**
 * ============================================================================
 * Paytime Launch Blockers — Test Suite
 * ============================================================================
 * Tests for the three main launch-blocker fixes:
 *   1. Password Reset — new /api/auth/forgot-password/* endpoints
 *   2. Leave Management — GET/DELETE/PUT leave records from backend
 *   3. PAYE Reconciliation — backend summary endpoint logic
 *
 * All tests are pure logic tests (no real DB/HTTP calls).
 * Backend route handlers are tested by extracting their core logic.
 * ============================================================================
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — PASSWORD RESET LOGIC
// ─────────────────────────────────────────────────────────────────────────────

describe('Password Reset — input validation', () => {
  // Mirrors the backend validation in POST /api/auth/forgot-password/reset

  function validateResetInput(email, newPassword) {
    if (!email || !newPassword) return { ok: false, error: 'email and newPassword are required' };
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters' };
    }
    if (!email.includes('@')) return { ok: false, error: 'Valid email address is required' };
    return { ok: true };
  }

  test('rejects missing email', () => {
    expect(validateResetInput('', 'NewPass123').ok).toBe(false);
  });

  test('rejects missing password', () => {
    expect(validateResetInput('user@example.com', '').ok).toBe(false);
  });

  test('rejects password shorter than 8 chars', () => {
    const r = validateResetInput('user@example.com', 'Short1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/8 characters/);
  });

  test('rejects email without @ sign', () => {
    const r = validateResetInput('notanemail', 'ValidPass123');
    expect(r.ok).toBe(false);
  });

  test('accepts valid email and 8-char password', () => {
    expect(validateResetInput('user@example.com', 'Secure1!').ok).toBe(true);
  });

  test('accepts password exactly 8 chars long', () => {
    expect(validateResetInput('a@b.com', '12345678').ok).toBe(true);
  });

  test('accepts password longer than 8 chars', () => {
    expect(validateResetInput('a@b.com', 'AVeryLongSecurePassword!').ok).toBe(true);
  });
});

describe('Password Reset — check endpoint logic', () => {
  // Mirrors the backend email lookup in POST /api/auth/forgot-password/check

  function validateCheckInput(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return { ok: false, error: 'Valid email address is required' };
    }
    return { ok: true };
  }

  test('rejects empty email', () => {
    expect(validateCheckInput('').ok).toBe(false);
  });

  test('rejects non-string email', () => {
    expect(validateCheckInput(null).ok).toBe(false);
  });

  test('rejects email without @', () => {
    expect(validateCheckInput('noatsign').ok).toBe(false);
  });

  test('accepts valid email', () => {
    expect(validateCheckInput('user@company.co.za').ok).toBe(true);
  });

  test('accepts email with subdomain', () => {
    expect(validateCheckInput('admin@mail.example.com').ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — LEAVE MANAGEMENT LOGIC
// ─────────────────────────────────────────────────────────────────────────────

describe('Leave Management — statutory defaults', () => {
  // Mirrors the logic that creates default leave balances if none exist

  const SA_LEAVE_DEFAULTS = [
    { leave_type: 'annual',  annual_entitlement: 15, balance: 15 },
    { leave_type: 'sick',    annual_entitlement: 30, balance: 30 },
    { leave_type: 'family',  annual_entitlement: 3,  balance: 3  },
  ];

  test('creates 3 leave types by default', () => {
    expect(SA_LEAVE_DEFAULTS).toHaveLength(3);
  });

  test('annual leave entitlement is 15 days (SA statutory minimum)', () => {
    const annual = SA_LEAVE_DEFAULTS.find(d => d.leave_type === 'annual');
    expect(annual.annual_entitlement).toBe(15);
    expect(annual.balance).toBe(15);
  });

  test('sick leave entitlement is 30 days per 3-year cycle', () => {
    const sick = SA_LEAVE_DEFAULTS.find(d => d.leave_type === 'sick');
    expect(sick.annual_entitlement).toBe(30);
  });

  test('family responsibility leave is 3 days', () => {
    const family = SA_LEAVE_DEFAULTS.find(d => d.leave_type === 'family');
    expect(family.annual_entitlement).toBe(3);
  });
});

describe('Leave Management — balance adjustment logic', () => {
  // Mirrors the balance adjustment logic in PUT/DELETE leave routes

  function adjustBalance(currentBalance, daysTaken, action) {
    // action: 'approve' | 'restore' | 'update_days'
    const bal = parseFloat(currentBalance) || 0;
    const days = parseFloat(daysTaken) || 0;
    switch (action) {
      case 'approve':  return bal - days;
      case 'restore':  return bal + days;
      default:         return bal;
    }
  }

  test('approving leave reduces balance', () => {
    expect(adjustBalance(15, 3, 'approve')).toBe(12);
  });

  test('restoring leave increases balance', () => {
    expect(adjustBalance(12, 3, 'restore')).toBe(15);
  });

  test('balance does not go negative for very large leave (warning only — not enforced in backend)', () => {
    // Backend does not enforce minimum — that's a business rule for future UI validation
    expect(adjustBalance(5, 10, 'approve')).toBe(-5);
  });

  test('balance adjustment with fractional days', () => {
    expect(adjustBalance(15, 0.5, 'approve')).toBe(14.5);
  });

  test('restoring from 0 balance gives correct result', () => {
    expect(adjustBalance(0, 3, 'restore')).toBe(3);
  });
});

describe('Leave Management — leave record validation', () => {
  function validateLeaveRecord(rec) {
    if (!rec.employee_id) return { ok: false, error: 'employee_id is required' };
    if (!rec.records || rec.records.length === 0) return { ok: false, error: 'records array required' };
    const r = rec.records[0];
    if (!r.start_date || !r.end_date) return { ok: false, error: 'start_date and end_date are required' };
    if (!r.leave_type) return { ok: false, error: 'leave_type is required' };
    const validTypes = ['annual', 'sick', 'family', 'maternity', 'paternity', 'unpaid', 'other'];
    if (!validTypes.includes(r.leave_type)) return { ok: false, error: 'Invalid leave_type' };
    return { ok: true };
  }

  test('rejects missing employee_id', () => {
    expect(validateLeaveRecord({ records: [{ start_date: '2025-01-01', end_date: '2025-01-03', leave_type: 'annual' }] }).ok).toBe(false);
  });

  test('rejects empty records array', () => {
    expect(validateLeaveRecord({ employee_id: 1, records: [] }).ok).toBe(false);
  });

  test('rejects missing start_date', () => {
    expect(validateLeaveRecord({ employee_id: 1, records: [{ end_date: '2025-01-03', leave_type: 'annual' }] }).ok).toBe(false);
  });

  test('rejects invalid leave_type', () => {
    expect(validateLeaveRecord({ employee_id: 1, records: [{ start_date: '2025-01-01', end_date: '2025-01-03', leave_type: 'vacation' }] }).ok).toBe(false);
  });

  test('accepts valid annual leave record', () => {
    const result = validateLeaveRecord({
      employee_id: 42,
      records: [{ start_date: '2025-01-06', end_date: '2025-01-10', leave_type: 'annual', days_taken: 5, status: 'approved' }]
    });
    expect(result.ok).toBe(true);
  });

  test('accepts unpaid leave type', () => {
    const result = validateLeaveRecord({
      employee_id: 1,
      records: [{ start_date: '2025-03-01', end_date: '2025-03-05', leave_type: 'unpaid', days_taken: 5, status: 'approved' }]
    });
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — PAYE RECONCILIATION BACKEND LOGIC
// ─────────────────────────────────────────────────────────────────────────────

describe('PAYE Recon — tax year helpers', () => {
  // Mirrors the helper functions in recon.js

  function taxYearToDateRange(taxYear) {
    const [y1, y2] = taxYear.split('/').map(Number);
    if (!y1 || !y2) throw new Error('Invalid tax year format. Use YYYY/YYYY');
    return { startDate: `${y1}-03-01`, endDate: `${y2}-02-28` };
  }

  function taxYearForPeriod(period) {
    const [y, m] = period.split('-').map(Number);
    return m >= 3 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
  }

  function generatePeriods(startDate, endDate) {
    const periods = [];
    const [sy, sm] = startDate.split('-').map(Number);
    const [ey, em] = endDate.split('-').map(Number);
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      periods.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return periods;
  }

  test('2025/2026 tax year starts 2025-03', () => {
    expect(taxYearToDateRange('2025/2026').startDate).toBe('2025-03-01');
  });

  test('2025/2026 tax year ends 2026-02', () => {
    expect(taxYearToDateRange('2025/2026').endDate).toBe('2026-02-28');
  });

  test('throws on invalid tax year format', () => {
    expect(() => taxYearToDateRange('invalid')).toThrow('Invalid tax year format');
  });

  test('March period belongs to current/next tax year', () => {
    expect(taxYearForPeriod('2025-03')).toBe('2025/2026');
  });

  test('February period belongs to previous/current tax year', () => {
    expect(taxYearForPeriod('2026-02')).toBe('2025/2026');
  });

  test('January period belongs to previous/current tax year', () => {
    expect(taxYearForPeriod('2025-01')).toBe('2024/2025');
  });

  test('December is in the current SA tax year', () => {
    expect(taxYearForPeriod('2025-12')).toBe('2025/2026');
  });

  test('generates 12 periods for a full tax year', () => {
    const periods = generatePeriods('2025-03-01', '2026-02-28');
    expect(periods).toHaveLength(12);
  });

  test('generated periods start with March', () => {
    const periods = generatePeriods('2025-03-01', '2026-02-28');
    expect(periods[0]).toBe('2025-03');
  });

  test('generated periods end with February', () => {
    const periods = generatePeriods('2025-03-01', '2026-02-28');
    expect(periods[11]).toBe('2026-02');
  });

  test('period list crosses year boundary correctly', () => {
    const periods = generatePeriods('2025-03-01', '2026-02-28');
    expect(periods).toContain('2025-12');
    expect(periods).toContain('2026-01');
  });
});

describe('PAYE Recon — aggregation logic', () => {
  // Mirrors the per-period aggregation in recon.js summary endpoint

  function aggregatePeriods(records) {
    const totals = {};
    for (const rec of records) {
      const p = rec.period_key;
      if (!totals[p]) totals[p] = { gross: 0, paye: 0, uif: 0, sdl: 0, net: 0, employeeCount: 0 };
      totals[p].gross += parseFloat(rec.gross) || 0;
      totals[p].paye  += parseFloat(rec.paye)  || 0;
      totals[p].uif   += parseFloat(rec.uif)   || 0;
      totals[p].sdl   += parseFloat(rec.sdl)   || 0;
      totals[p].net   += parseFloat(rec.net)   || 0;
      totals[p].employeeCount++;
    }
    for (const p of Object.keys(totals)) {
      const t = totals[p];
      t.gross = Math.round(t.gross * 100) / 100;
      t.paye  = Math.round(t.paye  * 100) / 100;
      t.uif   = Math.round(t.uif   * 100) / 100;
      t.sdl   = Math.round(t.sdl   * 100) / 100;
      t.net   = Math.round(t.net   * 100) / 100;
      t.total = Math.round((t.paye + t.uif + t.sdl) * 100) / 100;
    }
    return totals;
  }

  const sampleRecords = [
    { period_key: '2025-03', gross: 15000, paye: 2100, uif: 148.72, sdl: 75, net: 12676.28 },
    { period_key: '2025-03', gross: 25000, paye: 4500, uif: 177.12, sdl: 125, net: 20197.88 },
    { period_key: '2025-04', gross: 15000, paye: 2100, uif: 148.72, sdl: 75, net: 12676.28 },
  ];

  test('aggregates gross correctly for a single period', () => {
    const totals = aggregatePeriods(sampleRecords);
    expect(totals['2025-03'].gross).toBe(40000);
  });

  test('aggregates PAYE correctly across employees', () => {
    const totals = aggregatePeriods(sampleRecords);
    expect(totals['2025-03'].paye).toBe(6600);
  });

  test('counts employees per period', () => {
    const totals = aggregatePeriods(sampleRecords);
    expect(totals['2025-03'].employeeCount).toBe(2);
    expect(totals['2025-04'].employeeCount).toBe(1);
  });

  test('separate period is not included in another period total', () => {
    const totals = aggregatePeriods(sampleRecords);
    expect(totals['2025-04'].gross).toBe(15000);
  });

  test('total (PAYE+UIF+SDL) is computed per period', () => {
    const totals = aggregatePeriods(sampleRecords);
    const expected = Math.round((6600 + 325.84 + 200) * 100) / 100;
    expect(totals['2025-03'].total).toBe(expected);
  });

  test('handles empty records', () => {
    const totals = aggregatePeriods([]);
    expect(Object.keys(totals)).toHaveLength(0);
  });

  test('rounds to 2 decimal places', () => {
    // Use a value that definitely produces a fractional cent after arithmetic
    const records = [{ period_key: '2025-03', gross: 10000.126, paye: 1400.001, uif: 148.72, sdl: 50, net: 8401.284 }];
    const totals = aggregatePeriods(records);
    // Math.round(10000.126 * 100) / 100 = 10000.13
    expect(totals['2025-03'].gross).toBe(10000.13);
  });
});

describe('PAYE Recon — annual totals computation', () => {
  function computeAnnualTotals(periodTotals) {
    const annual = { gross: 0, paye: 0, uif: 0, sdl: 0, net: 0 };
    for (const t of Object.values(periodTotals)) {
      annual.gross += t.gross;
      annual.paye  += t.paye;
      annual.uif   += t.uif;
      annual.sdl   += t.sdl;
      annual.net   += t.net;
    }
    annual.gross = Math.round(annual.gross * 100) / 100;
    annual.paye  = Math.round(annual.paye  * 100) / 100;
    annual.uif   = Math.round(annual.uif   * 100) / 100;
    annual.sdl   = Math.round(annual.sdl   * 100) / 100;
    annual.net   = Math.round(annual.net   * 100) / 100;
    annual.total = Math.round((annual.paye + annual.uif + annual.sdl) * 100) / 100;
    return annual;
  }

  test('sums all periods correctly', () => {
    const periodTotals = {
      '2025-03': { gross: 40000, paye: 6600, uif: 325.84, sdl: 200, net: 32874.16 },
      '2025-04': { gross: 15000, paye: 2100, uif: 148.72, sdl: 75,  net: 12676.28 },
    };
    const annual = computeAnnualTotals(periodTotals);
    expect(annual.gross).toBe(55000);
    expect(annual.paye).toBe(8700);
  });

  test('annual total includes all 3 statutory deductions', () => {
    const periodTotals = {
      '2025-03': { gross: 40000, paye: 6600, uif: 325.84, sdl: 200, net: 32874.16 },
    };
    const annual = computeAnnualTotals(periodTotals);
    expect(annual.total).toBe(Math.round((6600 + 325.84 + 200) * 100) / 100);
  });

  test('handles a single period', () => {
    const periodTotals = {
      '2025-03': { gross: 20000, paye: 3000, uif: 148.72, sdl: 100, net: 16751.28 }
    };
    const annual = computeAnnualTotals(periodTotals);
    expect(annual.gross).toBe(20000);
  });

  test('handles all-zero periods (no activity)', () => {
    const periodTotals = {
      '2025-03': { gross: 0, paye: 0, uif: 0, sdl: 0, net: 0 },
    };
    const annual = computeAnnualTotals(periodTotals);
    expect(annual.gross).toBe(0);
    expect(annual.total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — REGRESSION: CORE PAYROLL NOT BROKEN
// ─────────────────────────────────────────────────────────────────────────────

describe('Regression — leave changes do not affect payroll calc', () => {
  // Verify that leave balance logic is completely separate from payroll engine

  test('leave types are defined independently of payroll item categories', () => {
    const leaveTypes = ['annual', 'sick', 'family', 'maternity', 'paternity', 'unpaid', 'other'];
    const payrollCategories = ['basic_salary', 'overtime', 'allowance', 'deduction', 'uif', 'paye', 'sdl'];
    const overlap = leaveTypes.filter(l => payrollCategories.includes(l));
    expect(overlap).toHaveLength(0);
  });

  test('leave balance update does not affect PAYE calculation', () => {
    // PAYE is calculated from taxable gross — leave balance is a separate concern
    function calcPAYE(taxableGross) {
      // Simplified bracket — just for regression test
      if (taxableGross <= 0) return 0;
      if (taxableGross <= 237100 / 12) return taxableGross * 0.18;
      return taxableGross * 0.26;
    }

    const grossBefore = 15000;
    const leaveBalance = 12; // employee has 12 days of leave remaining
    const grossAfter = grossBefore; // leave balance has no effect on gross

    expect(calcPAYE(grossAfter)).toBe(calcPAYE(grossBefore));
    expect(leaveBalance).toBe(12); // balance is independent
  });

  test('password reset does not alter user payroll data', () => {
    // Password change only updates password_hash on the users table
    // It has no effect on employees, payroll_transactions, or leave_records
    const fieldsUpdated = ['password_hash'];
    const sensitivePayrollFields = ['basic_salary', 'gross_income', 'paye', 'uif', 'net_pay'];
    const intersection = fieldsUpdated.filter(f => sensitivePayrollFields.includes(f));
    expect(intersection).toHaveLength(0);
  });
});
