/* =============================================
   ATTENDANCE MANAGER MODULE
   Payroll App - Time & Attendance Tracking
   ============================================= */

const AttendanceManager = {
    currentCompanyId: null,
    currentPeriod: null,
    employees: [],
    importData: null,
    currentView: 'calendar',

    // ---- Initialize ----
    init: function() {
        const session = AUTH.getSession();
        if (!session) return;
        this.currentCompanyId = session.company_id;
        this.loadEmployees();
        this.initPeriodSelectors();
        this.renderCalendar();
        this.setupDragDrop();
        this.setupTabs();
    },

    // ---- Load Employees ----
    loadEmployees: function() {
        const stored = safeLocalStorage.getItem('employees_' + this.currentCompanyId);
        this.employees = stored ? JSON.parse(stored) : [];
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
        monthSelect.addEventListener('change', function() { self.renderCalendar(); });
        yearSelect.addEventListener('change', function() { self.renderCalendar(); });
    },

    // ---- Get Selected Period ----
    getSelectedPeriod: function() {
        var monthSelect = document.getElementById('attMonthSelect');
        var yearSelect = document.getElementById('attYearSelect');
        if (!monthSelect || !yearSelect) {
            var now = new Date();
            return { month: now.getMonth(), year: now.getFullYear() };
        }
        return {
            month: parseInt(monthSelect.value),
            year: parseInt(yearSelect.value)
        };
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

        // Day headers
        var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        dayNames.forEach(function(name) {
            var header = document.createElement('div');
            header.className = 'calendar-day-header';
            header.textContent = name;
            grid.appendChild(header);
        });

        // Empty cells before first day
        for (var i = 0; i < startDayOfWeek; i++) {
            var empty = document.createElement('div');
            empty.className = 'calendar-day empty';
            grid.appendChild(empty);
        }

        // Days
        var self = this;
        var totalHours = 0;
        var totalDays = 0;
        var totalOT = 0;
        var totalAbsent = 0;

        for (var day = 1; day <= daysInMonth; day++) {
            var date = new Date(period.year, period.month, day);
            var dateStr = self.formatDate(date);
            var isWeekend = (date.getDay() === 0 || date.getDay() === 6);
            var isToday = self.isToday(date);
            var entries = self.getEntriesForDate(dateStr, filterEmpId);

            var cell = document.createElement('div');
            cell.className = 'calendar-day' + (isWeekend ? ' weekend' : '') + (isToday ? ' today' : '');
            cell.setAttribute('data-date', dateStr);

            var dayNum = document.createElement('div');
            dayNum.className = 'day-number';
            dayNum.textContent = day;
            cell.appendChild(dayNum);

            if (entries.length > 0) {
                var indicator = document.createElement('div');
                indicator.className = 'day-indicator present';
                var dayHours = entries.reduce(function(sum, e) { return sum + (e.hours || 0); }, 0);
                indicator.textContent = dayHours.toFixed(1) + 'h';
                cell.appendChild(indicator);

                indicator.title = entries.length + ' entries - ' + dayHours.toFixed(1) + ' hours';
                totalHours += dayHours;
                totalDays++;

                entries.forEach(function(e) {
                    if (e.hours > 8) totalOT += (e.hours - 8);
                });
            } else if (!isWeekend) {
                var isPast = date < new Date() && !isToday;
                if (isPast) {
                    var absentInd = document.createElement('div');
                    absentInd.className = 'day-indicator absent';
                    absentInd.textContent = '--';
                    cell.appendChild(absentInd);
                    totalAbsent++;
                }
            }

            cell.addEventListener('click', (function(d) {
                return function() { self.showDayDetails(d); };
            })(dateStr));

            grid.appendChild(cell);
        }

        // Update stats
        this.updateElement('attTotalDays', totalDays);
        this.updateElement('attTotalHours', totalHours.toFixed(1));
        this.updateElement('attOvertimeHours', totalOT.toFixed(1));
        this.updateElement('attAbsences', totalAbsent);
    },

    // ---- Get Entries For Date ----
    getEntriesForDate: function(dateStr, filterEmpId) {
        var key = 'attendance_' + this.currentCompanyId + '_' + dateStr;
        var stored = safeLocalStorage.getItem(key);
        var entries = stored ? JSON.parse(stored) : [];
        if (filterEmpId && filterEmpId !== 'all') {
            entries = entries.filter(function(e) { return e.emp_id === filterEmpId; });
        }
        return entries;
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
                var emp = self.employees.find(function(e) { return e.id === entry.emp_id; });
                var card = document.createElement('div');
                card.className = 'day-entry-card';
                card.innerHTML =
                    '<div class="entry-header">' +
                        '<strong>' + (emp ? emp.first_name + ' ' + emp.last_name : 'Unknown') + '</strong>' +
                        '<span class="badge badge-' + (entry.hours >= 8 ? 'success' : 'warning') + '">' + (entry.hours || 0).toFixed(1) + 'h</span>' +
                    '</div>' +
                    '<div class="entry-times">' +
                        '<span>In: ' + (entry.clock_in || '--') + '</span>' +
                        '<span>Out: ' + (entry.clock_out || '--') + '</span>' +
                    '</div>' +
                    (entry.notes ? '<div class="entry-notes">' + entry.notes + '</div>' : '') +
                    '<div class="entry-actions">' +
                        '<button class="btn btn-sm btn-danger" onclick="AttendanceManager.deleteEntry(\'' + dateStr + '\', \'' + entry.id + '\')">Delete</button>' +
                    '</div>';
                body.appendChild(card);
            });
        }

        // Add quick-add button
        body.innerHTML += '<button class="btn btn-success" style="width:100%; margin-top:15px;" onclick="AttendanceManager.openManualEntry(\'' + dateStr + '\')">+ Add Entry for This Day</button>';

        modal.classList.add('show');
    },

    // ---- Delete Entry ----
    deleteEntry: function(dateStr, entryId) {
        if (!confirm('Delete this attendance entry?')) return;
        var key = 'attendance_' + this.currentCompanyId + '_' + dateStr;
        var entries = this.getEntriesForDate(dateStr, 'all');
        entries = entries.filter(function(e) { return e.id !== entryId; });
        if (entries.length > 0) {
            safeLocalStorage.setItem(key, JSON.stringify(entries));
        } else {
            safeLocalStorage.removeItem(key);
        }
        this.logAudit('DELETE', 'attendance', 'Deleted entry ' + entryId + ' for ' + dateStr);
        this.showDayDetails(dateStr);
        this.renderCalendar();
    },

    // ---- Manual Entry ----
    openManualEntry: function(dateStr) {
        this.closeAllModals();
        var modal = document.getElementById('manualEntryModal');
        if (!modal) return;

        // Populate employee dropdown
        var empSelect = document.getElementById('entryEmployee');
        empSelect.innerHTML = '<option value="">Select Employee</option>';
        this.employees.forEach(function(emp) {
            var opt = document.createElement('option');
            opt.value = emp.id;
            opt.textContent = emp.first_name + ' ' + emp.last_name + ' (' + emp.employee_number + ')';
            empSelect.appendChild(opt);
        });

        if (dateStr) {
            document.getElementById('entryDate').value = dateStr;
        } else {
            document.getElementById('entryDate').value = this.formatDate(new Date());
        }
        document.getElementById('entryClockIn').value = '08:00';
        document.getElementById('entryClockOut').value = '17:00';
        document.getElementById('entryNotes').value = '';

        modal.classList.add('show');
    },

    // ---- Save Time Entry ----
    saveTimeEntry: function() {
        var empId = document.getElementById('entryEmployee').value;
        var date = document.getElementById('entryDate').value;
        var clockIn = document.getElementById('entryClockIn').value;
        var clockOut = document.getElementById('entryClockOut').value;
        var notes = document.getElementById('entryNotes').value;

        if (!empId || !date || !clockIn) {
            alert('Please fill in Employee, Date, and Clock In time.');
            return;
        }

        var hours = this.calculateHours(clockIn, clockOut);

        var entry = {
            id: 'att-' + Math.random().toString(36).substr(2, 9),
            emp_id: empId,
            date: date,
            clock_in: clockIn,
            clock_out: clockOut || '',
            hours: hours,
            notes: notes,
            created_by: AUTH.getSession().email,
            created_date: new Date().toISOString()
        };

        var key = 'attendance_' + this.currentCompanyId + '_' + date;
        var entries = this.getEntriesForDate(date, 'all');

        // Check for duplicate
        var existing = entries.find(function(e) { return e.emp_id === empId; });
        if (existing) {
            if (!confirm('An entry already exists for this employee on this date. Add another?')) return;
        }

        entries.push(entry);
        safeLocalStorage.setItem(key, JSON.stringify(entries));

        this.logAudit('CREATE', 'attendance', 'Added entry for ' + date + ' - ' + hours.toFixed(1) + 'h');
        this.closeAllModals();
        this.renderCalendar();
        if (this.currentView === 'entries-view') this.renderTimeEntries();
        alert('Time entry saved successfully!');
    },

    // ---- Calculate Hours ----
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

        var period = this.getSelectedPeriod();
        var daysInMonth = new Date(period.year, period.month + 1, 0).getDate();
        var self = this;
        var allEntries = [];

        for (var day = 1; day <= daysInMonth; day++) {
            var date = new Date(period.year, period.month, day);
            var dateStr = self.formatDate(date);
            var entries = self.getEntriesForDate(dateStr, 'all');
            entries.forEach(function(entry) {
                entry._dateStr = dateStr;
                allEntries.push(entry);
            });
        }

        // Sort by date descending
        allEntries.sort(function(a, b) { return b.date.localeCompare(a.date); });

        tbody.innerHTML = '';
        if (allEntries.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#888;">No entries for this period.</td></tr>';
            return;
        }

        allEntries.forEach(function(entry) {
            var emp = self.employees.find(function(e) { return e.id === entry.emp_id; });
            var isLate = false;
            if (entry.clock_in) {
                var inParts = entry.clock_in.split(':').map(Number);
                isLate = (inParts[0] > 8 || (inParts[0] === 8 && inParts[1] > 0));
            }

            var row = document.createElement('tr');
            row.innerHTML =
                '<td>' + (emp ? emp.first_name + ' ' + emp.last_name : 'Unknown') + '</td>' +
                '<td>' + self.formatDateDisplay(entry.date) + '</td>' +
                '<td>' + (entry.clock_in || '--') + '</td>' +
                '<td>' + (entry.clock_out || '--') + '</td>' +
                '<td><strong>' + (entry.hours || 0).toFixed(1) + 'h</strong></td>' +
                '<td>' +
                    (isLate ? '<span class="badge badge-warning">Late</span>' : '') +
                    (entry.hours > 8 ? '<span class="badge badge-info">OT</span>' : '') +
                    (!isLate && entry.hours <= 8 && entry.hours > 0 ? '<span class="badge badge-success">OK</span>' : '') +
                '</td>' +
                '<td><button class="btn btn-sm btn-danger" onclick="AttendanceManager.deleteEntry(\'' + entry.date + '\', \'' + entry.id + '\')">Delete</button></td>';
            tbody.appendChild(row);
        });
    },

    // ---- Import CSV/Excel ----
    setupDragDrop: function() {
        var dropZone = document.getElementById('attDropZone');
        var fileInput = document.getElementById('attFileInput');
        if (!dropZone) return;

        var self = this;

        dropZone.addEventListener('dragover', function(e) {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });
        dropZone.addEventListener('dragleave', function() {
            dropZone.classList.remove('drag-over');
        });
        dropZone.addEventListener('drop', function(e) {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) {
                self.handleFileImport(e.dataTransfer.files[0]);
            }
        });

        if (fileInput) {
            fileInput.addEventListener('change', function() {
                if (fileInput.files.length > 0) {
                    self.handleFileImport(fileInput.files[0]);
                }
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
                var jsonData = XLSX.utils.sheet_to_json(firstSheet);

                if (jsonData.length === 0) {
                    alert('File is empty or could not be parsed.');
                    return;
                }

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

        // Show preview of first 10 rows
        var previewData = data.slice(0, 10);
        var keys = Object.keys(previewData[0]);

        var html = '<thead><tr>';
        keys.forEach(function(key) { html += '<th>' + key + '</th>'; });
        html += '</tr></thead><tbody>';

        previewData.forEach(function(row) {
            html += '<tr>';
            keys.forEach(function(key) { html += '<td>' + (row[key] || '') + '</td>'; });
            html += '</tr>';
        });
        html += '</tbody>';

        table.innerHTML = html;
        document.getElementById('importTotalRows').textContent = data.length;
        preview.style.display = 'block';
    },

    confirmImport: function() {
        if (!this.importData) return;

        var self = this;
        var imported = 0;
        var errors = [];
        var skipped = 0;

        this.importData.forEach(function(row) {
            // Find employee by employee_number or emp_id
            var empNumber = row.employee_number || row.emp_number || row.emp_id || row.EmployeeNumber || row.EmpNo;
            if (!empNumber) {
                errors.push('Row missing employee identifier');
                return;
            }

            var emp = self.employees.find(function(e) {
                return e.employee_number === String(empNumber) || e.id === String(empNumber);
            });

            if (!emp) {
                errors.push('Employee ' + empNumber + ' not found');
                return;
            }

            // Parse date
            var date = row.date || row.Date || row.work_date || row.WorkDate;
            if (!date) {
                errors.push('Row missing date for employee ' + empNumber);
                return;
            }
            // Normalize date format
            date = self.normalizeDate(String(date));
            if (!date) {
                errors.push('Invalid date format for employee ' + empNumber);
                return;
            }

            var clockIn = row.clock_in || row.ClockIn || row.time_in || row.TimeIn || row.start || '08:00';
            var clockOut = row.clock_out || row.ClockOut || row.time_out || row.TimeOut || row.end || '';
            var notes = row.notes || row.Notes || '';

            // Normalize time format
            clockIn = self.normalizeTime(String(clockIn));
            clockOut = clockOut ? self.normalizeTime(String(clockOut)) : '';

            var hours = clockOut ? self.calculateHours(clockIn, clockOut) : 0;

            var entry = {
                id: 'att-' + Math.random().toString(36).substr(2, 9),
                emp_id: emp.id,
                date: date,
                clock_in: clockIn,
                clock_out: clockOut,
                hours: hours,
                notes: notes + ' [IMPORTED]',
                created_by: 'IMPORT',
                created_date: new Date().toISOString()
            };

            var key = 'attendance_' + self.currentCompanyId + '_' + date;
            var entries = self.getEntriesForDate(date, 'all');
            entries.push(entry);
            safeLocalStorage.setItem(key, JSON.stringify(entries));
            imported++;
        });

        this.logAudit('IMPORT', 'attendance', 'Imported ' + imported + ' records, ' + errors.length + ' errors');

        var msg = 'Import complete!\n\nImported: ' + imported + '\nErrors: ' + errors.length;
        if (errors.length > 0) {
            msg += '\n\nFirst 5 errors:\n' + errors.slice(0, 5).join('\n');
        }
        alert(msg);

        this.cancelImport();
        this.renderCalendar();
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
            ['EMP001', '2026-02-01', '08:00', '17:00', 'Normal day'],
            ['EMP001', '2026-02-02', '08:30', '18:00', 'Overtime'],
            ['EMP002', '2026-02-01', '07:45', '16:30', '']
        ];
        var csv = rows.map(function(r) { return r.join(','); }).join('\n');
        var blob = new Blob([csv], { type: 'text/csv' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'attendance_import_template.csv';
        link.click();
    },

    // ---- Summary View ----
    renderSummary: function() {
        var tbody = document.getElementById('summaryBody');
        if (!tbody) return;

        var period = this.getSelectedPeriod();
        var daysInMonth = new Date(period.year, period.month + 1, 0).getDate();
        var self = this;

        // Calculate summary per employee
        var summary = {};
        this.employees.forEach(function(emp) {
            summary[emp.id] = {
                employee: emp,
                daysWorked: 0,
                totalHours: 0,
                regularHours: 0,
                overtime: 0,
                absences: 0,
                lateDays: 0
            };
        });

        // Count expected workdays
        var expectedWorkdays = 0;
        var today = new Date();
        for (var day = 1; day <= daysInMonth; day++) {
            var date = new Date(period.year, period.month, day);
            if (date.getDay() !== 0 && date.getDay() !== 6) {
                if (date <= today) expectedWorkdays++;
            }
        }

        // Process all days
        for (var day = 1; day <= daysInMonth; day++) {
            var date = new Date(period.year, period.month, day);
            var dateStr = self.formatDate(date);
            var entries = self.getEntriesForDate(dateStr, 'all');

            entries.forEach(function(entry) {
                var empSummary = summary[entry.emp_id];
                if (!empSummary) return;

                empSummary.daysWorked++;
                empSummary.totalHours += entry.hours;

                if (entry.hours <= 8) {
                    empSummary.regularHours += entry.hours;
                } else {
                    empSummary.regularHours += 8;
                    empSummary.overtime += (entry.hours - 8);
                }

                if (entry.clock_in) {
                    var parts = entry.clock_in.split(':').map(Number);
                    if (parts[0] > 8 || (parts[0] === 8 && parts[1] > 0)) {
                        empSummary.lateDays++;
                    }
                }
            });
        }

        // Calculate absences
        Object.values(summary).forEach(function(s) {
            s.absences = Math.max(0, expectedWorkdays - s.daysWorked);
        });

        // Render table
        tbody.innerHTML = '';
        var hasData = false;

        Object.values(summary).forEach(function(s) {
            if (s.totalHours === 0 && s.absences === 0) return;
            hasData = true;
            var row = document.createElement('tr');
            row.innerHTML =
                '<td><strong>' + s.employee.first_name + ' ' + s.employee.last_name + '</strong><br><small>' + s.employee.employee_number + '</small></td>' +
                '<td>' + s.daysWorked + ' / ' + expectedWorkdays + '</td>' +
                '<td><strong>' + s.totalHours.toFixed(1) + '</strong></td>' +
                '<td>' + s.regularHours.toFixed(1) + '</td>' +
                '<td>' + (s.overtime > 0 ? '<span class="badge badge-info">' + s.overtime.toFixed(1) + '</span>' : '0') + '</td>' +
                '<td>' + (s.absences > 0 ? '<span class="badge badge-danger">' + s.absences + '</span>' : '0') + '</td>' +
                '<td>' + (s.lateDays > 0 ? '<span class="badge badge-warning">' + s.lateDays + '</span>' : '0') + '</td>';
            tbody.appendChild(row);
        });

        if (!hasData) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#888;">No attendance data for this period.</td></tr>';
        }
    },

    // ---- Apply to Payroll ----
    applyToPayroll: function() {
        var periodStr = this.getPeriodString();
        var period = this.getSelectedPeriod();
        var daysInMonth = new Date(period.year, period.month + 1, 0).getDate();
        var self = this;
        var applied = 0;

        // Generate summary first
        var summary = {};
        this.employees.forEach(function(emp) {
            summary[emp.id] = { overtime: 0, absences: 0, daysWorked: 0 };
        });

        var expectedWorkdays = 0;
        var today = new Date();
        for (var day = 1; day <= daysInMonth; day++) {
            var date = new Date(period.year, period.month, day);
            if (date.getDay() !== 0 && date.getDay() !== 6) {
                if (date <= today) expectedWorkdays++;
            }
        }

        for (var day = 1; day <= daysInMonth; day++) {
            var date = new Date(period.year, period.month, day);
            var dateStr = self.formatDate(date);
            var entries = self.getEntriesForDate(dateStr, 'all');

            entries.forEach(function(entry) {
                var s = summary[entry.emp_id];
                if (!s) return;
                s.daysWorked++;
                if (entry.hours > 8) s.overtime += (entry.hours - 8);
            });
        }

        Object.keys(summary).forEach(function(empId) {
            var s = summary[empId];
            s.absences = Math.max(0, expectedWorkdays - s.daysWorked);
        });

        // Apply overtime to payroll
        Object.keys(summary).forEach(function(empId) {
            var s = summary[empId];
            if (s.overtime <= 0 && s.absences <= 0) return;

            // Add overtime
            if (s.overtime > 0) {
                var otKey = 'emp_overtime_' + self.currentCompanyId + '_' + empId + '_' + periodStr;
                var overtime = JSON.parse(safeLocalStorage.getItem(otKey) || '[]');

                // Remove existing auto entries
                overtime = overtime.filter(function(ot) { return ot.description !== 'AUTO: From Attendance'; });

                overtime.push({
                    id: 'ot-' + Math.random().toString(36).substr(2, 9),
                    date: periodStr + '-01',
                    hours: parseFloat(s.overtime.toFixed(1)),
                    rate_multiplier: 1.5,
                    description: 'AUTO: From Attendance'
                });
                safeLocalStorage.setItem(otKey, JSON.stringify(overtime));
            }

            // Add absences as short time
            if (s.absences > 0) {
                var stKey = 'emp_short_time_' + self.currentCompanyId + '_' + empId + '_' + periodStr;
                var shortTime = JSON.parse(safeLocalStorage.getItem(stKey) || '[]');

                // Remove existing auto entries
                shortTime = shortTime.filter(function(st) { return st.reason !== 'AUTO: Absences from Attendance'; });

                shortTime.push({
                    id: 'st-' + Math.random().toString(36).substr(2, 9),
                    date: periodStr + '-01',
                    hours_missed: s.absences * 8,
                    reason: 'AUTO: Absences from Attendance'
                });
                safeLocalStorage.setItem(stKey, JSON.stringify(shortTime));
            }

            applied++;
        });

        this.logAudit('APPLY', 'attendance', 'Applied attendance to payroll for ' + periodStr + ' (' + applied + ' employees)');
        alert('Attendance data applied to payroll for ' + applied + ' employees.\n\nOvertime and absences have been automatically added to their payslips for ' + periodStr + '.');
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
        // Handle various date formats
        // Try YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
        // Try DD/MM/YYYY
        var match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (match) return match[3] + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0');
        // Try MM/DD/YYYY
        match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (match && parseInt(match[1]) <= 12) return match[3] + '-' + match[1].padStart(2, '0') + '-' + match[2].padStart(2, '0');
        // Try Excel serial number
        if (/^\d{5}$/.test(dateStr)) {
            var excelDate = new Date((parseInt(dateStr) - 25569) * 86400 * 1000);
            return this.formatDate(excelDate);
        }
        return null;
    },

    normalizeTime: function(timeStr) {
        // Handle HH:MM
        if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
            var parts = timeStr.split(':');
            return parts[0].padStart(2, '0') + ':' + parts[1];
        }
        // Handle HHMM
        if (/^\d{4}$/.test(timeStr)) {
            return timeStr.substr(0, 2) + ':' + timeStr.substr(2, 2);
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

    logAudit: function(action, entity, description) {
        if (typeof AuditTrail !== 'undefined') {
            AuditTrail.log(this.currentCompanyId, action, entity, description);
        }
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
        select.addEventListener('change', function() { self.renderCalendar(); });
    }
};

// Initialize on page load
window.addEventListener('load', function() {
    if (typeof AUTH !== 'undefined' && AUTH.isLoggedIn()) {
        AttendanceManager.init();
        AttendanceManager.populateEmployeeFilter();
    }
});
