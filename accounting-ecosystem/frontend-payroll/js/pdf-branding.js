/* =============================================
   PDF BRANDING MODULE
   Branded Payslip PDF Generation
   ============================================= */

const PDFBranding = {

    // ---- Generate Single Branded Payslip ----
    generatePayslipPDF: function(employee, period, calculation, companyId) {
        var jspdf = window.jspdf;
        if (!jspdf) { alert('jsPDF library not loaded.'); return; }
        var doc = new jspdf.jsPDF();
        var details = this.getCompanyDetails(companyId);
        var company = AUTH.getCompanyById(companyId);

        this.addPayslipPage(doc, employee, period, calculation, details, company);

        doc.save('Payslip_' + employee.employee_number + '_' + period + '.pdf');
    },

    // ---- Generate Bulk Payslips (All Employees) ----
    generateBulkPayslips: function(employees, period, companyId, calcFn) {
        var jspdf = window.jspdf;
        if (!jspdf) { alert('jsPDF library not loaded.'); return; }
        var doc = new jspdf.jsPDF();
        var details = this.getCompanyDetails(companyId);
        var company = AUTH.getCompanyById(companyId);
        var isFirst = true;
        var count = 0;

        employees.forEach(function(emp) {
            var calc = calcFn(emp.id);
            if (!calc || calc.net <= 0) return;

            if (!isFirst) doc.addPage();
            isFirst = false;
            count++;

            PDFBranding.addPayslipPage(doc, emp, period, calc, details, company);
        });

        if (count === 0) {
            alert('No payslips to generate.');
            return;
        }

        doc.save('Bulk_Payslips_' + period + '.pdf');
        return count;
    },

    // ---- Add Single Payslip Page to Document ----
    addPayslipPage: function(doc, employee, period, calc, details, company) {
        var y = 10;
        var pageWidth = 210;
        var margin = 14;
        var contentWidth = pageWidth - (margin * 2);

        // Pre-compute display totals so that TOTAL GROSS, TOTAL DEDUCTIONS and
        // NET PAY all reflect the line items actually shown on this payslip.
        // This prevents a mismatch where items stored only in localStorage appear
        // as line items but are absent from the backend-calculated totals.
        var displayGross = parseFloat(calc.basicSalary || 0);
        (calc.allowances || []).forEach(function(a) { displayGross += parseFloat(a.amount) || 0; });
        displayGross += parseFloat(calc.overtimeAmount || 0);
        displayGross -= parseFloat(calc.shortTimeAmount || 0);
        if (displayGross <= 0 && (calc.gross || 0) > 0) displayGross = calc.gross;

        var displayDed = (parseFloat(calc.paye) || 0) + (parseFloat(calc.uif) || 0) - (parseFloat(calc.medicalCredit) || 0);
        (calc.deductionsList || []).forEach(function(d) { displayDed += parseFloat(d.amount) || 0; });
        if (displayDed < 0) displayDed = 0;

        var displayNet = Math.max(0, displayGross - displayDed);

        // ---- Company Header ----
        // Logo (if available)
        if (details.logo_data) {
            try { doc.addImage(details.logo_data, 'PNG', margin, y, 30, 15); } catch(e) {}
            var textX = margin + 34;
        } else {
            var textX = margin;
        }

        var lineY = y;

        doc.setFontSize(14);
        doc.setTextColor(102, 126, 234);
        doc.text(details.company_name || details.name || (company && company.name) || 'Company', textX, lineY + 7);
        lineY += 7;

        // Trading name (only if different from company name)
        if (details.trading_name && details.trading_name !== (details.company_name || '')) {
            doc.setFontSize(7.5);
            doc.setTextColor(80, 80, 80);
            doc.text('t/a ' + details.trading_name, textX, lineY + 4.5);
            lineY += 4.5;
        }

        // Compact refs line: Reg | PAYE | UIF | SDL
        var refs = [];
        if (details.reg_number) refs.push('Reg: ' + details.reg_number);
        if (details.paye_ref)   refs.push('PAYE: ' + details.paye_ref);
        if (details.uif_ref)    refs.push('UIF: ' + details.uif_ref);
        if (details.sdl_ref)    refs.push('SDL: ' + details.sdl_ref);
        if (refs.length > 0) {
            doc.setFontSize(6.5);
            doc.setTextColor(120, 120, 120);
            doc.text(refs.join('  |  '), textX, lineY + 4);
            lineY += 4;
        }

        doc.setFontSize(7.5);
        doc.setTextColor(120, 120, 120);
        if (details.address_line1) {
            doc.text(details.address_line1, textX, lineY + 4);
            lineY += 4;
        }
        if (details.phone || details.email) {
            var contactParts = [];
            if (details.phone) contactParts.push('Tel: ' + details.phone);
            if (details.email) contactParts.push('Email: ' + details.email);
            doc.text(contactParts.join('  |  '), textX, lineY + 4);
            lineY += 4;
        }

        // PAYSLIP title — pushed below header content with minimum gap
        y = Math.max(lineY + 6, 32);
        doc.setFillColor(102, 126, 234);
        doc.rect(margin, y, contentWidth, 8, 'F');
        doc.setFontSize(12);
        doc.setTextColor(255, 255, 255);
        doc.text('PAYSLIP', margin + 3, y + 5.5);

        // Period
        doc.setFontSize(9);
        var periodLabel = this.formatPeriod(period);
        doc.text(periodLabel, pageWidth - margin - doc.getTextWidth(periodLabel), y + 5.5);

        // ---- Employee Details ----
        y = 41;
        doc.setFontSize(8);
        doc.setTextColor(60, 60, 60);

        doc.setFillColor(245, 245, 245);
        doc.rect(margin, y, contentWidth, 19, 'F');
        doc.setDrawColor(220, 220, 220);
        doc.rect(margin, y, contentWidth, 19, 'S');

        y += 4;
        doc.setFont(undefined, 'bold');
        doc.text('Employee Details', margin + 3, y);
        doc.setFont(undefined, 'normal');

        y += 4.5;
        doc.text('Name: ' + (employee.first_name || '') + ' ' + (employee.last_name || ''), margin + 3, y);
        doc.text('ID Number: ' + (employee.id_number || '-'), margin + contentWidth/2, y);

        y += 4.5;
        doc.text('Emp No: ' + (employee.employee_number || '-'), margin + 3, y);
        doc.text('Department: ' + (employee.department || '-'), margin + contentWidth/2, y);

        y += 4.5;
        doc.text('Position: ' + (employee.position || employee.job_title || '-'), margin + 3, y);
        doc.text('Payment: ' + (employee.payment_method || 'EFT'), margin + contentWidth/2, y);

        // ---- Earnings Section ----
        y += 6;
        doc.setFillColor(40, 167, 69);
        doc.rect(margin, y, contentWidth, 6, 'F');
        doc.setFontSize(8);
        doc.setTextColor(255, 255, 255);
        doc.setFont(undefined, 'bold');
        doc.text('EARNINGS', margin + 3, y + 4.5);
        doc.text('Amount', pageWidth - margin - 18, y + 4.5);

        y += 9;
        doc.setTextColor(60, 60, 60);
        doc.setFont(undefined, 'normal');

        // Basic Salary
        doc.text('Basic Salary', margin + 3, y);
        doc.text(this.formatMoney(calc.basicSalary || calc.gross), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(calc.basicSalary || calc.gross)), y);
        y += 4.5;

        // Allowances
        if (calc.allowances && calc.allowances.length > 0) {
            calc.allowances.forEach(function(a) {
                doc.text(a.description || 'Allowance', margin + 3, y);
                doc.text(PDFBranding.formatMoney(a.amount), pageWidth - margin - 3 - doc.getTextWidth(PDFBranding.formatMoney(a.amount)), y);
                y += 4.5;
            });
        }

        // Overtime (independent earnings addition)
        if (calc.overtimeAmount > 0) {
            doc.text('Overtime', margin + 3, y);
            doc.text(this.formatMoney(calc.overtimeAmount), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(calc.overtimeAmount)), y);
            y += 4.5;
        }

        // Short Time (independent earnings reduction — shown as negative in earnings, not in deductions)
        if (calc.shortTimeAmount > 0) {
            doc.setTextColor(220, 53, 69);
            doc.text('Short Time', margin + 3, y);
            var stStr = '-' + this.formatMoney(calc.shortTimeAmount);
            doc.text(stStr, pageWidth - margin - 3 - doc.getTextWidth(stStr), y);
            doc.setTextColor(60, 60, 60);
            y += 4.5;
        }

        // Total Gross
        doc.setDrawColor(60, 60, 60);
        doc.line(margin + 3, y, pageWidth - margin - 3, y);
        y += 4;
        doc.setFont(undefined, 'bold');
        doc.text('TOTAL GROSS', margin + 3, y);
        doc.text(this.formatMoney(displayGross), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(displayGross)), y);
        doc.setFont(undefined, 'normal');

        // ---- Deductions Section ----
        y += 6;
        doc.setFillColor(220, 53, 69);
        doc.rect(margin, y, contentWidth, 6, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont(undefined, 'bold');
        doc.text('DEDUCTIONS', margin + 3, y + 4.5);
        doc.text('Amount', pageWidth - margin - 18, y + 4.5);

        y += 9;
        doc.setTextColor(60, 60, 60);
        doc.setFont(undefined, 'normal');

        // PAYE
        doc.text('PAYE (Income Tax)', margin + 3, y);
        doc.text(this.formatMoney(calc.paye), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(calc.paye)), y);
        y += 4.5;

        // UIF
        doc.text('UIF', margin + 3, y);
        doc.text(this.formatMoney(calc.uif), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(calc.uif)), y);
        y += 4.5;

        // Medical Tax Credit
        if (calc.medicalCredit > 0) {
            doc.setTextColor(40, 167, 69);
            doc.text('Medical Tax Credit', margin + 3, y);
            var creditStr = '-' + this.formatMoney(calc.medicalCredit);
            doc.text(creditStr, pageWidth - margin - 3 - doc.getTextWidth(creditStr), y);
            y += 4.5;
            doc.setTextColor(60, 60, 60);
        }

        // Other deductions
        if (calc.deductionsList && calc.deductionsList.length > 0) {
            calc.deductionsList.forEach(function(d) {
                doc.text(d.description || 'Deduction', margin + 3, y);
                doc.text(PDFBranding.formatMoney(d.amount), pageWidth - margin - 3 - doc.getTextWidth(PDFBranding.formatMoney(d.amount)), y);
                y += 4.5;
            });
        }

        // Total Deductions — pre-computed from displayed line items (matches what's shown above)
        doc.line(margin + 3, y, pageWidth - margin - 3, y);
        y += 4;
        doc.setFont(undefined, 'bold');
        doc.text('TOTAL DEDUCTIONS', margin + 3, y);
        doc.text(this.formatMoney(displayDed), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(displayDed)), y);
        doc.setFont(undefined, 'normal');

        // ---- NET PAY Section ----
        y += 7;
        doc.setFillColor(102, 126, 234);
        doc.roundedRect(margin, y, contentWidth, 12, 3, 3, 'F');
        doc.setFontSize(12);
        doc.setTextColor(255, 255, 255);
        doc.setFont(undefined, 'bold');
        doc.text('NET PAY', margin + 5, y + 8);
        var netStr = this.formatMoney(displayNet);
        doc.text(netStr, pageWidth - margin - 5 - doc.getTextWidth(netStr), y + 8);

        // ---- Footer ----
        y += 20;
        doc.setFontSize(7);
        doc.setTextColor(150, 150, 150);
        doc.setFont(undefined, 'normal');
        doc.text('Generated: ' + (window.formatDateTime ? window.formatDateTime(new Date()) : new Date().toISOString().slice(0,16).replace('T',' ')), margin, y);
        doc.text('This is a system-generated document.', margin, y + 4);

        // Bottom bar
        doc.setFillColor(102, 126, 234);
        doc.rect(0, y + 8, pageWidth, 5, 'F');
    },

    // ---- Helpers ----

    // Normalize a raw company record from any source (API cache, legacy key, AUTH)
    // to consistent display field names. Returns null if no company name present.
    // Handles both DB column names (from /api/companies/:id) and legacy short names.
    _normalizeDetails: function(raw) {
        if (!raw) return null;
        var name = raw.company_name || raw.name || '';
        if (!name) return null;
        return {
            company_name:  name,
            trading_name:  raw.trading_name  || '',
            reg_number:    raw.reg_number    || raw.registration_number    || '',
            paye_ref:      raw.paye_ref      || raw.paye_reference_number  || '',
            uif_ref:       raw.uif_ref       || raw.uif_reference_number   || '',
            sdl_ref:       raw.sdl_ref       || raw.sdl_reference_number   || '',
            address_line1: raw.address_line1 || raw.payslip_address_line1  || '',
            phone:         raw.phone         || raw.contact_number         || '',
            email:         raw.email         || raw.contact_email          || '',
            logo_data:     raw.logo_data     || null
        };
    },

    getCompanyDetails: function(companyId) {
        var n;

        // 1. Try legacy localStorage key (standalone Payroll App)
        try {
            var stored = safeLocalStorage.getItem('company_details_' + companyId);
            if (stored) {
                n = this._normalizeDetails(JSON.parse(stored));
                if (n) return n;
            }
        } catch(e) {}

        // 2. Try DataAccess cache key written by ecosystem data-access.js
        // Raw DB record — field names normalized by _normalizeDetails (e.g. payslip_address_line1 → address_line1)
        try {
            var apiCached = safeLocalStorage.getItem('cache_company_' + companyId);
            if (apiCached) {
                n = this._normalizeDetails(JSON.parse(apiCached));
                if (n) return n;
            }
        } catch(e) {}

        // 3. Build minimal details from the auth companies cache
        var result = {};
        try {
            if (typeof AUTH !== 'undefined' && AUTH.getCompanyById) {
                var authCompany = AUTH.getCompanyById(companyId);
                if (authCompany) {
                    result.company_name = authCompany.company_name || authCompany.name || authCompany.trading_name || '';
                    result.name = result.company_name;
                    result.paye_ref = authCompany.paye_ref || authCompany.paye_reference_number || '';
                    result.uif_ref  = authCompany.uif_ref  || authCompany.uif_reference_number  || '';
                    n = this._normalizeDetails(result);
                    if (n) return n;
                }
            }
        } catch(e) {}

        // 4. Fallback: use session company name when IDs match
        try {
            var session = JSON.parse(safeLocalStorage.getItem('session') || '{}');
            if (session && String(session.company_id) === String(companyId)) {
                result.company_name = session.company_name || session.companyName || '';
                result.name = result.company_name;
            }
        } catch(e) {}

        return result;
    },

    formatPeriod: function(period) {
        var parts = period.split('-');
        var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        return months[parseInt(parts[1]) - 1] + ' ' + parts[0];
    },

    formatMoney: function(amount) {
        return 'R' + (amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
};
