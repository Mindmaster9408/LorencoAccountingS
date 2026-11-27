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
 *   carryCorrection()   step 2 (migration 190): carry a filed period's difference
 *                       into a later, unfiled return — output → field 12,
 *                       input → field 18. Only what is still uncorrected can be
 *                       carried (difference − active corrections), under a row
 *                       lock on the filed return, so nothing is corrected twice.
 *   cancelCorrection()  only while the target period has no filed return
 *
 * Leo's own VAT201 figures come from the ledger via vatDetailReportService
 * (same journals as the VAT201 headline) plus corrections carried INTO the
 * period. Read and write paths are scoped by company_id everywhere.
 *
 * Why differences don't already flow on by themselves: once a period is
 * locked, entries dated in it are swept to the open period (and excluded from
 * the old one by PERIOD_JOURNAL_FILTER) — those correct themselves. What is
 * left is what the filed return itself got wrong, or what was posted between
 * the eFiling date and capturing the return here.
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
  // corrections of earlier filed periods carried into this one (migration 190)
  const corr = report.summary.corrections;
  if (corr) {
    f.field_12 = round2(f.field_12 + corr.outputVat);
    f.field_18 = round2(f.field_18 + corr.inputVat);
  }
  return Object.assign(f, computeTotals(f));
}

/**
 * What of a filed period's difference is still uncorrected: Total A / Total B
 * difference (Leo − filed) minus active corrections already carried. Pure.
 */
function remainingToCorrect(differences, correctionsOut) {
  const diff = key => {
    const d = (differences || []).find(x => x.key === key);
    return d ? d.difference : 0;
  };
  const active = (correctionsOut || []).filter(c => c.status === 'active');
  const carriedOutput = round2(active.reduce((s, c) => s + Number(c.output_vat), 0));
  const carriedInput = round2(active.reduce((s, c) => s + Number(c.input_vat), 0));
  return {
    outputDifference: diff('field_13'), inputDifference: diff('field_19'),
    carriedOutput, carriedInput,
    output: round2(diff('field_13') - carriedOutput),
    input: round2(diff('field_19') - carriedInput),
  };
}

/**
 * Check amounts to carry against what is still uncorrected: same direction,
 * not more than what is left, not both zero. Pure.
 */
function validateCarry(remaining, outputVat, inputVat) {
  const errors = [];
  const parse = (raw, label) => {
    if (raw === undefined || raw === null || raw === '') return 0;
    const v = Number(String(raw).replace(/[\s,]/g, '').replace(/^R/i, ''));
    if (!Number.isFinite(v)) { errors.push(`${label} is not a number`); return 0; }
    return round2(v);
  };
  const out = parse(outputVat, 'Output VAT correction');
  const inp = parse(inputVat, 'Input VAT correction');
  if (!errors.length && Math.abs(out) < 0.005 && Math.abs(inp) < 0.005) errors.push('Give an output and/or input VAT amount to carry');
  for (const [amt, left, label] of [[out, remaining.output, 'output VAT (field 12)'], [inp, remaining.input, 'input VAT (field 18)']]) {
    if (Math.abs(amt) < 0.005) continue;
    if (Math.abs(left) < 0.005) errors.push(`There is no uncorrected ${label} difference left for this period`);
    else if (Math.sign(amt) !== Math.sign(left)) errors.push(`The ${label} correction must be ${left > 0 ? 'positive' : 'negative'}, like the difference (${left.toFixed(2)})`);
    else if (Math.abs(amt) > Math.abs(left) + 0.005) errors.push(`Only ${left.toFixed(2)} ${label} is still uncorrected — ${amt.toFixed(2)} would correct it twice`);
  }
  return { outputVat: out, inputVat: inp, errors };
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

/** { periodKey, fromDate, toDate } of the calendar month after a YYYY-MM-DD date. Pure. */
function nextMonthAfter(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  const [y, m] = dateStr.split('-').map(Number);          // month of the date, 1-12
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const mm = String(nm).padStart(2, '0');
  return { periodKey: `${ny}-${mm}`, fromDate: `${ny}-${mm}-01`, toDate: `${ny}-${mm}-${String(last).padStart(2, '0')}` };
}

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

    const correctionsOut = await this._corrections(companyId, 'source', periodId);
    const correctionsIn = await this._corrections(companyId, 'target', periodId);
    const remaining = current ? remainingToCorrect(differences, correctionsOut) : null;
    let carryTargets = [], newTargetSuggestion = null;
    if (remaining && (Math.abs(remaining.output) >= 0.01 || Math.abs(remaining.input) >= 0.01)) {
      ({ targets: carryTargets, suggestion: newTargetSuggestion } = await this._carryTargets(companyId, period));
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
      correctionsOut, correctionsIn, remaining, carryTargets, newTargetSuggestion,
    };
  }

  /** Corrections from ('source') or into ('target') a period, with period keys + whether the target is filed. */
  async _corrections(companyId, side, periodId) {
    const col = side === 'source' ? 'c.source_period_id' : 'c.target_period_id';
    try {
      const { rows } = await db.query(
        `SELECT c.id, c.source_period_id, c.target_period_id, c.source_return_id,
                c.output_vat::float AS output_vat, c.input_vat::float AS input_vat,
                c.reason, c.status, c.created_at, c.cancelled_at, c.cancel_reason,
                sp.period_key AS source_period_key, tp.period_key AS target_period_key,
                EXISTS (SELECT 1 FROM vat_returns r
                         WHERE r.company_id = c.company_id AND r.vat_period_id = c.target_period_id
                           AND r.status = 'filed') AS target_filed
           FROM vat_corrections c
           JOIN vat_periods sp ON sp.id = c.source_period_id AND sp.company_id = c.company_id
           JOIN vat_periods tp ON tp.id = c.target_period_id AND tp.company_id = c.company_id
          WHERE c.company_id = $1 AND ${col} = $2
          ORDER BY c.created_at, c.id`, [companyId, periodId]);
      return rows;
    } catch (err) {
      if (err.code === '42P01') return [];        // migration 190 not run yet
      throw err;
    }
  }

  /**
   * Periods a difference can be carried into: later than the source and not
   * filed yet. Plus a suggested next month when a new one must be created.
   */
  async _carryTargets(companyId, source) {
    const { rows: targets } = await db.query(
      `SELECT p.id, p.period_key, p.from_date::text AS from_date, p.to_date::text AS to_date, p.status
         FROM vat_periods p
        WHERE p.company_id = $1 AND p.from_date > $2::date
          AND NOT EXISTS (SELECT 1 FROM vat_returns r
                           WHERE r.company_id = p.company_id AND r.vat_period_id = p.id AND r.status = 'filed')
        ORDER BY p.from_date`, [companyId, source.to_date]);
    const { rows: last } = await db.query(
      `SELECT MAX(to_date)::text AS last_to FROM vat_periods WHERE company_id = $1`, [companyId]);
    return { targets, suggestion: nextMonthAfter(last[0] && last[0].last_to > source.to_date ? last[0].last_to : source.to_date) };
  }

  async _resolveTarget(companyId, source, p) {
    const bad = msg => { const e = new Error(msg); e.status = 400; return e; };
    let target;
    if (parseInt(p.targetPeriodId, 10)) {
      target = await this._period(companyId, parseInt(p.targetPeriodId, 10));
      if (!target) { const e = new Error('Target VAT period not found'); e.status = 404; throw e; }
    } else if (p.targetNewPeriod) {
      const np = p.targetNewPeriod;
      if (!/^\d{4}-\d{2}$/.test(np.periodKey || '') || !/^\d{4}-\d{2}-\d{2}$/.test(np.fromDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(np.toDate || '') || np.fromDate > np.toDate) {
        throw bad('Give the new period as YYYY-MM with a from and to date');
      }
      const { rows: overlap } = await db.query(
        `SELECT period_key FROM vat_periods WHERE company_id = $1 AND from_date <= $3::date AND to_date >= $2::date LIMIT 1`,
        [companyId, np.fromDate, np.toDate]);
      if (overlap.length) throw bad(`Period ${overlap[0].period_key} already covers these dates — choose it from the list`);
      if (np.fromDate <= source.to_date) throw bad('The correction must go into a period after the one being corrected');
      const created = await vatReconService.createOrGetPeriod(companyId, {
        periodKey: np.periodKey, fromDate: np.fromDate, toDate: np.toDate, filingFrequency: np.filingFrequency || 'monthly',
      });
      target = await this._period(companyId, created.id);
    } else {
      throw bad('Choose the later period the correction goes into');
    }
    if (target.from_date <= source.to_date) throw bad('The correction must go into a period after the one being corrected');
    return target;
  }

  /**
   * Carry (part of) a filed period's difference into a later, unfiled return.
   * p: { sourcePeriodId, targetPeriodId | targetNewPeriod, outputVat, inputVat, reason }
   */
  async carryCorrection(companyId, userId, p) {
    const reason = String(p.reason || '').trim();
    if (!reason) { const e = new Error('A reason is required — it shows on the later return\'s VAT report'); e.status = 400; throw e; }
    const sourceId = parseInt(p.sourcePeriodId, 10);
    const source = sourceId ? await this._period(companyId, sourceId) : null;
    if (!source) { const e = new Error('VAT period not found'); e.status = 404; throw e; }

    const { rows: cur } = await db.query(
      `SELECT ${RETURN_COLS.filter(c => c !== 'ledger_snapshot').join(', ')}
         FROM vat_returns WHERE company_id = $1 AND vat_period_id = $2 AND status = 'filed'`, [companyId, sourceId]);
    if (!cur.length) { const e = new Error('Capture the filed return for this period first — there is nothing to correct against yet'); e.status = 400; throw e; }
    const current = numericReturn(cur[0]);
    const differences = diffFields((await this._ledger(companyId, source)).fields, current);
    const target = await this._resolveTarget(companyId, source, p);

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Serialise carries for this source: lock its filed return.
      const { rows: lock } = await client.query(
        `SELECT id FROM vat_returns WHERE company_id = $1 AND vat_period_id = $2 AND status = 'filed' FOR UPDATE`,
        [companyId, sourceId]);
      if (!lock.length || lock[0].id !== current.id) {
        const e = new Error('The filed return for this period changed meanwhile — reload and try again'); e.status = 409; throw e;
      }
      const { rows: targetFiled } = await client.query(
        `SELECT 1 FROM vat_returns WHERE company_id = $1 AND vat_period_id = $2 AND status = 'filed' LIMIT 1`,
        [companyId, target.id]);
      if (targetFiled.length) {
        const e = new Error(`Period ${target.period_key} is already filed — choose a period that has not been filed yet`); e.status = 400; throw e;
      }
      const { rows: carried } = await client.query(
        `SELECT output_vat, input_vat, status FROM vat_corrections
          WHERE company_id = $1 AND source_period_id = $2 AND status = 'active'`, [companyId, sourceId]);
      const remaining = remainingToCorrect(differences, carried);
      const { outputVat, inputVat, errors } = validateCarry(remaining, p.outputVat, p.inputVat);
      if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }

      const { rows: ins } = await client.query(
        `INSERT INTO vat_corrections (company_id, source_period_id, source_return_id, target_period_id,
                                      output_vat, input_vat, reason, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, source_period_id, target_period_id, source_return_id,
                   output_vat::float AS output_vat, input_vat::float AS input_vat, reason, status, created_at`,
        [companyId, sourceId, current.id, target.id, outputVat, inputVat, reason, userId || null]);
      await client.query('COMMIT');
      return { correction: { ...ins[0], source_period_key: source.period_key, target_period_key: target.period_key } };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Cancel a carried correction — only while the target period has no filed return. */
  async cancelCorrection(companyId, userId, correctionId, reason) {
    const { rows } = await db.query(
      `UPDATE vat_corrections c
          SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $3, cancel_reason = $4
        WHERE c.id = $1 AND c.company_id = $2 AND c.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM vat_returns r
                           WHERE r.company_id = c.company_id AND r.vat_period_id = c.target_period_id
                             AND r.status = 'filed')
        RETURNING c.id, c.source_period_id, c.target_period_id, c.output_vat::float AS output_vat,
                  c.input_vat::float AS input_vat, c.reason, c.status`,
      [correctionId, companyId, userId || null, String(reason || '').trim() || null]);
    if (rows.length) return rows[0];
    const { rows: found } = await db.query(
      `SELECT status FROM vat_corrections WHERE id = $1 AND company_id = $2`, [correctionId, companyId]);
    if (!found.length) { const e = new Error('Correction not found'); e.status = 404; throw e; }
    const e = new Error(found[0].status === 'cancelled'
      ? 'This correction is already cancelled'
      : 'The later return with this correction is already filed — it can no longer be cancelled. Correct it in a revised return instead.');
    e.status = 409;
    throw e;
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
          AND j.status IN ('posted', 'reversed')
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

    // A revision after part of the difference was carried to a later return
    // would correct the same thing twice — make the user confirm deliberately.
    const carriedOut = (await this._corrections(companyId, 'source', periodId)).filter(c => c.status === 'active');
    if (carriedOut.length && !payload.confirmCorrections) {
      const e = new Error(`Differences of this period were already carried to ${[...new Set(carriedOut.map(c => c.target_period_key))].join(', ')}. ` +
        'A revised return that also fixes them would correct them twice — cancel those corrections first (if not yet filed), or confirm that the revision does not include them.');
      e.status = 409; e.code = 'CORRECTIONS_EXIST';
      throw e;
    }

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
  remainingToCorrect, validateCarry, nextMonthAfter,
});
