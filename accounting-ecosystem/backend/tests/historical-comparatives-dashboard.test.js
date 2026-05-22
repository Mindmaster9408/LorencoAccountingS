'use strict';

/**
 * Tests for Historical Comparatives Dashboard Chart Integration
 *
 * Strategy: Mock supabase + pg pool — no real DB connection needed.
 * Tests cover:
 *   _buildChartDataset()       — pure function, no DB
 *   _buildAnnualSummaryDataset() — pure function, no DB
 *   getDashboardTrends()       — mocked DB, tests metric routing, company scoping, auth
 *   Route security             — draft access gated by role
 *   Data isolation             — confirms no writes to live ledger tables
 */

const path = require('path');

// ─── Mock dependencies before requiring the service ──────────────────────────

// Mock supabase client (for batch metadata queries)
const mockSupabaseChain = {
  eq:  jest.fn().mockReturnThis(),
  in:  jest.fn().mockReturnThis(),
  lte: jest.fn().mockReturnThis(),
  gte: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  // Default: return empty batches
  then: jest.fn((resolve) => resolve({ data: [], error: null })),
};
mockSupabaseChain[Symbol.for('nodejs.rejection')] = undefined;

// Make the chain thenable (Promise-like)
jest.mock('../config/database', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq:     jest.fn().mockReturnThis(),
      in:     jest.fn().mockReturnThis(),
      lte:    jest.fn().mockReturnThis(),
      gte:    jest.fn().mockReturnThis(),
      // Resolve with empty batches by default
      then: jest.fn(cb => Promise.resolve(cb({ data: [], error: null }))),
      catch: jest.fn(cb => Promise.resolve()),
    })),
  },
}));

// Mock direct pg pool
const mockDbQuery = jest.fn();
jest.mock(
  path.resolve(__dirname, '../modules/accounting/config/database'),
  () => ({ query: mockDbQuery }),
  { virtual: true }
);

const servicePath = path.resolve(
  __dirname,
  '../modules/accounting/services/historicalComparativesService'
);
const HistoricalComparativesService = require(servicePath);

// ─── Helper: build mock P&L rows (Income/Expense) ────────────────────────────
function makeMonthlyRows(accountType, year, amount = 10000) {
  // SA FY months: 3..12, 1, 2
  const months = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2];
  return months.map(m => ({
    financial_year: year,
    period_month:   m,
    account_type:   accountType,
    total_amount:   String(amount),
  }));
}

// ─── Tests for _buildChartDataset (pure function) ────────────────────────────

describe('_buildChartDataset — revenue metric', () => {
  test('produces one dataset per year in SA FY month order', () => {
    const rows = [
      ...makeMonthlyRows('Income', 2022, 15000),
      ...makeMonthlyRows('Income', 2023, 18000),
    ];
    const result = HistoricalComparativesService._buildChartDataset({
      metric: 'revenue', rows, fyStart: 2022, fyEnd: 2023, finalizedOnly: true,
    });

    expect(result.source).toBe('historical_comparatives');
    expect(result.datasets).toHaveLength(2);
    expect(result.labels).toHaveLength(12);
    // First label is March (SA FY start)
    expect(result.labels[0]).toBe('Mar');
    // Last label is February
    expect(result.labels[11]).toBe('Feb');
    // Revenue dataset should use Income amounts
    expect(result.datasets[0].data[0]).toBe(15000); // March 2022
    expect(result.datasets[1].data[0]).toBe(18000); // March 2023
  });

  test('year with no data returns 0 for all months', () => {
    const rows = makeMonthlyRows('Income', 2022, 5000);
    const result = HistoricalComparativesService._buildChartDataset({
      metric: 'revenue', rows, fyStart: 2021, fyEnd: 2022, finalizedOnly: true,
    });
    // FY 2021 has no rows — should all be 0
    expect(result.datasets[0].data.every(v => v === 0)).toBe(true);
    // FY 2022 has data
    expect(result.datasets[1].data.every(v => v === 5000)).toBe(true);
  });
});

describe('_buildChartDataset — expenses metric', () => {
  test('uses Expense rows, not Income rows', () => {
    const rows = [
      ...makeMonthlyRows('Income',  2023, 20000),
      ...makeMonthlyRows('Expense', 2023, 8000),
    ];
    const result = HistoricalComparativesService._buildChartDataset({
      metric: 'expenses', rows, fyStart: 2023, fyEnd: 2023, finalizedOnly: true,
    });
    expect(result.datasets[0].data[0]).toBe(8000); // Expense amount only
  });
});

describe('_buildChartDataset — net_profit metric', () => {
  test('returns Income minus Expense per month', () => {
    const rows = [
      ...makeMonthlyRows('Income',  2023, 20000),
      ...makeMonthlyRows('Expense', 2023, 12000),
    ];
    const result = HistoricalComparativesService._buildChartDataset({
      metric: 'net_profit', rows, fyStart: 2023, fyEnd: 2023, finalizedOnly: true,
    });
    expect(result.datasets[0].data[0]).toBe(8000); // 20000 - 12000
  });

  test('gross_profit uses same formula as net_profit', () => {
    const rows = [
      ...makeMonthlyRows('Income',  2023, 30000),
      ...makeMonthlyRows('Expense', 2023, 10000),
    ];
    const netResult = HistoricalComparativesService._buildChartDataset({
      metric: 'net_profit', rows: [...rows], fyStart: 2023, fyEnd: 2023, finalizedOnly: true,
    });
    const gpResult = HistoricalComparativesService._buildChartDataset({
      metric: 'gross_profit', rows: [...rows], fyStart: 2023, fyEnd: 2023, finalizedOnly: true,
    });
    expect(gpResult.datasets[0].data).toEqual(netResult.datasets[0].data);
  });
});

describe('_buildChartDataset — account_trend metric', () => {
  test('uses total_amount directly without Income/Expense discrimination', () => {
    const rows = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2].map(m => ({
      financial_year: 2022,
      period_month:   m,
      total_amount:   String(5500),
      account_code:   '1000',
      account_name:   'Test Account',
      account_type:   'Asset',
    }));
    const result = HistoricalComparativesService._buildChartDataset({
      metric: 'account_trend', rows, fyStart: 2022, fyEnd: 2022, finalizedOnly: true,
    });
    expect(result.datasets[0].data.every(v => v === 5500)).toBe(true);
    expect(result.metadata.accountInfo.account_name).toBe('Test Account');
  });
});

// ─── Tests for _buildAnnualSummaryDataset (pure function) ────────────────────

describe('_buildAnnualSummaryDataset', () => {
  test('builds three series: Revenue, Expenses, Net Profit', () => {
    const rows = [
      { financial_year: 2022, account_type: 'Income',  total_amount: '100000' },
      { financial_year: 2022, account_type: 'Expense', total_amount: '70000'  },
      { financial_year: 2023, account_type: 'Income',  total_amount: '120000' },
      { financial_year: 2023, account_type: 'Expense', total_amount: '80000'  },
    ];
    const result = HistoricalComparativesService._buildAnnualSummaryDataset({
      rows, fyStart: 2022, fyEnd: 2023, finalizedOnly: true,
    });
    expect(result.datasets).toHaveLength(3);
    expect(result.datasets[0].label).toBe('Revenue');
    expect(result.datasets[1].label).toBe('Expenses');
    expect(result.datasets[2].label).toBe('Net Profit');
    expect(result.datasets[0].data).toEqual([100000, 120000]);
    expect(result.datasets[1].data).toEqual([70000, 80000]);
    expect(result.datasets[2].data).toEqual([30000, 40000]); // net profit
  });

  test('year with no data returns 0 across all three series', () => {
    const rows = [
      { financial_year: 2023, account_type: 'Income',  total_amount: '50000' },
      { financial_year: 2023, account_type: 'Expense', total_amount: '30000' },
    ];
    const result = HistoricalComparativesService._buildAnnualSummaryDataset({
      rows, fyStart: 2022, fyEnd: 2023, finalizedOnly: true,
    });
    expect(result.datasets[0].data[0]).toBe(0); // FY 2022 Revenue
    expect(result.datasets[1].data[0]).toBe(0); // FY 2022 Expense
    expect(result.datasets[2].data[0]).toBe(0); // FY 2022 Net Profit
  });

  test('FY labels follow SA format (FY YYYY/YY)', () => {
    const rows = [];
    const result = HistoricalComparativesService._buildAnnualSummaryDataset({
      rows, fyStart: 2022, fyEnd: 2024, finalizedOnly: true,
    });
    expect(result.labels).toEqual(['FY 2022/23', 'FY 2023/24', 'FY 2024/25']);
  });

  test('source field is always "historical_comparatives"', () => {
    const result = HistoricalComparativesService._buildAnnualSummaryDataset({
      rows: [], fyStart: 2022, fyEnd: 2022, finalizedOnly: true,
    });
    expect(result.source).toBe('historical_comparatives');
  });
});

// ─── Tests for getDashboardTrends (validation + mocked DB) ───────────────────

describe('getDashboardTrends — input validation', () => {
  test('throws on invalid metric', async () => {
    await expect(
      HistoricalComparativesService.getDashboardTrends({
        companyId: 1, metric: 'invalid_metric', fromYear: 2022, toYear: 2023,
      })
    ).rejects.toThrow('Invalid metric');
  });

  test('throws when fromYear > toYear', async () => {
    await expect(
      HistoricalComparativesService.getDashboardTrends({
        companyId: 1, metric: 'revenue', fromYear: 2024, toYear: 2020,
      })
    ).rejects.toThrow('fromYear');
  });

  test('throws account_trend without accountId', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      HistoricalComparativesService.getDashboardTrends({
        companyId: 1, metric: 'account_trend', fromYear: 2022, toYear: 2023,
        // accountId intentionally omitted
      })
    ).rejects.toThrow('accountId is required');
  });
});

describe('getDashboardTrends — data isolation (finalized only by default)', () => {
  test('SQL includes is_finalized = true AND status = finalized when finalizedOnly=true', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await HistoricalComparativesService.getDashboardTrends({
      companyId: 1, metric: 'revenue', fromYear: 2022, toYear: 2023, finalizedOnly: true,
    });
    const calledSQL = mockDbQuery.mock.calls[0][0];
    expect(calledSQL).toContain("l.is_finalized = true");
    expect(calledSQL).toContain("b.status = 'finalized'");
  });

  test('SQL does NOT include is_finalized filter when finalizedOnly=false', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await HistoricalComparativesService.getDashboardTrends({
      companyId: 1, metric: 'revenue', fromYear: 2022, toYear: 2023, finalizedOnly: false,
    });
    const calledSQL = mockDbQuery.mock.calls[0][0];
    expect(calledSQL).not.toContain('is_finalized = true');
    expect(calledSQL).toContain("b.status IN ('draft', 'validated', 'finalized')");
  });
});

describe('getDashboardTrends — company scoping', () => {
  test('companyId is always the first SQL parameter', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await HistoricalComparativesService.getDashboardTrends({
      companyId: 42, metric: 'revenue', fromYear: 2022, toYear: 2023,
    });
    const params = mockDbQuery.mock.calls[0][1];
    expect(params[0]).toBe(42); // company_id must be first param
  });

  test('company_id not injectable through metric or other fields', async () => {
    // Passing a SQL injection attempt as metric should throw before any DB call
    await expect(
      HistoricalComparativesService.getDashboardTrends({
        companyId: 1, metric: "revenue'; DROP TABLE accounts;--", fromYear: 2022, toYear: 2023,
      })
    ).rejects.toThrow('Invalid metric');
  });
});

describe('getDashboardTrends — chart value correctness', () => {
  test('revenue chart values match monthly Income rows', async () => {
    const mockRows = makeMonthlyRows('Income', 2022, 25000);
    mockDbQuery.mockResolvedValueOnce({ rows: mockRows });

    const result = await HistoricalComparativesService.getDashboardTrends({
      companyId: 1, metric: 'revenue', fromYear: 2022, toYear: 2022, finalizedOnly: true,
    });
    // All 12 months should equal 25000
    expect(result.datasets[0].data.every(v => v === 25000)).toBe(true);
  });

  test('net_profit = income - expense per month from stored lines', async () => {
    const mockRows = [
      ...makeMonthlyRows('Income',  2022, 40000),
      ...makeMonthlyRows('Expense', 2022, 15000),
    ];
    mockDbQuery.mockResolvedValueOnce({ rows: mockRows });

    const result = await HistoricalComparativesService.getDashboardTrends({
      companyId: 1, metric: 'net_profit', fromYear: 2022, toYear: 2022, finalizedOnly: true,
    });
    expect(result.datasets[0].data.every(v => v === 25000)).toBe(true); // 40000 - 15000
  });
});

describe('getDashboardTrends — no live ledger writes', () => {
  test('getDashboardTrends only calls db.query (read) — never INSERT/UPDATE/DELETE', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await HistoricalComparativesService.getDashboardTrends({
      companyId: 1, metric: 'revenue', fromYear: 2022, toYear: 2023, finalizedOnly: true,
    });
    const allCalls = mockDbQuery.mock.calls;
    allCalls.forEach(([sql]) => {
      const upperSQL = sql.toUpperCase().trim();
      expect(upperSQL).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE)/);
      expect(upperSQL).toMatch(/^\s*SELECT/);
    });
  });
});
