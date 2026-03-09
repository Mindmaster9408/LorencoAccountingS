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

        // ---- Company Header ----
        // Logo (if available)
        if (details.logo_data) {
            try { doc.addImage(details.logo_data, 'PNG', margin, y, 30, 15); } catch(e) {}
            var textX = margin + 34;
        } else {
            var textX = margin;
        }

        doc.setFontSize(14);
        doc.setTextColor(102, 126, 234); // #667eea
        doc.text(details.company_name || company.name || 'Company', textX, y + 7);

        doc.setFontSize(7.5);
        doc.setTextColor(120, 120, 120);
        if (details.address_line1) doc.text(details.address_line1, textX, y + 12);
        if (details.phone) doc.text('Tel: ' + details.phone + (details.email ? '  |  Email: ' + details.email : ''), textX, y + 16);

        // PAYSLIP title
        y = 30;
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

        // Overtime
        if (calc.overtimeAmount > 0) {
            doc.text('Overtime', margin + 3, y);
            doc.text(this.formatMoney(calc.overtimeAmount), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(calc.overtimeAmount)), y);
            y += 4.5;
        }

        // Total Gross
        doc.setDrawColor(60, 60, 60);
        doc.line(margin + 3, y, pageWidth - margin - 3, y);
        y += 4;
        doc.setFont(undefined, 'bold');
        doc.text('TOTAL GROSS', margin + 3, y);
        doc.text(this.formatMoney(calc.gross), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(calc.gross)), y);
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

        // Total Deductions
        var totalDed = (calc.paye || 0) + (calc.uif || 0) + (calc.deductions || calc.totalDeductions || 0);
        doc.line(margin + 3, y, pageWidth - margin - 3, y);
        y += 4;
        doc.setFont(undefined, 'bold');
        doc.text('TOTAL DEDUCTIONS', margin + 3, y);
        doc.text(this.formatMoney(totalDed), pageWidth - margin - 3 - doc.getTextWidth(this.formatMoney(totalDed)), y);
        doc.setFont(undefined, 'normal');

        // ---- NET PAY Section ----
        y += 7;
        doc.setFillColor(102, 126, 234);
        doc.roundedRect(margin, y, contentWidth, 12, 3, 3, 'F');
        doc.setFontSize(12);
        doc.setTextColor(255, 255, 255);
        doc.setFont(undefined, 'bold');
        doc.text('NET PAY', margin + 5, y + 8);
        var netStr = this.formatMoney(calc.net);
        doc.text(netStr, pageWidth - margin - 5 - doc.getTextWidth(netStr), y + 8);

        // ---- Footer ----
        y += 20;
        doc.setFontSize(7);
        doc.setTextColor(150, 150, 150);
        doc.setFont(undefined, 'normal');
        doc.text('Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString(), margin, y);
        doc.text('This is a system-generated document.', margin, y + 4);

        // Bottom bar
        doc.setFillColor(102, 126, 234);
        doc.rect(0, y + 8, pageWidth, 5, 'F');
    },

    // ---- Helpers ----
    getCompanyDetails: function(companyId) {
        var stored = safeLocalStorage.getItem('company_details_' + companyId);
        return stored ? JSON.parse(stored) : {};
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
