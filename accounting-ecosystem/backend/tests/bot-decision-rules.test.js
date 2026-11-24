'use strict';

/**
 * Bot decision rules (Codebox 4) — rule > Sean > evidence > bot > person.
 * Pure logic, synthetic data only.
 */
const { evaluateAllocation } = require('../modules/accounting/services/botDecisionService');

const accounts = new Map([
  [10, { id: 10, code: '6200', name: 'Telephone and Internet' }],
  [11, { id: 11, code: '6300', name: 'Office Expenses' }],
  [12, { id: 12, code: '2400', name: 'Director Loan Account' }],
  [13, { id: 13, code: '1010', name: 'Bank — Savings' }],
  [14, { id: 14, code: '5000', name: 'Old header', is_postable: false }],
  [15, { id: 15, code: '3200', name: 'Drawings' }],
  [16, { id: 16, code: '1030', name: 'Savings / Call Account', reporting_group: 'bank_cash' }],
  [17, { id: 17, code: '1020', name: 'Petty Cash', sub_type: 'cash' }],
  [18, { id: 18, code: '3100', name: 'Owner contributions', reporting_group: 'drawings' }]
]);
const base = (o = {}) => Object.assign({
  txn: { id: 1, amount: -115, description: 'TELKOM DEBIT ORDER', status: 'unmatched' },
  lines: [{ accountId: 10, amount: 115 }],
  accountsById: accounts, bankLedgerIds: new Set([13]), rule: null, sean: null, policy: {},
  reason: 'Monthly fibre and phone account'
}, o);

describe('bot decision rules', () => {
  test('plain, consistent allocation is posted', () => {
    expect(evaluateAllocation(base())).toMatchObject({ outcome: 'post', decisionSource: 'bot', holdReasons: [] });
  });

  test('a reason is always required', () => {
    expect(evaluateAllocation(base({ reason: '' }))).toMatchObject({ outcome: 'refuse', code: 'REASON_REQUIRED' });
  });

  test('lines must add up; accounts must exist and be postable; line must be unallocated', () => {
    expect(evaluateAllocation(base({ lines: [{ accountId: 10, amount: 100 }] })).code).toBe('LINES_DO_NOT_ADD_UP');
    expect(evaluateAllocation(base({ lines: [{ accountId: 99, amount: 115 }] })).code).toBe('UNKNOWN_ACCOUNT');
    expect(evaluateAllocation(base({ lines: [{ accountId: 14, amount: 115 }] })).code).toBe('ACCOUNT_NOT_POSTABLE');
    expect(evaluateAllocation(base({ txn: { id: 1, amount: -115, description: 'X', status: 'matched' } })).code).toBe('ALREADY_ALLOCATED');
    expect(evaluateAllocation(base({ lines: [{ accountId: 10, amount: 100 }, { accountId: 11, amount: 15 }] })).outcome).toBe('post');
  });

  test('1. an approved rule is never overridden; following it is posted as source "rule"', () => {
    const rule = { ruleId: 7, accountId: 11, accountCode: '6300' };
    expect(evaluateAllocation(base({ rule }))).toMatchObject({ outcome: 'refuse', code: 'RULE_OVERRIDE' });
    expect(evaluateAllocation(base({ rule, lines: [{ accountId: 11, amount: 115 }] })))
      .toMatchObject({ outcome: 'post', decisionSource: 'rule' });
    // the rule wins even over a confident Sean suggestion
    expect(evaluateAllocation(base({ rule, sean: { accountId: 10, confidence: 95 }, lines: [{ accountId: 11, amount: 115 }] })).outcome).toBe('post');
  });

  test('2. agreeing with a confident Sean is posted as source "sean"', () => {
    expect(evaluateAllocation(base({ sean: { accountId: 10, confidence: 90 } }))).toMatchObject({ outcome: 'post', decisionSource: 'sean' });
  });

  test('2. disagreeing with a confident Sean is the bot’s call (employee) — posted, no reason refusal', () => {
    const sean = { accountId: 11, confidence: 85 };
    expect(evaluateAllocation(base({ sean }))).toMatchObject({ outcome: 'post', decisionSource: 'bot', holdReasons: [] });
    expect(evaluateAllocation(base({ sean, disagreementReason: 'Invoice shows it is the fibre line, not stationery' })).outcome).toBe('post');
  });

  test('a low-confidence Sean hint does not block the bot', () => {
    expect(evaluateAllocation(base({ sean: { accountId: 11, confidence: 40 } }))).toMatchObject({ outcome: 'post', decisionSource: 'bot' });
  });

  test('director / owner lines post like any employee allocation (Ruan 2026-11-24)', () => {
    expect(evaluateAllocation(base({ lines: [{ accountId: 12, amount: 115 }] })).outcome).toBe('post');
    expect(evaluateAllocation(base({ lines: [{ accountId: 15, amount: 115 }] })).outcome).toBe('post');
    expect(evaluateAllocation(base({ lines: [{ accountId: 18, amount: 115 }] })).outcome).toBe('post');
    expect(evaluateAllocation(base({ txn: { id: 1, amount: -115, description: 'PAYMENT TO DIRECTOR J DOE', status: 'unmatched' } })).outcome).toBe('post');
  });

  test('transfers between own bank / cash accounts are refused as allocations — Leo’s transfer function matches both sides once', () => {
    for (const id of [13, 16, 17]) {   // linked bank, bank_cash in the chart, cash sub-type
      expect(evaluateAllocation(base({ lines: [{ accountId: id, amount: 115 }] }))).toMatchObject({ outcome: 'refuse', code: 'USE_TRANSFER' });
    }
  });

  test('the key policy no longer holds anything', () => {
    expect(evaluateAllocation(base({ policy: { require_approval_all: true } }))).toMatchObject({ outcome: 'post', holdReasons: [] });
  });
});
