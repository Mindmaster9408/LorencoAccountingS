'use strict';

/**
 * ============================================================================
 * Attendance → payroll proposal — Fase 8 (spec 05 PI-08 option b, PI-09; V1)
 * ============================================================================
 * Turns one employee's attendance for a month into a PROPOSAL of overtime and
 * short-time rows. Nothing reaches the payslip until a payroll user approves it
 * (POST /api/payroll/attendance/apply). Pure — no DB access.
 *
 * Rules (BCEA defaults — the payroll user reviews every proposal):
 *   - Scheduled hours per weekday come from the employee's work schedule
 *     (employee_work_schedule), default Mon–Fri × hours_per_day (8).
 *   - Overtime (1.5×) = hours worked beyond the day's scheduled hours, plus
 *     ordinary hours beyond 45 in a week (BCEA s9/s10). Not "> 8 hours a day".
 *   - Sunday not in the schedule: all hours at 2× (BCEA s16). Sunday in the
 *     schedule: normal day.
 *   - Public holiday worked: an extra 1× for the hours worked (BCEA s18 — the
 *     monthly salary already pays the holiday itself).
 *   - Absent = a scheduled working day (up to today, inside employment) with no
 *     attendance, or status 'absent' — not a public holiday, not approved leave.
 *     Short time = that day's scheduled hours. Partial days are reported only.
 * ============================================================================
 */

const DAY_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };

/** Easter Sunday (Gregorian, anonymous algorithm), UTC date. */
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** South African public holidays for a year (Public Holidays Act; Sunday → Monday). */
function saPublicHolidays(year) {
  const fixed = ['01-01', '03-21', '04-27', '05-01', '06-16', '08-09', '09-24', '12-16', '12-25', '12-26']
    .map(md => new Date(`${year}-${md}T00:00:00Z`));
  const easter = easterSunday(year);
  const set = new Set();
  fixed.forEach(d => { set.add(iso(d)); if (d.getUTCDay() === 0) set.add(iso(addDays(d, 1))); });
  set.add(iso(addDays(easter, -2)));   // Good Friday
  set.add(iso(addDays(easter, 1)));    // Family Day
  return set;
}

/** { 0..6: scheduled hours } from employee_work_schedule (same reading as the engine). */
function scheduleMap(schedule) {
  const hpd = parseFloat(schedule && schedule.hours_per_day) || 8;
  let days = schedule && Array.isArray(schedule.working_days) && schedule.working_days.length ? schedule.working_days : null;
  if (!days) days = ['MON', 'TUE', 'WED', 'THU', 'FRI'].map(d => ({ day: d, enabled: true, type: 'normal' }));
  const map = {};
  days.forEach(sd => {
    const idx = DAY_KEYS.indexOf(sd.day);
    if (sd.enabled && idx >= 0) map[idx] = (sd.type === 'partial' && sd.partial_hours != null) ? parseFloat(sd.partial_hours) : hpd;
  });
  return map;
}

/**
 * @param {object} p
 *   periodKey 'YYYY-MM'; employee { hire_date, termination_date };
 *   schedule { hours_per_day, working_days }; records [{ attendance_date, hours_worked, status }];
 *   leave [{ start_date, end_date, status }]; today 'YYYY-MM-DD'
 * @returns {object} proposal
 */
function computeAttendanceProposal(p) {
  const [y, m] = p.periodKey.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const today = p.today || iso(new Date());
  const hire = p.employee && p.employee.hire_date ? String(p.employee.hire_date).slice(0, 10) : null;
  const term = p.employee && p.employee.termination_date ? String(p.employee.termination_date).slice(0, 10) : null;
  const sched = scheduleMap(p.schedule);
  const holidays = saPublicHolidays(y);

  const byDate = {};
  (p.records || []).forEach(r => { byDate[String(r.attendance_date).slice(0, 10)] = r; });
  const leaveDates = new Set();
  (p.leave || []).filter(l => !l.status || l.status === 'approved').forEach(l => {
    for (let d = new Date(`${String(l.start_date).slice(0, 10)}T00:00:00Z`); iso(d) <= String(l.end_date).slice(0, 10); d = addDays(d, 1)) {
      leaveDates.add(iso(d));
    }
  });

  const out = {
    period_key: p.periodKey,
    worked_hours: 0, scheduled_hours: 0,
    overtime_hours: 0, sunday_hours: 0, public_holiday_hours: 0, weekly_excess_hours: 0,
    absent_days: [], leave_days: [], partial_days: [], short_time_hours: 0
  };
  const weekOrdinary = {};

  for (let d = first; d <= last; d = addDays(d, 1)) {
    const ds = iso(d);
    if ((hire && ds < hire) || (term && ds > term)) continue;
    const dow = d.getUTCDay();
    const scheduled = sched[dow] || 0;
    const rec = byDate[ds];
    const status = rec && rec.status;
    const worked = rec && status !== 'absent' && status !== 'leave' ? (parseFloat(rec.hours_worked) || 0) : 0;
    const isHoliday = holidays.has(ds);
    const onLeave = leaveDates.has(ds) || status === 'leave';
    out.worked_hours += worked;
    if (ds <= today && !isHoliday) out.scheduled_hours += scheduled;

    if (worked > 0) {
      if (dow === 0 && !scheduled) {
        out.sunday_hours += worked;                    // BCEA s16: 2×
      } else if (isHoliday) {
        out.public_holiday_hours += worked;            // BCEA s18: extra 1×
      } else {
        out.overtime_hours += Math.max(worked - scheduled, 0);
        const wk = iso(addDays(d, -((dow + 6) % 7)));  // Monday of the week
        weekOrdinary[wk] = (weekOrdinary[wk] || 0) + Math.min(worked, scheduled);
        if (scheduled && worked < scheduled) out.partial_days.push({ date: ds, worked: r2(worked), scheduled });
      }
    } else if (scheduled > 0 && ds <= today && !isHoliday) {
      if (onLeave) out.leave_days.push(ds);
      else { out.absent_days.push(ds); out.short_time_hours += scheduled; }
    }
  }
  Object.values(weekOrdinary).forEach(h => { out.weekly_excess_hours += Math.max(h - 45, 0); });

  ['worked_hours', 'scheduled_hours', 'overtime_hours', 'sunday_hours', 'public_holiday_hours', 'weekly_excess_hours', 'short_time_hours']
    .forEach(k => { out[k] = r2(out[k]); });

  const ot = r2(out.overtime_hours + out.weekly_excess_hours);
  out.overtime_rows = [
    ot > 0 && { hours: ot, rate_multiplier: 1.5, description: 'Attendance: overtime' },
    out.sunday_hours > 0 && { hours: out.sunday_hours, rate_multiplier: 2, description: 'Attendance: Sunday work' },
    out.public_holiday_hours > 0 && { hours: out.public_holiday_hours, rate_multiplier: 1, description: 'Attendance: public holiday worked' }
  ].filter(Boolean);
  out.short_time_rows = out.short_time_hours > 0
    ? [{ hours_missed: out.short_time_hours, description: `Attendance: ${out.absent_days.length} absent day(s)` }]
    : [];
  out.has_changes = out.overtime_rows.length > 0 || out.short_time_rows.length > 0;
  return out;
}

/** Hours between two 'HH:MM' times (overnight allowed), 2 decimals. */
function hoursBetween(clockIn, clockOut) {
  if (!clockIn || !clockOut) return 0;
  const [ih, im] = String(clockIn).split(':').map(Number);
  const [oh, om] = String(clockOut).split(':').map(Number);
  if ([ih, im, oh, om].some(isNaN)) return 0;
  let mins = (oh * 60 + om) - (ih * 60 + im);
  if (mins <= 0) mins += 1440;
  return r2(mins / 60);
}

module.exports = { computeAttendanceProposal, saPublicHolidays, scheduleMap, hoursBetween };
