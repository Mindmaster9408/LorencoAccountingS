'use strict';

/**
 * Filed SARS VAT returns (vatReturnsService, migration 189) + the period filter
 * fix that stops late entries counting in two periods. Fictional data only.
 */

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
jest.mock('../modules/accounting/config/database', () => ({
  query: (...a) => mockQuery(...a),
  getClient: async () => ({ query: (...a) => mockClientQuery(...a), release: mockRelease }),
}));
jest.mock('../config/database', () => ({ supabase: {} }));
jest.mock('../modules/accounting/services/vatReconciliationService', () => ({
  createOrGetPeriod: jest.fn(async () => ({ id: 77 })),
  lockPeriod: jest.fn(async () => true),
}));
jest.mock('../modules/accounting/services/vatDetailReportService', () => ({
  generate: jest.fn(),
}));

const svc = require('../modules/accounting/services/vatReturnsService');
const vatDetail = require('../modules/accounting/services/vatDetailReportService');
const vatRecon = require('../modules/accounting/services/vatReconciliationService');
const { PERIOD_JOURNAL_FILTER } = require('../modules/accounting/services/vatReportService');
const { computeTotals, validateReturnFields, ledgerFieldsFromDetail, diffFields, paymentPosition } = svc;

const detailReport = () => ({
  rows: [
    { section: 'output_standard', account: 'Sales', exclusive: 1000, vat: 150, inclusive: 1150 },
    { section: 'input_standard', account: 'Materials', exclusive: 400, vat: 60, inclusive: 460, capital: false },
    { section: 'input_standard', account: 'Vehicles', exclusive: 1000, vat: 150, inclusive: 1150, capital: true },
    { section: 'vat_adjustment', account: 'VAT Output (2300)', exclusive: 0, vat: 5, inclusive: 5 },
    { section: 'output_no_vat', account: 'Sales', exclusive: 300, vat: 0, inclusive: 300 },
  ],
  summary: {
    totals: {
      output_standard: { inclusive: 1150, vat: 150, exclusive: 1000, count: 1 },
      output_no_vat: { inclusive: 300, vat: 0, exclusive: 300, count: 1 },
    },
    tieOut: { ties: true },
  },
});

beforeEach(() => {
  mockQuery.mockReset(); mockClientQuery.mockReset(); mockRelease.mockReset();
  vatRecon.lockPeriod.mockClear(); vatRecon.createOrGetPeriod.mockClear();
  vatDetail.generate.mockReset().mockResolvedValue(detailReport());
});

describe('VAT201 arithmetic', () => {
  test('Total A, Total B and 20', () => {
    expect(computeTotals({ field_4: 150, field_4a: 10, field_9: 1, field_11: 2, field_12: 3, field_14: 20, field_15: 60, field_18: 5 }))
      .toEqual({ field_13: 166, field_19: 85, field_20: 81 });
  });

  test('typed totals that do not add up are refused', () => {
    const { errors } = validateReturnFields({ field_4: 150, field_15: 60, field_13: 999, field_20: 90 });
    expect(errors.join(' ')).toMatch(/Total A \(13\) is 999.00 but the fields add up to 150.00/);
    expect(errors).toHaveLength(1);                 // field 20 = 90 is correct
  });

  test('blank = 0, "R 1 234,00" style input is accepted, totals filled in', () => {
    const { fields, errors } = validateReturnFields({ field_4: 'R1 234.50', field_15: '' });
    expect(errors).toEqual([]);
    expect(fields.field_4).toBe(1234.5);
    expect(fields.field_15).toBe(0);
    expect(fields.field_20).toBe(1234.5);
  });

  test('a non-number is refused', () => {
    expect(validateReturnFields({ field_15: 'abc' }).errors[0]).toMatch(/Field 15 is not a number/);
  });
});

describe("Leo's own VAT201 fields", () => {
  test('maps detail sections onto VAT201 fields (capital → 14, adjustments → 12)', () => {
    const f = ledgerFieldsFromDetail(detailReport());
    expect(f).toEqual(expect.objectContaining({
      field_1: 1150, field_4: 150, field_2: 300, field_12: 5,
      field_14: 150, field_15: 60, field_13: 155, field_19: 210, field_20: -55,
    }));
  });
});

describe('differences and payments', () => {
  test('only fields that differ are listed, Leo minus filed', () => {
    const d = diffFields({ field_4: 160, field_13: 160, field_20: 160 }, { field_4: 150, field_13: 150, field_20: 150 });
    expect(d.map(x => [x.code, x.difference])).toEqual([['4', 10], ['13', 10], ['20', 10]]);
  });

  test('outstanding = 20 − VAT paid + refunds; penalties/interest kept apart; deleted ignored', () => {
    const pos = paymentPosition({ field_20: 1000 }, [
      { payment_type: 'vat', amount: 600 }, { payment_type: 'vat', amount: 300 },
      { payment_type: 'penalty', amount: 50 }, { payment_type: 'vat', amount: 999, deleted_at: '2026-11-01' },
    ]);
    expect(pos).toEqual(expect.objectContaining({ due: 1000, paidVat: 900, penalties: 50, outstanding: 100 }));
  });

  test('refund period: refund received settles a negative 20', () => {
    expect(paymentPosition({ field_20: -400 }, [{ payment_type: 'refund', amount: 400 }]).outstanding).toBe(0);
  });

  test('no filed return → nothing due yet', () => {
    expect(paymentPosition(null, []).outstanding).toBeNull();
  });
});

describe('captureReturn', () => {
  const period = { id: 5, period_key: '2026-10', from_date: '2026-10-01', to_date: '2026-10-31', status: 'open' };

  function wireClient({ previous = null, maxVersion = 0 } = {}) {
    mockClientQuery.mockImplementation(async (sql) => {
      if (/FOR UPDATE/.test(sql)) return { rows: previous ? [previous] : [] };
      if (/MAX\(version\)/.test(sql)) return { rows: [{ v: maxVersion }] };
      if (/^INSERT INTO vat_returns/.test(sql.trim())) return { rows: [{ id: 99, vat_period_id: 5, version: maxVersion + 1, status: 'filed', field_20: 150 }] };
      return { rows: [] };
    });
  }

  test('first capture: version 1, ledger snapshot stored, period locked', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [period] });
    wireClient();
    const r = await svc.captureReturn(1, 7, { periodId: 5, filedDate: '2026-11-20', sarsReference: 'REF', fields: { field_4: 150 } });
    expect(r.saved.version).toBe(1);
    expect(r.supersededReturnId).toBeNull();
    const insert = mockClientQuery.mock.calls.find(c => /^INSERT INTO vat_returns/.test(c[0].trim()));
    expect(JSON.parse(insert[1].find(v => typeof v === 'string' && v.includes('capturedAt'))).fields.field_4).toBe(150);
    expect(mockClientQuery.mock.calls.map(c => c[0].trim().split(/\s/)[0])).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(vatRecon.lockPeriod).toHaveBeenCalledWith(1, 5, 7);
    expect(mockRelease).toHaveBeenCalled();
  });

  test('second capture = revision: previous superseded and linked, version 2', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...period, status: 'LOCKED' }] });
    wireClient({ previous: { id: 40, version: 1 }, maxVersion: 1 });
    const r = await svc.captureReturn(1, 7, { periodId: 5, filedDate: '2026-12-01', fields: { field_4: 160 } });
    expect(r.saved.version).toBe(2);
    expect(r.supersededReturnId).toBe(40);
    const sqls = mockClientQuery.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /SET status = 'superseded'/.test(s))).toBe(true);
    expect(sqls.some(s => /superseded_by_return_id = \$1/.test(s))).toBe(true);
    expect(vatRecon.lockPeriod).not.toHaveBeenCalled();     // already locked
  });

  test('a failure rolls back and releases the connection', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [period] });
    mockClientQuery.mockImplementation(async (sql) => {
      if (/^INSERT INTO vat_returns/.test(sql.trim())) throw new Error('boom');
      if (/MAX\(version\)/.test(sql)) return { rows: [{ v: 0 }] };
      return { rows: [] };
    });
    await expect(svc.captureReturn(1, 7, { periodId: 5, filedDate: '2026-11-20', fields: {} })).rejects.toThrow('boom');
    expect(mockClientQuery.mock.calls.map(c => c[0])).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
    expect(vatRecon.lockPeriod).not.toHaveBeenCalled();
  });

  test('older period is created first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...period, id: 77, period_key: '2024-02' }] });
    wireClient();
    await svc.captureReturn(1, 7, { newPeriod: { periodKey: '2024-02', fromDate: '2024-01-01', toDate: '2024-02-29' }, filedDate: '2024-03-25', fields: {} });
    expect(vatRecon.createOrGetPeriod).toHaveBeenCalledWith(1, expect.objectContaining({ periodKey: '2024-02', fromDate: '2024-01-01', toDate: '2024-02-29' }));
  });

  test('bad input is refused before anything is written', async () => {
    await expect(svc.captureReturn(1, 7, { periodId: 5, fields: { field_13: 5 } })).rejects.toMatchObject({ status: 400 });
    expect(mockClientQuery).not.toHaveBeenCalled();
  });
});

describe('payments', () => {
  test('amount must be positive; foreign bank line refused', async () => {
    await expect(svc.addPayment(1, 7, { periodId: 5, paymentDate: '2026-11-25', amount: 0 })).rejects.toMatchObject({ status: 400 });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }] })      // period exists
      .mockResolvedValueOnce({ rows: [] });                       // bank txn not in this company
    await expect(svc.addPayment(1, 7, { periodId: 5, paymentDate: '2026-11-25', amount: 100, bankTransactionId: 123 }))
      .rejects.toThrow(/Bank transaction not found/);
  });
});

describe('period filter (late entries no longer count twice)', () => {
  test('a journal swept to another period is excluded from its old date range', () => {
    expect(PERIOD_JOURNAL_FILTER).toMatch(/NOT \(COALESCE\(j\.is_out_of_period, false\) = true AND j\.vat_period_id IS DISTINCT FROM \$4\)/);
    expect(PERIOD_JOURNAL_FILTER).toMatch(/OR \(j\.vat_period_id = \$4 AND j\.is_out_of_period = true\)/);
  });
});

describe('bot (MCP) cannot capture SARS returns', () => {
  const { blockReason } = require('../modules/mcp/lorencoApi');
  test('writes blocked, reading allowed', () => {
    expect(blockReason('POST', '/api/accounting/vat-returns/returns')).toMatch(/done by a person/);
    expect(blockReason('POST', '/api/accounting/vat-returns/payments')).toMatch(/done by a person/);
    expect(blockReason('DELETE', '/api/accounting/vat-returns/payments/3')).toMatch(/done by a person/);
    expect(blockReason('GET', '/api/accounting/vat-returns/overview')).toBeNull();
  });
});
