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

// Added 2026-09-13 for Ledger Leo's UK rollout — display-only, same as the
// two lookups above (never a source of truth for an actual tax
// calculation). Only ZA/UK are populated with real values for now; AU_NZ/US
// fall back to the ZA value everywhere below exactly like getTaxLabel/
// getCurrencyDisplay already do, since no accounting work has been done for
// those two jurisdictions yet — revisit when that happens.
const TAX_AUTHORITY_BY_JURISDICTION = {
  ZA: 'SARS',
  UK: 'HMRC',
};

// Default VAT/GST/Sales Tax RATE — a starting point new companies/accounts
// are seeded with, not a live-updated rate table. Whoever sets this jurisdiction
// up must still confirm the current real rate; this only saves them from a
// silent 15% (South Africa's rate) appearing for a UK company by accident.
const DEFAULT_TAX_RATE_BY_JURISDICTION = {
  ZA: 15,
  UK: 20,
};

// Default VAT return filing frequency — SA is bi-monthly by default (though
// some vendors file monthly), UK is quarterly by default (though some file
// monthly/annually under specific schemes). vatPeriodUtils.js already
// supports both 'bi-monthly' and 'quarterly' as filingFrequency values —
// this just picks the sensible starting default per jurisdiction instead of
// always defaulting new companies to the SA convention.
const DEFAULT_VAT_FREQUENCY_BY_JURISDICTION = {
  ZA: 'bi-monthly',
  UK: 'quarterly',
};

function getTaxLabel(jurisdiction) {
  return TAX_LABEL_BY_JURISDICTION[jurisdiction] || TAX_LABEL_BY_JURISDICTION.ZA;
}

function getCurrencyDisplay(currencyCode) {
  return CURRENCY_DISPLAY[currencyCode] || CURRENCY_DISPLAY.ZAR;
}

function getTaxAuthority(jurisdiction) {
  return TAX_AUTHORITY_BY_JURISDICTION[jurisdiction] || TAX_AUTHORITY_BY_JURISDICTION.ZA;
}

function getDefaultTaxRate(jurisdiction) {
  return DEFAULT_TAX_RATE_BY_JURISDICTION[jurisdiction] ?? DEFAULT_TAX_RATE_BY_JURISDICTION.ZA;
}

function getDefaultVatFrequency(jurisdiction) {
  return DEFAULT_VAT_FREQUENCY_BY_JURISDICTION[jurisdiction] || DEFAULT_VAT_FREQUENCY_BY_JURISDICTION.ZA;
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
    tax_authority: getTaxAuthority(jurisdiction),
    locale,
  };
}

module.exports = {
  JURISDICTIONS,
  getTaxLabel,
  getCurrencyDisplay,
  getTaxAuthority,
  getDefaultTaxRate,
  getDefaultVatFrequency,
  buildDisplayConfig,
};
