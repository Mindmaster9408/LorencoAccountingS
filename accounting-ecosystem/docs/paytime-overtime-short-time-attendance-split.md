# Paytime — Overtime, Short Time & Attendance Split
> Created: 2026-03-21
> Status: Implemented and tested

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:
    Paytime payroll calculation display — overtime and short time visibility

- Files/services involved:
    frontend-payroll/js/payroll-engine.js      — calculation engine (calculateFromData)
    frontend-payroll/employee-detail.html      — payslip entry UI + preview modal
    frontend-payroll/js/pdf-branding.js        — PDF payslip generation
    frontend-payroll/payruns.html              — bulk payslip PDF calcFn
    backend/tests/payroll-overtime-shorttime.test.js  — new test suite (26 tests)

- Current behaviour identified:
    Short time silently reduced taxable gross with no visible line item.
    The payslip preview, PDF, and summary panel showed Basic + Overtime → Gross
    but the gross was lower than expected because short time was already applied
    invisibly. This created the PERCEPTION that overtime was being cancelled by
    short time. The calculation engine was mathematically correct throughout.

- Required behaviours to preserve:
    1. Overtime and short time are independent components — neither offsets the other
    2. Payslip calculation works without attendance data (attendance remains optional)
    3. PAYE/UIF/SDL calculations on the correctly adjusted gross — preserved
    4. Finalized payslip freeze (historical snapshot) — preserved and extended
    5. Net-to-gross reverse calculation — unaffected (separate flow)
    6. All existing payroll items (allowances, deductions) — unaffected

- Risk of regression:
    LOW. Engine calculation logic unchanged. Only additions to return value and display.

- Related dependencies:
    Attendance module (attendance.js) feeds overtime/short time upward to payslip storage.
    This flow is unchanged — attendance writes to the same emp_overtime_/emp_short_time_
    keys that the engine reads. Nothing in the attendance-to-payslip path was modified.

- Safe implementation plan:
    1. Add overtimeAmount + shortTimeAmount to engine return value (additive change)
    2. Add short time line to payslip preview modal HTML (display only)
    3. Add short time line to PDF payslip (display only)
    4. Add breakdown rows to summary table (hidden by default, shown when non-zero)
    5. Persist overtimeAmount + shortTimeAmount in historical snapshot
    6. Add shortTimeAmount to payruns.html calcFn for bulk PDF
```

---

## 1. Audit Findings

### What was audited

All files involved in the overtime/short time/attendance/payslip flow:
- `payroll-engine.js` — central calculation engine
- `employee-detail.html` — payslip entry, calculation display, finalization
- `attendance.js` — attendance module and payroll sync
- `pdf-branding.js` — PDF payslip generation
- `payruns.html` — pay run management and bulk export

### What the engine does (and always did correctly)

`calculateFromData()` processes overtime and short time as **completely independent components**:

```
taxableGross = basic_salary
             + regular_inputs (taxable)
             + current_inputs (taxable)
             + overtime_hours × hourly_rate × rate_multiplier   ← independent addition
             - short_time_hours_missed × hourly_rate             ← independent subtraction
```

They do not cancel each other. Both are applied independently to the same `taxableGross` variable. The mathematical result was always correct.

### Root cause of the reported issue

Short time was **invisible on every payslip surface**:

| Surface | Overtime shown | Short time shown |
|---|---|---|
| Summary panel (Payroll Summary card) | Only the total gross (post-ST) | ❌ Not shown |
| Payslip preview modal | ✅ As "Overtime: +R X" | ❌ Not shown |
| PDF payslip | ✅ As "Overtime: +R X" | ❌ Not shown |
| Historical snapshot | Not persisted | ❌ Not persisted |

The user saw: `Basic R10,000 + Overtime R1,000 → expected Gross R11,000`
The system showed: `Gross: R10,200` (because R800 short time was silently subtracted)
The user concluded: "Overtime is being eaten / cancelled"

The perception was wrong but completely understandable given the missing display.

---

## 2. Why Overtime and Short Time Must Be Separate

These are **two distinct payroll events** that may both occur in the same period:

- **Overtime** — employee worked extra hours beyond the standard day/week. This is an **earnings addition**. Example: employee worked 3 Saturdays = +24 hours @ 1.5x.
- **Short time** — employee missed hours they were contracted to work. This is an **earnings reduction**. Example: employee was sick for 2 days without pay = -16 hours @ 1.0x.

An employee who worked overtime on some days and was absent on other days within the same month must receive **both** correctly applied. Collapsing them into a net hours figure would be wrong:

- It would obscure the audit trail (what did the employee actually earn?)
- It would misrepresent the payroll component breakdown (required for IRP5 etc.)
- It could result in incorrect PAYE calculation if gross is understated or overstated

---

## 3. Attendance vs Payslip Responsibility Split

### The two layers

```
ATTENDANCE LAYER (optional operational input)
    ↓
    Tracks daily in/out, hours per day, absences
    Calculates: overtime hours (hours > 8/day), absent days
    Writes to: emp_overtime_{companyId}_{empId}_{period}
               emp_short_time_{companyId}_{empId}_{period}
    ↓ (one-way push — user initiates "Apply to Payroll")

PAYSLIP LAYER (primary payroll calculation surface)
    Reads from: emp_overtime_* and emp_short_time_* storage
    Also accepts: direct manual entry by user (no attendance required)
    Calculates: gross, taxableGross, PAYE, UIF, SDL, net
    Produces: payslip, PDF, finalized historical snapshot
```

### Direction of flow

`Attendance → Payslip` (attendance can assist payslip, never the reverse)

The payslip does NOT depend on attendance. The user can:
1. Skip attendance entirely
2. Enter overtime hours directly on the payslip ("+ Add Overtime")
3. Enter short time hours directly on the payslip ("+ Add Short Time")
4. Calculate and finalize payroll

Attendance is an optional layer that can auto-populate these same fields if the client tracks daily attendance.

### Attendance is NOT mandatory

The "Pay for Additional Hours" card in the payslip UI expands to show Overtime, Short Time, and Paid at Different Rate sections. These accept direct monthly input — no daily attendance required.

---

## 4. Overtime Calculation Logic

### Formula

```
overtimeAmount = Σ (hours × hourly_rate × rate_multiplier)
hourly_rate    = basic_salary / 173.33
```

Where `173.33 = 21.67 working days/month × 8 hours/day` (standard SA working hours divisor).

### Rate multipliers

| Code | Multiplier | Use case |
|---|---|---|
| Standard | 1.5x | Time and a half — weekday/Saturday overtime |
| Double time | 2.0x | Sunday or public holiday |
| 2.5x | 2.5x | Extended public holiday or by agreement |
| Triple time | 3.0x | Exceptional circumstances by agreement |

Default: 1.5x. Each overtime entry can have its own multiplier.

### Multiple entries

Multiple overtime records per period are supported (e.g. one entry per weekend worked). All entries are summed. Each entry can have a different rate multiplier.

### Tax treatment

Overtime is **always taxable** — it adds directly to `taxableGross` and is subject to PAYE at the employee's marginal rate.

---

## 5. Short Time Calculation Logic

### Formula

```
shortTimeAmount = Σ (hours_missed × hourly_rate × 1.0)
hourly_rate     = basic_salary / 173.33
```

Short time is always at **1.0x** (straight hourly deduction). There is no multiplier penalty.

### What short time represents

Hours the employee was contracted to work but did not. Common causes:
- Unpaid sick leave (exceeds sick leave balance)
- Unpaid absence without authorisation
- Partial days not worked
- Formal short-time working arrangements

### Effect on pay

Short time **reduces taxable gross** — the employee is not paid for hours not worked. It is treated as an earnings reduction, not a separate "deduction type" (it adjusts the gross before PAYE is calculated).

### Display on payslip

Short time now appears as a **negative line item in the Earnings section** of the payslip (both modal preview and PDF), shown in red:

```
EARNINGS
  Basic Salary          R 20,000.00
  Overtime              R  1,153.80
  Short Time           -R    461.52
  ─────────────────────────────────
  TOTAL GROSS           R 20,692.28
```

---

## 6. Attendance-to-Payslip Auto-Population

When attendance is used and the user clicks "Apply to Payroll" in the attendance module:

```javascript
// attendance.js — applyToPayroll()
// Overtime: hours per day exceeding 8 hours
if (s.overtime > 0) {
    // Writes to: emp_overtime_{companyId}_{empId}_{period}
    // Removes existing AUTO entries first (idempotent)
    // description: 'AUTO: From Attendance'
}

// Short time: absent days × 8 hours
if (s.absences > 0) {
    // Writes to: emp_short_time_{companyId}_{empId}_{period}
    // Removes existing AUTO entries first (idempotent)
    // reason: 'AUTO: Absences from Attendance'
    // hours_missed = absent_days × 8
}
```

These writes use the same storage keys that the payslip engine reads. The payslip UI will then show the auto-populated entries alongside any manually entered entries.

AUTO-entries and manual entries can coexist. AUTO-entries are identified by their description/reason prefix so they can be cleanly replaced on re-apply.

---

## 7. UX Simplification Goals

### Primary workflow (no attendance)

1. Open employee payslip (employee-detail.html)
2. Check/set period
3. Expand "Pay for Additional Hours" card if needed
4. Click "+ Add" under Overtime → enter hours + multiplier
5. Click "+ Add" under Short Time → enter hours missed
6. Click "Calculate Payslip"
7. See summary with breakdown: Gross Salary (with Overtime/Short Time sub-rows), PAYE, UIF, Net
8. Preview or download payslip
9. Finalize

No attendance records required. No daily breakdown required.

### With attendance

1. Enter daily attendance in Attendance module
2. Click "Apply to Payroll"
3. Open payslip — overtime and short time entries are pre-populated from attendance
4. Review, adjust if needed, calculate, finalize

### Summary panel transparency

The Payroll Summary card now shows overtime and short time as sub-rows beneath Gross Salary when non-zero:

```
Gross Salary:          R 20,692.28
  ↳ Overtime:    [green] R 1,153.80
  ↳ Short Time:  [red]  -R   461.52
PAYE:                   R  2,877.00
UIF:                    R    177.12
Deductions:             R      0.00
NET SALARY:             R 17,638.16
```

This eliminates the "where did my overtime go?" confusion.

---

## 8. Files Changed

### `frontend-payroll/js/payroll-engine.js`
- `calculateFromData()`: tracks `overtimeAmount` and `shortTimeAmount` during their respective loops
- Both are now returned in the result object (alongside existing gross, paye, uif, net, etc.)
- Added CommonJS export guard (`if (typeof module !== 'undefined')`) for testability

### `frontend-payroll/employee-detail.html`
- **Summary table HTML**: added `summaryOvertimeRow` and `summaryShortTimeRow` rows (hidden by default, shown when non-zero)
- **`updateCalculation()`**: shows/updates the OT and ST sub-rows from `calc.overtimeAmount` / `calc.shortTimeAmount`
- **Frozen payslip display path**: same OT/ST sub-row logic applied when loading from historical snapshot
- **`finalizePayslip()`**: now persists `overtimeAmount` and `shortTimeAmount` in the historical snapshot
- **`getPayslipData()`**: computes `shortTimeAmount` and attaches to `calc.shortTimeAmount` for preview + PDF
- **`previewPayslip()`**: adds "Short Time" as a visible red negative line in the EARNINGS section of the modal payslip

### `frontend-payroll/js/pdf-branding.js`
- `generatePayslipPDF()`: after the Overtime line, adds Short Time line in red (negative amount) if `calc.shortTimeAmount > 0`

### `frontend-payroll/payruns.html`
- `calcFn` (used for bulk PDF generation): adds `shortTimeAmount` calculation parallel to the existing `overtimeAmount` calculation

### `backend/tests/payroll-overtime-shorttime.test.js` *(new)*
- 26 tests covering: OT only, ST only, both together (non-cancellation), no data, return values, attendance optionality, rate multipliers, zero floor, regression

---

## 9. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Short time — payslip display position
- Dependency: Design decision
- What was done now: Short time shown as negative line in EARNINGS section
- What still needs to be checked:
    Some payroll practitioners prefer short time in a separate "ADJUSTMENTS" section.
    Current implementation (negative in EARNINGS) is the most common SA practice.
    Can be changed if clients/accountants request it — isolated to previewPayslip()
    and pdf-branding.js earnings block.
- Risk if wrong: Visual/display only — no calculation impact
- Recommended next review point: First client feedback on payslip layout
```

```
FOLLOW-UP NOTE
- Area: Attendance — partial day (less than 8 hours worked, not absent)
- Dependency: attendance.js applyToPayroll()
- What was done now: Absence = full days × 8 hours
- What still needs to be checked:
    Partial days (e.g. employee worked 5 of 8 hours) are not captured as short time.
    Current attendance model only tracks full absent days, not partial hour deficits.
    If client needs partial-day short time, attendance module would need hour-level tracking.
- Risk if wrong: Partial day short time must be entered manually on the payslip
- Recommended next review point: When attendance is upgraded to hour-level tracking
```

```
FOLLOW-UP NOTE
- Area: Historical snapshot — backward compatibility
- Dependency: Existing finalized payslips
- What was done now: New snapshot saves overtimeAmount and shortTimeAmount
- What still needs to be checked:
    Existing finalized payslips (saved before this fix) will have
    snap.overtimeAmount = undefined → defaults to 0 in the display path.
    This means previously finalized payslips will not show OT/ST breakdown rows
    in the summary (safe — no breakdown shown, correct totals preserved).
- Risk if wrong: None. The gross/net/paye values in the snapshot are correct and unchanged.
- Recommended next review point: Not required — graceful fallback in place
```

---

## 10. Test Coverage

```
backend/tests/payroll-overtime-shorttime.test.js — 26 tests, all passing

A. Overtime only (3 tests)
B. Short time only (3 tests)
C. Both in same period — non-cancellation (3 tests)
D. Neither present (2 tests)
E. Engine return values (4 tests)
F. Attendance optionality (2 tests)
G. Rate multiplier accuracy (2 tests)
H. Zero floor (2 tests)
J. Regression — existing flows (5 tests)
```

Run with: `cd accounting-ecosystem/backend && npx jest tests/payroll-overtime-shorttime.test.js`
