'use strict';

/**
 * ============================================================================
 * VAT Detail Report — "show me exactly where my output and input VAT come from"
 * ============================================================================
 * Built straight from the posted general ledger, so every figure is a real
 * booked amount (no back-calculation from VAT ÷ 15%):
 *
 *   one row per posted journal in the VAT period
 *     • VAT       = movement on VAT Output (2300) / VAT Input (1400)
 *     • Exclusive = the income lines (output) or the expense / asset lines
 *                   (input) of that same journal
 *     • Inclusive = Exclusive + VAT
 *
 * Sections:
 *   OUTPUT  standard rate          — journals with output VAT
 *   OUTPUT  no VAT                 — income with no VAT (zero-rated or exempt;
 *                                    the ledger can't tell those two apart)
 *   INPUT   standard rate          — journals with input VAT
 *   INPUT   no VAT                 — expenses/assets with no VAT claimed
 *   VAT     adjustments            — VAT lines with no income/expense in the journal
 *
 * Journals with only balance-sheet lines (bank transfers, loans, customer
 * receipts, supplier payments, VAT payments to SARS) are not supplies and are
 * left out — they are only counted in the summary.
 *
 * Period + journal selection is IDENTICAL to vatReportService (the VAT201
 * headline): period from vat_periods (month fallback), date range OR swept
 * forward into this period as out-of-period. So the VAT totals here always tie
 * to the headline Output/Input VAT — the summary shows that check.
 *
 * Read-only. Multi-tenant: every query scoped by company_id.
 * ============================================================================
 */

const db = require('../config/database');
const vatReportService = require('./vatReportService');
const { PERIOD_JOURNAL_FILTER } = require('./vatReportService');

const STANDARD_RATE = 15;            // SA standard rate (same as vatCategoryReportService)
const SPLIT_THRESHOLD = 1.0;         // R1 — below this a difference is rounding, not a no-VAT part

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

const blankTotals = () => ({ count: 0, exclusive: 0, vat: 0, inclusive: 0 });

function addTo(t, row) {
  t.count += 1;
  t.exclusive = round2(t.exclusive + row.exclusive);
  t.vat       = round2(t.vat + row.vat);
  t.inclusive = round2(t.inclusive + row.inclusive);
}

/**
 * Turn one journal (header + its lines) into report rows. Pure — exported for tests.
 *
 * line: { code, name, type, sub_type, debit, credit }
 * @returns {Array<{section, date, reference, description, account, exclusive, vat, inclusive, note}>}
 */
function classifyJournal(journal, lines, rate = STANDARD_RATE) {
  let outputVat = 0, inputVat = 0;
  let income = 0;                // net credit on income accounts
  let purchases = 0;             // net debit on expense + non-current asset accounts
  let stockAndOther = 0;         // net debit on current (non-bank) assets — counts for input only when VAT was claimed
  let capital = 0;               // part of `purchases` on non-current (fixed) assets → VAT201 field 14
  const incomeNames = new Set(), purchaseNames = new Set(), stockNames = new Set();

  for (const l of lines) {
    const dr = Number(l.debit) || 0, cr = Number(l.credit) || 0;
    if (l.code === '2300') { outputVat += cr - dr; continue; }
    if (l.code === '1400') { inputVat += dr - cr; continue; }
    if (l.type === 'income') { income += cr - dr; incomeNames.add(l.name); continue; }
    if (l.type === 'expense' || (l.type === 'asset' && l.sub_type === 'non_current_asset')) {
      purchases += dr - cr; purchaseNames.add(l.name);
      if (l.type === 'asset') capital += dr - cr;
      continue;
    }
    if (l.type === 'asset' && l.sub_type !== 'bank' && dr > cr) {
      stockAndOther += dr - cr; stockNames.add(l.name);
    }
  }
  outputVat = round2(outputVat); inputVat = round2(inputVat);
  income = round2(income); purchases = round2(purchases); stockAndOther = round2(stockAndOther);

  const base = {
    journalId: journal.id,
    date: journal.date,
    reference: journal.reference || '',
    description: journal.description || '',
    note: journal.is_out_of_period ? 'Late item moved into this period'
        : journal.reversal_of_journal_id ? 'Reversal of an earlier entry' : '',
  };
  const names = set => [...set].filter(Boolean).slice(0, 3).join(', ');
  const rows = [];

  // Split a VAT-bearing amount into the part that carries VAT and a no-VAT remainder
  // (e.g. an invoice with a 15% line and a 0% line).
  const split = (excl, vat) => {
    if (Math.abs(vat) < 0.005) return { std: 0, rest: excl };
    const expected = round2(vat / (rate / 100));
    const rest = round2(excl - expected);
    if (Math.sign(rest) === Math.sign(excl) && Math.abs(rest) > SPLIT_THRESHOLD) {
      return { std: expected, rest };
    }
    return { std: excl, rest: 0 };
  };

  // ── Output side ──────────────────────────────────────────────────────────
  if (Math.abs(outputVat) >= 0.005) {
    if (Math.abs(income) < 0.005) {
      rows.push({ ...base, section: 'vat_adjustment', account: 'VAT Output (2300)',
        exclusive: 0, vat: outputVat, inclusive: outputVat,
        note: base.note || 'Output VAT with no income line in this entry' });
    } else {
      const { std, rest } = split(income, outputVat);
      rows.push({ ...base, section: 'output_standard', account: names(incomeNames),
        exclusive: std, vat: outputVat, inclusive: round2(std + outputVat) });
      if (rest) rows.push({ ...base, section: 'output_no_vat', account: names(incomeNames),
        exclusive: rest, vat: 0, inclusive: rest,
        note: base.note || 'Part of this entry carried no VAT' });
    }
  } else if (Math.abs(income) >= 0.005) {
    rows.push({ ...base, section: 'output_no_vat', account: names(incomeNames),
      exclusive: income, vat: 0, inclusive: income });
  }

  // ── Input side ───────────────────────────────────────────────────────────
  if (Math.abs(inputVat) >= 0.005) {
    const cost = round2(purchases + stockAndOther);
    const acct = names(new Set([...purchaseNames, ...stockNames]));
    if (Math.abs(cost) < 0.005) {
      rows.push({ ...base, section: 'vat_adjustment', account: 'VAT Input (1400)',
        exclusive: 0, vat: inputVat, inclusive: inputVat,
        note: base.note || 'Input VAT with no expense line in this entry' });
    } else {
      const { std, rest } = split(cost, inputVat);
      // Mostly fixed assets → capital goods (VAT201 field 14) rather than field 15.
      const isCapital = Math.abs(capital) >= 0.005 && Math.abs(capital) * 2 >= Math.abs(cost);
      rows.push({ ...base, section: 'input_standard', account: acct, capital: isCapital,
        exclusive: std, vat: inputVat, inclusive: round2(std + inputVat) });
      if (rest) rows.push({ ...base, section: 'input_no_vat', account: acct,
        exclusive: rest, vat: 0, inclusive: rest,
        note: base.note || 'Part of this entry carried no VAT' });
    }
  } else if (Math.abs(purchases) >= 0.005) {
    rows.push({ ...base, section: 'input_no_vat', account: names(purchaseNames),
      exclusive: purchases, vat: 0, inclusive: purchases });
  }

  return rows;
}

/** Totals + the step-by-step VAT calculation. Pure — exported for tests. */
function buildSummary(rows, headline, rate = STANDARD_RATE) {
  const t = {
    output_standard: blankTotals(), output_no_vat: blankTotals(),
    input_standard: blankTotals(), input_no_vat: blankTotals(),
    vat_adjustment: blankTotals(),
  };
  let adjOutput = 0, adjInput = 0;
  for (const r of rows) {
    addTo(t[r.section], r);
    if (r.section === 'vat_adjustment') {
      if (r.account.includes('2300')) adjOutput = round2(adjOutput + r.vat);
      else adjInput = round2(adjInput + r.vat);
    }
  }

  const outputVat = round2(t.output_standard.vat + adjOutput);
  const inputVat  = round2(t.input_standard.vat + adjInput);
  const net = round2(outputVat - inputVat);

  return {
    rate,
    totals: t,
    calculation: {
      outputStandardExclusive: t.output_standard.exclusive,
      outputVatExpected: round2(t.output_standard.exclusive * rate / 100),
      outputVatOnSupplies: t.output_standard.vat,
      outputVatAdjustments: adjOutput,
      outputVat,
      outputNoVatExclusive: t.output_no_vat.exclusive,
      inputStandardExclusive: t.input_standard.exclusive,
      inputVatExpected: round2(t.input_standard.exclusive * rate / 100),
      inputVatOnPurchases: t.input_standard.vat,
      inputVatAdjustments: adjInput,
      inputVat,
      inputNoVatExclusive: t.input_no_vat.exclusive,
      netVat: net,
      result: net > 0.005 ? 'payable' : net < -0.005 ? 'refundable' : 'nil',
    },
    tieOut: {
      headlineOutputVat: headline.outputVat,
      headlineInputVat: headline.inputVat,
      outputDifference: round2(outputVat - headline.outputVat),
      inputDifference: round2(inputVat - headline.inputVat),
      ties: Math.abs(outputVat - headline.outputVat) < 0.01 && Math.abs(inputVat - headline.inputVat) < 0.01,
    },
  };
}

class VatDetailReportService {
  /**
   * @param {number} companyId
   * @param {string} periodKey  YYYY-MM
   * @param {object} [range]    explicit { periodId, dateFrom, dateTo } — used by
   *                            vatReturnsService for periods (e.g. bi-monthly or
   *                            older) whose dates are known exactly
   */
  async generate(companyId, periodKey, range = null) {
    const period = range && range.dateFrom && range.dateTo
      ? { periodKey, periodId: range.periodId || null, dateFrom: range.dateFrom, dateTo: range.dateTo,
          status: range.status || 'draft', warnings: [] }
      : await vatReportService.getVatPeriodRange(companyId, periodKey);
    const { dateFrom, dateTo, periodId } = period;

    const { rows: lineRows } = await db.query(
      `SELECT j.id, j.date::text AS date, j.reference, j.description,
              j.is_out_of_period, j.reversal_of_journal_id, j.posted_at,
              a.code, a.name, a.type, a.sub_type, jl.debit, jl.credit
         FROM journals j
         JOIN journal_lines jl ON jl.journal_id = j.id
         JOIN accounts a       ON a.id = jl.account_id
        WHERE j.company_id = $1
          AND j.status = 'posted'
          AND ${PERIOD_JOURNAL_FILTER}
        ORDER BY j.date, j.id, jl.id`,
      [companyId, dateFrom, dateTo, periodId]
    );

    // group lines per journal (rows arrive ordered by journal)
    const journals = [];
    let cur = null;
    for (const r of lineRows) {
      if (!cur || cur.header.id !== r.id) {
        cur = { header: r, lines: [] };
        journals.push(cur);
      }
      cur.lines.push(r);
    }

    const rows = [];
    let notVatRelated = 0;
    for (const j of journals) {
      const jr = classifyJournal(j.header, j.lines);
      if (jr.length === 0) notVatRelated++;
      rows.push(...jr);
    }

    const headline = {
      outputVat: await vatReportService.calculateOutputVat(companyId, dateFrom, dateTo, periodId),
      inputVat:  await vatReportService.calculateInputVat(companyId, dateFrom, dateTo, periodId),
    };
    const summary = buildSummary(rows, headline);

    const warnings = [...period.warnings];
    if (!summary.tieOut.ties) {
      warnings.push('The detail does not add up to the VAT201 headline figures — please report this; the headline is taken directly from the VAT control accounts.');
    }
    if (summary.totals.vat_adjustment.count > 0) {
      warnings.push(`${summary.totals.vat_adjustment.count} entr${summary.totals.vat_adjustment.count === 1 ? 'y posts' : 'ies post'} VAT with no income or expense line (manual VAT adjustments). Check them under "VAT adjustments".`);
    }

    return {
      companyId,
      periodKey: period.periodKey,
      dateFrom, dateTo,
      status: period.status,
      rows,
      summary,
      notVatRelatedCount: notVatRelated,
      warnings,
      generatedAt: new Date().toISOString(),
    };
  }
}

module.exports = new VatDetailReportService();
module.exports.classifyJournal = classifyJournal;
module.exports.buildSummary = buildSummary;
module.exports.SECTION_TITLES = {
  output_standard: 'OUTPUT VAT — Standard rate (15%)',
  output_no_vat:   'OUTPUT — Income with no VAT (zero-rated / exempt)',
  input_standard:  'INPUT VAT — Standard rate (15%) purchases and expenses',
  input_no_vat:    'INPUT — Purchases and expenses with no VAT claimed (zero-rated / exempt / not claimable)',
  vat_adjustment:  'VAT adjustments (VAT with no income or expense line)',
};
