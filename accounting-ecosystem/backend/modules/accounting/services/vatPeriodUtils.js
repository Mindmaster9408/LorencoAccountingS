'use strict';

/**
 * vatPeriodUtils.js
 * Pure VAT period derivation utilities — no DB access, fully testable.
 *
 * South African VAT filing frequencies:
 *   monthly    — each calendar month is its own period
 *   bi-monthly — every 2 months; cycle determines period-end months:
 *                  even: Feb, Apr, Jun, Aug, Oct, Dec
 *                  odd:  Jan, Mar, May, Jul, Sep, Nov
 *                  (odd cycle: Dec+Jan spans the year boundary → period ends Jan)
 *   quarterly  — every 3 months; period ends Mar, Jun, Sep, Dec
 *   annually   — full tax year (12 months)
 *
 * Period key format: "YYYY-MM" (the period's end month).
 * E.g. bi-monthly even, Jan+Feb → period key "2025-02"
 *      bi-monthly odd,  Dec+Jan → period key "2026-01"
 */

// ─── Internal helpers ────────────────────────────────────────────────────────

function _pad(n) { return String(n).padStart(2, '0'); }

/** Return "YYYY-MM-DD" string from year/month/day integers. */
function _ymd(y, m, d) {
  return `${y}-${_pad(m)}-${_pad(d)}`;
}

/** Last day of month as integer. */
function _lastDay(year, month) {
  return new Date(year, month, 0).getDate(); // month here is 1-based, new Date handles it
}

// ─── Period derivation ───────────────────────────────────────────────────────

/**
 * Given a date string (YYYY-MM-DD), filing frequency, and optional cycle type,
 * return the VAT period that contains this date.
 *
 * Returns: { periodKey, fromDate, toDate }
 *   periodKey  — "YYYY-MM" (end month)
 *   fromDate   — "YYYY-MM-DD" first day of period
 *   toDate     — "YYYY-MM-DD" last day of period
 */
function derivePeriodForDate(dateStr, filingFrequency, vatCycleType) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const year  = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12

  switch ((filingFrequency || 'bi-monthly').toLowerCase()) {

    case 'monthly': {
      const periodKey = `${year}-${_pad(month)}`;
      const fromDate  = _ymd(year, month, 1);
      const toDate    = _ymd(year, month, _lastDay(year, month));
      return { periodKey, fromDate, toDate };
    }

    case 'bi-monthly':
    case 'every 2 months': {
      const cycle = (vatCycleType || 'even').toLowerCase();

      if (cycle === 'even') {
        // Even ends: Feb(2), Apr(4), Jun(6), Aug(8), Oct(10), Dec(12)
        // Jan→Feb, Feb→Feb, Mar→Apr, Apr→Apr, etc.
        const endMonth  = month % 2 === 0 ? month : month + 1;
        const startMonth = endMonth - 1;
        const endYear   = year;
        const startYear = year;

        const periodKey = `${endYear}-${_pad(endMonth)}`;
        const fromDate  = _ymd(startYear, startMonth, 1);
        const toDate    = _ymd(endYear, endMonth, _lastDay(endYear, endMonth));
        return { periodKey, fromDate, toDate };

      } else {
        // Odd ends: Jan(1), Mar(3), May(5), Jul(7), Sep(9), Nov(11)
        // Dec→Jan of next year (spans year boundary)
        // Nov→Nov, Dec→Jan(next year), Jan→Jan, Feb→Mar, Mar→Mar, etc.
        if (month === 12) {
          // Dec is the start of a period that ends in Jan of next year
          const endYear   = year + 1;
          const periodKey = `${endYear}-01`;
          const fromDate  = _ymd(year, 12, 1);
          const toDate    = _ymd(endYear, 1, 31);
          return { periodKey, fromDate, toDate };
        }
        // Odd months end themselves; even months roll to next odd
        const endMonth   = month % 2 !== 0 ? month : month + 1;
        const startMonth = endMonth - 1;
        // Handle Jan → start is Dec of previous year
        if (endMonth === 1) {
          const startYear = year - 1;
          const periodKey = `${year}-01`;
          const fromDate  = _ymd(startYear, 12, 1);
          const toDate    = _ymd(year, 1, 31);
          return { periodKey, fromDate, toDate };
        }
        const periodKey = `${year}-${_pad(endMonth)}`;
        const fromDate  = _ymd(year, startMonth, 1);
        const toDate    = _ymd(year, endMonth, _lastDay(year, endMonth));
        return { periodKey, fromDate, toDate };
      }
    }

    case 'quarterly': {
      // Ends: Mar(3), Jun(6), Sep(9), Dec(12)
      const endMonth   = Math.ceil(month / 3) * 3;
      const startMonth = endMonth - 2;
      const periodKey  = `${year}-${_pad(endMonth)}`;
      const fromDate   = _ymd(year, startMonth, 1);
      const toDate     = _ymd(year, endMonth, _lastDay(year, endMonth));
      return { periodKey, fromDate, toDate };
    }

    case 'annually': {
      // SA tax year: March to February (e.g. Mar 2025 – Feb 2026)
      // Period key = year the period ends in
      let periodEndYear, fromYear;
      if (month >= 3) {
        fromYear      = year;
        periodEndYear = year + 1;
      } else {
        fromYear      = year - 1;
        periodEndYear = year;
      }
      const periodKey = `${periodEndYear}-02`;
      const fromDate  = _ymd(fromYear, 3, 1);
      const toDate    = _ymd(periodEndYear, 2, _lastDay(periodEndYear, 2));
      return { periodKey, fromDate, toDate };
    }

    default:
      throw new Error(`Unknown filing frequency: ${filingFrequency}`);
  }
}

/**
 * Generate all VAT periods between two dates (inclusive).
 *
 * @param {string} fromDateStr  YYYY-MM-DD — first date to cover
 * @param {string} toDateStr    YYYY-MM-DD — last date to cover
 * @param {string} filingFrequency
 * @param {string} vatCycleType
 * @returns {Array<{ periodKey, fromDate, toDate }>} ordered chronologically, unique
 */
function generatePeriods(fromDateStr, toDateStr, filingFrequency, vatCycleType) {
  const periods = new Map();

  // Walk month-by-month through the range, derive period for each month's first day
  const start = new Date(fromDateStr + 'T00:00:00Z');
  const end   = new Date(toDateStr   + 'T00:00:00Z');

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endFloor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

  while (cursor <= endFloor) {
    const dateStr = `${cursor.getUTCFullYear()}-${_pad(cursor.getUTCMonth() + 1)}-01`;
    const period  = derivePeriodForDate(dateStr, filingFrequency, vatCycleType);
    if (!periods.has(period.periodKey)) {
      periods.set(period.periodKey, period);
    }
    // Advance one month
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  return Array.from(periods.values()).sort((a, b) => a.periodKey.localeCompare(b.periodKey));
}

// ─── VAT journal detection helpers ───────────────────────────────────────────

/**
 * Return true if the journal lines contain any VAT account posting.
 * VAT accounts are those with reporting_group 'vat_asset' or 'vat_liability'.
 * Accepts lines as returned by journalService (with account_reporting_group
 * or vat_relevant flag injected at query time).
 *
 * This is a fast heuristic — the definitive check is done in the DB queries.
 */
function isVatJournal(lines) {
  if (!Array.isArray(lines)) return false;
  return lines.some(l =>
    l.account_reporting_group === 'vat_asset' ||
    l.account_reporting_group === 'vat_liability' ||
    l.is_vat_account === true
  );
}

/**
 * Extract VAT input and output totals from journal lines.
 * Returns { inputVat, outputVat } — both positive numbers.
 *
 * Convention (from accounting-schema and GL posting):
 *   VAT Input  (1400, reporting_group='vat_asset')     → debit = claim
 *   VAT Output (2300, reporting_group='vat_liability')  → credit = payable
 */
function getVatAmountsFromLines(lines) {
  let inputVat  = 0;
  let outputVat = 0;

  if (!Array.isArray(lines)) return { inputVat, outputVat };

  for (const l of lines) {
    const isInput  = l.account_reporting_group === 'vat_asset'     || l.account_code === '1400';
    const isOutput = l.account_reporting_group === 'vat_liability'  || l.account_code === '2300';

    if (isInput)  inputVat  += parseFloat(l.debit  || 0) - parseFloat(l.credit || 0);
    if (isOutput) outputVat += parseFloat(l.credit || 0) - parseFloat(l.debit  || 0);
  }

  return {
    inputVat:  Math.round(inputVat  * 100) / 100,
    outputVat: Math.round(outputVat * 100) / 100,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  derivePeriodForDate,
  generatePeriods,
  isVatJournal,
  getVatAmountsFromLines,
};
