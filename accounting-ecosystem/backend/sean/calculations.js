/**
 * ============================================================================
 * SEAN AI — SA Tax & Accounting Calculations
 * ============================================================================
 * Ported from sean-webapp/lib/calculations.ts
 * 100% LOCAL — Zero external API calls.
 * South African tax tables, VAT, PAYE, UIF, SDL calculations.
 * Tax tables valid for 2026/2027 tax year (1 Mar 2026 – 28 Feb 2027).
 * NOTE: SARS kept brackets unchanged from 2023/2024 through 2026/2027.
 *       Verify after each annual budget speech at www.sars.gov.za.
 * ============================================================================
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const VAT_RATE = 0.15; // 15%

// SA Income Tax Tables — valid 2023/2024 through 2026/2027 (brackets unchanged by SARS)
const INCOME_TAX_BRACKETS_2025 = [
  { min: 0, max: 237100, rate: 0.18, baseTax: 0 },
  { min: 237101, max: 370500, rate: 0.26, baseTax: 42678 },
  { min: 370501, max: 512800, rate: 0.31, baseTax: 77362 },
  { min: 512801, max: 673000, rate: 0.36, baseTax: 121475 },
  { min: 673001, max: 857900, rate: 0.39, baseTax: 179147 },
  { min: 857901, max: 1817000, rate: 0.41, baseTax: 251258 },
  { min: 1817001, max: Infinity, rate: 0.45, baseTax: 644489 }
];

// Tax Rebates — valid 2024/2025 through 2026/2027 (unchanged)
const TAX_REBATES_2025 = {
  primary: 17235,   // All taxpayers
  secondary: 9444,  // 65 years and older
  tertiary: 3145    // 75 years and older
};

// Tax Thresholds — verify annually at www.sars.gov.za
const TAX_THRESHOLDS_2025 = {
  under65: 95750,
  age65to74: 148217,
  age75plus: 165689
};

// Medical Aid Tax Credits — verify annually at www.sars.gov.za
const MEDICAL_TAX_CREDITS_2025 = {
  mainMember: 364,           // per month
  firstDependant: 364,       // per month
  additionalDependants: 246  // per month each
};

// UIF
const UIF_RATE = 0.01;       // 1% employee, 1% employer
const UIF_CEILING = 17712;   // Monthly ceiling

// SDL
const SDL_RATE = 0.01;       // 1% of payroll

// ─── VAT Calculations ───────────────────────────────────────────────────────

function calculateVATInclusive(excludingVAT) {
  const vat = excludingVAT * VAT_RATE;
  return {
    excluding: Math.round(excludingVAT * 100) / 100,
    vat: Math.round(vat * 100) / 100,
    including: Math.round((excludingVAT + vat) * 100) / 100
  };
}

function calculateVATExclusive(includingVAT) {
  const excluding = includingVAT / (1 + VAT_RATE);
  const vat = includingVAT - excluding;
  return {
    excluding: Math.round(excluding * 100) / 100,
    vat: Math.round(vat * 100) / 100,
    including: Math.round(includingVAT * 100) / 100
  };
}

function extractVATFromInclusive(includingVAT) {
  return Math.round((includingVAT * VAT_RATE / (1 + VAT_RATE)) * 100) / 100;
}

// ─── Income Tax ──────────────────────────────────────────────────────────────

function calculateIncomeTax(annualIncome, age = 30, medicalMembers = 0, medicalDependants = 0) {
  let grossTax = 0;
  const bracketDetails = [];

  for (const bracket of INCOME_TAX_BRACKETS_2025) {
    if (annualIncome > bracket.min) {
      if (bracket.min === 0) {
        const taxableAmount = Math.min(annualIncome, bracket.max);
        const taxOnBracket = taxableAmount * bracket.rate;
        grossTax = taxOnBracket;
        bracketDetails.push({
          bracket: `R0 - R${bracket.max.toLocaleString()}`,
          taxableInBracket: taxableAmount,
          taxOnBracket: Math.round(taxOnBracket * 100) / 100
        });
      } else if (annualIncome > bracket.min) {
        const taxableAbove = Math.min(
          annualIncome - bracket.min,
          bracket.max === Infinity ? Infinity : bracket.max - bracket.min
        );
        const taxOnBracket = taxableAbove * bracket.rate;
        grossTax = bracket.baseTax + taxOnBracket;
        bracketDetails.push({
          bracket: `R${bracket.min.toLocaleString()} - R${bracket.max === Infinity ? '∞' : bracket.max.toLocaleString()}`,
          taxableInBracket: taxableAbove,
          taxOnBracket: Math.round(taxOnBracket * 100) / 100
        });
      }
    }
  }

  // Rebates
  let rebates = TAX_REBATES_2025.primary;
  if (age >= 65) rebates += TAX_REBATES_2025.secondary;
  if (age >= 75) rebates += TAX_REBATES_2025.tertiary;

  // Medical tax credits (annual)
  let medicalCredits = 0;
  if (medicalMembers > 0) {
    medicalCredits += MEDICAL_TAX_CREDITS_2025.mainMember * 12;
    if (medicalMembers > 1 || medicalDependants > 0) {
      medicalCredits += MEDICAL_TAX_CREDITS_2025.firstDependant * 12;
    }
    if (medicalDependants > 1) {
      medicalCredits += MEDICAL_TAX_CREDITS_2025.additionalDependants * 12 * (medicalDependants - 1);
    }
  }

  const netTax = Math.max(0, grossTax - rebates - medicalCredits);

  // Marginal rate
  let marginalRate = 0;
  for (const bracket of INCOME_TAX_BRACKETS_2025) {
    if (annualIncome >= bracket.min) {
      marginalRate = bracket.rate;
    }
  }

  return {
    taxableIncome: annualIncome,
    grossTax: Math.round(grossTax * 100) / 100,
    rebates,
    medicalCredits,
    netTax: Math.round(netTax * 100) / 100,
    effectiveRate: annualIncome > 0 ? Math.round((netTax / annualIncome) * 10000) / 100 : 0,
    marginalRate: marginalRate * 100,
    monthlyTax: Math.round((netTax / 12) * 100) / 100,
    brackets: bracketDetails
  };
}

// ─── PAYE Calculation ────────────────────────────────────────────────────────

function calculatePAYE(monthlyGross, age = 30, medicalMembers = 0, medicalDependants = 0) {
  const annualGross = monthlyGross * 12;
  const annualTax = calculateIncomeTax(annualGross, age, medicalMembers, medicalDependants);
  const monthlyUIF = Math.min(monthlyGross * UIF_RATE, UIF_CEILING * UIF_RATE);

  return {
    monthlyPAYE: annualTax.monthlyTax,
    monthlyUIF: Math.round(monthlyUIF * 100) / 100,
    netSalary: Math.round((monthlyGross - annualTax.monthlyTax - monthlyUIF) * 100) / 100,
    annualProjection: annualTax
  };
}

// ─── Currency Formatting ─────────────────────────────────────────────────────

function formatZAR(amount) {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR'
  }).format(amount);
}

// ─── Natural Language Calculation Parser ─────────────────────────────────────

function parseCalculationRequest(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase();

  // Extract amount
  const amountMatch = t.match(/r?\s*(\d[\d\s,]*(?:\.\d{2})?)/);
  const amount = amountMatch
    ? parseFloat(amountMatch[1].replace(/[\s,]/g, ''))
    : undefined;

  // Extract age if mentioned
  const ageMatch = t.match(/(\d{2})\s*(?:years?\s*old|jaar)/);
  const age = ageMatch ? parseInt(ageMatch[1]) : undefined;

  if (t.includes('vat') || t.includes('btw')) {
    if (t.includes('excl') || t.includes('without') || t.includes('sonder')) {
      return { type: 'VAT_INCLUSIVE', amount }; // Add VAT to excl amount
    }
    if (t.includes('incl') || t.includes('with') || t.includes('met')) {
      return { type: 'VAT_EXCLUSIVE', amount }; // Extract VAT from incl amount
    }
    return { type: 'VAT_EXCLUSIVE', amount }; // Default: extract from inclusive
  }

  if (t.includes('paye') || t.includes('salary') || t.includes('salaris') || t.includes('monthly tax')) {
    return { type: 'PAYE', amount, age };
  }

  if (t.includes('income tax') || t.includes('inkomstebelasting') || t.includes('tax on')) {
    return { type: 'INCOME_TAX', amount, age };
  }

  return null;
}

// ─── Process Calculation & Format Response ───────────────────────────────────

function processCalculation(text) {
  const request = parseCalculationRequest(text);
  if (!request || !request.amount) return null;

  switch (request.type) {
    case 'VAT_INCLUSIVE': {
      const result = calculateVATInclusive(request.amount);
      return {
        type: 'VAT_INCLUSIVE',
        input: request.amount,
        result,
        formatted: `**VAT Calculation (Adding VAT)**\n\nAmount excluding VAT: ${formatZAR(result.excluding)}\nVAT (15%): ${formatZAR(result.vat)}\n**Amount including VAT: ${formatZAR(result.including)}**`
      };
    }

    case 'VAT_EXCLUSIVE': {
      const result = calculateVATExclusive(request.amount);
      return {
        type: 'VAT_EXCLUSIVE',
        input: request.amount,
        result,
        formatted: `**VAT Calculation (Extracting VAT)**\n\nAmount including VAT: ${formatZAR(result.including)}\nVAT (15%): ${formatZAR(result.vat)}\n**Amount excluding VAT: ${formatZAR(result.excluding)}**`
      };
    }

    case 'INCOME_TAX': {
      const result = calculateIncomeTax(request.amount, request.age || 30);
      return {
        type: 'INCOME_TAX',
        input: request.amount,
        result,
        formatted: `**Income Tax Calculation (2024/2025)**\n\nTaxable Income: ${formatZAR(result.taxableIncome)}\nGross Tax: ${formatZAR(result.grossTax)}\nLess: Rebates: ${formatZAR(result.rebates)}\n**Net Tax Payable: ${formatZAR(result.netTax)}**\n\nEffective Rate: ${result.effectiveRate}%\nMarginal Rate: ${result.marginalRate}%\nMonthly Tax: ${formatZAR(result.monthlyTax)}`
      };
    }

    case 'PAYE': {
      const result = calculatePAYE(request.amount, request.age || 30);
      return {
        type: 'PAYE',
        input: request.amount,
        result,
        formatted: `**PAYE Calculation (Monthly)**\n\nGross Salary: ${formatZAR(request.amount)}\nPAYE: ${formatZAR(result.monthlyPAYE)}\nUIF (1%): ${formatZAR(result.monthlyUIF)}\n**Net Salary: ${formatZAR(result.netSalary)}**\n\nAnnual Projection:\n- Annual Gross: ${formatZAR(request.amount * 12)}\n- Annual Tax: ${formatZAR(result.annualProjection.netTax)}\n- Effective Rate: ${result.annualProjection.effectiveRate}%`
      };
    }

    default:
      return null;
  }
}

module.exports = {
  // Constants
  VAT_RATE,
  INCOME_TAX_BRACKETS_2025,
  TAX_REBATES_2025,
  TAX_THRESHOLDS_2025,
  MEDICAL_TAX_CREDITS_2025,
  UIF_RATE,
  UIF_CEILING,
  SDL_RATE,
  // VAT
  calculateVATInclusive,
  calculateVATExclusive,
  extractVATFromInclusive,
  // Income Tax
  calculateIncomeTax,
  // PAYE
  calculatePAYE,
  // Formatting
  formatZAR,
  // NLP
  parseCalculationRequest,
  processCalculation
};
