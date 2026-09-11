// deadline-utils.js — SA statutory deadline computation + practice offset engine
// Exposes: window.DeadlineUtils
(function (global) {
    'use strict';

    // ── Easter Sunday (Anonymous Gregorian algorithm) ─────────────────────────
    function easterSunday(year) {
        var a = year % 19, b = Math.floor(year / 100), c = year % 100;
        var d = Math.floor(b / 4), e = b % 4;
        var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
        var h = (19 * a + b - d - g + 15) % 30;
        var i = Math.floor(c / 4), k = c % 4;
        var l = (32 + 2 * e + 2 * i - h - k) % 7;
        var m = Math.floor((a + 11 * h + 22 * l) / 451);
        var mo = Math.floor((h + l - 7 * m + 114) / 31) - 1; // 0-indexed month
        var dy = ((h + l - 7 * m + 114) % 31) + 1;
        return new Date(year, mo, dy);
    }

    // ── SA Public Holidays ────────────────────────────────────────────────────
    // Returns a Set of 'YYYY-MM-DD' strings for the given year.
    // Fixed holidays observed on the next Monday when they fall on Sunday (SA rule).
    var _holidayCache = {};

    function getSAPublicHolidays(year) {
        if (_holidayCache[year]) return _holidayCache[year];

        var set = new Set();

        function pad2(n) { return String(n).padStart(2, '0'); }
        function fmt(d) {
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
        }
        function addHoliday(d) {
            set.add(fmt(d));
            if (d.getDay() === 0) { // Sunday → Monday observed
                var mon = new Date(d);
                mon.setDate(d.getDate() + 1);
                set.add(fmt(mon));
            }
        }

        // Fixed public holidays (month 1-indexed)
        [[1,1],[3,21],[4,27],[5,1],[6,16],[8,9],[9,24],[12,16],[12,25],[12,26]].forEach(function (f) {
            addHoliday(new Date(year, f[0] - 1, f[1]));
        });

        // Easter-based
        var easter = easterSunday(year);
        var goodFriday = new Date(easter); goodFriday.setDate(easter.getDate() - 2);
        var familyDay  = new Date(easter); familyDay.setDate(easter.getDate() + 1);
        addHoliday(goodFriday);
        addHoliday(familyDay);

        _holidayCache[year] = set;
        return set;
    }

    // ── Working-day primitives ────────────────────────────────────────────────
    function pad2(n) { return String(n).padStart(2, '0'); }
    function isoDate(d) {
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function isWorkingDay(d) {
        var day = d.getDay();
        if (day === 0 || day === 6) return false; // Sat/Sun
        return !getSAPublicHolidays(d.getFullYear()).has(isoDate(d));
    }

    // Last working day of the given month. month is 0-indexed JS month.
    // Pass month=12 to get last working day of December (handled via overflow).
    function lastWorkingDayOfMonth(year, month) {
        // new Date(year, month+1, 0) = last calendar day of month (overflow trick)
        var d = new Date(year, month + 1, 0);
        while (!isWorkingDay(d)) { d.setDate(d.getDate() - 1); }
        return d;
    }

    // The working day on or before targetDay of the given month.
    // month is 0-indexed. Used for the PAYE 7th-of-month rule.
    function workingDayOnOrBefore(year, month, targetDay) {
        var d = new Date(year, month, targetDay);
        while (!isWorkingDay(d)) { d.setDate(d.getDate() - 1); }
        return d;
    }

    // ── Obligation Rules ──────────────────────────────────────────────────────
    // compute(periodEnd: Date) → Date   (periodEnd = last day of the filing period)
    var OBLIGATION_RULES = {
        vat_return: {
            label: 'VAT Return (Monthly)',
            rule:  'Last working day of the month following the tax period',
            compute: function (pe) {
                var m = pe.getMonth() + 1, y = pe.getFullYear();
                if (m > 11) { m = 0; y++; }
                return lastWorkingDayOfMonth(y, m);
            }
        },
        paye: {
            label: 'PAYE / EMP201',
            rule:  '7th of the month following the payroll period (or last working day before)',
            compute: function (pe) {
                var m = pe.getMonth() + 1, y = pe.getFullYear();
                if (m > 11) { m = 0; y++; }
                return workingDayOnOrBefore(y, m, 7);
            }
        },
        uif: {
            label: 'UIF',
            rule:  '7th of the month following the payroll period (or last working day before)',
            compute: function (pe) {
                var m = pe.getMonth() + 1, y = pe.getFullYear();
                if (m > 11) { m = 0; y++; }
                return workingDayOnOrBefore(y, m, 7);
            }
        },
        sdl: {
            label: 'SDL',
            rule:  '7th of the month following the payroll period (or last working day before)',
            compute: function (pe) {
                var m = pe.getMonth() + 1, y = pe.getFullYear();
                if (m > 11) { m = 0; y++; }
                return workingDayOnOrBefore(y, m, 7);
            }
        },
        provisional_tax_p1: {
            label: 'Provisional Tax — 1st Period',
            rule:  'Last working day of the 6th month of the tax year',
            compute: function (pe) {
                return lastWorkingDayOfMonth(pe.getFullYear(), pe.getMonth());
            }
        },
        provisional_tax_p2: {
            label: 'Provisional Tax — 2nd Period',
            rule:  'Last working day of the last month of the tax year',
            compute: function (pe) {
                return lastWorkingDayOfMonth(pe.getFullYear(), pe.getMonth());
            }
        },
        tax_return: {
            label: 'Income Tax Return (ITR12)',
            rule:  '31 January of the year following the assessment year (eFiling)',
            compute: function (pe) {
                return workingDayOnOrBefore(pe.getFullYear() + 1, 0, 31);
            }
        }
    };

    // Obligation types that have auto-compute support (used to populate settings modal)
    var CONFIGURABLE_TYPES = [
        { type: 'vat_return',         label: 'VAT Return (Monthly)' },
        { type: 'paye',               label: 'PAYE / EMP201' },
        { type: 'uif',                label: 'UIF' },
        { type: 'sdl',                label: 'SDL' },
        { type: 'provisional_tax_p1', label: 'Provisional Tax — 1st Period' },
        { type: 'provisional_tax_p2', label: 'Provisional Tax — 2nd Period' },
        { type: 'tax_return',         label: 'Income Tax Return (ITR12)' }
    ];

    // ── Deadline computation ──────────────────────────────────────────────────

    // Returns statutory Date or null. periodEnd: Date (last day of filing period).
    function computeStatutoryDeadline(type, periodEnd) {
        var rule = OBLIGATION_RULES[type];
        if (!rule || !periodEnd) return null;
        try { return rule.compute(periodEnd); } catch (e) { return null; }
    }

    // Subtracts offsetDays *working days* from the statutory date.
    // Returns a new Date or null.
    function computePracticeDeadline(statutoryDate, offsetDays) {
        if (!statutoryDate) return null;
        var d = new Date(statutoryDate);
        var remaining = Math.max(0, Math.round(offsetDays || 0));
        while (remaining > 0) {
            d.setDate(d.getDate() - 1);
            if (isWorkingDay(d)) remaining--;
        }
        return d;
    }

    // ── Formatting helpers ────────────────────────────────────────────────────
    var MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    function fmtDate(d) {
        if (!d) return '—';
        return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getFullYear();
    }

    function toISODate(d) {
        if (!d) return '';
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    // Parses a 'YYYY-MM-DD' string to a local midnight Date (avoids UTC offset shift).
    function parseDate(str) {
        if (!str) return null;
        var d = new Date(str + 'T00:00:00');
        return isNaN(d.getTime()) ? null : d;
    }

    // ── Export ────────────────────────────────────────────────────────────────
    global.DeadlineUtils = {
        OBLIGATION_RULES:      OBLIGATION_RULES,
        CONFIGURABLE_TYPES:    CONFIGURABLE_TYPES,
        getSAPublicHolidays:   getSAPublicHolidays,
        isWorkingDay:          isWorkingDay,
        lastWorkingDayOfMonth: lastWorkingDayOfMonth,
        computeStatutoryDeadline: computeStatutoryDeadline,
        computePracticeDeadline:  computePracticeDeadline,
        fmtDate:    fmtDate,
        toISODate:  toISODate,
        parseDate:  parseDate
    };

}(window));
