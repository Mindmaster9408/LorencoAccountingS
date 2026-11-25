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
const { computeTotals, validateReturnFields, ledgerFieldsFromDetail, diffFields, paymentPosition,
  remainingToCorrect, validateCarry, nextMonthAfter } = svc;

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
  mockQuery.mockReset().mockResolvedValue({ rows: [] }); mockClientQuery.mockReset(); mockRelease.mockReset();
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

// ── Step 2: carrying differences into a later return (migration 190) ──────────
describe('corrections: what is left to correct', () => {
  const diffs = [{ key: 'field_13', difference: 300 }, { key: 'field_19', difference: -40 }];

  test('difference minus active corrections; cancelled ones ignored', () => {
    const r = remainingToCorrect(diffs, [
      { status: 'active', output_vat: 100, input_vat: -40 },
      { status: 'cancelled', output_vat: 200, input_vat: 0 },
    ]);
    expect(r).toEqual({ outputDifference: 300, inputDifference: -40, carriedOutput: 100, carriedInput: -40, output: 200, input: 0 });
  });

  test('carry up to what is left, same direction', () => {
    const rem = { output: 200, input: -40 };
    expect(validateCarry(rem, '200', '-40').errors).toEqual([]);
    expect(validateCarry(rem, 150, '').outputVat).toBe(150);
  });

  test('more than what is left would correct twice → refused', () => {
    expect(validateCarry({ output: 200, input: 0 }, 250, 0).errors[0]).toMatch(/Only 200.00 output VAT \(field 12\) is still uncorrected/);
  });

  test('wrong direction, nothing left, or both zero → refused', () => {
    expect(validateCarry({ output: 200, input: 0 }, -10, 0).errors[0]).toMatch(/must be positive/);
    expect(validateCarry({ output: 200, input: 0 }, 0, 5).errors[0]).toMatch(/no uncorrected input VAT/);
    expect(validateCarry({ output: 200, input: 0 }, 0, 0).errors[0]).toMatch(/Give an output and\/or input/);
  });

  test('next month suggestion', () => {
    expect(nextMonthAfter('2026-11-30')).toEqual({ periodKey: '2026-12', fromDate: '2026-12-01', toDate: '2026-12-31' });
    expect(nextMonthAfter('2026-12-31')).toEqual({ periodKey: '2027-01', fromDate: '2027-01-01', toDate: '2027-01-31' });
    expect(nextMonthAfter('2028-01-31').toDate).toBe('2028-02-29');
  });

  test("corrections carried INTO a period land in Leo's field 12 / 18", () => {
    const rep = detailReport();
    rep.summary.corrections = { items: [{}], outputVat: 300, inputVat: -40 };
    const f = ledgerFieldsFromDetail(rep);
    expect(f.field_12).toBe(305);            // 5 ledger adjustment + 300 carried
    expect(f.field_18).toBe(-40);
    expect(f.field_13).toBe(455);
    expect(f.field_20).toBe(455 - 170);
  });
});

describe('carryCorrection', () => {
  const source = { id: 5, period_key: '2026-09', from_date: '2026-09-01', to_date: '2026-09-30', status: 'LOCKED' };
  const target = { id: 6, period_key: '2026-11', from_date: '2026-11-01', to_date: '2026-11-30', status: 'DRAFT' };
  const filed = { id: 40, version: 1, status: 'filed', field_4: 150, field_13: 150, field_19: 210, field_15: 60, field_14: 150, field_20: -60 };
  // Leo now (detailReport): field_13 155, field_19 210 → output difference 5

  function wire({ carried = [], targetFiled = false, lockId = 40 } = {}) {
    mockQuery
      .mockResolvedValueOnce({ rows: [source] })         // _period(source)
      .mockResolvedValueOnce({ rows: [filed] })          // current filed return
      .mockResolvedValueOnce({ rows: [target] });        // _period(target)
    mockClientQuery.mockImplementation(async (sql) => {
      if (/FOR UPDATE/.test(sql)) return { rows: lockId ? [{ id: lockId }] : [] };
      if (/SELECT 1 FROM vat_returns/.test(sql)) return { rows: targetFiled ? [{}] : [] };
      if (/FROM vat_corrections/.test(sql)) return { rows: carried };
      if (/INSERT INTO vat_corrections/.test(sql)) return { rows: [{ id: 9, output_vat: 5, input_vat: 0, status: 'active' }] };
      return { rows: [] };
    });
  }

  test('carries the uncorrected output difference into the later period', async () => {
    wire();
    const r = await svc.carryCorrection(1, 7, { sourcePeriodId: 5, targetPeriodId: 6, outputVat: 5, reason: 'invoice after filing' });
    expect(r.correction).toEqual(expect.objectContaining({ id: 9, source_period_key: '2026-09', target_period_key: '2026-11' }));
    const ins = mockClientQuery.mock.calls.find(c => /INSERT INTO vat_corrections/.test(c[0]));
    expect(ins[1]).toEqual([1, 5, 40, 6, 5, 0, 'invoice after filing', 7]);
    expect(mockClientQuery.mock.calls.map(c => c[0])).toContain('COMMIT');
  });

  test('already carried → second carry refused (no double correction)', async () => {
    wire({ carried: [{ status: 'active', output_vat: 5, input_vat: 0 }] });
    await expect(svc.carryCorrection(1, 7, { sourcePeriodId: 5, targetPeriodId: 6, outputVat: 5, reason: 'again' }))
      .rejects.toThrow(/no uncorrected output VAT/);
    expect(mockClientQuery.mock.calls.map(c => c[0])).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  test('target already filed → refused', async () => {
    wire({ targetFiled: true });
    await expect(svc.carryCorrection(1, 7, { sourcePeriodId: 5, targetPeriodId: 6, outputVat: 5, reason: 'x' }))
      .rejects.toThrow(/already filed/);
  });

  test('target not after the source → refused', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [filed] })
      .mockResolvedValueOnce({ rows: [{ ...target, from_date: '2026-08-01', to_date: '2026-08-31' }] });
    await expect(svc.carryCorrection(1, 7, { sourcePeriodId: 5, targetPeriodId: 6, outputVat: 5, reason: 'x' }))
      .rejects.toThrow(/period after the one being corrected/);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  test('no filed return yet, or no reason → refused', async () => {
    await expect(svc.carryCorrection(1, 7, { sourcePeriodId: 5, targetPeriodId: 6, outputVat: 5 })).rejects.toThrow(/reason is required/);
    mockQuery.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] });
    await expect(svc.carryCorrection(1, 7, { sourcePeriodId: 5, targetPeriodId: 6, outputVat: 5, reason: 'x' }))
      .rejects.toThrow(/Capture the filed return/);
  });

  test('return revised meanwhile → 409', async () => {
    wire({ lockId: 41 });
    await expect(svc.carryCorrection(1, 7, { sourcePeriodId: 5, targetPeriodId: 6, outputVat: 5, reason: 'x' }))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe('cancelCorrection + revision guard', () => {
  test('cannot cancel once the later return is filed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })                    // UPDATE matched nothing
      .mockResolvedValueOnce({ rows: [{ status: 'active' }] });
    await expect(svc.cancelCorrection(1, 7, 9, 'oops')).rejects.toThrow(/already filed/);
  });

  test('cancel works while the later return is not filed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 9, status: 'cancelled' }] });
    expect((await svc.cancelCorrection(1, 7, 9, 'wrong amount')).status).toBe('cancelled');
    expect(mockQuery.mock.calls[0][0]).toMatch(/NOT EXISTS[\s\S]*status = 'filed'/);
  });

  test('revision of a period whose difference was carried needs confirmation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, period_key: '2026-09', from_date: '2026-09-01', to_date: '2026-09-30', status: 'LOCKED' }] })
      .mockResolvedValueOnce({ rows: [{ id: 9, status: 'active', target_period_key: '2026-11' }] });
    await expect(svc.captureReturn(1, 7, { periodId: 5, filedDate: '2026-12-01', fields: {} }))
      .rejects.toMatchObject({ status: 409, code: 'CORRECTIONS_EXIST' });
    expect(mockClientQuery).not.toHaveBeenCalled();
  });
});

describe('bot (MCP) cannot carry corrections', () => {
  const { blockReason } = require('../modules/mcp/lorencoApi');
  test('blocked', () => {
    expect(blockReason('POST', '/api/accounting/vat-returns/corrections')).toMatch(/done by a person/);
    expect(blockReason('POST', '/api/accounting/vat-returns/corrections/9/cancel')).toMatch(/done by a person/);
  });
});
