// ============================================================
// PayrollItemsHelper - Bridge between Payroll Items master list
// and employee-level input modals
// ============================================================

var PayrollItemsHelper = {

    /**
     * Get all payroll items for a company from safeLocalStorage.
     * @param {string} companyId
     * @returns {Array} Array of payroll item objects
     */
    getItems: function(companyId) {
        var stored = safeLocalStorage.getItem('payroll_items_' + companyId);
        if (!stored) return [];
        try { return JSON.parse(stored); } catch(e) { return []; }
    },

    /**
     * Get payroll items filtered by item_type.
     * @param {string} companyId
     * @param {string|Array} types - Single type or array: 'income', 'allowance', 'deduction', 'employer_contribution'
     * @returns {Array}
     */
    getByType: function(companyId, types) {
        var items = this.getItems(companyId);
        if (!types) return items;
        if (typeof types === 'string') types = [types];
        return items.filter(function(item) {
            return types.indexOf(item.item_type) !== -1;
        });
    },

    /**
     * Get a single payroll item by ID.
     * @param {string} companyId
     * @param {string} itemId
     * @returns {Object|null}
     */
    getById: function(companyId, itemId) {
        var items = this.getItems(companyId);
        return items.find(function(i) { return i.id === itemId; }) || null;
    },

    /**
     * Get a single payroll item by item_code.
     * @param {string} companyId
     * @param {string} itemCode
     * @returns {Object|null}
     */
    getByCode: function(companyId, itemCode) {
        var items = this.getItems(companyId);
        return items.find(function(i) { return i.item_code === itemCode; }) || null;
    },

    /**
     * Render <option> HTML for a select dropdown, filtered by item types.
     * Includes a "Custom" option at the top for manual entry.
     * @param {string} companyId
     * @param {string|Array} itemTypes - Types to include (e.g. ['allowance', 'deduction'])
     * @returns {string} HTML string of <option> elements
     */
    renderSelectOptions: function(companyId, itemTypes) {
        var items = this.getByType(companyId, itemTypes);
        var html = '<option value="">-- Select from Master List --</option>';
        html += '<option value="__custom__">Custom (type manually)</option>';

        if (items.length === 0) return html;

        // Group by item_type for readability
        var grouped = {};
        items.forEach(function(item) {
            if (!grouped[item.item_type]) grouped[item.item_type] = [];
            grouped[item.item_type].push(item);
        });

        var typeLabels = {
            income: 'Income',
            allowance: 'Allowances',
            deduction: 'Deductions',
            employer_contribution: 'Employer Contributions'
        };

        Object.keys(grouped).forEach(function(type) {
            html += '<optgroup label="' + (typeLabels[type] || type) + '">';
            grouped[type].forEach(function(item) {
                var label = item.item_name;
                if (item.irp5_code) label += ' (IRP5: ' + item.irp5_code + ')';
                if (item.default_amount) label += ' - R' + parseFloat(item.default_amount).toFixed(2);
                html += '<option value="' + item.id + '">' + label + '</option>';
            });
            html += '</optgroup>';
        });

        return html;
    },

    /**
     * Calculate the amount for a payroll item based on its category.
     * @param {Object} item - The payroll item from master list
     * @param {number} basicSalary - Employee's basic salary (used for percentage calculations)
     * @param {number} [overrideValue] - Optional override amount/percentage
     * @returns {number} Calculated amount
     */
    calculateAmount: function(item, basicSalary, overrideValue) {
        if (!item) return 0;
        var value = (overrideValue !== undefined && overrideValue !== null) ? overrideValue : (item.default_amount || 0);

        switch (item.category) {
            case 'fixed':
                return parseFloat(value) || 0;
            case 'percentage':
                return (parseFloat(basicSalary) || 0) * (parseFloat(value) / 100);
            case 'hours_based':
                // For hours-based, value is the hourly rate; caller must multiply by hours separately
                return parseFloat(value) || 0;
            case 'increasing_balance':
            case 'decreasing_balance':
                return parseFloat(value) || 0;
            default:
                return parseFloat(value) || 0;
        }
    },

    /**
     * Build enriched input data from a selected payroll item.
     * Copies IRP5 code, taxability, UIF flags from master item to the saved input.
     * @param {Object} item - The selected payroll item
     * @param {Object} overrides - { amount, description } overrides from the form
     * @returns {Object} Enriched input data ready to be saved
     */
    enrichInput: function(item, overrides) {
        overrides = overrides || {};
        return {
            payroll_item_id: item.id,
            item_code: item.item_code,
            irp5_code: item.irp5_code || null,
            is_taxable: item.is_taxable !== false,
            affects_uif: item.affects_uif !== false,
            type: this.mapItemTypeToInputType(item.item_type),
            description: overrides.description || item.item_name,
            amount: overrides.amount !== undefined ? overrides.amount : (item.default_amount || 0),
            category: item.category
        };
    },

    /**
     * Map payroll item types to the input types used in regular/current inputs.
     * @param {string} itemType - 'income', 'allowance', 'deduction', 'employer_contribution'
     * @returns {string} 'allowance' or 'deduction'
     */
    mapItemTypeToInputType: function(itemType) {
        if (itemType === 'deduction') return 'deduction';
        // income, allowance, and employer_contribution all add to earnings
        return 'allowance';
    }
};
