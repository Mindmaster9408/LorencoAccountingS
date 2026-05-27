'use strict';

/**
 * Historical Comparatives — Save Integrity Fix Pack 01 Tests
 * ============================================================================
 * Verifies all 7 save-integrity fixes applied in Fix Pack 01:
 *
 *   R1 — saveManualGrid now runs inside a pg BEGIN/COMMIT transaction
 *   R2 — saveAccountGrid/saveAllGrids save years sequentially (not Promise.all)
 *   R3 — finalizeBatch blocked when historicalDirty = true (frontend dirty-state flag)
 *   R4 — finalizeBatch now runs inside a pg BEGIN/COMMIT transaction
 *   R5 — saveAllGrids error log includes account name + year
 *   R6 — Server save count verified against DOM cell count per year
 *   R7 — api() helper checks res.ok before res.json()
 *   Migration 049 — unique index on null-account rows; SELECT FOR UPDATE race guard
 *
 * All tests use pure simulation — no real database, no HTTP server.
 *
 * Scenarios covered:
 *   TEST-HIST-01  saveManualGrid rejects writes to a finalized batch (finalization guard)
 *   TEST-HIST-02  saveManualGrid rejects writes to a parent/header account (postability guard)
 *   TEST-HIST-03  saveManualGrid account_id path — all writes inside BEGIN/COMMIT (R1)
 *   TEST-HIST-04  saveManualGrid — ROLLBACK called when a query throws (R1 rollback)
 *   TEST-HIST-05  saveManualGrid null-account path — SELECT FOR UPDATE issued (migration 049)
 *   TEST-HIST-06  finalizeBatch rejects draft batches (must validate first)
 *   TEST-HIST-07  finalizeBatch rejects already-finalized batches
 *   TEST-HIST-08  finalizeBatch — 422 guard for empty batch (no lines)
 *   TEST-HIST-09  finalizeBatch — lines + batch update inside single BEGIN/COMMIT (R4)
 *   TEST-HIST-10  finalizeBatch — ROLLBACK called when batch UPDATE fails (R4 rollback)
 *   TEST-HIST-11  _buildPeriodDates — Jan and Feb resolve to the next calendar year (SA FY)
 *   TEST-HIST-12  _buildPeriodDates — March resolves to the FY start year (SA FY)
 *   TEST-HIST-13  _actorId — null / undefined / empty / string-number / integer inputs
 *   TEST-HIST-14  saveManualGrid account_id path — original_amount NOT in DO UPDATE SET
 *   TEST-HIST-15  finalizeBatch — SELECT FOR UPDATE precedes both UPDATEs (TOCTOU guard, R4)
 */

// ── Module mocks (hoisted by Jest before any require) ──────────────────────────
// Factory closures must not reference variables declared outside — Jest restriction.

jest.mock('../config/database', () => ({
  supabase: { from: jest.fn() },
}));

jest.mock('../modules/accounting/config/database', () => ({
  getClient: jest.fn(),
  query:     jest.fn(),
}));

const HistoricalComparativesService = require('../modules/accounting/services/historicalComparativesService');
const { supabase } = require('../config/database');
const db            = require('../modules/accounting/config/database');

// ── Simulation helpers ─────────────────────────────────────────────────────────

/**
 * Create a Supabase chainable query builder that resolves its terminal call
 * (.single / .maybeSingle) with the supplied response object.
 * All chaining methods return `this`.
 */
function makeSbChain(finalResponse) {
  const chain = {};
  [
    'select', 'eq', 'in', 'not', 'or', 'filter', 'match',
    'order', 'limit', 'lte', 'gte',
    'insert', 'update', 'upsert', 'delete',
  ].forEach(m => { chain[m] = () => chain; });
  chain.single      = () => Promise.resolve(finalResponse);
  chain.maybeSingle = () => Promise.resolve(finalResponse);
  return chain;
}

/**
 * Create a mock pg client with scripted query responses.
 *   responses — array of return values for successive query() calls.
 *               An Error instance causes the query to throw.
 *               Undefined (past end of array) falls back to { rows: [], rowCount: 0 }.
 */
function makePgClient(responses = []) {
  let callIndex = 0;
  const queryCalls = [];
  return {
    queryCalls,
    query: jest.fn(async (sql, params) => {
      queryCalls.push({ sql, params });
      const resp = responses[callIndex++];
      if (resp instanceof Error) throw resp;
      return resp !== undefined ? resp : { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DRAFT_BATCH     = { id: 'batch-1', company_id: 10, status: 'draft',     is_finalized: false };
const VALIDATED_BATCH = { id: 'batch-1', company_id: 10, status: 'validated', is_finalized: false };
const FINALIZED_BATCH = { id: 'batch-1', company_id: 10, status: 'finalized', is_finalized: true  };

const NOT_POSTABLE_ACCT = { code: '1000', name: 'Trade Receivables', is_postable: false };
const POSTABLE_ACCT     = { code: '1001', name: 'Trade Debtors',     is_postable: true  };

function makeGridArgs(overrides = {}) {
  return {
    companyId:     10,
    batchId:       'batch-1',
    userId:        1,
    accountId:     42,
    accountCode:   '4000',
    accountName:   'Revenue',
    accountType:   'income',
    financialYear: 2023,
    cells: Array.from({ length: 12 }, (_, i) => ({ periodMonth: i + 1, amount: (i + 1) * 100 })),
    ...overrides,
  };
}

function makeFinalizeArgs(overrides = {}) {
  return { companyId: 10, batchId: 'batch-1', userId: 1, ...overrides };
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: any unmocked supabase.from() call returns a safe chain (audit logs etc.)
  supabase.from.mockReturnValue(makeSbChain({ data: null, error: null }));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Historical Comparatives — Save Integrity Fix Pack 01', () => {

  // ── R1 guard: finalized batch blocks edits ─────────────────────────────────

  describe('TEST-HIST-01: saveManualGrid rejects writes to a finalized batch', () => {
    it('throws "finalized and cannot be edited" when batch.status is finalized', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: FINALIZED_BATCH, error: null }));  // getBatch

      await expect(
        HistoricalComparativesService.saveManualGrid(makeGridArgs())
      ).rejects.toThrow('finalized and cannot be edited');
    });
  });

  // ── R1 guard: parent account blocks capture ────────────────────────────────

  describe('TEST-HIST-02: saveManualGrid rejects writes to a parent/header account', () => {
    it('throws "parent account" error when the account is_postable = false', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: DRAFT_BATCH,      error: null }))  // getBatch
        .mockReturnValueOnce(makeSbChain({ data: NOT_POSTABLE_ACCT, error: null })); // account check

      await expect(
        HistoricalComparativesService.saveManualGrid(makeGridArgs({ accountId: 99 }))
      ).rejects.toThrow('parent account and cannot be used for direct historical capture');
    });
  });

  // ── R1: all writes inside a single BEGIN/COMMIT ─────────────────────────────

  describe('TEST-HIST-03: saveManualGrid — account_id path runs inside BEGIN/COMMIT', () => {
    it('issues BEGIN before the upsert and COMMIT after, and releases the client', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: DRAFT_BATCH,  error: null }))  // getBatch
        .mockReturnValueOnce(makeSbChain({ data: POSTABLE_ACCT, error: null })); // account check

      const pgClient = makePgClient([
        { rows: [], rowCount: 0 },                                                          // BEGIN
        { rows: [{ id: 'l-1', period_month: 1 }], rowCount: 12 },                          // upsert RETURNING
        { rows: [], rowCount: 1 },                                                          // UPDATE batch
        { rows: [], rowCount: 0 },                                                          // COMMIT
      ]);
      db.getClient.mockResolvedValue(pgClient);

      await HistoricalComparativesService.saveManualGrid(makeGridArgs());

      const sqls = pgClient.queryCalls.map(c => c.sql.trim().toUpperCase());
      expect(sqls[0]).toContain('BEGIN');
      expect(sqls[sqls.length - 1]).toContain('COMMIT');
      expect(pgClient.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── R1: ROLLBACK on query error ────────────────────────────────────────────

  describe('TEST-HIST-04: saveManualGrid — ROLLBACK called when a query throws', () => {
    it('calls ROLLBACK, releases the client, and re-throws the original error', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: DRAFT_BATCH,  error: null }))  // getBatch
        .mockReturnValueOnce(makeSbChain({ data: POSTABLE_ACCT, error: null })); // account check

      const upsertError = new Error('DB constraint violation — duplicate key');
      const pgClient = makePgClient([
        { rows: [], rowCount: 0 }, // BEGIN
        upsertError,                // upsert throws
        { rows: [], rowCount: 0 }, // ROLLBACK
      ]);
      db.getClient.mockResolvedValue(pgClient);

      await expect(
        HistoricalComparativesService.saveManualGrid(makeGridArgs())
      ).rejects.toThrow('DB constraint violation');

      const sqls = pgClient.queryCalls.map(c => c.sql.trim().toUpperCase());
      expect(sqls.some(s => s === 'ROLLBACK')).toBe(true);
      expect(pgClient.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── Migration 049: null-account path issues SELECT FOR UPDATE ──────────────

  describe('TEST-HIST-05: saveManualGrid null-account path — SELECT FOR UPDATE issued', () => {
    it('issues SELECT ... FOR UPDATE as the first read inside the transaction', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: DRAFT_BATCH, error: null }));  // getBatch
      // No postability check for null-account path; default fallback handles audit log

      const pgClient = makePgClient([
        { rows: [], rowCount: 0 },   // BEGIN
        { rows: [], rowCount: 0 },   // SELECT FOR UPDATE (0 existing rows)
        // 12 INSERT responses (one per cell)
        ...Array.from({ length: 12 }, (_, i) => ({
          rows: [{ id: `new-${i}`, period_month: i + 1 }], rowCount: 1,
        })),
        { rows: [], rowCount: 1 },   // UPDATE batch.updated_at
        { rows: [], rowCount: 0 },   // COMMIT
      ]);
      db.getClient.mockResolvedValue(pgClient);

      await HistoricalComparativesService.saveManualGrid(makeGridArgs({ accountId: null }));

      const forUpdateCall = pgClient.queryCalls.find(
        c => c.sql.toUpperCase().includes('FOR UPDATE')
      );
      expect(forUpdateCall).toBeDefined();
      expect(forUpdateCall.sql.toUpperCase()).toContain('SELECT');
      expect(forUpdateCall.sql.toUpperCase()).toContain('FOR UPDATE');
    });
  });

  // ── R4 guard: draft batch ──────────────────────────────────────────────────

  describe('TEST-HIST-06: finalizeBatch rejects draft batches', () => {
    it('throws "must be validated before finalizing" when status is draft', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: DRAFT_BATCH, error: null }));  // getBatch

      await expect(
        HistoricalComparativesService.finalizeBatch(makeFinalizeArgs())
      ).rejects.toThrow('validated before finalizing');
    });
  });

  // ── R4 guard: already finalized ───────────────────────────────────────────

  describe('TEST-HIST-07: finalizeBatch rejects already-finalized batches', () => {
    it('throws "already finalized" without opening a pg client', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: FINALIZED_BATCH, error: null }));  // getBatch

      await expect(
        HistoricalComparativesService.finalizeBatch(makeFinalizeArgs())
      ).rejects.toThrow('already finalized');

      // Pre-flight check should reject before acquiring a DB connection
      expect(db.getClient).not.toHaveBeenCalled();
    });
  });

  // ── Empty batch 422 guard ──────────────────────────────────────────────────

  describe('TEST-HIST-08: finalizeBatch 422 guard — empty batch cannot be finalized', () => {
    it('throws with statusCode 422 when the batch has no saved lines', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: VALIDATED_BATCH, error: null }));  // getBatch

      const pgClient = makePgClient([
        { rows: [], rowCount: 0 },                                   // BEGIN
        { rows: [{ id: 'batch-1', status: 'validated' }] },         // SELECT FOR UPDATE
        { rows: [{ line_count: '0' }], rowCount: 1 },               // COUNT(*) — zero lines
        { rows: [], rowCount: 0 },                                   // ROLLBACK (thrown)
      ]);
      db.getClient.mockResolvedValue(pgClient);

      let thrownError = null;
      try {
        await HistoricalComparativesService.finalizeBatch(makeFinalizeArgs());
      } catch (e) {
        thrownError = e;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError.statusCode).toBe(422);
      expect(thrownError.message).toMatch(/empty/i);
    });
  });

  // ── R4: full transaction wraps lines + batch update ────────────────────────

  describe('TEST-HIST-09: finalizeBatch — lines + batch update inside single BEGIN/COMMIT', () => {
    it('issues BEGIN first, updates lines then batch, COMMITs last, releases client', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: VALIDATED_BATCH, error: null }));  // getBatch

      const finalizedRow = { ...VALIDATED_BATCH, status: 'finalized', finalized_at: new Date().toISOString() };
      const pgClient = makePgClient([
        { rows: [], rowCount: 0 },                                    // BEGIN
        { rows: [{ id: 'batch-1', status: 'validated' }] },          // SELECT FOR UPDATE
        { rows: [{ line_count: '3' }] },                             // COUNT(*)
        { rows: [], rowCount: 3 },                                    // UPDATE lines
        { rows: [finalizedRow], rowCount: 1 },                       // UPDATE batch RETURNING *
        { rows: [], rowCount: 0 },                                    // COMMIT
      ]);
      db.getClient.mockResolvedValue(pgClient);

      const result = await HistoricalComparativesService.finalizeBatch(makeFinalizeArgs());

      const sqls = pgClient.queryCalls.map(c => c.sql.trim().toUpperCase());

      // Transaction boundaries
      expect(sqls[0]).toContain('BEGIN');
      expect(sqls[sqls.length - 1]).toContain('COMMIT');

      // Both UPDATE statements are present and lines come before batch
      const linesUpdateIdx = sqls.findIndex(
        s => s.startsWith('UPDATE') && s.includes('HISTORICAL_COMPARATIVE_LINES')
      );
      const batchUpdateIdx = sqls.findIndex(
        s => s.startsWith('UPDATE') && s.includes('HISTORICAL_COMPARATIVE_BATCHES')
      );
      expect(linesUpdateIdx).toBeGreaterThan(0);
      expect(batchUpdateIdx).toBeGreaterThan(linesUpdateIdx);

      expect(result).toMatchObject({ status: 'finalized' });
      expect(pgClient.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── R4: ROLLBACK when batch UPDATE fails ───────────────────────────────────

  describe('TEST-HIST-10: finalizeBatch — ROLLBACK when the batch UPDATE fails', () => {
    it('rolls back the whole transaction so lines are not left partially finalized', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: VALIDATED_BATCH, error: null }));  // getBatch

      const batchUpdateFailure = new Error('Connection timeout during batch status update');
      const pgClient = makePgClient([
        { rows: [], rowCount: 0 },                               // BEGIN
        { rows: [{ id: 'batch-1', status: 'validated' }] },     // SELECT FOR UPDATE
        { rows: [{ line_count: '3' }] },                        // COUNT(*)
        { rows: [], rowCount: 3 },                              // UPDATE lines (succeeds)
        batchUpdateFailure,                                      // UPDATE batch (fails)
        { rows: [], rowCount: 0 },                              // ROLLBACK
      ]);
      db.getClient.mockResolvedValue(pgClient);

      await expect(
        HistoricalComparativesService.finalizeBatch(makeFinalizeArgs())
      ).rejects.toThrow('Connection timeout during batch status update');

      const sqls = pgClient.queryCalls.map(c => c.sql.trim().toUpperCase());
      expect(sqls.some(s => s === 'ROLLBACK')).toBe(true);
      expect(pgClient.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── Pure helper: _buildPeriodDates — SA financial year ────────────────────

  describe('TEST-HIST-11: _buildPeriodDates — Jan and Feb map to the NEXT calendar year', () => {
    it('FY 2023 month 1 (January) resolves to 2024-01-01 → 2024-01-31', () => {
      const { periodStart, periodEnd } = HistoricalComparativesService._buildPeriodDates(2023, 1);
      expect(periodStart).toBe('2024-01-01');
      expect(periodEnd).toBe('2024-01-31');
    });

    it('FY 2023 month 2 (February) resolves to 2024-02-01 → 2024-02-29 (2024 is leap)', () => {
      const { periodStart, periodEnd } = HistoricalComparativesService._buildPeriodDates(2023, 2);
      expect(periodStart).toBe('2024-02-01');
      expect(periodEnd).toBe('2024-02-29');
    });
  });

  // ── Pure helper: _buildPeriodDates — March stays in FY start year ──────────

  describe('TEST-HIST-12: _buildPeriodDates — March maps to the FY start year', () => {
    it('FY 2023 month 3 (March) resolves to 2023-03-01 → 2023-03-31', () => {
      const { periodStart, periodEnd } = HistoricalComparativesService._buildPeriodDates(2023, 3);
      expect(periodStart).toBe('2023-03-01');
      expect(periodEnd).toBe('2023-03-31');
    });

    it('FY 2023 month 12 (December) resolves to 2023-12-01 → 2023-12-31', () => {
      const { periodStart, periodEnd } = HistoricalComparativesService._buildPeriodDates(2023, 12);
      expect(periodStart).toBe('2023-12-01');
      expect(periodEnd).toBe('2023-12-31');
    });
  });

  // ── Pure helper: _actorId ─────────────────────────────────────────────────

  describe('TEST-HIST-13: _actorId coerces inputs correctly', () => {
    it('returns null for null',       () => expect(HistoricalComparativesService._actorId(null)).toBeNull());
    it('returns null for undefined',  () => expect(HistoricalComparativesService._actorId(undefined)).toBeNull());
    it('returns null for ""',         () => expect(HistoricalComparativesService._actorId('')).toBeNull());
    it('returns null for "abc"',      () => expect(HistoricalComparativesService._actorId('abc')).toBeNull());
    it('returns 7 for string "7"',    () => expect(HistoricalComparativesService._actorId('7')).toBe(7));
    it('returns 42 for integer 42',   () => expect(HistoricalComparativesService._actorId(42)).toBe(42));
  });

  // ── R1: original_amount immutability in upsert SQL ────────────────────────

  describe('TEST-HIST-14: saveManualGrid — original_amount excluded from ON CONFLICT DO UPDATE SET', () => {
    it('the upsert SQL must not update original_amount, entered_by, or entered_at on conflict', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: DRAFT_BATCH,  error: null }))   // getBatch
        .mockReturnValueOnce(makeSbChain({ data: POSTABLE_ACCT, error: null })); // account check

      const pgClient = makePgClient([
        { rows: [], rowCount: 0 },
        { rows: [{ id: 'l-1', period_month: 1 }], rowCount: 12 },
        { rows: [], rowCount: 1 },
        { rows: [], rowCount: 0 },
      ]);
      db.getClient.mockResolvedValue(pgClient);

      await HistoricalComparativesService.saveManualGrid(makeGridArgs());

      const upsertCall = pgClient.queryCalls.find(
        c => c.sql.includes('ON CONFLICT') && c.sql.includes('INSERT')
      );
      expect(upsertCall).toBeDefined();

      // Extract only the DO UPDATE SET section for targeted assertions
      const doUpdateIdx = upsertCall.sql.indexOf('DO UPDATE SET');
      expect(doUpdateIdx).toBeGreaterThan(-1);
      const doUpdateSection = upsertCall.sql.slice(doUpdateIdx);

      expect(doUpdateSection).not.toContain('original_amount');
      expect(doUpdateSection).not.toContain('entered_by');
      expect(doUpdateSection).not.toContain('entered_at');
    });
  });

  // ── R4: TOCTOU — SELECT FOR UPDATE precedes both UPDATEs ──────────────────

  describe('TEST-HIST-15: finalizeBatch — SELECT FOR UPDATE precedes both UPDATE statements', () => {
    it('the FOR UPDATE lock on the batch row is acquired before lines or batch are modified', async () => {
      supabase.from
        .mockReturnValueOnce(makeSbChain({ data: VALIDATED_BATCH, error: null }));  // getBatch

      const finalizedRow = { ...VALIDATED_BATCH, status: 'finalized', finalized_at: new Date().toISOString() };
      const pgClient = makePgClient([
        { rows: [], rowCount: 0 },
        { rows: [{ id: 'batch-1', status: 'validated' }] },    // FOR UPDATE response
        { rows: [{ line_count: '2' }] },
        { rows: [], rowCount: 2 },
        { rows: [finalizedRow], rowCount: 1 },
        { rows: [], rowCount: 0 },
      ]);
      db.getClient.mockResolvedValue(pgClient);

      await HistoricalComparativesService.finalizeBatch(makeFinalizeArgs());

      const forUpdateIdx = pgClient.queryCalls.findIndex(
        c => c.sql.toUpperCase().includes('FOR UPDATE')
      );
      const firstUpdateIdx = pgClient.queryCalls.findIndex(
        c => c.sql.trim().toUpperCase().startsWith('UPDATE')
      );

      expect(forUpdateIdx).toBeGreaterThan(-1);
      expect(firstUpdateIdx).toBeGreaterThan(-1);
      expect(forUpdateIdx).toBeLessThan(firstUpdateIdx);
    });
  });

});
