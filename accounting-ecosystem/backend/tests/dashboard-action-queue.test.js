'use strict';

/**
 * Dashboard — Pilot Action Queue
 * Unit tests for safeCount helper and buildActionQueueItems pure function.
 *
 * Route-level auth is not tested here (covered by auth01 tests).
 * These tests focus on the query safety contract and the item-building logic.
 */

const db = require('../modules/accounting/config/database');

jest.mock('../modules/accounting/config/database', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

const dashboardRouter = require('../modules/accounting/routes/dashboard');
const { safeCount, buildActionQueueItems } = dashboardRouter;

// ─── Shared fixture — all results clean with zero counts ────────────────────
const ALL_OK_ZERO = {
  bankUnmatched:     { ok: true, count: 0 },
  bankMatchedUnrecon:{ ok: true, count: 0 },
  bankReconOpen:     { ok: true, count: 0 },
  arOverdue:         { ok: true, count: 0 },
  arDraft:           { ok: true, count: 0 },
  apOverdue:         { ok: true, count: 0 },
  apDraft:           { ok: true, count: 0 },
  historicalDraft:   { ok: true, count: 0 },
  openingDraft:      { ok: true, count: 0 },
  auditErrors:       { ok: true, count: 0 },
  historicalBlocked: { ok: true, count: 0 },
  vatOpen:           { ok: true, count: 0 },
};

describe('Dashboard — Pilot Action Queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── safeCount ──────────────────────────────────────────────────────────────

  test('TEST-DASH-01: safeCount returns count and ok=true on success', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ n: 24 }] });
    const result = await safeCount(
      `SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id=$1`,
      [5]
    );
    expect(result).toEqual({ count: 24, ok: true });
  });

  test('TEST-DASH-02: safeCount returns ok=false and count=null when the query throws', async () => {
    db.query.mockRejectedValueOnce(new Error('relation "bank_transactions" does not exist'));
    const result = await safeCount(
      `SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id=$1`,
      [5]
    );
    expect(result.ok).toBe(false);
    expect(result.count).toBeNull();
    expect(result.message).toContain('bank_transactions');
  });

  test('TEST-DASH-03: safeCount returns 0 when COUNT returns a zero row', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    const result = await safeCount(
      `SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE company_id=$1 AND status='draft'`,
      [5]
    );
    expect(result).toEqual({ count: 0, ok: true });
  });

  // ── buildActionQueueItems — empty result ───────────────────────────────────

  test('TEST-DASH-04: buildActionQueueItems returns empty array when all counts are zero', () => {
    const items = buildActionQueueItems(ALL_OK_ZERO);
    expect(items).toEqual([]);
  });

  // ── buildActionQueueItems — severity assignments ───────────────────────────

  test('TEST-DASH-05: bank-unmatched is severity "high" with correct count and link', () => {
    const items = buildActionQueueItems({
      ...ALL_OK_ZERO,
      bankUnmatched: { ok: true, count: 5 },
    });
    const item = items.find(i => i.id === 'bank-unmatched');
    expect(item).toBeDefined();
    expect(item.severity).toBe('high');
    expect(item.count).toBe(5);
    expect(item.link).toBe('/accounting/bank.html');
  });

  test('TEST-DASH-06: bank-matched-unrecon is severity "warning"', () => {
    const items = buildActionQueueItems({
      ...ALL_OK_ZERO,
      bankMatchedUnrecon: { ok: true, count: 12 },
    });
    const item = items.find(i => i.id === 'bank-matched-unrecon');
    expect(item).toBeDefined();
    expect(item.severity).toBe('warning');
    expect(item.link).toBe('/accounting/bank-reconciliation.html');
  });

  test('TEST-DASH-07: audit-errors is severity "critical"', () => {
    const items = buildActionQueueItems({
      ...ALL_OK_ZERO,
      auditErrors: { ok: true, count: 3 },
    });
    const item = items.find(i => i.id === 'audit-errors');
    expect(item).toBeDefined();
    expect(item.severity).toBe('critical');
    expect(item.link).toBe('/accounting/audit-trail.html');
  });

  test('TEST-DASH-08: historical-draft is severity "info"', () => {
    const items = buildActionQueueItems({
      ...ALL_OK_ZERO,
      historicalDraft: { ok: true, count: 1 },
    });
    const item = items.find(i => i.id === 'historical-draft');
    expect(item).toBeDefined();
    expect(item.severity).toBe('info');
    expect(item.link).toBe('/accounting/historical-comparatives.html');
  });

  // ── buildActionQueueItems — degraded item when query fails ─────────────────

  test('TEST-DASH-09: degraded item returned when a query fails (ok=false)', () => {
    const items = buildActionQueueItems({
      ...ALL_OK_ZERO,
      bankUnmatched: { ok: false, count: null, message: 'connection refused' },
    });
    const item = items.find(i => i.id === 'bank-unmatched');
    expect(item).toBeDefined();
    expect(item.severity).toBe('warning');
    expect(item.title).toContain('Unable to check');
    expect(item.count).toBeNull();
    expect(item.link).toBeNull();
  });

  // ── summary computation ────────────────────────────────────────────────────

  test('TEST-DASH-10: summary counts are correct for a mixed result set', () => {
    const results = {
      ...ALL_OK_ZERO,
      auditErrors:       { ok: true, count: 1 },  // → 1 critical
      bankUnmatched:     { ok: true, count: 5 },  // → 1 high
      bankReconOpen:     { ok: true, count: 2 },  // → 1 high
      arDraft:           { ok: true, count: 3 },  // → 1 warning
      historicalDraft:   { ok: true, count: 1 },  // → 1 info
    };
    const items = buildActionQueueItems(results);

    const summary = {
      criticalCount:   items.filter(i => i.severity === 'critical').length,
      highCount:       items.filter(i => i.severity === 'high').length,
      warningCount:    items.filter(i => i.severity === 'warning').length,
      infoCount:       items.filter(i => i.severity === 'info').length,
      totalActionable: items.filter(i => ['critical','high','warning'].includes(i.severity)).length,
    };

    expect(summary.criticalCount).toBe(1);
    expect(summary.highCount).toBe(2);
    expect(summary.warningCount).toBe(1);
    expect(summary.infoCount).toBe(1);
    expect(summary.totalActionable).toBe(4); // critical + high + warning
  });
});
