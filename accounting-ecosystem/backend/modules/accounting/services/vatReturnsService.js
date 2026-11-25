'use strict';

/**
 * ============================================================================
 * VAT Returns — what was ACTUALLY filed with SARS, what was paid, and where
 * the books now differ from it
 * ============================================================================
 * Tables (migration 189): vat_returns (one row per period per version; a
 * revision supersedes, never overwrites) and vat_payments (soft-deleted).
 *
 *   overview()          all periods: filed A / B / 20, paid, outstanding
 *   getPeriod()         one period: versions, payments, Leo's VAT201 now,
 *                       differences vs the current filed version, and the
 *                       entries posted on/after the filing date that cause them
 *   captureReturn()     save a filed return (or a revision) and lock the period,
 *                       so later entries dated in it are swept to the open period
 *                       (existing journalService out-of-period mechanism)
 *   addPayment() / deletePayment()
 *
 * Leo's own VAT201 figures come from the ledger via vatDetailReportService
 * (same journals as the VAT201 headline). Read and write paths are scoped by
 * company_id everywhere.
 *
 * Step 2 (not built here): carrying a difference into a later return
 * (field 12 / 18) — see SESSION_HANDOFF.
 * ============================================================================
 */

const db = require('../config/database');
const vatDetailReportService = require('./vatDetailReportService');
const vatReconService = require('./vatReconciliationService');
const { PERIOD_JOURNAL_FILTER } = require('./vatReportService');

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/** VAT201 layout. kind: 'amount' = consideration, 'vat' = VAT, 'total' = computed. */
const FIELDS = [
  { key: 'field_1',   code: '1',   section: 'output', kind: 'amount', label: 'Standard rate (excluding capital goods and/or services and accommodation)' },
  { key: 'field_1a',  code: '1A',  section: 'output', kind: 'amount', label: 'Standard rate (only capital goods and/or services)' },
  { key: 'field_2',   code: '2',   section: 'output', kind: 'amount', label: 'Zero rate (excluding goods exported)' },
  { key: 'field_2a',  code: '2A',  section: 'output', kind: 'amount', label: 'Zero rate (only exported goods)' },
  { key: 'field_3',   code: '3',   section: 'output', kind: 'amount', label: 'Exempt and non-supplies' },
  { key: 'field_4',   code: '4',   section: 'output', kind: 'vat',    label: 'VAT on field 1' },
  { key: 'field_4a',  code: '4A',  section: 'output', kind: 'vat',    label: 'VAT on field 1A' },
  { key: 'field_5',   code: '5',   section: 'output', kind: 'amount', label: 'Supply of accommodation exceeding 28 days' },
  { key: 'field_6',   code: '6',   section: 'output', kind: 'amount', label: 'Field 5 × 60%' },
  { key: 'field_7',   code: '7',   section: 'output', kind: 'amount', label: 'Supply of accommodation not exceeding 28 days' },
  { key: 'field_8',   code: '8',   section: 'output', kind: 'amount', label: 'Total accommodation (6 + 7)' },
  { key: 'field_9',   code: '9',   section: 'output', kind: 'vat',    label: 'VAT on accommodation' },
  { key: 'field_10',  code: '10',  section: 'output', kind: 'amount', label: 'Change in use and export of second-hand goods' },
  { key: 'field_11',  code: '11',  section: 'output', kind: 'vat',    label: 'VAT on field 10' },
  { key: 'field_12',  code: '12',  section: 'output', kind: 'vat',    label: 'Other and imported services' },
  { key: 'field_13',  code: '13',  section: 'output', kind: 'total',  label: 'TOTAL A: Total output tax (4 + 4A + 9 + 11 + 12)' },
  { key: 'field_14',  code: '14',  section: 'input',  kind: 'vat',    label: 'Capital goods and/or services supplied to you' },
  { key: 'field_14a', code: '14A', section: 'input',  kind: 'vat',    label: 'Capital goods imported by you' },
  { key: 'field_15',  code: '15',  section: 'input',  kind: 'vat',    label: 'Other goods and/or services supplied to you (not capital goods)' },
  { key: 'field_15a', code: '15A', section: 'input',  kind: 'vat',    label: 'Other goods imported by you (not capital goods)' },
  { key: 'field_16',  code: '16',  section: 'input',  kind: 'vat',    label: 'Change in use' },
  { key: 'field_17',  code: '17',  section: 'input',  kind: 'vat',    label: 'Bad debts' },
  { key: 'field_18',  code: '18',  section: 'input',  kind: 'vat',    label: 'Other' },
  { key: 'field_19',  code: '19',  section: 'input',  kind: 'total',  label: 'TOTAL B: Total input tax (14 + 14A + 15 + 15A + 16 + 17 + 18)' },
  { key: 'field_20',  code: '20',  section: 'result', kind: 'total',  label: 'VAT payable / (refundable) (A − B)' },
];
const FIELD_KEYS = FIELDS.map(f => f.key);

/** Totals A, B and 20 from the entered fields. Pure. */
function computeTotals(f) {
  const n = k => round2(f[k]);
  const a = round2(n('field_4') + n('field_4a') + n('field_9') + n('field_11') + n('field_12'));
  const b = round2(n('field_14') + n('field_14a') + n('field_15') + n('field_15a') + n('field_16') + n('field_17') + n('field_18'));
  return { field_13: a, field_19: b, field_20: round2(a - b) };
}

/**
 * Normalise + check a captured return. Totals the user typed must agree with
 * the fields (SARS's own form adds them up the same way). Pure.
 * @returns {{ fields: object, errors: string[] }}
 */
function validateReturnFields(input) {
  const errors = [];
  const fields = {};
  for (const k of FIELD_KEYS) {
    const raw = input && input[k];
    if (raw === undefined || raw === null || raw === '') { fields[k] = 0; continue; }
    const v = Number(String(raw).replace(/[\s,]/g, '').replace(/^R/i, ''));
    if (!Number.isFinite(v)) { errors.push(`Field ${FIELDS.find(f => f.key === k).code} is not a number`); fields[k] = 0; continue; }
    fields[k] = round2(v);
  }
  const t = computeTotals(fields);
  const given = k => input && input[k] !== undefined && input[k] !== null && input[k] !== '';
  for (const [k, label] of [['field_13', 'Total A (13)'], ['field_19', 'Total B (19)'], ['field_20', 'Field 20']]) {
    if (given(k) && Math.abs(fields[k] - t[k]) >= 0.01) {
      errors.push(`${label} is ${fields[k].toFixed(2)} but the fields add up to ${t[k].toFixed(2)}`);
    }
    fields[k] = t[k];
  }
  return { fields, errors };
}

/** Leo's VAT201 field values from a vatDetailReportService report. Pure. */
function ledgerFieldsFromDetail(report) {
  const f = Object.fromEntries(FIELD_KEYS.map(k => [k, 0]));
  const t = report.summary.totals;
  f.field_1 = t.output_standard.inclusive;
  f.field_4 = t.output_standard.vat;
  f.field_2 = t.output_no_vat.exclusive;        // zero-rated AND exempt — the ledger can't tell them apart
  for (const r of report.rows) {
    if (r.section === 'vat_adjustment') {
      if (String(r.account).includes('2300')) f.field_12 = round2(f.field_12 + r.vat);
      else f.field_18 = round2(f.field_18 + r.vat);
    } else if (r.section === 'input_standard') {
      if (r.capital) f.field_14 = round2(f.field_14 + r.vat);
      else f.field_15 = round2(f.field_15 + r.vat);
    }
  }
  return Object.assign(f, computeTotals(f));
}

/** Field-by-field differences: Leo now minus filed. Pure. */
function diffFields(ledger, filed) {
  return FIELDS.map(f => ({
    key: f.key, code: f.code, label: f.label, kind: f.kind,
    leo: round2(ledger[f.key]), filed: round2(filed[f.key]),
    difference: round2(round2(ledger[f.key]) - round2(filed[f.key])),
  })).filter(d => Math.abs(d.difference) >= 0.01);
}

/** VAT due, settled and outstanding for a period. Pure. */
function paymentPosition(filedReturn, payments) {
  const live = (payments || []).filter(p => !p.deleted_at);
  const sum = type => round2(live.filter(p => p.payment_type === type).reduce((s, p) => s + Number(p.amount), 0));
  const due = filedReturn ? round2(filedReturn.field_20) : null;
  const paidVat = sum('vat'), refunds = sum('refund');
  const settled = round2(paidVat - refunds);          // a refund received counts against a negative 20
  return {
    due, paidVat, refundsReceived: refunds,
    penalties: sum('penalty'), interest: sum('interest'),
    outstanding: due === null ? null : round2(due - settled),
  };
}

const RETURN_COLS = ['id', 'company_id', 'vat_period_id', 'version', 'status', 'filed_date', 'sars_reference', 'notes',
  ...FIELD_KEYS, 'ledger_snapshot', 'captured_by_user_id', 'captured_at', 'superseded_at', 'superseded_by_return_id'];

function numericReturn(r) {
  if (!r) return r;
  const out = { ...r };
  for (const k of FIELD_KEYS) out[k] = round2(r[k]);
  if (out.filed_date instanceof Date) out.filed_date = out.filed_date.toISOString().slice(0, 10);
  return out;
}

class VatReturnsService {

  async _period(companyId, periodId) {
    const { rows } = await db.query(
      `SELECT id, period_key, from_date::text AS from_date, to_date::text AS to_date, status, filing_frequency
         FROM vat_periods WHERE company_id = $1 AND id = $2`, [companyId, periodId]);
    return rows[0] || null;
  }

  async _ledger(companyId, period) {
    const report = await vatDetailReportService.generate(companyId, period.period_key.replace('.', '-'), {
      periodId: period.id, dateFrom: period.from_date, dateTo: period.to_date, status: period.status,
    });
    return { fields: ledgerFieldsFromDetail(report), tieOut: report.summary.tieOut };
  }

  /** All periods with their current filed return and payment position. */
  async overview(companyId) {
    const { rows: periods } = await db.query(
      `SELECT id, period_key, from_date::text AS from_date, to_date::text AS to_date, status
         FROM vat_periods WHERE company_id = $1 ORDER BY from_date DESC`, [companyId]);
    const { rows: returns } = await db.query(
      `SELECT ${RETURN_COLS.filter(c => c !== 'ledger_snapshot').join(', ')}
         FROM vat_returns WHERE company_id = $1 AND status = 'filed'`, [companyId]);
    const { rows: payments } = await db.query(
      `SELECT vat_period_id, payment_type, amount, deleted_at
         FROM vat_payments WHERE company_id = $1 AND deleted_at IS NULL`, [companyId]);
    const { rows: versions } = await db.query(
      `SELECT vat_period_id, MAX(version)::int AS versions FROM vat_returns WHERE company_id = $1 GROUP BY 1`, [companyId]);

    const byPeriod = Object.fromEntries(returns.map(r => [r.vat_period_id, numericReturn(r)]));
    const verBy = Object.fromEntries(versions.map(v => [v.vat_period_id, v.versions]));
    return periods.map(p => {
      const ret = byPeriod[p.id] || null;
      const pos = paymentPosition(ret, payments.filter(x => x.vat_period_id === p.id));
      return {
        periodId: p.id, periodKey: p.period_key, fromDate: p.from_date, toDate: p.to_date,
        locked: String(p.status || '').toUpperCase() === 'LOCKED',
        filed: !!ret, version: ret ? ret.version : null, revisions: Math.max(0, (verBy[p.id] || 0) - 1),
        filedDate: ret ? ret.filed_date : null, sarsReference: ret ? ret.sars_reference : null,
        outputVat: ret ? ret.field_13 : null, inputVat: ret ? ret.field_19 : null, netVat: ret ? ret.field_20 : null,
        ...pos,
      };
    });
  }

  /** One period: all versions, payments, Leo now, differences + their cause. */
  async getPeriod(companyId, periodId) {
    const period = await this._period(companyId, periodId);
    if (!period) { const e = new Error('VAT period not found'); e.status = 404; throw e; }

    const { rows: versions } = await db.query(
      `SELECT ${RETURN_COLS.join(', ')} FROM vat_returns
        WHERE company_id = $1 AND vat_period_id = $2 ORDER BY version DESC`, [companyId, periodId]);
    const { rows: payments } = await db.query(
      `SELECT id, payment_date::text AS payment_date, amount::float AS amount, payment_type, reference,
              bank_transaction_id, notes, created_at, deleted_at
         FROM vat_payments WHERE company_id = $1 AND vat_period_id = $2
        ORDER BY payment_date, id`, [companyId, periodId]);

    const all = versions.map(numericReturn);
    const current = all.find(r => r.status === 'filed') || null;
    const ledger = await this._ledger(companyId, period);

    let differences = null, causes = [];
    if (current) {
      differences = diffFields(ledger.fields, current);
      if (differences.length) causes = await this._causes(companyId, period, current.filed_date);
    }

    return {
      period: { id: period.id, periodKey: period.period_key, fromDate: period.from_date, toDate: period.to_date,
        locked: String(period.status || '').toUpperCase() === 'LOCKED' },
      fields: FIELDS,
      current, versions: all,
      payments: payments.filter(p => !p.deleted_at),
      deletedPayments: payments.filter(p => p.deleted_at),
      position: paymentPosition(current, payments),
      ledger: ledger.fields,
      ledgerTiesToControlAccounts: ledger.tieOut.ties,
      differences, causes,
    };
  }

  /**
   * VAT entries counted in this period that were posted on or after the filing
   * date — the usual reason Leo no longer agrees with what was filed.
   */
  async _causes(companyId, period, filedDate) {
    const { rows } = await db.query(
      `SELECT j.id, j.date::text AS date, j.reference, j.description, j.posted_at,
              j.reversal_of_journal_id, j.is_out_of_period,
              ROUND(SUM(CASE WHEN a.code = '2300' THEN jl.credit - jl.debit ELSE 0 END), 2)::float AS output_vat,
              ROUND(SUM(CASE WHEN a.code = '1400' THEN jl.debit - jl.credit ELSE 0 END), 2)::float AS input_vat
         FROM journals j
         JOIN journal_lines jl ON jl.journal_id = j.id
         JOIN accounts a       ON a.id = jl.account_id
        WHERE j.company_id = $1
          AND j.status = 'posted'
          AND ${PERIOD_JOURNAL_FILTER}
          AND j.posted_at >= $5::date
        GROUP BY j.id
       HAVING SUM(CASE WHEN a.code IN ('1400', '2300') THEN ABS(jl.debit) + ABS(jl.credit) ELSE 0 END) > 0
          OR  SUM(CASE WHEN a.type = 'income' THEN ABS(jl.debit) + ABS(jl.credit) ELSE 0 END) > 0
        ORDER BY j.posted_at, j.id
        LIMIT 500`,
      [companyId, period.from_date, period.to_date, period.id, filedDate]);
    return rows;
  }

  /**
   * Save a filed return. If the period already has one, this becomes the next
   * version and the previous one is marked superseded (same transaction).
   * A period that doesn't exist yet (older periods) is created from
   * newPeriod { periodKey, fromDate, toDate }. The period is locked afterwards.
   */
  async captureReturn(companyId, userId, payload) {
    const { fields, errors } = validateReturnFields(payload.fields || {});
    if (!payload.filedDate || !/^\d{4}-\d{2}-\d{2}$/.test(payload.filedDate)) errors.push('Filing date is required (YYYY-MM-DD)');
    if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }

    let periodId = parseInt(payload.periodId, 10) || null;
    if (!periodId) {
      const np = payload.newPeriod || {};
      if (!/^\d{4}-\d{2}$/.test(np.periodKey || '') || !/^\d{4}-\d{2}-\d{2}$/.test(np.fromDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(np.toDate || '') || np.fromDate > np.toDate) {
        const e = new Error('Choose a VAT period, or give a new period as YYYY-MM with a from and to date'); e.status = 400; throw e;
      }
      const created = await vatReconService.createOrGetPeriod(companyId, {
        periodKey: np.periodKey, fromDate: np.fromDate, toDate: np.toDate,
        filingFrequency: np.filingFrequency || 'monthly',
      });
      periodId = created.id;
    }
    const period = await this._period(companyId, periodId);
    if (!period) { const e = new Error('VAT period not found'); e.status = 404; throw e; }

    const ledger = await this._ledger(companyId, period);
    const snapshot = { capturedAt: new Date().toISOString(), fields: ledger.fields, tiesToControlAccounts: ledger.tieOut.ties };

    const client = await db.getClient();
    let saved, previous = null;
    try {
      await client.query('BEGIN');
      const { rows: prev } = await client.query(
        `SELECT id, version FROM vat_returns
          WHERE company_id = $1 AND vat_period_id = $2 AND status = 'filed' FOR UPDATE`, [companyId, periodId]);
      const { rows: maxv } = await client.query(
        `SELECT COALESCE(MAX(version), 0)::int AS v FROM vat_returns WHERE company_id = $1 AND vat_period_id = $2`,
        [companyId, periodId]);
      previous = prev[0] || null;
      if (previous) {
        await client.query(
          `UPDATE vat_returns SET status = 'superseded', superseded_at = now(), updated_at = now()
            WHERE id = $1 AND company_id = $2`, [previous.id, companyId]);
      }
      const cols = ['company_id', 'vat_period_id', 'version', 'status', 'filed_date', 'sars_reference', 'notes',
        ...FIELD_KEYS, 'ledger_snapshot', 'captured_by_user_id'];
      const vals = [companyId, periodId, maxv[0].v + 1, 'filed', payload.filedDate,
        (payload.sarsReference || '').trim() || null, (payload.notes || '').trim() || null,
        ...FIELD_KEYS.map(k => fields[k]), JSON.stringify(snapshot), userId || null];
      const { rows: ins } = await client.query(
        `INSERT INTO vat_returns (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})
         RETURNING ${RETURN_COLS.join(', ')}`, vals);
      saved = ins[0];
      if (previous) {
        await client.query(`UPDATE vat_returns SET superseded_by_return_id = $1 WHERE id = $2 AND company_id = $3`,
          [saved.id, previous.id, companyId]);
      }
      await client.query(
        `UPDATE vat_periods SET submitted_at = now(), submitted_by_user_id = $3,
                submission_reference = COALESCE($4, submission_reference), updated_at = now()
          WHERE id = $1 AND company_id = $2`,
        [periodId, companyId, userId || null, (payload.sarsReference || '').trim() || null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Lock the period so entries posted later in its dates go to the open period.
    let lockWarning = null;
    if (payload.lockPeriod !== false && String(period.status || '').toUpperCase() !== 'LOCKED') {
      try {
        await vatReconService.lockPeriod(companyId, periodId, userId);
      } catch (e) {
        lockWarning = `The return was saved, but the period could not be locked: ${e.message}`;
      }
    }

    return { saved: numericReturn(saved), supersededReturnId: previous ? previous.id : null, lockWarning };
  }

  async addPayment(companyId, userId, p) {
    const amount = round2(p.amount);
    const errors = [];
    const periodId = parseInt(p.periodId, 10);
    if (!periodId) errors.push('VAT period is required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.paymentDate || '')) errors.push('Payment date is required (YYYY-MM-DD)');
    if (!(amount > 0)) errors.push('Amount must be more than 0');
    const type = p.paymentType || 'vat';
    if (!['vat', 'penalty', 'interest', 'refund'].includes(type)) errors.push('Unknown payment type');
    if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
    if (!(await this._period(companyId, periodId))) { const e = new Error('VAT period not found'); e.status = 404; throw e; }

    let bankTxnId = parseInt(p.bankTransactionId, 10) || null;
    if (bankTxnId) {
      const { rows } = await db.query('SELECT id FROM bank_transactions WHERE id = $1 AND company_id = $2', [bankTxnId, companyId]);
      if (!rows.length) { const e = new Error('Bank transaction not found for this company'); e.status = 400; throw e; }
    }

    const { rows } = await db.query(
      `INSERT INTO vat_payments (company_id, vat_period_id, payment_date, amount, payment_type, reference,
                                 bank_transaction_id, notes, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, vat_period_id, payment_date::text AS payment_date, amount::float AS amount, payment_type,
                 reference, bank_transaction_id, notes, created_at`,
      [companyId, periodId, p.paymentDate, amount, type, (p.reference || '').trim() || null,
        bankTxnId, (p.notes || '').trim() || null, userId || null]);
    return rows[0];
  }

  async deletePayment(companyId, userId, paymentId) {
    const { rows } = await db.query(
      `UPDATE vat_payments SET deleted_at = now(), deleted_by_user_id = $3
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
        RETURNING id, vat_period_id, payment_date::text AS payment_date, amount::float AS amount, payment_type, reference`,
      [paymentId, companyId, userId || null]);
    if (!rows.length) { const e = new Error('Payment not found'); e.status = 404; throw e; }
    return rows[0];
  }
}

module.exports = new VatReturnsService();
Object.assign(module.exports, {
  FIELDS, computeTotals, validateReturnFields, ledgerFieldsFromDetail, diffFields, paymentPosition,
});
