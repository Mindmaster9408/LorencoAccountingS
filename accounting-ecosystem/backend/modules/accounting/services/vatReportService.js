const db = require('../config/database');
const { getBadge } = require('./reportTruthBadge');

const PERIOD_KEY_CANONICAL = /^\d{4}-\d{2}$/;
const PERIOD_KEY_LEGACY = /^\d{4}\.\d{2}$/;

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function endOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function normalizeVatPeriodKey(input) {
  const raw = String(input || '').trim();

  if (PERIOD_KEY_CANONICAL.test(raw)) {
    return {
      periodKey: raw,
      normalized: false,
      legacyInput: null,
      warning: null,
    };
  }

  if (PERIOD_KEY_LEGACY.test(raw)) {
    const periodKey = raw.replace('.', '-');
    return {
      periodKey,
      normalized: true,
      legacyInput: raw,
      warning: `Legacy VAT period key '${raw}' normalized to '${periodKey}'.`,
    };
  }

  throw new Error('periodKey must be YYYY-MM (legacy YYYY.MM is accepted and normalized)');
}

class VATReportService {
  normalizeVatPeriodKey(input) {
    return normalizeVatPeriodKey(input);
  }

  async getVatPeriodRange(companyId, periodKeyInput) {
    const normalized = normalizeVatPeriodKey(periodKeyInput);
    const warnings = [];
    if (normalized.warning) warnings.push(normalized.warning);

    const canonicalKey = normalized.periodKey;
    const legacyKey = canonicalKey.replace('-', '.');

    const periodResult = await db.query(
      `SELECT id, period_key, from_date::text AS from_date, to_date::text AS to_date, status
       FROM vat_periods
       WHERE company_id = $1 AND period_key IN ($2, $3)
       ORDER BY CASE WHEN period_key = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [companyId, canonicalKey, legacyKey]
    );

    let periodId = null;
    let dateFrom;
    let dateTo;
    let status = 'draft';

    if (periodResult.rows.length > 0) {
      const row = periodResult.rows[0];
      periodId = row.id;
      dateFrom = row.from_date;
      dateTo = row.to_date;
      status = (row.status || 'draft').toLowerCase();
      if (row.period_key !== canonicalKey) {
        warnings.push(
          `Stored VAT period key '${row.period_key}' is legacy format. Report generated using canonical key '${canonicalKey}'.`
        );
      }
    } else {
      const [yearStr, monthStr] = canonicalKey.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);
      dateFrom = `${yearStr}-${monthStr}-01`;
      dateTo = endOfMonth(year, month);
      warnings.push('VAT period row not found. Using month boundary date range from normalized period key.');
    }

    return {
      periodId,
      periodKey: canonicalKey,
      dateFrom,
      dateTo,
      status,
      warnings,
    };
  }

  async getVatControlAccounts(companyId) {
    const rows = await db.query(
      `SELECT id, code, name
       FROM accounts
       WHERE company_id = $1
         AND is_active = true
         AND code IN ('1400', '2300')`,
      [companyId]
    );

    const byCode = {};
    for (const row of rows.rows) byCode[row.code] = row;

    const warnings = [];
    if (!byCode['1400']) {
      warnings.push('VAT Input account (1400) is missing from the active chart of accounts.');
    }
    if (!byCode['2300']) {
      warnings.push('VAT Output account (2300) is missing from the active chart of accounts.');
    }

    return {
      inputVatAccount: byCode['1400'] || null,
      outputVatAccount: byCode['2300'] || null,
      warnings,
    };
  }

  async calculateInputVat(companyId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS input_vat
       FROM journal_lines jl
       INNER JOIN journals j ON j.id = jl.journal_id
       INNER JOIN accounts a ON a.id = jl.account_id
       WHERE j.company_id = $1
         AND j.status = 'posted'
         AND j.date >= $2
         AND j.date <= $3
         AND a.code = '1400'`,
      [companyId, dateFrom, dateTo]
    );

    return round2(result.rows[0]?.input_vat || 0);
  }

  async calculateOutputVat(companyId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS output_vat
       FROM journal_lines jl
       INNER JOIN journals j ON j.id = jl.journal_id
       INNER JOIN accounts a ON a.id = jl.account_id
       WHERE j.company_id = $1
         AND j.status = 'posted'
         AND j.date >= $2
         AND j.date <= $3
         AND a.code = '2300'`,
      [companyId, dateFrom, dateTo]
    );

    return round2(result.rows[0]?.output_vat || 0);
  }

  async calculateOutOfPeriodVat(companyId, periodId) {
    if (!periodId) {
      return {
        journalCount: 0,
        inputVat: 0,
        outputVat: 0,
        netVat: 0,
      };
    }

    const result = await db.query(
      `SELECT
          COUNT(DISTINCT j.id)::int AS journal_count,
          COALESCE(SUM(CASE WHEN a.code = '1400' THEN (jl.debit - jl.credit) ELSE 0 END), 0) AS input_vat,
          COALESCE(SUM(CASE WHEN a.code = '2300' THEN (jl.credit - jl.debit) ELSE 0 END), 0) AS output_vat
       FROM journals j
       INNER JOIN journal_lines jl ON jl.journal_id = j.id
       INNER JOIN accounts a ON a.id = jl.account_id
       WHERE j.company_id = $1
         AND j.status = 'posted'
         AND j.vat_period_id = $2
         AND j.is_out_of_period = true
         AND a.code IN ('1400', '2300')`,
      [companyId, periodId]
    );

    const inputVat = round2(result.rows[0]?.input_vat || 0);
    const outputVat = round2(result.rows[0]?.output_vat || 0);

    return {
      journalCount: parseInt(result.rows[0]?.journal_count || 0, 10),
      inputVat,
      outputVat,
      netVat: round2(outputVat - inputVat),
    };
  }

  buildVat201Summary(outputVat, inputVat) {
    return {
      outputVat: round2(outputVat),
      inputVat: round2(inputVat),
      netVatPayableRefundable: round2(outputVat - inputVat),
    };
  }

  async buildSourceBreakdown(companyId, dateFrom, dateTo, periodId) {
    const rows = await db.query(
      `SELECT
          j.id AS journal_id,
          j.source_type,
          j.is_out_of_period,
          COALESCE(SUM(CASE WHEN a.code = '1400' THEN (jl.debit - jl.credit) ELSE 0 END), 0) AS input_vat,
          COALESCE(SUM(CASE WHEN a.code = '2300' THEN (jl.credit - jl.debit) ELSE 0 END), 0) AS output_vat
       FROM journals j
       INNER JOIN journal_lines jl ON jl.journal_id = j.id
       INNER JOIN accounts a ON a.id = jl.account_id
       WHERE j.company_id = $1
         AND j.status = 'posted'
         AND j.date >= $2
         AND j.date <= $3
         AND a.code IN ('1400', '2300')
       GROUP BY j.id, j.source_type, j.is_out_of_period`,
      [companyId, dateFrom, dateTo]
    );

    const blankBucket = () => ({ journalCount: 0, inputVat: 0, outputVat: 0, netVat: 0 });
    const sourceBreakdown = {
      customerInvoices: blankBucket(),
      supplierInvoices: blankBucket(),
      bankAllocations: blankBucket(),
      manualJournals: blankBucket(),
      outOfPeriod: blankBucket(),
    };

    const unclassifiedSources = {};

    const addToBucket = (bucket, input, output) => {
      sourceBreakdown[bucket].journalCount += 1;
      sourceBreakdown[bucket].inputVat = round2(sourceBreakdown[bucket].inputVat + input);
      sourceBreakdown[bucket].outputVat = round2(sourceBreakdown[bucket].outputVat + output);
      sourceBreakdown[bucket].netVat = round2(sourceBreakdown[bucket].outputVat - sourceBreakdown[bucket].inputVat);
    };

    for (const row of rows.rows) {
      const inputVat = round2(row.input_vat || 0);
      const outputVat = round2(row.output_vat || 0);
      const sourceType = (row.source_type || '').toLowerCase();

      if (row.is_out_of_period) {
        addToBucket('outOfPeriod', inputVat, outputVat);
        continue;
      }

      if (sourceType === 'customer_invoice') {
        addToBucket('customerInvoices', inputVat, outputVat);
      } else if (sourceType === 'supplier_invoice') {
        addToBucket('supplierInvoices', inputVat, outputVat);
      } else if (sourceType === 'bank') {
        addToBucket('bankAllocations', inputVat, outputVat);
      } else if (!sourceType || sourceType === 'manual') {
        addToBucket('manualJournals', inputVat, outputVat);
      } else {
        const key = row.source_type || '(blank)';
        if (!unclassifiedSources[key]) {
          unclassifiedSources[key] = { count: 0, inputVat: 0, outputVat: 0 };
        }
        unclassifiedSources[key].count += 1;
        unclassifiedSources[key].inputVat  = round2(unclassifiedSources[key].inputVat  + inputVat);
        unclassifiedSources[key].outputVat = round2(unclassifiedSources[key].outputVat + outputVat);
      }
    }

    if (periodId) {
      const oopByPeriod = await this.calculateOutOfPeriodVat(companyId, periodId);
      sourceBreakdown.outOfPeriod = oopByPeriod;
    }

    const totalUnclassified = Object.values(unclassifiedSources).reduce((s, b) => s + b.count, 0);
    const warnings = [];
    if (totalUnclassified > 0) {
      const typeList = Object.entries(unclassifiedSources)
        .map(([src, b]) => `'${src}' (${b.count} journal${b.count !== 1 ? 's' : ''}, ` +
          `output VAT R ${b.outputVat.toFixed(2)}, input VAT R ${b.inputVat.toFixed(2)})`)
        .join('; ');
      warnings.push(
        `${totalUnclassified} journal${totalUnclassified !== 1 ? 's' : ''} with unrecognised source type` +
        `${Object.keys(unclassifiedSources).length !== 1 ? 's' : ''} could not be classified: ${typeList}. ` +
        `These are included in the VAT totals but not in any source breakdown category. ` +
        `Check the source_type field on these journals.`
      );
    }

    return {
      sourceBreakdown,
      warnings,
      unclassifiedSources: totalUnclassified > 0 ? unclassifiedSources : null,
    };
  }

  async generateVatReport(companyId, periodKey, options = {}) {
    const warnings = [];

    const periodRange = await this.getVatPeriodRange(companyId, periodKey);
    warnings.push(...periodRange.warnings);

    const controls = await this.getVatControlAccounts(companyId);
    warnings.push(...controls.warnings);

    const outputVat = await this.calculateOutputVat(companyId, periodRange.dateFrom, periodRange.dateTo);
    const inputVat = await this.calculateInputVat(companyId, periodRange.dateFrom, periodRange.dateTo);

    const summary = this.buildVat201Summary(outputVat, inputVat);

    let sourceBreakdown = {
      customerInvoices: { journalCount: 0, inputVat: 0, outputVat: 0, netVat: 0 },
      supplierInvoices: { journalCount: 0, inputVat: 0, outputVat: 0, netVat: 0 },
      bankAllocations: { journalCount: 0, inputVat: 0, outputVat: 0, netVat: 0 },
      manualJournals: { journalCount: 0, inputVat: 0, outputVat: 0, netVat: 0 },
      outOfPeriod: { journalCount: 0, inputVat: 0, outputVat: 0, netVat: 0 },
    };

    const includeSources = options.includeSources !== false;
    if (includeSources) {
      const sourceData = await this.buildSourceBreakdown(
        companyId,
        periodRange.dateFrom,
        periodRange.dateTo,
        periodRange.periodId
      );
      sourceBreakdown = sourceData.sourceBreakdown;
      warnings.push(...sourceData.warnings);
    }

    return {
      companyId,
      periodKey: periodRange.periodKey,
      dateFrom: periodRange.dateFrom,
      dateTo: periodRange.dateTo,
      basis: 'invoice',
      status: periodRange.status,
      outputVat: summary.outputVat,
      inputVat: summary.inputVat,
      netVatPayableRefundable: summary.netVatPayableRefundable,
      warnings,
      sourceBreakdown,
      generatedAt: new Date().toISOString(),
      generatedBy: options.generatedBy || null,
      calculationVersion: 'VAT_ENGINE_V1', // TODO: hook this into immutable VAT snapshot persistence during period lock/submission.
      reportTruth: getBadge('posted_gl_only'),
    };
  }
}

module.exports = new VATReportService();
module.exports.normalizeVatPeriodKey = normalizeVatPeriodKey;
