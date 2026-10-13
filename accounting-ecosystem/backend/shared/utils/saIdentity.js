'use strict';

/**
 * ============================================================================
 * South African identity numbers — validation (Paytime Fase 10, spec 03 WN-02/03)
 * ============================================================================
 * Pure functions shared by every route that creates or edits an employee.
 *
 *   SA ID number   13 digits, Luhn check digit, valid date of birth (YYMMDD).
 *   Passport       contains a letter, 5–20 characters — accepted as is
 *                  (foreign nationals have no SA ID).
 *   SARS income-tax reference   10 digits, first digit 0/1/2/3/9, Luhn check
 *                  (verified 2026-10-13 against live data: 219 of 223 pass).
 * ============================================================================
 */

const clean = (v) => String(v == null ? '' : v).replace(/[\s-]/g, '');

function luhnOk(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** @returns {string|null} error message, or null when valid */
function idNumberError(value) {
  const v = clean(value);
  if (!v) return 'ID or passport number is required';
  if (/[A-Za-z]/.test(v)) {
    return /^[A-Za-z0-9]{5,20}$/.test(v) ? null : 'Passport number must be 5–20 letters/digits';
  }
  if (!/^\d{13}$/.test(v)) return 'SA ID number must be 13 digits';
  const mm = Number(v.slice(2, 4)), dd = Number(v.slice(4, 6)), yy = Number(v.slice(0, 2));
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  if (mm < 1 || mm > 12 || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) {
    return 'SA ID number has an invalid date of birth';
  }
  if (!luhnOk(v)) return 'SA ID number is not valid (check digit)';
  return null;
}

/** @returns {string|null} error message, or null when valid. Empty is NOT valid here. */
function taxNumberError(value) {
  const v = clean(value);
  if (!v) return 'SARS tax number is required (or tick "not yet registered with SARS")';
  if (!/^\d{10}$/.test(v)) return 'SARS tax number must be 10 digits';
  if (!/^[01239]/.test(v)) return 'SARS tax number must start with 0, 1, 2, 3 or 9';
  if (!luhnOk(v)) return 'SARS tax number is not valid (check digit)';
  return null;
}

/** Issues that block IRP5/EMP501 or warrant a warning on every run (WN-02). */
function employeeTaxIssues(emp) {
  const issues = [];
  if (!clean(emp.tax_number)) {
    issues.push(emp.tax_number_pending ? 'not yet registered with SARS' : 'no SARS tax number');
  } else if (taxNumberError(emp.tax_number)) {
    issues.push(taxNumberError(emp.tax_number));
  }
  if (clean(emp.id_number) && idNumberError(emp.id_number)) issues.push(idNumberError(emp.id_number));
  if (!clean(emp.id_number)) issues.push('no ID or passport number');
  return issues;
}

module.exports = { clean, luhnOk, idNumberError, taxNumberError, employeeTaxIssues };
