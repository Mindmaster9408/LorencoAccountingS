/* =============================================================
   Individual Income Tax Constants — SA SARS Foundation Tables
   Codebox 28 — Draft Calculation Engine

   IMPORTANT:
   These tax tables are provided for DRAFT / ESTIMATE purposes only.
   They must be reviewed and updated each SARS budget year.
   They are NOT authoritative SARS publications.
   DO NOT use for final submission without accountant verification.

   To update for a new tax year:
   1. Add a new key to TAX_YEAR_CONSTANTS
   2. Update DEFAULT_TAX_YEAR to the new year
   3. Run migration to add any new bracket columns if needed

   Bracket structure: Each bracket has:
     { from, to (null = no upper limit), base, rate }
     tax = base + (income - from) * rate
   ============================================================= */
'use strict';

// Version string embedded in every calculation for audit trail
// Format: '<taxYear>-v<schemaVersion>'
const CONSTANTS_VERSION = 'CB28-v1';

const TAX_YEAR_CONSTANTS = {

    // ── 2023 (1 March 2022 – 28 February 2023) ──────────────────────────────
    2023: {
        version:        '2023-v1',
        brackets: [
            { from: 0,         to: 226000,   base: 0,       rate: 0.18 },
            { from: 226001,    to: 353100,   base: 40680,   rate: 0.26 },
            { from: 353101,    to: 488700,   base: 73726,   rate: 0.31 },
            { from: 488701,    to: 641400,   base: 115762,  rate: 0.36 },
            { from: 641401,    to: 817600,   base: 170734,  rate: 0.39 },
            { from: 817601,    to: 1731600,  base: 239452,  rate: 0.41 },
            { from: 1731601,   to: null,     base: 614192,  rate: 0.45 },
        ],
        rebates: {
            primary:   15714,
            secondary: 8613,
            tertiary:  2871,
        },
        medical_credits_monthly: {
            main_and_first_dependant: 347,
            additional_dependant:     234,
        },
        thresholds: {
            below_65:  91250,
            age_65_74: 141250,
            age_75_plus: 157900,
        },
    },

    // ── 2024 (1 March 2023 – 29 February 2024) ──────────────────────────────
    2024: {
        version:        '2024-v1',
        brackets: [
            { from: 0,         to: 237100,   base: 0,       rate: 0.18 },
            { from: 237101,    to: 370500,   base: 42678,   rate: 0.26 },
            { from: 370501,    to: 512800,   base: 77362,   rate: 0.31 },
            { from: 512801,    to: 673000,   base: 121475,  rate: 0.36 },
            { from: 673001,    to: 857900,   base: 179147,  rate: 0.39 },
            { from: 857901,    to: 1817000,  base: 251258,  rate: 0.41 },
            { from: 1817001,   to: null,     base: 644489,  rate: 0.45 },
        ],
        rebates: {
            primary:   17235,
            secondary: 9444,
            tertiary:  3145,
        },
        medical_credits_monthly: {
            main_and_first_dependant: 364,
            additional_dependant:     246,
        },
        thresholds: {
            below_65:  95750,
            age_65_74: 148217,
            age_75_plus: 165689,
        },
    },

    // ── 2025 (1 March 2024 – 28 February 2025) ──────────────────────────────
    2025: {
        version:        '2025-v1',
        brackets: [
            { from: 0,         to: 237100,   base: 0,       rate: 0.18 },
            { from: 237101,    to: 370500,   base: 42678,   rate: 0.26 },
            { from: 370501,    to: 512800,   base: 77362,   rate: 0.31 },
            { from: 512801,    to: 673000,   base: 121475,  rate: 0.36 },
            { from: 673001,    to: 857900,   base: 179147,  rate: 0.39 },
            { from: 857901,    to: 1817000,  base: 251258,  rate: 0.41 },
            { from: 1817001,   to: null,     base: 644489,  rate: 0.45 },
        ],
        rebates: {
            primary:   17235,
            secondary: 9444,
            tertiary:  3145,
        },
        medical_credits_monthly: {
            main_and_first_dependant: 364,
            additional_dependant:     246,
        },
        thresholds: {
            below_65:  95750,
            age_65_74: 148217,
            age_75_plus: 165689,
        },
    },

    // ── 2026 (1 March 2025 – 28 February 2026) ──────────────────────────────
    2026: {
        version:        '2026-v1',
        brackets: [
            { from: 0,         to: 237100,   base: 0,       rate: 0.18 },
            { from: 237101,    to: 370500,   base: 42678,   rate: 0.26 },
            { from: 370501,    to: 512800,   base: 77362,   rate: 0.31 },
            { from: 512801,    to: 673000,   base: 121475,  rate: 0.36 },
            { from: 673001,    to: 857900,   base: 179147,  rate: 0.39 },
            { from: 857901,    to: 1817000,  base: 251258,  rate: 0.41 },
            { from: 1817001,   to: null,     base: 644489,  rate: 0.45 },
        ],
        rebates: {
            primary:   17235,
            secondary: 9444,
            tertiary:  3145,
        },
        medical_credits_monthly: {
            main_and_first_dependant: 364,
            additional_dependant:     246,
        },
        thresholds: {
            below_65:  95750,
            age_65_74: 148217,
            age_75_plus: 165689,
        },
    },
};

// Default to current SARS tax year if a year is missing from the table
const DEFAULT_TAX_YEAR = 2026;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConstants(taxYear) {
    return TAX_YEAR_CONSTANTS[taxYear] || TAX_YEAR_CONSTANTS[DEFAULT_TAX_YEAR];
}

function computeTaxFromBrackets(taxableIncome, brackets) {
    if (taxableIncome <= 0) return 0;
    for (var i = brackets.length - 1; i >= 0; i--) {
        var b = brackets[i];
        if (taxableIncome >= b.from) {
            return Math.round((b.base + (taxableIncome - b.from) * b.rate) * 100) / 100;
        }
    }
    return 0;
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
    TAX_YEAR_CONSTANTS,
    DEFAULT_TAX_YEAR,
    CONSTANTS_VERSION,
    getConstants,
    computeTaxFromBrackets,
};
