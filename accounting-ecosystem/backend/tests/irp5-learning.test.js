'use strict';

/**
 * Tests for accounting-ecosystem/backend/sean/irp5-learning.js
 *
 * Strategy: The module calls `supabase` from '../config/database'.
 * We mock that module with Jest so no real DB connections are made.
 *
 * Coverage:
 *   normalizeName()        — pure function
 *   calculateConfidence()  — pure function (now exported)
 *   recordLearningEvent()  — validates required fields / changeType
 *   approveProposal()      — validates args, enforces 'pending' gate
 *   rejectProposal()       — validates args, enforces 'pending' gate
 *   propagateApproved()    — CRITICAL safety: null→write, same→skip, diff→exception
 *   IRP5 code format       — regex boundary tests
 */

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockSupabase = {
  _responses: {},
  _insertCalls: [],
  _updateCalls: [],

  __setResponse(table, response) {
    this._responses[table] = response;
  },

  __reset() {
    this._responses  = {};
    this._insertCalls = [];
    this._updateCalls = [];
  },

  from(table) {
    const self     = this;
    const response = self._responses[table] || { data: null, error: null };

    const builder = {
      select()   { return this; },
      eq()       { return this; },
      neq()      { return this; },
      gte()      { return this; },
      order()    { return this; },
      limit()    { return this; },
      is()       { return this; },
      not()      { return this; },
      in()       { return this; },

      insert(rows) {
        self._insertCalls.push({ table, rows });
        return this;
      },
      update(fields) {
        self._updateCalls.push({ table, fields });
        return this;
      },

      async single()      { return response; },
      async maybeSingle() { return response; },

      then(resolve) {
        return Promise.resolve(response).then(resolve);
      }
    };

    return builder;
  }
};

jest.mock('../config/database', () => ({ supabase: mockSupabase }));

// ─── Module under test ────────────────────────────────────────────────────────

const {
  normalizeName,
  calculateConfidence,
  recordLearningEvent,
  approveProposal,
  rejectProposal,
  propagateApproved,
  SOURCE_APP,
  MIN_CLIENTS_FOR_PROPOSAL,
  MIN_CONFIDENCE_FOR_PROPOSAL
} = require('../sean/irp5-learning');

beforeEach(() => mockSupabase.__reset());

// ─── normalizeName() ──────────────────────────────────────────────────────────

describe('normalizeName()', () => {
  test('lowercases', () => {
    expect(normalizeName('Basic Salary')).toBe('basic salary');
  });

  test('strips punctuation and trailing dots', () => {
    expect(normalizeName('Comm.')).toBe('comm');
    expect(normalizeName('Travel Allow.')).toBe('travel allow');
  });

  test('strips frequency words (monthly/weekly/annual/yearly)', () => {
    expect(normalizeName('Monthly Commission')).toBe('commission');
    expect(normalizeName('Weekly Overtime')).toBe('overtime');
    expect(normalizeName('Annual Bonus')).toBe('bonus');
  });

  test('strips frequency word AND year together', () => {
    // 'annual' is stripped → 'Annual Bonus (2024)' → 'bonus'
    expect(normalizeName('Annual Bonus (2024)')).toBe('bonus');
    expect(normalizeName('Bonus 2025')).toBe('bonus');
    expect(normalizeName('Monthly Basic 2026')).toBe('basic');
  });

  test('collapses multiple spaces', () => {
    expect(normalizeName('Basic   Salary')).toBe('basic salary');
  });

  test('handles null/undefined/empty gracefully', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('')).toBe('');
  });

  test('Comm. and Commission remain distinct (conservative matching)', () => {
    expect(normalizeName('Comm.')).not.toBe(normalizeName('Commission'));
  });
});

// ─── calculateConfidence() ────────────────────────────────────────────────────

describe('calculateConfidence()', () => {
  test('returns 0 when totalOccurrences is 0 (divide-by-zero guard)', () => {
    expect(calculateConfidence(0, 0, 0)).toBe(0);
  });

  test('returns 0 when occurrenceCount is 0', () => {
    expect(calculateConfidence(0, 3, 10)).toBe(0);
  });

  test('single client sole occurrence ~37', () => {
    // freq = 100*0.3 = 30; diversity = 10*0.7 = 7; total = 37
    expect(calculateConfidence(1, 1, 1)).toBeCloseTo(37, 0);
  });

  test('10 clients at 100% frequency = 100', () => {
    expect(calculateConfidence(10, 10, 10)).toBe(100);
  });

  test('never exceeds 100', () => {
    expect(calculateConfidence(100, 100, 100)).toBeLessThanOrEqual(100);
  });

  test('more clients → higher confidence (same frequency)', () => {
    expect(calculateConfidence(5, 5, 5)).toBeGreaterThan(calculateConfidence(5, 1, 5));
  });

  test('exported threshold constants are sensible', () => {
    expect(MIN_CONFIDENCE_FOR_PROPOSAL).toBeGreaterThan(0);
    expect(MIN_CONFIDENCE_FOR_PROPOSAL).toBeLessThanOrEqual(100);
    expect(MIN_CLIENTS_FOR_PROPOSAL).toBeGreaterThanOrEqual(2);
  });
});

// ─── SOURCE_APP ───────────────────────────────────────────────────────────────

test('SOURCE_APP is "paytime"', () => {
  expect(SOURCE_APP).toBe('paytime');
});

// ─── recordLearningEvent() ────────────────────────────────────────────────────

describe('recordLearningEvent()', () => {
  const base = {
    companyId: 1, payrollItemName: 'Commission',
    newIrp5Code: '3606', changeType: 'new_item'
  };

  test.each(['companyId', 'payrollItemName', 'newIrp5Code', 'changeType'])(
    'throws when %s is missing',
    async (field) => {
      const ev = { ...base, [field]: undefined };
      await expect(recordLearningEvent(ev)).rejects.toThrow(field);
    }
  );

  test('throws for invalid changeType', async () => {
    await expect(recordLearningEvent({ ...base, changeType: 'bad' }))
      .rejects.toThrow('invalid changeType');
  });

  test('accepts new_item, code_added, code_changed', async () => {
    for (const changeType of ['new_item', 'code_added', 'code_changed']) {
      mockSupabase.__reset();
      mockSupabase.__setResponse('sean_learning_events', {
        data: { id: 1, ...base, changeType }, error: null
      });
      await expect(recordLearningEvent({ ...base, changeType })).resolves.toBeDefined();
    }
  });

  test('returns the saved row', async () => {
    const saved = { id: 42, ...base, source_app: 'paytime' };
    mockSupabase.__setResponse('sean_learning_events', { data: saved, error: null });
    mockSupabase.__setResponse('sean_irp5_mapping_patterns', { data: [], error: null });
    await expect(recordLearningEvent(base)).resolves.toEqual(saved);
  });

  test('throws when Supabase returns error', async () => {
    mockSupabase.__setResponse('sean_learning_events', {
      data: null, error: { message: 'connection refused' }
    });
    await expect(recordLearningEvent(base)).rejects.toThrow('connection refused');
  });
});

// ─── approveProposal() ────────────────────────────────────────────────────────

describe('approveProposal()', () => {
  test('throws when approvalId missing', async () => {
    await expect(approveProposal(undefined, 1)).rejects.toThrow('approvalId');
  });

  test('throws when userId missing', async () => {
    await expect(approveProposal(1, undefined)).rejects.toThrow('userId');
  });

  test('throws when proposal not found', async () => {
    mockSupabase.__setResponse('sean_irp5_propagation_approvals', {
      data: null, error: { message: 'not found' }
    });
    await expect(approveProposal(999, 1)).rejects.toThrow('999');
  });

  test('throws when proposal is not pending', async () => {
    mockSupabase.__setResponse('sean_irp5_propagation_approvals', {
      data: { id: 1, status: 'rejected', mapping_pattern_id: 10 }, error: null
    });
    await expect(approveProposal(1, 1)).rejects.toThrow('not pending');
  });
});

// ─── rejectProposal() ─────────────────────────────────────────────────────────

describe('rejectProposal()', () => {
  test('throws when approvalId missing', async () => {
    await expect(rejectProposal(undefined, 1, 'r')).rejects.toThrow('approvalId');
  });

  test('throws when userId missing', async () => {
    await expect(rejectProposal(1, undefined, 'r')).rejects.toThrow('userId');
  });

  test('throws when proposal is not pending', async () => {
    mockSupabase.__setResponse('sean_irp5_propagation_approvals', {
      data: { id: 1, status: 'approved', mapping_pattern_id: 5 }, error: null
    });
    await expect(rejectProposal(1, 1, 'reason')).rejects.toThrow('not pending');
  });
});

// ─── propagateApproved() — CRITICAL SAFETY ───────────────────────────────────

describe('propagateApproved() — safety enforcement', () => {
  test('throws when approvalId missing', async () => {
    await expect(propagateApproved(undefined, 1)).rejects.toThrow('approvalId');
  });

  test('throws when authorizedUserId missing', async () => {
    await expect(propagateApproved(1, undefined)).rejects.toThrow('authorizedUserId');
  });

  test('throws when approval not found', async () => {
    mockSupabase.__setResponse('sean_irp5_propagation_approvals', {
      data: null, error: { message: 'row not found' }
    });
    await expect(propagateApproved(99, 1)).rejects.toThrow('99');
  });

  test('throws when status is not "approved"', async () => {
    mockSupabase.__setResponse('sean_irp5_propagation_approvals', {
      data: { id: 1, status: 'pending', mapping_pattern_id: 5,
              snapshot_normalized_name: 'commission', snapshot_irp5_code: '3606' },
      error: null
    });
    await expect(propagateApproved(1, 1)).rejects.toThrow("not in 'approved' status");
  });

  describe('with an approved proposal for "commission" → 3606', () => {
    const APPROVAL = {
      id: 1, status: 'approved', mapping_pattern_id: 5,
      snapshot_normalized_name: 'commission', snapshot_irp5_code: '3606'
    };

    /**
     * Build a focused supabase mock for propagateApproved.
     *
     * Call sequence inside propagateApproved:
     *   1. from('sean_irp5_propagation_approvals').select().eq().single()  → fetch approval
     *   2. from('payroll_items_master').select().eq()                      → fetch items (thenable)
     *   3. from('payroll_items_master').update(fields).eq()                → write per null item
     *   4. from('sean_irp5_propagation_log').insert()                      → log batch
     *   5. from('sean_irp5_propagation_approvals').update().eq()            → mark propagated
     *   6. from('sean_irp5_mapping_patterns').update().eq()                 → mark pattern propagated
     */
    function makeMock(items) {
      let approvalCallCount  = 0;
      const itemsUpdateCalls = [];

      const m = {
        itemsUpdateCalls,
        from(table) {
          if (table === 'sean_irp5_propagation_approvals') {
            approvalCallCount++;
            if (approvalCallCount === 1) {
              const b = {
                select() { return b; },
                eq()     { return b; },
                async single() { return { data: APPROVAL, error: null }; }
              };
              return b;
            }
            // update() call to mark propagated
            const u = {
              update() { return u; },
              eq()     { return Promise.resolve({ data: null, error: null }); }
            };
            return u;
          }

          if (table === 'payroll_items_master') {
            let selectedOnce = false;
            const b = {
              select() { selectedOnce = true; return b; },
              eq() {
                if (selectedOnce) {
                  selectedOnce = false;
                  // Fetch: resolve thenable with item list
                  return { then: (r) => r({ data: items, error: null }) };
                }
                return Promise.resolve({ data: null, error: null });
              },
              update(fields) {
                itemsUpdateCalls.push(fields);
                return { eq: () => Promise.resolve({ data: null, error: null }) };
              },
              then(r) { return r({ data: items, error: null }); }
            };
            return b;
          }

          if (table === 'sean_irp5_propagation_log') {
            return { insert: () => Promise.resolve({ data: null, error: null }) };
          }

          if (table === 'sean_irp5_mapping_patterns') {
            const p = {
              update() { return p; },
              eq()     { return Promise.resolve({ data: null, error: null }); }
            };
            return p;
          }

          return { then: (r) => r({ data: null, error: null }) };
        }
      };

      return m;
    }

    test('SAFETY: null irp5_code → applied; same code → skipped; different code → exception (never written)', async () => {
      const items = [
        { id: 10, company_id: 1, name: 'Commission', irp5_code: null },   // → applied
        { id: 11, company_id: 2, name: 'Commission', irp5_code: '3606' }, // → skipped_existing
        { id: 12, company_id: 3, name: 'Commission', irp5_code: '9999' }  // → skipped_exception — NEVER write
      ];

      const mock = makeMock(items);
      const saved = mockSupabase.from;
      mockSupabase.from = mock.from.bind(mock);

      try {
        const result = await propagateApproved(1, 42);

        expect(result.applied).toBe(1);
        expect(result.skippedExisting).toBe(1);
        expect(result.exceptions).toBe(1);
        expect(result.errors).toBe(0);

        // Only item 10 (null) was written — item 12 (different code) must NEVER be written
        expect(mock.itemsUpdateCalls).toHaveLength(1);
        expect(mock.itemsUpdateCalls[0].irp5_code).toBe('3606');
      } finally {
        mockSupabase.from = saved;
      }
    });

    test('SAFETY: empty-string irp5_code is falsy → treated as blank → written', async () => {
      const items = [{ id: 20, company_id: 5, name: 'Commission', irp5_code: '' }];

      const mock = makeMock(items);
      const saved = mockSupabase.from;
      mockSupabase.from = mock.from.bind(mock);

      try {
        const result = await propagateApproved(1, 42);
        expect(result.applied).toBe(1);
        expect(result.exceptions).toBe(0);
        expect(mock.itemsUpdateCalls).toHaveLength(1);
      } finally {
        mockSupabase.from = saved;
      }
    });

    test('SAFETY: no matching items → zero counts, zero writes', async () => {
      // 'Basic Salary Standard' does not normalize to 'commission'
      const items = [{ id: 30, company_id: 6, name: 'Basic Salary Standard', irp5_code: null }];

      const mock = makeMock(items);
      const saved = mockSupabase.from;
      mockSupabase.from = mock.from.bind(mock);

      try {
        const result = await propagateApproved(1, 42);
        expect(result.applied).toBe(0);
        expect(result.skippedExisting).toBe(0);
        expect(result.exceptions).toBe(0);
        expect(mock.itemsUpdateCalls).toHaveLength(0);
      } finally {
        mockSupabase.from = saved;
      }
    });
  });
});

// ─── IRP5 code format validation ─────────────────────────────────────────────

describe('IRP5 code format — /^\\d{4,6}$/ (route-layer boundary)', () => {
  const R = /^\d{4,6}$/;

  test.each(['3601', '3606', '3811'])('accepts 4-digit code %s', (c) => {
    expect(R.test(c)).toBe(true);
  });

  test('accepts 5-digit code', () => expect(R.test('36010')).toBe(true));
  test('accepts 6-digit code', () => expect(R.test('360100')).toBe(true));

  test.each(['36', '360'])('rejects %s (too short)', (c) => {
    expect(R.test(c)).toBe(false);
  });

  test('rejects 7-digit code (too long)', () => expect(R.test('3601000')).toBe(false));

  test.each(['360A', 'ABCD', '', '3601 ', ' 3601', '36-01'])(
    'rejects non-numeric or spaced code "%s"',
    (c) => expect(R.test(c)).toBe(false)
  );
});
