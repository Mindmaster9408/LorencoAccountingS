/* =============================================
   EXPORT FORMATS MODULE
   Sage Pastel & Xero Journal Exports
   ============================================= */

const ExportFormats = {

    // ---- Sage Pastel Journal Export ----
    exportSageJournal: function(payrunData, companyId) {
        var details = this.getCompanyDetails(companyId);
        var company = AUTH.getCompanyById(companyId);
        var rows = [];

        // Header row
        rows.push(['Date', 'Account Code', 'Account Name', 'Debit', 'Credit', 'Reference', 'Description', 'Tax Type']);

        var date = this.formatDateSage(new Date());
        var ref = 'PAYROLL-' + payrunData.period;
        var periodLabel = this.formatPeriodLabel(payrunData.period);

        // 1. Salaries & Wages Expense (DEBIT)
        rows.push([
            date,
            details.sage_salaries_account || '5000',
            'Salaries & Wages',
            payrunData.total_gross.toFixed(2),
            '',
            ref,
            'Gross salaries for ' + periodLabel,
            'N/A'
        ]);

        // 2. PAYE Liability (CREDIT)
        rows.push([
            date,
            details.sage_paye_account || '2100',
            'SARS - PAYE Liability',
            '',
            payrunData.total_paye.toFixed(2),
            ref,
            'PAYE withheld for ' + periodLabel,
            'N/A'
        ]);

        // 3. UIF Liability (CREDIT) - Employee + Employer
        var totalUIF = (payrunData.total_uif || 0) * 2;
        rows.push([
            date,
            details.sage_uif_account || '2101',
            'UIF Liability',
            '',
            totalUIF.toFixed(2),
            ref,
            'UIF contributions (employee + employer) for ' + periodLabel,
            'N/A'
        ]);

        // 4. UIF Employer Expense (DEBIT)
        rows.push([
            date,
            details.sage_uif_expense_account || '5010',
            'UIF Employer Contribution',
            (payrunData.total_uif || 0).toFixed(2),
            '',
            ref,
            'Employer UIF contribution for ' + periodLabel,
            'N/A'
        ]);

        // 5. SDL Liability (CREDIT)
        var totalSDL = (payrunData.total_sdl || payrunData.total_gross * 0.01);
        rows.push([
            date,
            details.sage_sdl_account || '2102',
            'SDL Liability',
            '',
            totalSDL.toFixed(2),
            ref,
            'SDL for ' + periodLabel,
            'N/A'
        ]);

        // 6. SDL Expense (DEBIT)
        rows.push([
            date,
            details.sage_sdl_expense_account || '5020',
            'SDL Expense',
            totalSDL.toFixed(2),
            '',
            ref,
            'SDL expense for ' + periodLabel,
            'N/A'
        ]);

        // 7. Net Pay - Bank (CREDIT)
        rows.push([
            date,
            details.sage_bank_account || '1000',
            'Bank Account',
            '',
            payrunData.total_net.toFixed(2),
            ref,
            'Net salaries paid for ' + periodLabel,
            'N/A'
        ]);

        this.downloadCSV(rows, 'Sage_Journal_' + payrunData.period + '.csv');
        return rows;
    },

    // ---- Xero Journal Export ----
    exportXeroJournal: function(payrunData, companyId) {
        var details = this.getCompanyDetails(companyId);
        var rows = [];

        // Xero Manual Journal CSV format
        rows.push(['*Date', '*Description', 'Reference', '*AccountCode', 'TaxType', 'Debit', 'Credit']);

        var date = this.formatDateXero(new Date());
        var ref = 'PAYROLL-' + payrunData.period;
        var periodLabel = this.formatPeriodLabel(payrunData.period);

        // 1. Wages Expense (Debit)
        rows.push([
            date,
            'Gross salaries - ' + periodLabel,
            ref,
            details.xero_wages_account || '400',
            'Tax Exempt',
            payrunData.total_gross.toFixed(2),
            ''
        ]);

        // 2. PAYE Payable (Credit)
        rows.push([
            date,
            'PAYE withheld - ' + periodLabel,
            ref,
            details.xero_paye_account || '825',
            'Tax Exempt',
            '',
            payrunData.total_paye.toFixed(2)
        ]);

        // 3. UIF Payable (Credit)
        var totalUIF = (payrunData.total_uif || 0) * 2;
        rows.push([
            date,
            'UIF contributions - ' + periodLabel,
            ref,
            details.xero_uif_account || '826',
            'Tax Exempt',
            '',
            totalUIF.toFixed(2)
        ]);

        // 4. UIF Employer Expense (Debit)
        rows.push([
            date,
            'UIF employer contribution - ' + periodLabel,
            ref,
            details.xero_uif_expense_account || '401',
            'Tax Exempt',
            (payrunData.total_uif || 0).toFixed(2),
            ''
        ]);

        // 5. Wages Payable / Bank (Credit)
        rows.push([
            date,
            'Net salaries payable - ' + periodLabel,
            ref,
            details.xero_bank_account || '090',
            'Tax Exempt',
            '',
            payrunData.total_net.toFixed(2)
        ]);

        this.downloadCSV(rows, 'Xero_Journal_' + payrunData.period + '.csv');
        return rows;
    },

    // ---- Helpers ----
    getCompanyDetails: function(companyId) {
        var stored = safeLocalStorage.getItem('company_details_' + companyId);
        return stored ? JSON.parse(stored) : {};
    },

    formatDateSage: function(date) {
        var d = String(date.getDate()).padStart(2, '0');
        var m = String(date.getMonth() + 1).padStart(2, '0');
        return d + '/' + m + '/' + date.getFullYear();
    },

    formatDateXero: function(date) {
        var d = String(date.getDate()).padStart(2, '0');
        var m = String(date.getMonth() + 1).padStart(2, '0');
        return d + '/' + m + '/' + date.getFullYear();
    },

    formatPeriodLabel: function(period) {
        var parts = period.split('-');
        var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        return months[parseInt(parts[1]) - 1] + ' ' + parts[0];
    },

    downloadCSV: function(rows, filename) {
        var csv = rows.map(function(row) {
            return row.map(function(cell) {
                var val = String(cell || '');
                if (val.indexOf(',') >= 0 || val.indexOf('"') >= 0 || val.indexOf('\n') >= 0) {
                    return '"' + val.replace(/"/g, '""') + '"';
                }
                return val;
            }).join(',');
        }).join('\r\n');

        var BOM = '\uFEFF'; // UTF-8 BOM for Excel compatibility
        var blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
    }
};
