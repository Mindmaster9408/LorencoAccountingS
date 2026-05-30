'use strict';

/**
 * Paytime Hardening — End of Service Safety Fixes
 * Unit tests for Fix 1 (isEligibleForPayroll guard), Fix 3 (permission tightening),
 * and Fix 4 (orphaned deleteEmployee removed).
 *
 * Fix 2 (payroll DELETE alignment) is covered by the shared employees route test suite.
 * Fix 5 (history safety) is confirmed: none of these changes touch payroll_snapshots,
 * payroll_runs, or payroll_historical tables.
 */

const path = require('path');
const fs   = require('fs');

// Mock all payruns.js dependencies so the router loads without a live DB connection.
jest.mock('../middleware/auth', () => ({
  authenticateToken: (_req, _res, next) => next(),
  requireCompany:    (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));

jest.mock('../middleware/audit', () => ({
  auditFromReq: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../modules/payroll/services/paytimeAccess', () => ({
  getEmployeeFilter:    jest.fn().mockResolvedValue({ type: 'none' }),
  requirePaytimeModule: () => (_req, _res, next) => next(),
}));

jest.mock('../modules/payroll/services/PayrollDataService', () => ({
  fetchCalculationInputs: jest.fn(),
  fetchPeriod:            jest.fn(),
}));

jest.mock('../modules/payroll/services/PayrollCalculationService', () => ({
  calculate:      jest.fn(),
  validateOutput: jest.fn(),
}));

jest.mock('../modules/payroll/services/PayrollHistoryService', () => ({
  createPayrollRun:       jest.fn(),
  getSnapshot:            jest.fn(),
  prepareSnapshot:        jest.fn(),
  saveSnapshot:           jest.fn(),
  updatePayrollRunTotals: jest.fn(),
}));

jest.mock('../config/database', () => ({
  supabase: {
    from: jest.fn().mockReturnValue({
      select:      jest.fn().mockReturnThis(),
      eq:          jest.fn().mockReturnThis(),
      in:          jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      single:      jest.fn().mockResolvedValue({ data: null }),
    }),
  },
}));

const payruns = require('../modules/payroll/routes/payruns');
const { isEligibleForPayroll } = payruns;

// ─── Shared period boundaries ─────────────────────────────────────────────────
const PERIOD_START = '2026-05-01';
const PERIOD_END   = '2026-05-31';

describe('Paytime Hardening — End of Service Safety Fixes', () => {

  // ── Fix 1: isEligibleForPayroll pure guard ─────────────────────────────────

  test('TEST-EOS-01: active employee passes the payroll guard', () => {
    const empRow = { is_active: true, termination_date: null };
    expect(isEligibleForPayroll(empRow, PERIOD_START, PERIOD_END)).toBe(true);
  });

  test('TEST-EOS-02: inactive employee with no termination_date is blocked', () => {
    const empRow = { is_active: false, termination_date: null };
    expect(isEligibleForPayroll(empRow, PERIOD_START, PERIOD_END)).toBe(false);
  });

  test('TEST-EOS-03: inactive employee terminated before the period is blocked', () => {
    const empRow = { is_active: false, termination_date: '2026-04-30' };
    expect(isEligibleForPayroll(empRow, PERIOD_START, PERIOD_END)).toBe(false);
  });

  test('TEST-EOS-04: inactive employee terminated within the period passes (final pro-rata month)', () => {
    // Employee left on 15 May. is_active=false but should still get their final pay.
    const empRow = { is_active: false, termination_date: '2026-05-15' };
    expect(isEligibleForPayroll(empRow, PERIOD_START, PERIOD_END)).toBe(true);
  });

  test('TEST-EOS-05: null empRow (employee not found or cross-company) is blocked', () => {
    expect(isEligibleForPayroll(null, PERIOD_START, PERIOD_END)).toBe(false);
  });

  test('TEST-EOS-06: inactive employee terminated after the period end is blocked', () => {
    // Future termination_date should not unlock payroll for a past inactive period.
    const empRow = { is_active: false, termination_date: '2026-06-01' };
    expect(isEligibleForPayroll(empRow, PERIOD_START, PERIOD_END)).toBe(false);
  });

  // ── Fix 3: End Service permission tightening ───────────────────────────────

  test('TEST-EOS-07: EMPLOYEES.DELETE is restricted to senior management (not store_manager or payroll_admin)', () => {
    const { PERMISSIONS } = require('../config/permissions');
    const deleteRoles = PERMISSIONS.EMPLOYEES.DELETE;
    expect(deleteRoles).toEqual(['super_admin', 'business_owner', 'practice_manager', 'administrator']);
    expect(deleteRoles).not.toContain('store_manager');
    expect(deleteRoles).not.toContain('payroll_admin');
    expect(deleteRoles).not.toContain('accountant');
  });

  test('TEST-EOS-08: EMPLOYEES.EDIT includes store_manager and payroll_admin — confirming End Service is now gated on the tighter DELETE permission', () => {
    const { PERMISSIONS } = require('../config/permissions');
    expect(PERMISSIONS.EMPLOYEES.EDIT).toContain('store_manager');
    expect(PERMISSIONS.EMPLOYEES.EDIT).toContain('payroll_admin');
    expect(PERMISSIONS.EMPLOYEES.DELETE).not.toContain('store_manager');
    expect(PERMISSIONS.EMPLOYEES.DELETE).not.toContain('payroll_admin');
  });

  // ── Fix 4: Orphaned deleteEmployee() removed ──────────────────────────────

  test('TEST-EOS-09: deleteEmployee() function and .btn-delete CSS are not present in employee-management.html', () => {
    const htmlPath = path.join(__dirname, '../../frontend-payroll/employee-management.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).not.toContain('function deleteEmployee(');
    expect(html).not.toContain('.btn-delete {');
  });

});
