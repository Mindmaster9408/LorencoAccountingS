/**
 * ============================================================================
 * PayrollCalculationService — Orchestrate PayrollEngine Calls
 * ============================================================================
 * Purpose: Execute payroll calculations through the unified engine.
 *
 * Responsibilities:
 * - Accept normalized calculation inputs
 * - Call the unified PayrollEngine
 * - Return stable, validated engine outputs
 * - Add service-level metadata (timestamps, engine version)
 * - Handle calculation errors gracefully
 * - Preserve engine output contract (no mutations to locked fields)
 *
 * CRITICAL INVARIANTS:
 * - Engine logic remains pure (no business rules here)
 * - Output contract is trusted and not altered
 * - Decimal hours are preserved throughout
 * - Pro-rata inputs pass through unchanged
 * - All 13 locked fields remain unchanged in value and order
 *
 * Usage:
 *   const result = await PayrollCalculationService.calculate(
 *     { basic_salary: 20000, ... },
 *     { startDate: '2026-04-10', endDate: '2026-04-30' }
 *   );
 * ============================================================================
 */

const PayrollEngine = require('../../../core/payroll-engine');

/**
 * Build an effective tax tables object from an admin-configured KV override.
 * Falls back to engine defaults for any field not set in the config.
 * Returns null if cfg is falsy — callers treat null as "use engine defaults".
 *
 * @param {object|null} cfg - Tax config from payroll_kv_store_eco (key: tax_config)
 * @returns {object|null}
 */
function buildEffectiveTables(cfg) {
    if (!cfg) return null;
    // JSON.stringify converts Infinity to null when saving tax_config to the KV store.
    // Normalize null / large-sentinel values back to Infinity so bracket comparisons
    // are correct for all income levels (including top bracket with no upper limit).
    function normalizeBrackets(brackets) {
        return brackets.map(function(b) {
            var max = (b.max === null || b.max === undefined || (typeof b.max === 'number' && b.max >= 1e15))
                ? Infinity : b.max;
            return { min: b.min, max: max, base: b.base, rate: b.rate };
        });
    }

    // Validate all required fields are present in the taxConfig.
    // Missing fields fall back to engine defaults but produce a warning — this indicates
    // the KV config is incomplete and the super admin should re-save via Tax Configuration UI.
    var missingFields = [];
    var numericFields = [
        'PRIMARY_REBATE', 'SECONDARY_REBATE', 'TERTIARY_REBATE',
        'UIF_RATE', 'UIF_MONTHLY_CAP', 'SDL_RATE',
        'MEDICAL_CREDIT_MAIN', 'MEDICAL_CREDIT_FIRST_DEP', 'MEDICAL_CREDIT_ADDITIONAL'
    ];
    numericFields.forEach(function(f) {
        if (typeof cfg[f] !== 'number') missingFields.push(f);
    });
    if (!Array.isArray(cfg.BRACKETS) || !cfg.BRACKETS.length) missingFields.push('BRACKETS');
    if (missingFields.length > 0) {
        console.warn('[PayrollCalculationService] taxConfig is missing fields: ' + missingFields.join(', ') +
            ' — engine defaults used for those fields. Re-save Tax Configuration to resolve.');
    }

    return {
        // TAX_YEAR included so getTablesForPeriod can match historical periods to the override.
        TAX_YEAR:                  cfg.TAX_YEAR || null,
        BRACKETS:                  Array.isArray(cfg.BRACKETS) && cfg.BRACKETS.length ? normalizeBrackets(cfg.BRACKETS) : PayrollEngine.BRACKETS,
        PRIMARY_REBATE:            typeof cfg.PRIMARY_REBATE            === 'number' ? cfg.PRIMARY_REBATE            : PayrollEngine.PRIMARY_REBATE,
        SECONDARY_REBATE:          typeof cfg.SECONDARY_REBATE          === 'number' ? cfg.SECONDARY_REBATE          : PayrollEngine.SECONDARY_REBATE,
        TERTIARY_REBATE:           typeof cfg.TERTIARY_REBATE           === 'number' ? cfg.TERTIARY_REBATE           : PayrollEngine.TERTIARY_REBATE,
        UIF_RATE:                  typeof cfg.UIF_RATE                  === 'number' ? cfg.UIF_RATE                  : PayrollEngine.UIF_RATE,
        UIF_MONTHLY_CAP:           typeof cfg.UIF_MONTHLY_CAP           === 'number' ? cfg.UIF_MONTHLY_CAP           : PayrollEngine.UIF_MONTHLY_CAP,
        SDL_RATE:                  typeof cfg.SDL_RATE                  === 'number' ? cfg.SDL_RATE                  : PayrollEngine.SDL_RATE,
        MEDICAL_CREDIT_MAIN:       typeof cfg.MEDICAL_CREDIT_MAIN       === 'number' ? cfg.MEDICAL_CREDIT_MAIN       : PayrollEngine.MEDICAL_CREDIT_MAIN,
        MEDICAL_CREDIT_FIRST_DEP:  typeof cfg.MEDICAL_CREDIT_FIRST_DEP  === 'number' ? cfg.MEDICAL_CREDIT_FIRST_DEP  : PayrollEngine.MEDICAL_CREDIT_FIRST_DEP,
        MEDICAL_CREDIT_ADDITIONAL: typeof cfg.MEDICAL_CREDIT_ADDITIONAL === 'number' ? cfg.MEDICAL_CREDIT_ADDITIONAL : PayrollEngine.MEDICAL_CREDIT_ADDITIONAL
    };
}

/*
 * Calculate payroll for a normalized input set.
 * Thin wrapper around PayrollEngine that adds metadata and error handling.
 *
 * @param {object} normalizedInputs - Output from PayrollDataService.fetchCalculationInputs()
 * @param {object} [options] - Calculation options
 * @param {string} [options.startDate] - Override pro-rata start date (YYYY-MM-DD)
 * @param {string} [options.endDate] - Override pro-rata end date (YYYY-MM-DD)
 * @param {boolean} [options.useProRata] - Enable pro-rata calculation (default: true if dates provided)
 * @param {object} [options.taxConfig] - Admin-configured tax tables from Supabase KV (backend use only)
 * @returns {Promise<object>} Engine output + service metadata
 */
async function calculate(normalizedInputs, options = {}) {
  if (!normalizedInputs) {
    throw new Error('normalizedInputs required');
  }

  // Validate required inputs
  const requiredFields = ['basic_salary', 'regular_inputs', 'employeeOptions', 'period'];
  for (const field of requiredFields) {
    if (normalizedInputs[field] === undefined) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  try {
    // Determine calculation method based on options
    const useProRata =
      options.useProRata !== false &&
      (options.startDate || options.endDate || normalizedInputs.start_date);

    // Build period-aware tax tables from admin KV config (Node.js backend cannot use localStorage).
    // Null means "use engine defaults" — backward compatible with all existing callers.
    const taxOverride = buildEffectiveTables(options.taxConfig || null);

    let result;

    if (useProRata) {
      // Pro-rata calculation path
      const startDate = options.startDate || normalizedInputs.start_date;
      const endDate = options.endDate || normalizedInputs.end_date;

      result = PayrollEngine.calculateWithProRata(
        {
          basic_salary: normalizedInputs.basic_salary,
          regular_inputs: normalizedInputs.regular_inputs,
          workSchedule: normalizedInputs.workSchedule,
          hours_per_day: normalizedInputs.hours_per_day
        },
        startDate,
        endDate,
        normalizedInputs.currentInputs || [],
        normalizedInputs.overtime || [],
        normalizedInputs.multiRate || [],
        normalizedInputs.shortTime || [],
        normalizedInputs.employeeOptions,
        normalizedInputs.period,
        normalizedInputs.ytdData || null,
        taxOverride
      );
    } else {
      // Standard full-month calculation
      result = PayrollEngine.calculateFromData(
        {
          basic_salary: normalizedInputs.basic_salary,
          regular_inputs: normalizedInputs.regular_inputs,
          workSchedule: normalizedInputs.workSchedule,
          hours_per_day: normalizedInputs.hours_per_day
        },
        normalizedInputs.currentInputs || [],
        normalizedInputs.overtime || [],
        normalizedInputs.multiRate || [],
        normalizedInputs.shortTime || [],
        normalizedInputs.employeeOptions,
        normalizedInputs.period,
        normalizedInputs.ytdData || null,
        taxOverride
      );
    }

    // Add service-level metadata (DO NOT mutate engine output fields)
    result._meta = {
      calculatedAt: new Date().toISOString(),
      engineVersion: PayrollEngine.ENGINE_VERSION,
      schemaVersion: PayrollEngine.SCHEMA_VERSION,
      calculationMethod: useProRata ? 'prorata' : 'standard',
      startDate: options.startDate || normalizedInputs.start_date || null,
      endDate: options.endDate || normalizedInputs.end_date || null,
      // Resolved SA tax year for this period — stored in snapshot for audit trail.
      // Derived from period_key by the engine's getTaxYearForPeriod().
      resolvedTaxYear: normalizedInputs.period
        ? PayrollEngine.getTaxYearForPeriod(normalizedInputs.period)
        : PayrollEngine.TAX_YEAR
    };

    return result;
  } catch (err) {
    // Wrap engine errors with context
    throw new PayrollCalculationError(
      `Payroll calculation failed: ${err.message}`,
      err,
      {
        normalizedInputs,
        options
      }
    );
  }
}

/**
 * Custom error class for payroll calculation failures.
 * Preserves context for diagnostic and audit purposes.
 */
class PayrollCalculationError extends Error {
  constructor(message, originalError, context) {
    super(message);
    this.name = 'PayrollCalculationError';
    this.originalError = originalError;
    this.context = context;
  }
}

/**
 * Validate calculation output against locked fields contract.
 * This is a safety check to ensure output hasn't been corrupted.
 *
 * @param {object} output - Engine output to validate
 * @throws {Error} if locked fields are missing
 */
function validateOutput(output) {
  const lockedFields = [
    'gross',
    'taxableGross',
    'paye',
    'paye_base',
    'voluntary_overdeduction',
    'uif',
    'sdl',
    'deductions',
    'net',
    'negativeNetPay',
    'medicalCredit',
    'overtimeAmount',
    'shortTimeAmount'
  ];

  for (const field of lockedFields) {
    if (output[field] === undefined) {
      throw new Error(`Output validation failed: missing locked field "${field}"`);
    }
  }

  return true;
}

/**
 * Format calculation output for API response.
 * Includes engine output + metadata, ready for serialization.
 *
 * @param {object} result - Output from calculate()
 * @returns {object} API-safe output
 */
function formatForResponse(result) {
  return {
    success: true,
    data: {
      // Locked calculation fields (13)
      gross: result.gross,
      taxableGross: result.taxableGross,
      paye: result.paye,
      paye_base: result.paye_base,
      voluntary_overdeduction: result.voluntary_overdeduction,
      uif: result.uif,
      sdl: result.sdl,
      deductions: result.deductions,
      net: result.net,
      negativeNetPay: result.negativeNetPay,
      medicalCredit: result.medicalCredit,
      overtimeAmount: result.overtimeAmount,
      shortTimeAmount: result.shortTimeAmount,

      // Pro-rata fields (additive, if present)
      ...(result.prorataFactor !== undefined && {
        prorataFactor: result.prorataFactor,
        expectedHoursInPeriod: result.expectedHoursInPeriod,
        workedHoursInPeriod: result.workedHoursInPeriod
      }),

      // Service metadata
      _meta: result._meta
    },
    timestamp: new Date().toISOString()
  };
}

/**
 * Format error for API response.
 *
 * @param {Error} error - Error to format
 * @returns {object} API-safe error response
 */
function formatError(error) {
  const response = {
    success: false,
    error: error.message || 'Unknown error',
    timestamp: new Date().toISOString()
  };

  // Include context for PayrollCalculationError
  if (error instanceof PayrollCalculationError) {
    response.details = {
      originalError: error.originalError?.message,
      context: error.context // Use carefully; may contain large objects
    };
  }

  return response;
}

module.exports = {
  calculate,
  validateOutput,
  formatForResponse,
  formatError,
  PayrollCalculationError
};
