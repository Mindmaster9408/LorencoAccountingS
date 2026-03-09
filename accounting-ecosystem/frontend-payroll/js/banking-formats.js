/* =============================================
   BANKING FORMATS MODULE
   SA Bank EFT File Generation
   ABSA, FNB, Standard Bank, Nedbank
   ============================================= */

const BankingFormats = {

    // ---- ABSA EFT File (Fixed-width) ----
    generateABSA: function(payrunData, employees, companyId, calcFn) {
        var details = this.getCompanyDetails(companyId);
        var records = [];
        var sequence = 0;
        var totalAmount = 0;
        var totalRecords = 0;

        // Header Record
        var header = this.pad('1', 1) +                                    // Record type
                    this.pad(details.absa_user_code || '00000000', 8) +   // User code
                    this.pad(new Date().toISOString().slice(0,10).replace(/-/g, ''), 8) + // Date YYYYMMDD
                    this.pad(details.company_name || 'LORENCO PAYTIME', 30) +    // Company name
                    this.pad('SALARY', 10) +                             // Payment type
                    this.pad('', 18);                                    // Filler
        records.push(header);

        // Detail Records
        employees.forEach(function(emp) {
            if (emp.payment_method !== 'EFT' && emp.payment_method !== 'eft') return;

            var calc = calcFn(emp.id);
            if (!calc || calc.net <= 0) return;

            sequence++;
            totalAmount += calc.net;
            totalRecords++;

            var detail = BankingFormats.pad('2', 1) +                                    // Record type
                        BankingFormats.pad(emp.branch_code || '632005', 6) +            // Branch code
                        BankingFormats.pad(emp.account_number || '', 13) +               // Account number
                        BankingFormats.pad(emp.account_type === 'Savings' ? '2' : '1', 1) + // Account type
                        BankingFormats.padNum(Math.round(calc.net * 100), 11) +         // Amount in cents
                        BankingFormats.pad(emp.account_holder || emp.first_name + ' ' + emp.last_name, 30) + // Beneficiary name
                        BankingFormats.pad('SAL ' + payrunData.period, 12) +             // Reference
                        BankingFormats.pad(String(sequence), 6, '0');                    // Sequence
            records.push(detail);
        });

        // Trailer Record
        var trailer = this.pad('3', 1) +                                   // Record type
                     this.padNum(Math.round(totalAmount * 100), 15) +     // Total amount in cents
                     this.padNum(totalRecords, 6) +                       // Total records
                     this.pad('', 53);                                    // Filler
        records.push(trailer);

        this.downloadFile(records.join('\r\n'), 'ABSA_EFT_' + payrunData.period + '.txt', 'text/plain');
        return { total: totalAmount, count: totalRecords };
    },

    // ---- FNB EFT File (Fixed-width) ----
    generateFNB: function(payrunData, employees, companyId, calcFn) {
        var details = this.getCompanyDetails(companyId);
        var records = [];
        var totalAmount = 0;
        var totalRecords = 0;

        // Header
        var header = 'H' +                                                 // Record type
                    this.pad(details.fnb_originator_code || '', 10) +     // Originator code
                    this.pad(new Date().toISOString().slice(0,10).replace(/-/g,''), 8) + // Date
                    this.pad('SALARIES', 20) +                           // Description
                    this.pad('', 41);                                    // Filler
        records.push(header);

        // Detail Records
        employees.forEach(function(emp) {
            if (emp.payment_method !== 'EFT' && emp.payment_method !== 'eft') return;

            var calc = calcFn(emp.id);
            if (!calc || calc.net <= 0) return;

            totalAmount += calc.net;
            totalRecords++;

            var detail = 'D' +                                             // Record type
                        BankingFormats.pad(emp.branch_code || '250655', 6) +  // Branch code
                        BankingFormats.pad(emp.account_number || '', 11) +    // Account number
                        (emp.account_type === 'Savings' ? 'S' : 'C') +       // Account type
                        BankingFormats.padNum(Math.round(calc.net * 100), 11) + // Amount
                        BankingFormats.pad(emp.account_holder || emp.first_name + ' ' + emp.last_name, 32) + // Name
                        BankingFormats.pad('SAL' + payrunData.period.replace('-',''), 20); // Reference
            records.push(detail);
        });

        // Trailer
        var trailer = 'T' +                                                // Record type
                     this.padNum(Math.round(totalAmount * 100), 15) +     // Total
                     this.padNum(totalRecords, 6) +                       // Count
                     this.pad('', 58);                                    // Filler
        records.push(trailer);

        this.downloadFile(records.join('\r\n'), 'FNB_EFT_' + payrunData.period + '.txt', 'text/plain');
        return { total: totalAmount, count: totalRecords };
    },

    // ---- Standard Bank EFT (CSV) ----
    generateStandardBank: function(payrunData, employees, companyId, calcFn) {
        var rows = [];
        rows.push(['Account Number', 'Branch Code', 'Account Type', 'Amount', 'Beneficiary Name', 'Beneficiary Reference', 'Own Reference']);

        var totalAmount = 0;
        var totalRecords = 0;

        employees.forEach(function(emp) {
            if (emp.payment_method !== 'EFT' && emp.payment_method !== 'eft') return;

            var calc = calcFn(emp.id);
            if (!calc || calc.net <= 0) return;

            totalAmount += calc.net;
            totalRecords++;

            rows.push([
                emp.account_number || '',
                emp.branch_code || '',
                emp.account_type || 'Current',
                calc.net.toFixed(2),
                emp.account_holder || emp.first_name + ' ' + emp.last_name,
                'Salary ' + BankingFormats.formatPeriodShort(payrunData.period),
                emp.employee_number || ''
            ]);
        });

        this.downloadCSV(rows, 'StandardBank_EFT_' + payrunData.period + '.csv');
        return { total: totalAmount, count: totalRecords };
    },

    // ---- Nedbank EFT (CSV) ----
    generateNedbank: function(payrunData, employees, companyId, calcFn) {
        var rows = [];
        rows.push(['AccountNumber', 'BranchCode', 'AccountType', 'AmountInCents', 'BeneficiaryName', 'BeneficiaryReference', 'StatementReference']);

        var totalAmount = 0;
        var totalRecords = 0;

        employees.forEach(function(emp) {
            if (emp.payment_method !== 'EFT' && emp.payment_method !== 'eft') return;

            var calc = calcFn(emp.id);
            if (!calc || calc.net <= 0) return;

            totalAmount += calc.net;
            totalRecords++;

            rows.push([
                emp.account_number || '',
                emp.branch_code || '',
                emp.account_type === 'Savings' ? '2' : '1',
                Math.round(calc.net * 100).toString(),
                emp.account_holder || emp.first_name + ' ' + emp.last_name,
                'SAL ' + BankingFormats.formatPeriodShort(payrunData.period),
                emp.employee_number || ''
            ]);
        });

        this.downloadCSV(rows, 'Nedbank_EFT_' + payrunData.period + '.csv');
        return { total: totalAmount, count: totalRecords };
    },

    // ---- Helpers ----
    getCompanyDetails: function(companyId) {
        var stored = safeLocalStorage.getItem('company_details_' + companyId);
        return stored ? JSON.parse(stored) : {};
    },

    pad: function(str, length, char) {
        char = char || ' ';
        return String(str || '').padEnd(length, char).substring(0, length);
    },

    padNum: function(num, length) {
        return String(num || 0).padStart(length, '0').substring(0, length);
    },

    formatPeriodShort: function(period) {
        var parts = period.split('-');
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return months[parseInt(parts[1]) - 1] + parts[0].substring(2);
    },

    downloadFile: function(content, filename, mimeType) {
        var blob = new Blob([content], { type: mimeType || 'text/plain' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
    },

    downloadCSV: function(rows, filename) {
        var csv = rows.map(function(row) {
            return row.map(function(cell) {
                var val = String(cell || '');
                if (val.indexOf(',') >= 0 || val.indexOf('"') >= 0) {
                    return '"' + val.replace(/"/g, '""') + '"';
                }
                return val;
            }).join(',');
        }).join('\r\n');

        var BOM = '\uFEFF';
        var blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
    }
};
