/* =============================================
   ATTENDANCE MANAGER MODULE
   Payroll App - Time & Attendance Tracking

   Fase 8 (spec 05 PI-08 option b, PI-09; finding V1):
   - All attendance is stored in the database through /api/payroll/attendance.
     Nothing is kept in browser storage (CLAUDE.md Part D) — it used to be,
     and "Apply to Payroll" wrote KV keys the payroll never read.
   - "Apply to Payroll" shows a PROPOSAL per employee (BCEA overtime, Sunday and
     public-holiday work, absences less approved leave), calculated on the server.
     Only the employees the payroll user ticks are written to their payslips, as
     overtime / short-time rows marked "from attendance".
   ============================================= */

const AttendanceManager = {
    currentCompanyId: null,
    employees: [],
    records: {},        // 'YYYY-MM-DD' → [{ id, emp_id, date, clock_in, clock_out, hours, status, notes }]
    proposal: null,     // last /attendance/proposal response for the selected month
    importData: null,
    currentView: 'calendar',

    // ---- API ----
    api: async function(method, path, body) {
        var token = safeLocalStorage.getItem('token') || '';
        var r = await fetch('/api/payroll' + path, {
            method: method,
            headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {}),
            body: body ? JSON.stringify(body) : undefined
        });
        var data = await r.json().catch(function() { return {}; });
        if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
        return data;
    },

    // ---- Initialize ----
    init: async function() {
        const session = AUTH.getSession();
        if (!session) return;
        this.currentCompanyId = session.company_id;
        this.initPeriodSelectors();
        this.setupDragDrop();
        this.setupTabs();
        try {
            await this.loadEmployees();
        } catch (e) {
            alert('Could not load employees: ' + e.message);
        }
        this.populateEmployeeFilter();
        await this.refresh();
    },

    // ---- Load Employees (server, visibility-filtered) ----
    loadEmployees: async function() {
        var data = await this.api('GET', '/employees');
        this.employees = (data.employees || []).map(function(e) {
            return Object.assign({}, e, { id: String(e.id), employee_number: e.employee_code || e.employee_number || '' });
        });
    },

    // ---- Load the selected month's attendance + proposal, then redraw ----
    refresh: async function() {
        var period = this.getSelectedPeriod();
        var from = this.getPeriodString() + '-01';
        var to = this.formatDate(new Date(period.year, period.month + 1, 0));
        var self = this;
        try {
            var data = await this.api('GET', '/attendance?from=' + from + '&to=' + to);
            self.records = {};
            (data.attendance || []).forEach(function(r) {
                var rec = { id: r.id, emp_id: String(r.employee_id), date: r.date, clock_in: r.clock_in || '',
                            clock_out: r.clock_out || '', hours: parseFloat(r.hours_worked) || 0,
                            status: r.status || 'present', notes: r.notes || '' };
                (self.records[rec.date] = self.records[rec.date] || []).push(rec);
            });
        } catch (e) {
            self.records = {};
            alert('Could not load attendance: ' + e.message);
        }
        try {
            this.proposal = await this.api('GET', '/attendance/proposal?period_key=' + this.getPeriodString());
        } catch (e) {
            this.proposal = null;
        }
        this.renderCalendar();
        if (this.currentView === 'entries-view') this.renderTimeEntries();
        if (this.currentView === 'summary-view') this.renderSummary();
    },

    // ---- Setup Tabs ----
    setupTabs: function() {
        var self = this;
        document.querySelectorAll('.att-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                document.querySelectorAll('.att-tab').forEach(function(t) { t.classList.remove('active'); });
                document.querySelectorAll('.att-tab-content').forEach(function(c) { c.style.display = 'none'; });
                tab.classList.add('active');
                var target = tab.getAttribute('data-tab');
                document.getElementById(target).style.display = 'block';
                self.currentView = target;
                if (target === 'summary-view') self.renderSummary();
                if (target === 'entries-view') self.renderTimeEntries();
            });
        });
    },

    // ---- Period Selectors ----
    initPeriodSelectors: function() {
        var monthSelect = document.getElementById('attMonthSelect');
        var yearSelect = document.getElementById('attYearSelect');
        if (!monthSelect || !yearSelect) return;

        var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        var now = new Date();
        monthSelect.innerHTML = '';
        months.forEach(function(m, i) {
            var opt = document.createElement('option');
            opt.value = i;
            opt.textContent = m;
            if (i === now.getMonth()) opt.selected = true;
            monthSelect.appendChild(opt);
        });

        yearSelect.innerHTML = '';
        for (var y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
            var opt = document.createElement('option');
            opt.value = y;
            opt.textContent = y;
            if (y === now.getFullYear()) opt.selected = true;
            yearSelect.appendChild(opt);
        }

        var self = this;
        monthSelect.addEventListener('change', function() { self.refresh(); });
        yearSelect.addEventListener('change', function() { self.refresh(); });
    },

    getSelectedPeriod: function() {
        var monthSelect = document.getElementById('attMonthSelect');
        var yearSelect = document.getElementById('attYearSelect');
        if (!monthSelect || !yearSelect) {
            var now = new Date();
            return { month: now.getMonth(), year: now.getFullYear() };
        }
        return { month: parseInt(monthSelect.value), year: parseInt(yearSelect.value) };
    },

    getPeriodString: function() {
        var p = this.getSelectedPeriod();
        return p.year + '-' + String(p.month + 1).padStart(2, '0');
    },

    // ---- Calendar View ----
    renderCalendar: function() {
        var period = this.getSelectedPeriod();
        var grid = document.getElementById('calendar-grid');
        if (!grid) return;

        var firstDay = new Date(period.year, period.month, 1);
        var lastDay = new Date(period.year, period.month + 1, 0);
        var daysInMonth = lastDay.getDate();
        var startDayOfWeek = firstDay.getDay(); // 0=Sun

        var empFilter = document.getElementById('attEmployeeFilter');
        var filterEmpId = empFilter ? empFilter.value : 'all';

        grid.innerHTML = '';
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function(name) {
            var header = document.createElement('div');
            header.className = 'calendar-day-header';
            header.textContent = name;
            grid.appendChild(header);
        });
        for (var i = 0; i < startDayOfWeek; i++) {
            var empty = document.createElement('div');
            empty.className = 'calendar-day empty';
            grid.appendChild(empty);
        }

        var self = this;
        var totalHours = 0;
        var totalDays = 0;
        for (var day = 1; day <= daysInMonth; day++) {
            var date = new Date(period.year, period.month, day);
            var dateStr = self.formatDate(date);
            var isWeekend = (date.getDay() === 0 || date.getDay() === 6);
            var entries = self.getEntriesForDate(dateStr, filterEmpId);

            var cell = document.createElement('div');
            cell.className = 'calendar-day' + (isWeekend ? ' weekend' : '') + (self.isToday(date) ? ' today' : '');
            cell.setAttribute('data-date', dateStr);
            var dayNum = document.createElement('div');
            dayNum.className = 'day-number';
            dayNum.textContent = day;
            cell.appendChild(dayNum);

            if (entries.length > 0) {
                var dayHours = entries.reduce(function(sum, e) { return sum + (e.hours || 0); }, 0);
                var indicator = document.createElement('div');
                indicator.className = 'day-indicator ' + (dayHours > 0 ? 'present' : 'absent');
                indicator.textContent = dayHours > 0 ? dayHours.toFixed(1) + 'h' : (entries[0].status === 'leave' ? 'leave' : '--');
                indicator.title = entries.length + ' record(s) - ' + dayHours.toFixed(1) + ' hours';
                cell.appendChild(indicator);
                totalHours += dayHours;
                if (dayHours > 0) totalDays++;
            }
            cell.addEventListener('click', (function(d) {
                return function() { self.showDayDetails(d); };
            })(dateStr));
            grid.appendChild(cell);
        }

        // Overtime and absences come from the server-side proposal (BCEA rules, leave,
        // public holidays) — the same numbers the payroll would receive.
        var rows = (this.proposal && this.proposal.proposals) || [];
        if (filterEmpId && filterEmpId !== 'all') rows = rows.filter(function(p) { return String(p.employee_id) === filterEmpId; });
        var ot = rows.reduce(function(s, p) { return s + p.overtime_hours + p.weekly_excess_hours + p.sunday_hours + p.public_holiday_hours; }, 0);
        var absent = rows.reduce(function(s, p) { return s + p.absent_days.length; }, 0);

        this.updateElement('attTotalDays', totalDays);
        this.updateElement('attTotalHours', totalHours.toFixed(1));
        this.updateElement('attOvertimeHours', ot.toFixed(1));
        this.updateElement('attAbsences', absent);
    },

    getEntriesForDate: function(dateStr, filterEmpId) {
        var entries = this.records[dateStr] || [];
        if (filterEmpId && filterEmpId !== 'all') {
            entries = entries.filter(function(e) { return e.emp_id === filterEmpId; });
        }
        return entries;
    },

    empName: function(empId) {
        var emp = this.employees.find(function(e) { return e.id === String(empId); });
        return emp ? emp.first_name + ' ' + emp.last_name : 'Unknown';
    },

    esc: function(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    },

    // ---- Show Day Details ----
    showDayDetails: function(dateStr) {
        var entries = this.getEntriesForDate(dateStr, 'all');
        var modal = document.getElementById('dayDetailModal');
        if (!modal) return;
        var self = this;
        document.getElementById('dayDetailDate').textContent = this.formatDateDisplay(dateStr);
        var body = document.getElementById('dayDetailBody');
        body.innerHTML = '';

        if (entries.length === 0) {
            body.innerHTML = '<p style="text-align:center; color:#888; padding:20px;">No attendance records for this day.</p>';
        } else {
            entries.forEach(function(entry) {
                var card = document.createElement('div');
                card.className = 'day-entry-card';
                card.innerHTML =
                    '<div class="entry-header">' +
                        '<strong>' + self.esc(self.empName(entry.emp_id)) + '</strong>' +
                        '<span class="badge badge-' + (entry.hours >= 8 ? 'success' : 'warning') + '">' +
                            (entry.status !== 'present' ? self.esc(entry.status) + ' ' : '') + (entry.hours || 0).toFixed(1) + 'h</span>' +
                    '</div>' +
                    '<div class="entry-times">' +
                        '<span>In: ' + (entry.clock_in || '--') + '</span>' +
                        '<span>Out: ' + (entry.clock_out || '--') + '</span>' +
                    '</div>' +
                    (entry.notes ? '<div class="entry-notes">' + self.esc(entry.notes) + '</div>' : '') +
                    '<div class="entry-actions">' +
                        '<button class="btn btn-sm btn-danger" onclick="AttendanceManager.deleteEntry(\'' + dateStr + '\', ' + Number(entry.id) + ')">Delete</button>' +
                    '</div>';
                body.appendChild(card);
            });
        }
        body.innerHTML += '<button class="btn btn-success" style="width:100%; margin-top:15px;" onclick="AttendanceManager.openManualEntry(\'' + dateStr + '\')">+ Add Entry for This Day</button>';
        modal.classList.add('show');
    },

    // ---- Delete Entry ----
    deleteEntry: async function(dateStr, entryId) {
        if (!confirm('Delete this attendance entry?')) return;
        try {
            await this.api('DELETE', '/attendance/' + Number(entryId));
        } catch (e) {
            alert('Delete failed: ' + e.message);
            return;
        }
        await this.refresh();
        this.showDayDetails(dateStr);
    },

    // ---- Manual Entry ----
    openManualEntry: function(dateStr) {
        this.closeAllModals();
        var modal = document.getElementById('manualEntryModal');
        if (!modal) return;
        var empSelect = document.getElementById('entryEmployee');
        empSelect.innerHTML = '<option value="">Select Employee</option>';
        var self = this;
        this.employees.forEach(function(emp) {
            var opt = document.createElement('option');
            opt.value = emp.id;
            opt.textContent = emp.first_name + ' ' + emp.last_name + (emp.employee_number ? ' (' + emp.employee_number + ')' : '');
            empSelect.appendChild(opt);
        });
        document.getElementById('entryDate').value = dateStr || self.formatDate(new Date());
        document.getElementById('entryClockIn').value = '08:00';
        document.getElementById('entryClockOut').value = '17:00';
        document.getElementById('entryNotes').value = '';
        modal.classList.add('show');
    },

    // ---- Save Time Entry (one record per employee per day) ----
    saveTimeEntry: async function() {
        var empId = document.getElementById('entryEmployee').value;
        var date = document.getElementById('entryDate').value;
        var clockIn = document.getElementById('entryClockIn').value;
        var clockOut = document.getElementById('entryClockOut').value;
        var notes = document.getElementById('entryNotes').value;

        if (!empId || !date || !clockIn) {
            alert('Please fill in Employee, Date, and Clock In time.');
            return;
        }
        var existing = this.getEntriesForDate(date, empId);
        if (existing.length && !confirm('This employee already has a record on this date. Replace it?')) return;

        try {
            await this.api('POST', '/attendance', { entries: [{
                employee_id: parseInt(empId, 10), date: date, clock_in: clockIn, clock_out: clockOut || '', notes: notes
            }] });
        } catch (e) {
            alert('Not saved: ' + e.message);
            return;
        }
        this.closeAllModals();
        await this.refresh();
    },

    calculateHours: function(clockIn, clockOut) {
        if (!clockOut) return 0;
        var inParts = clockIn.split(':').map(Number);
        var outParts = clockOut.split(':').map(Number);
        var inMinutes = inParts[0] * 60 + inParts[1];
        var outMinutes = outParts[0] * 60 + outParts[1];
        if (outMinutes <= inMinutes) outMinutes += 1440; // Overnight shift
        return Math.round((outMinutes - inMinutes) / 60 * 100) / 100;
    },

    // ---- Time Entries View ----
    renderTimeEntries: function() {
        var tbody = document.getElementById('timeEntriesBody');
        if (!tbody) return;
        var self = this;
        var allEntries = [];
        Object.keys(this.records).forEach(function(d) { allEntries = allEntries.concat(self.records[d]); });
        allEntries.sort(function(a, b) { return b.date.localeCompare(a.date); });

        tbody.innerHTML = '';
        if (allEntries.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#888;">No entries for this period.</td></tr>';
            return;
        }
        allEntries.forEach(function(entry) {
            var row = document.createElement('tr');
            row.innerHTML =
                '<td>' + self.esc(self.empName(entry.emp_id)) + '</td>' +
                '<td>' + self.formatDateDisplay(entry.date) + '</td>' +
                '<td>' + (entry.clock_in || '--') + '</td>' +
                '<td>' + (entry.clock_out || '--') + '</td>' +
                '<td><strong>' + (entry.hours || 0).toFixed(1) + 'h</strong></td>' +
                '<td>' + (entry.status !== 'present' ? '<span class="badge badge-warning">' + self.esc(entry.status) + '</span>' : '<span class="badge badge-success">OK</span>') + '</td>' +
                '<td><button class="btn btn-sm btn-danger" onclick="AttendanceManager.deleteEntry(\'' + entry.date + '\', ' + Number(entry.id) + ')">Delete</button></td>';
            tbody.appendChild(row);
        });
    },

    // ---- Import CSV/Excel ----
    setupDragDrop: function() {
        var dropZone = document.getElementById('attDropZone');
        var fileInput = document.getElementById('attFileInput');
        if (!dropZone) return;
        var self = this;
        dropZone.addEventListener('dragover', function(e) { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', function() { dropZone.classList.remove('drag-over'); });
        dropZone.addEventListener('drop', function(e) {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) self.handleFileImport(e.dataTransfer.files[0]);
        });
        if (fileInput) {
            fileInput.addEventListener('change', function() {
                if (fileInput.files.length > 0) self.handleFileImport(fileInput.files[0]);
            });
        }
    },

    handleFileImport: function(file) {
        var self = this;
        var reader = new FileReader();
        reader.onload = function(e) {
            try {
                var data = new Uint8Array(e.target.result);
                var workbook = XLSX.read(data, { type: 'array' });
                var firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                var jsonData = XLSX.utils.sheet_to_json(firstSheet, { raw: true, defval: '' });
                if (jsonData.length === 0) { alert('File is empty or could not be parsed.'); return; }
                self.previewImportData(jsonData);
            } catch (err) {
                alert('Error reading file: ' + err.message);
            }
        };
        reader.readAsArrayBuffer(file);
    },

    previewImportData: function(data) {
        this.importData = data;
        var preview = document.getElementById('importPreview');
        var table = document.getElementById('previewTable');
        if (!preview || !table) return;
        var self = this;
        var previewData = data.slice(0, 10);
        var keys = Object.keys(previewData[0]);
        var html = '<thead><tr>';
        keys.forEach(function(key) { html += '<th>' + self.esc(key) + '</th>'; });
        html += '</tr></thead><tbody>';
        previewData.forEach(function(row) {
            html += '<tr>';
            keys.forEach(function(key) { html += '<td>' + self.esc(row[key] || '') + '</td>'; });
            html += '</tr>';
        });
        html += '</tbody>';
        table.innerHTML = html;
        document.getElementById('importTotalRows').textContent = data.length;
        preview.style.display = 'block';
    },

    confirmImport: async function() {
        if (!this.importData) return;
        var self = this;
        var errors = [];
        var entries = [];

        this.importData.forEach(function(row, i) {
            var empNumber = row.employee_number || row.emp_number || row.emp_id || row.EmployeeNumber || row.EmpNo;
            if (!empNumber) { errors.push('Row ' + (i + 2) + ': missing employee identifier'); return; }
            var emp = self.employees.find(function(e) {
                return e.employee_number === String(empNumber) || e.id === String(empNumber);
            });
            if (!emp) { errors.push('Row ' + (i + 2) + ': employee ' + empNumber + ' not found'); return; }
            var date = row.date || row.Date || row.work_date || row.WorkDate;
            date = date ? self.normalizeDate(String(date)) : null;
            if (!date) { errors.push('Row ' + (i + 2) + ': missing or invalid date'); return; }
            var clockIn = self.normalizeTime(String(row.clock_in || row.ClockIn || row.time_in || row.TimeIn || row.start || '08:00'));
            var rawOut = row.clock_out || row.ClockOut || row.time_out || row.TimeOut || row.end || '';
            entries.push({
                employee_id: parseInt(emp.id, 10), date: date, clock_in: clockIn,
                clock_out: rawOut ? self.normalizeTime(String(rawOut)) : '',
                notes: ((row.notes || row.Notes || '') + ' [IMPORTED]').trim()
            });
        });

        var imported = 0;
        for (var i = 0; i < entries.length; i += 1000) {
            try {
                var res = await this.api('POST', '/attendance', { entries: entries.slice(i, i + 1000) });
                imported += res.saved || 0;
            } catch (e) {
                errors.push('Rows ' + (i + 1) + '–' + Math.min(i + 1000, entries.length) + ' not saved: ' + e.message);
            }
        }

        var msg = 'Import complete!\n\nSaved: ' + imported + '\nErrors: ' + errors.length;
        if (errors.length > 0) msg += '\n\nFirst 5 errors:\n' + errors.slice(0, 5).join('\n');
        alert(msg);
        this.cancelImport();
        await this.refresh();
    },

    cancelImport: function() {
        this.importData = null;
        var preview = document.getElementById('importPreview');
        if (preview) preview.style.display = 'none';
        var fileInput = document.getElementById('attFileInput');
        if (fileInput) fileInput.value = '';
    },

    downloadTemplate: function() {
        var rows = [
            ['employee_number', 'date', 'clock_in', 'clock_out', 'notes'],
            ['EMP001', '2026-02-02', '08:00', '17:00', 'Normal day'],
            ['EMP001', '2026-02-03', '08:30', '18:00', 'Overtime'],
            ['EMP002', '2026-02-02', '07:45', '16:30', '']
        ];
        var csv = rows.map(function(r) { return r.join(','); }).join('\n');
        var blob = new Blob([csv], { type: 'text/csv' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'attendance_import_template.csv';
        link.click();
    },

    // ---- Summary View (server proposal: the numbers payroll would receive) ----
    renderSummary: function() {
        var tbody = document.getElementById('summaryBody');
        if (!tbody) return;
        var self = this;
        var rows = (this.proposal && this.proposal.proposals) || [];
        tbody.innerHTML = '';
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#888;">No attendance data for this period.</td></tr>';
            return;
        }
        rows.forEach(function(p) {
            var ot = p.overtime_hours + p.weekly_excess_hours;
            var extra = (p.sunday_hours ? ' + ' + p.sunday_hours.toFixed(1) + ' Sun' : '') + (p.public_holiday_hours ? ' + ' + p.public_holiday_hours.toFixed(1) + ' PH' : '');
            var row = document.createElement('tr');
            row.innerHTML =
                '<td><strong>' + self.esc(p.name) + '</strong>' + (p.employee_code ? '<br><small>' + self.esc(p.employee_code) + '</small>' : '') + '</td>' +
                '<td>' + (p.leave_days.length ? p.leave_days.length + ' leave' : '—') + '</td>' +
                '<td><strong>' + p.worked_hours.toFixed(1) + '</strong></td>' +
                '<td>' + p.scheduled_hours.toFixed(1) + ' scheduled</td>' +
                '<td>' + (ot > 0 || extra ? '<span class="badge badge-info">' + ot.toFixed(1) + extra + '</span>' : '0') + '</td>' +
                '<td>' + (p.absent_days.length ? '<span class="badge badge-danger">' + p.absent_days.length + '</span>' : '0') + '</td>' +
                '<td>' + (p.partial_days.length ? '<span class="badge badge-warning">' + p.partial_days.length + ' short</span>' : '0') + '</td>';
            tbody.appendChild(row);
        });
    },

    // ---- Apply to Payroll: review the proposal, approve per employee ----
    applyToPayroll: async function() {
        var period = this.getPeriodString();
        var self = this;
        try {
            this.proposal = await this.api('GET', '/attendance/proposal?period_key=' + period);
        } catch (e) {
            alert('Could not build the proposal: ' + e.message);
            return;
        }
        var rows = (this.proposal.proposals || []).filter(function(p) { return p.has_changes; });
        var modal = document.getElementById('proposalModal');
        var body = document.getElementById('proposalBody');
        document.getElementById('proposalTitle').textContent = 'Attendance proposal — ' + period;
        if (!rows.length) {
            body.innerHTML = '<p style="padding:15px; color:#666;">No overtime or absences to put on payslips for ' + period + '.</p>';
            document.getElementById('proposalApproveBtn').style.display = 'none';
            modal.classList.add('show');
            return;
        }
        var line = function(r, short) {
            return short ? r.hours_missed + 'h short time' : r.hours + 'h × ' + r.rate_multiplier;
        };
        var html = '<p style="font-size:13px; color:#555; margin-bottom:10px;">Nothing is on a payslip yet. Tick the employees to approve — their overtime and short time ' +
                   'from attendance for ' + period + ' are replaced; entries typed in by hand are not touched.</p>' +
                   '<table style="width:100%; font-size:13px; border-collapse:collapse;"><thead><tr>' +
                   '<th style="text-align:left;"><input type="checkbox" checked onclick="AttendanceManager.toggleAllProposal(this.checked)"></th>' +
                   '<th style="text-align:left;">Employee</th><th style="text-align:left;">Overtime</th><th style="text-align:left;">Short time</th></tr></thead><tbody>';
        rows.forEach(function(p) {
            html += '<tr style="border-top:1px solid #eee;">' +
                '<td><input type="checkbox" class="proposal-pick" value="' + Number(p.employee_id) + '" checked></td>' +
                '<td>' + self.esc(p.name) + '</td>' +
                '<td>' + (p.overtime_rows.map(function(r) { return self.esc(r.description.replace('Attendance: ', '')) + ': ' + line(r); }).join('<br>') || '—') + '</td>' +
                '<td>' + (p.short_time_rows.length ? line(p.short_time_rows[0], true) + '<br><small>' + p.absent_days.join(', ') + '</small>' : '—') +
                    (p.leave_days.length ? '<br><small style="color:#2e7d32;">leave not counted: ' + p.leave_days.length + ' day(s)</small>' : '') + '</td>' +
                '</tr>';
        });
        html += '</tbody></table>';
        body.innerHTML = html;
        document.getElementById('proposalApproveBtn').style.display = '';
        modal.classList.add('show');
    },

    toggleAllProposal: function(on) {
        document.querySelectorAll('.proposal-pick').forEach(function(c) { c.checked = on; });
    },

    approveProposal: async function() {
        var ids = Array.prototype.map.call(document.querySelectorAll('.proposal-pick:checked'), function(c) { return parseInt(c.value, 10); });
        if (!ids.length) { alert('Tick at least one employee.'); return; }
        var period = this.getPeriodString();
        if (!confirm('Put the attendance overtime / short time for ' + ids.length + ' employee(s) on their ' + period + ' payslips?')) return;
        var btn = document.getElementById('proposalApproveBtn');
        btn.disabled = true;
        try {
            var res = await this.api('POST', '/attendance/apply', { period_key: period, employee_ids: ids });
            var msg = 'Applied to ' + res.applied.length + ' payslip(s) for ' + period + '.';
            if (res.skipped.length) msg += '\n\nNot applied (' + res.skipped.length + '):\n' + res.skipped.slice(0, 8).map(function(s) { return '- ' + s.error; }).join('\n');
            alert(msg);
            this.closeModal('proposalModal');
        } catch (e) {
            alert('Not applied: ' + e.message);
        } finally {
            btn.disabled = false;
        }
    },

    // ---- Helpers ----
    formatDate: function(date) {
        var y = date.getFullYear();
        var m = String(date.getMonth() + 1).padStart(2, '0');
        var d = String(date.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    },

    formatDateDisplay: function(dateStr) {
        var parts = dateStr.split('-');
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return parseInt(parts[2]) + ' ' + months[parseInt(parts[1]) - 1] + ' ' + parts[0];
    },

    isToday: function(date) {
        var today = new Date();
        return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    },

    normalizeDate: function(dateStr) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
        // DD/MM/YYYY (South African format)
        var match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (match) return match[3] + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0');
        // Excel serial number
        if (/^\d{5}$/.test(dateStr)) {
            var excelDate = new Date((parseInt(dateStr) - 25569) * 86400 * 1000);
            return excelDate.toISOString().slice(0, 10);
        }
        return null;
    },

    normalizeTime: function(timeStr) {
        if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
            var parts = timeStr.split(':');
            return parts[0].padStart(2, '0') + ':' + parts[1];
        }
        if (/^\d{4}$/.test(timeStr)) return timeStr.substr(0, 2) + ':' + timeStr.substr(2, 2);
        // Excel time fraction (e.g. 0.333333 = 08:00)
        if (/^0?\.\d+$/.test(timeStr)) {
            var mins = Math.round(parseFloat(timeStr) * 1440);
            return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
        }
        return timeStr;
    },

    updateElement: function(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value;
    },

    closeAllModals: function() {
        document.querySelectorAll('.modal').forEach(function(m) { m.classList.remove('show'); });
    },

    closeModal: function(id) {
        var modal = document.getElementById(id);
        if (modal) modal.classList.remove('show');
    },

    // ---- Populate Employee Filter ----
    populateEmployeeFilter: function() {
        var select = document.getElementById('attEmployeeFilter');
        if (!select) return;
        select.innerHTML = '<option value="all">All Employees</option>';
        this.employees.forEach(function(emp) {
            var opt = document.createElement('option');
            opt.value = emp.id;
            opt.textContent = emp.first_name + ' ' + emp.last_name;
            select.appendChild(opt);
        });
        var self = this;
        select.onchange = function() { self.renderCalendar(); };
    }
};

// Initialize on page load
window.addEventListener('load', function() {
    if (typeof AUTH !== 'undefined' && AUTH.isLoggedIn()) {
        AttendanceManager.init();
    }
});
