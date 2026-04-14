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

/*
 * Calculate payroll for a normalized input set.
 * Thin wrapper around PayrollEngine that adds metadata and error handling.
 *
 * @param {object} normalizedInputs - Output from PayrollDataService.fetchCalculationInputs()
 * @param {object} [options] - Calculation options
 * @param {string} [options.startDate] - Override pro-rata start date (YYYY-MM-DD)
 * @param {string} [options.endDate] - Override pro-rata end date (YYYY-MM-DD)
 * @param {boolean} [options.useProRata] - Enable pro-rata calculation (default: true if dates provided)
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
        normalizedInputs.ytdData || null
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
        normalizedInputs.ytdData || null
      );
    }

    // Add service-level metadata (DO NOT mutate engine output fields)
    result._meta = {
      calculatedAt: new Date().toISOString(),
      engineVersion: PayrollEngine.ENGINE_VERSION,
      schemaVersion: PayrollEngine.SCHEMA_VERSION,
      calculationMethod: useProRata ? 'prorata' : 'standard',
      startDate: options.startDate || normalizedInputs.start_date || null,
      endDate: options.endDate || normalizedInputs.end_date || null
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
