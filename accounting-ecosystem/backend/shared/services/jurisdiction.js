/**
 * ============================================================================
 * Jurisdiction / Currency Display Service
 * ============================================================================
 * Shared lookup for the 4 international jurisdictions this ecosystem
 * supports (South Africa, UK, Australia/NZ, US) — first used by Collector's
 * email templates, now also by POS (Charlie) and Inventory (Stockton) for
 * tax-label and currency display. Keeping this in one place means adding a
 * 5th jurisdiction later, or fixing a symbol/locale, only needs to happen
 * once.
 *
 * This governs DISPLAY only (what a tax rate is called, what symbol/locale
 * to format money with) — it does not compute tax, is not a source of tax
 * rates, and must never be treated as one.
 * ============================================================================
 */

const JURISDICTIONS = ['ZA', 'UK', 'AU_NZ', 'US'];

const TAX_LABEL_BY_JURISDICTION = {
  ZA: 'VAT',
  UK: 'VAT',
  AU_NZ: 'GST',
  US: 'Sales Tax',
};

const CURRENCY_DISPLAY = {
  ZAR: { symbol: 'R', locale: 'en-ZA' },
  GBP: { symbol: '£', locale: 'en-GB' },
  AUD: { symbol: '$', locale: 'en-AU' },
  NZD: { symbol: '$', locale: 'en-NZ' },
  USD: { symbol: '$', locale: 'en-US' },
};

function getTaxLabel(jurisdiction) {
  return TAX_LABEL_BY_JURISDICTION[jurisdiction] || TAX_LABEL_BY_JURISDICTION.ZA;
}

function getCurrencyDisplay(currencyCode) {
  return CURRENCY_DISPLAY[currencyCode] || CURRENCY_DISPLAY.ZAR;
}

/**
 * Convenience: builds the full display bundle a frontend settings response
 * needs, from a company row's jurisdiction/currency_code (both default to
 * the South African values if the columns are somehow missing/null, so a
 * company predating migration 167 behaves identically to today).
 */
function buildDisplayConfig(company) {
  const jurisdiction = company?.jurisdiction || 'ZA';
  const currencyCode = company?.currency_code || 'ZAR';
  const { symbol, locale } = getCurrencyDisplay(currencyCode);
  return {
    jurisdiction,
    currency_code: currencyCode,
    currency_symbol: symbol,
    tax_label: getTaxLabel(jurisdiction),
    locale,
  };
}

module.exports = {
  JURISDICTIONS,
  getTaxLabel,
  getCurrencyDisplay,
  buildDisplayConfig,
};
