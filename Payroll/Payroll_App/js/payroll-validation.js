// ============================================================
// PayrollValidation — Shared validation layer for Lorenco Paytime
//
// All critical input validation should go through this module.
// Used by employee-management.html, employee-detail.html,
// payroll-items.html, and payruns.html.
//
// Rules:
//   - Pure functions: no side effects, return { valid, errors[] }
//   - All numeric ranges enforced here, not just in HTML attributes
//   - SA ID validation included
//   - Duplicate detection helpers included
// ============================================================

var PayrollValidation = {

    // ==========================================================
    // EMPLOYEE VALIDATION
    // ==========================================================

    /**
     * Validate an employee record before save.
     *
     * @param {Object} emp           - Employee object being saved
     * @param {Array}  allEmployees  - All existing employees for this company
     * @param {boolean} isEdit       - True if editing existing; false if creating new
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateEmployee: function(emp, allEmployees, isEdit) {
        var errors = [];

        // Required: employee number
        if (!emp.employee_number || !String(emp.employee_number).trim()) {
            errors.push('Employee number is required.');
        }

        // Required: first name
        if (!emp.first_name || !String(emp.first_name).trim()) {
            errors.push('First name is required.');
        }

        // Required: last name
        if (!emp.last_name || !String(emp.last_name).trim()) {
            errors.push('Last name is required.');
        }

        // Duplicate employee number (skip current record when editing)
        if (emp.employee_number && allEmployees) {
            var empNumUpper = String(emp.employee_number).trim().toUpperCase();
            var dupe = allEmployees.find(function(e) {
                // When editing, skip the record itself
                if (isEdit && e.id === emp.id) return false;
                return String(e.employee_number || '').trim().toUpperCase() === empNumUpper;
            });
            if (dupe) {
                errors.push('Employee number "' + emp.employee_number + '" already exists in this company.');
            }
        }

        // SA ID number format (if provided)
        if (emp.id_number && String(emp.id_number).trim()) {
            var idResult = this.validateSAIdNumber(String(emp.id_number).trim());
            if (!idResult.valid) {
                errors.push('ID number: ' + idResult.message);
            }
        }

        // Medical aid members: 0–20
        var members = parseInt(emp.medical_aid_members);
        if (!isNaN(members) && (members < 0 || members > 20)) {
            errors.push('Medical aid members must be between 0 and 20.');
        }

        // Tax directive: 0–100%
        var directive = parseFloat(emp.tax_directive);
        if (!isNaN(directive) && directive !== 0 && (directive < 0 || directive > 100)) {
            errors.push('Tax directive must be between 0 and 100%.');
        }

        return { valid: errors.length === 0, errors: errors };
    },

    // ==========================================================
    // SALARY VALIDATION
    // ==========================================================

    /**
     * Validate a basic salary amount.
     *
     * @param {*} amount - Raw value from input
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateBasicSalary: function(amount) {
        var errors = [];
        var val = parseFloat(amount);

        if (isNaN(val)) {
            errors.push('Basic salary must be a number.');
            return { valid: false, errors: errors };
        }
        if (val < 0) {
            errors.push('Basic salary cannot be negative.');
        }
        if (val > 9999999) {
            errors.push('Basic salary exceeds the maximum allowed amount (R 9,999,999). Please verify.');
        }
        // Zero salary: warn but allow (some employees may be on commission only)
        // Not a hard block — handled at finalize time

        return { valid: errors.length === 0, errors: errors };
    },

    // ==========================================================
    // PRE-FINALIZE PAYSLIP CHECKLIST
    // ==========================================================

    /**
     * Run all safety checks before a payslip can be finalized.
     * Returns a structured result with warnings and blocking errors.
     *
     * @param {Object} payrollData    - { basic_salary, regular_inputs }
     * @param {Object} calc           - Result from PayrollEngine.calculateFromData
     * @param {Object} employee       - Current employee record
     * @returns {{ canFinalize: boolean, blocking: string[], warnings: string[] }}
     */
    preFinalizeSafetyCheck: function(payrollData, calc, employee) {
        var blocking = [];
        var warnings = [];

        // BLOCK: basic salary is zero/missing and no other income
        var hasAnyIncome = (payrollData.basic_salary > 0) ||
            (payrollData.regular_inputs || []).some(function(ri) {
                return ri.type !== 'deduction' && parseFloat(ri.amount) > 0;
            });
        if (!hasAnyIncome) {
            blocking.push('No income recorded. Basic salary is R 0 and no allowances or earnings exist.');
        }

        // BLOCK: negative net pay — cannot finalize without override
        if (calc && calc.negativeNetPay) {
            blocking.push(
                'Net pay is negative (R ' + (calc.net || 0).toFixed(2) + '). ' +
                'Total deductions exceed gross. Please review deductions before finalizing.'
            );
        }

        // BLOCK: calculated gross is zero
        if (calc && calc.gross <= 0) {
            blocking.push('Calculated gross pay is R 0. There is nothing to finalize.');
        }

        // WARN: missing tax number (not a block — some employees may not have one yet)
        if (employee && !employee.tax_number) {
            warnings.push('Employee has no tax number on record. IRP5 generation will be incomplete.');
        }

        // WARN: missing ID number
        if (employee && !employee.id_number) {
            warnings.push('Employee has no SA ID number on record. Age-based tax rebates cannot be applied.');
        }

        // WARN: very large single-month pay (> R 500k gross) — sanity check
        if (calc && calc.gross > 500000) {
            warnings.push(
                'Gross pay is R ' + calc.gross.toFixed(2) + '. This is unusually high — please verify before finalizing.'
            );
        }

        return {
            canFinalize: blocking.length === 0,
            blocking: blocking,
            warnings: warnings
        };
    },

    /**
     * Run pre-finalize checks for an entire pay run before finalizing.
     *
     * @param {Array}  finalizedEmps  - Employees whose payslips are finalized
     * @param {Object} totals         - { totalGross, totalNet, totalPaye }
     * @param {Object} companyDetails - Company config record
     * @returns {{ canFinalize: boolean, blocking: string[], warnings: string[] }}
     */
    preFinalizePayRunCheck: function(finalizedEmps, totals, companyDetails) {
        var blocking = [];
        var warnings = [];

        if (!finalizedEmps || finalizedEmps.length === 0) {
            blocking.push('No employees have finalized payslips. Finalize each employee\'s payslip before creating a pay run.');
        }

        if (totals && totals.totalNet < 0) {
            blocking.push('Total net pay for the pay run is negative. Please review.');
        }

        if (!companyDetails || !companyDetails.paye_ref) {
            warnings.push('Company PAYE reference number is not set. EMP201 submission will be incomplete.');
        }
        if (!companyDetails || !companyDetails.uif_ref) {
            warnings.push('Company UIF reference number is not set. UIF declarations will be incomplete.');
        }

        return {
            canFinalize: blocking.length === 0,
            blocking: blocking,
            warnings: warnings
        };
    },

    // ==========================================================
    // SA ID NUMBER VALIDATION
    // ==========================================================

    /**
     * Validate a South African ID number.
     * Checks: 13 digits, valid date-of-birth segment, Luhn checksum.
     *
     * @param {string} idNumber
     * @returns {{ valid: boolean, message: string, dob?: Date, gender?: string, citizen?: string }}
     */
    validateSAIdNumber: function(idNumber) {
        if (!idNumber) {
            return { valid: false, message: 'ID number is required.' };
        }

        var id = String(idNumber).replace(/\s/g, '');

        if (!/^\d{13}$/.test(id)) {
            return { valid: false, message: 'SA ID number must be exactly 13 digits.' };
        }

        // Extract date-of-birth (YYMMDD)
        var yy = parseInt(id.substring(0, 2));
        var mm = parseInt(id.substring(2, 4));
        var dd = parseInt(id.substring(4, 6));

        if (mm < 1 || mm > 12) {
            return { valid: false, message: 'ID number contains an invalid month (' + mm + ').' };
        }
        if (dd < 1 || dd > 31) {
            return { valid: false, message: 'ID number contains an invalid day (' + dd + ').' };
        }

        // Gender: digits 6–9 (0000–4999 = female, 5000–9999 = male)
        var genderDigits = parseInt(id.substring(6, 10));
        var gender = genderDigits < 5000 ? 'Female' : 'Male';

        // Citizenship: digit 10 (0 = SA citizen, 1 = permanent resident)
        var citizenDigit = parseInt(id.charAt(10));
        var citizen = citizenDigit === 0 ? 'SA Citizen' : 'Permanent Resident';

        // Luhn checksum validation
        if (!this._luhn(id)) {
            return { valid: false, message: 'ID number has an invalid checksum digit (Luhn check failed).' };
        }

        var century = yy >= 0 && yy <= (new Date().getFullYear() % 100) ? 2000 : 1900;
        var dob = new Date(century + yy, mm - 1, dd);

        return {
            valid: true,
            message: 'Valid SA ID',
            dob: dob,
            gender: gender,
            citizen: citizen
        };
    },

    /**
     * Luhn algorithm — validates the last digit of an ID number.
     * @private
     */
    _luhn: function(id) {
        var total = 0;
        var alternate = false;
        for (var i = id.length - 1; i >= 0; i--) {
            var n = parseInt(id.charAt(i));
            if (alternate) {
                n *= 2;
                if (n > 9) n -= 9;
            }
            total += n;
            alternate = !alternate;
        }
        return total % 10 === 0;
    },

    // ==========================================================
    // PAYROLL ITEM VALIDATION
    // ==========================================================

    /**
     * Validate a payroll item before save.
     *
     * @param {Object} item           - Payroll item object
     * @param {Array}  existingItems  - All existing items for this company
     * @param {boolean} isEdit
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validatePayrollItem: function(item, existingItems, isEdit) {
        var errors = [];

        if (!item.item_code || !String(item.item_code).trim()) {
            errors.push('Item code is required.');
        }
        if (!item.item_name || !String(item.item_name).trim()) {
            errors.push('Item name is required.');
        }
        if (!item.item_type) {
            errors.push('Item type is required.');
        }
        if (!item.category) {
            errors.push('Category is required.');
        }

        // Default amount range
        var amt = parseFloat(item.default_amount);
        if (isNaN(amt) || amt < 0) {
            errors.push('Default amount must be 0 or a positive number.');
        }
        if (!isNaN(amt) && item.category === 'percentage' && amt > 500) {
            errors.push('Percentage items over 500% are not allowed. Please verify the amount (enter as a % value, e.g., 15 for 15%).');
        }

        // Duplicate item code check (allow same code when editing same item)
        if (item.item_code && existingItems) {
            var codeUpper = String(item.item_code).trim().toUpperCase();
            var dupe = existingItems.find(function(i) {
                if (isEdit && i.id === item.id) return false;
                return String(i.item_code || '').trim().toUpperCase() === codeUpper;
            });
            if (dupe) {
                errors.push('Item code "' + item.item_code + '" already exists.');
            }
        }

        return { valid: errors.length === 0, errors: errors };
    },

    // ==========================================================
    // UI HELPERS
    // ==========================================================

    /**
     * Format a validation result as an HTML error list.
     * @param {string[]} errors
     * @returns {string} HTML string
     */
    formatErrorsAsHTML: function(errors) {
        if (!errors || errors.length === 0) return '';
        if (errors.length === 1) return errors[0];
        return '<ul style="margin:4px 0 0 0; padding-left:18px;">' +
            errors.map(function(e) { return '<li>' + e + '</li>'; }).join('') +
            '</ul>';
    },

    /**
     * Show validation errors in a modal error div.
     * @param {string}   elementId - ID of the error div
     * @param {string[]} errors
     */
    showErrors: function(elementId, errors) {
        var el = document.getElementById(elementId);
        if (!el) return;
        if (!errors || errors.length === 0) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        el.innerHTML = this.formatErrorsAsHTML(errors);
        el.style.display = 'block';
    }
};
