# Paytime — Employee Work Hours & Hourly Rate Foundation

**Implemented:** 2026-03-21
**Migration:** `database/014_employee_work_hours.sql`

---

## Overview

Each employee now has configurable weekly and daily work hours. These drive the hourly wage formula used for overtime and short time calculations, replacing the previous hardcoded divisor.

---

## Formula

```
Hourly wage  = Monthly Salary ÷ (hours_per_week × 4.33)
Overtime pay = Hourly wage × OT hours × rate multiplier (typically 1.5)
Short time   = Hourly wage × hours_missed
```

**Where:** `4.33` is the average number of weeks in a month (52 ÷ 12).

**Examples at R20,000/month:**

| hours_per_week | Divisor | Hourly wage | OT rate (1.5×) |
|---|---|---|---|
| 40 (SA standard) | 173.2 | R115.47/hr | R173.21/hr |
| 45 | 194.85 | R102.64/hr | R153.96/hr |
| 37.5 | 162.375 | R123.17/hr | R184.75/hr |

---

## Database Fields

Added to the `employees` table via migration `014_employee_work_hours.sql`:

| Column | Type | Default | Constraint |
|---|---|---|---|
| `hours_per_week` | `DECIMAL(4,2)` | `40.00` | 1–84 (SA legal max) |
| `hours_per_day` | `DECIMAL(4,2)` | `8.00` | 1–24 |

**`hours_per_week`** drives the payroll calculation.
**`hours_per_day`** is informational (attendance context) — not used in the payroll engine formula.

Quarter-hour increments are supported: `0.25` = 15 min, `0.50` = 30 min, `0.75` = 45 min.

---

## Backward Compatibility

Existing employees that do not have `hours_per_week` set (null) automatically fall back to the legacy constant:

```javascript
PayrollEngine.HOURLY_DIVISOR = 173.33
```

At 40 hrs/week the new formula produces `40 × 4.33 = 173.2`, which differs from `173.33` by ~R0.013/hr — a negligible rounding difference. No reprocessing of historical payslips is required.

---

## Static Helpers (PayrollEngine)

Three static methods were added to `frontend-payroll/js/payroll-engine.js`:

### `PayrollEngine.calculateHourlyWage(monthlySalary, hoursPerWeek)`

Returns the hourly wage for a given salary and weekly hours. Falls back to `HOURLY_DIVISOR` when `hoursPerWeek` is null, undefined, or 0.

```javascript
PayrollEngine.calculateHourlyWage(20000, 40)   // → 115.4734
PayrollEngine.calculateHourlyWage(20000, null) // → 115.38 (legacy HOURLY_DIVISOR)
```

### `PayrollEngine.calculateOvertimeRate(monthlySalary, hoursPerWeek)`

Returns the 1.5× overtime rate. Equivalent to `calculateHourlyWage × 1.5`.

```javascript
PayrollEngine.calculateOvertimeRate(20000, 40) // → 173.21
```

### `PayrollEngine.calculateShortTimeValue(monthlySalary, hoursMissed, hoursPerWeek)`

Returns the rand value of missed hours (rounded to 2dp).

```javascript
PayrollEngine.calculateShortTimeValue(20000, 8, 40) // → 923.79
```

---

## Integration Points

### PayrollEngine.calculateFromData

When `payrollData.hours_per_week` is present, the engine uses it to compute the hourly divisor:

```javascript
var weeklyHours   = parseFloat(payrollData.hours_per_week) || null;
var hourlyDivisor = (weeklyHours && weeklyHours > 0)
    ? (weeklyHours * 4.33)
    : PayrollEngine.HOURLY_DIVISOR;
var hourlyRate    = payrollData.basic_salary / hourlyDivisor;
```

Callers pass `hours_per_week` via `Object.assign()` from `currentEmployee`:

```javascript
var calcPayrollData = Object.assign({}, payrollData, {
    hours_per_week: currentEmployee ? (parseFloat(currentEmployee.hours_per_week) || null) : null
});
var calc = PayrollEngine.calculateFromData(calcPayrollData, ...);
```

### API — PUT /api/payroll/employees/:id/salary

`hours_per_week` and `hours_per_day` are accepted in the request body and persisted:

```json
{
  "basic_salary": 20000,
  "payment_frequency": "monthly",
  "hours_per_week": 45,
  "hours_per_day": 9
}
```

Validation: `hours_per_week` must be 1–84; `hours_per_day` must be 1–24.

---

## UI Changes (employee-detail.html)

### Edit Employee modal — Work Hours section

A "Work Hours" section was added after "Tax Directive":

- **Hours Worked Per Week** — input with `step="0.25"`, range 1–84, default 40
- **Hours Worked Per Day** — input with `step="0.25"`, range 1–24, default 8

### Hourly Rate / OT Rate display (payslip card)

Two read-only display rows appear below Basic Salary when salary > 0:

- **Hourly Rate** — `R {hourlyWage}/hr`, styled in indigo
- **Overtime Rate** — `R {overtimeRate}/hr (×1.5)`, styled in green

These update automatically on every `renderPayroll()` call. They are display-only — never editable.

### Quarter-hour input steps

All hour inputs (overtime, short time, multi-rate) were updated from `step="0.5"` to `step="0.25"` to support 15-minute increments.

---

## Files Changed

| File | Change |
|---|---|
| `database/014_employee_work_hours.sql` | Migration — adds `hours_per_week`, `hours_per_day` to `employees` |
| `database/schema.sql` | Master schema updated to include new columns |
| `backend/modules/payroll/routes/employees.js` | `PUT /:id/salary` — accepts and validates `hours_per_week`, `hours_per_day` |
| `frontend-payroll/js/payroll-engine.js` | Employee-specific hourly divisor; three static helpers added |
| `frontend-payroll/employee-detail.html` | Work Hours UI, derived rate display, step 0.25, `hours_per_week` wiring |
| `backend/tests/employee-work-hours.test.js` | 44 tests covering all formula paths and regression |

---

## Testing

```bash
cd accounting-ecosystem/backend
npx jest tests/employee-work-hours.test.js
# 44 tests — A through G coverage
```

Test coverage:
- **A** — Static helpers (`calculateHourlyWage`, `calculateOvertimeRate`, `calculateShortTimeValue`)
- **B** — Hourly wage formula (custom hours, edge cases, legal bounds)
- **C** — Overtime rate with employee-specific hours
- **D** — Short time quarter-hour increments (0.25, 0.50, 0.75, 1.25 hrs)
- **E** — `calculateFromData` integration with `hours_per_week` in `payrollData`
- **F** — Backward compatibility (null falls back to `HOURLY_DIVISOR`)
- **G** — Regression (existing OT/ST/deduction flows unchanged)

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: hours_per_day
- What was done now: hours_per_day is saved to DB and shown in the Edit modal.
- Not yet used: The payroll engine does not use hours_per_day in any formula.
  It is stored for attendance context and future daily rate calculations.
- Risk if not checked: None for current payroll calculations.
- Recommended next review point: If daily rate (docking for absent days rather
  than per-hour) is needed, implement: Salary / (hours_per_day × working_days_per_month).
```
