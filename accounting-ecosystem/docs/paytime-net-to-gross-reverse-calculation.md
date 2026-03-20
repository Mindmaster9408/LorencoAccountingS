# Paytime — Net-to-Gross Reverse Calculation

> Implemented: March 2026
> Files: `frontend-payroll/js/payroll-engine.js`, `frontend-payroll/net-to-gross.html`
> Area: Paytime — salary planning tool

---

## CHANGE IMPACT NOTE

- **Area being changed:** PayrollEngine (additive new function), new standalone page
- **Files/services involved:**
  - `frontend-payroll/js/payroll-engine.js` — new `calculateNetToGross()` method
  - `frontend-payroll/net-to-gross.html` — new UI page
  - All sidebar pages in `frontend-payroll/` — nav link added
- **Current behaviour identified:** No reverse calculation existed. To determine what basic salary to set, users had to manually trial-and-error in the pay run.
- **Required behaviours to preserve:** All existing `calculateFromData()`, `calculateMonthlyPAYE()`, `calculateMonthlyPAYE_YTD()`, `calculateUIF()` logic is completely unchanged. The new function is purely additive.
- **Risk of regression:** None. `calculateNetToGross()` calls `calculateFromData()` as a black box — it does not alter any internal calculation logic.
- **Safe implementation plan:** Pure function added at end of PayrollEngine object. No backend changes. No data mutations. Page is standalone.

---

## 1. What Net-to-Gross Means

A business owner tells the accountant: *"I want Johan to take home R20,000 per month after tax."*

**The problem:** PAYE is non-linear (bracketed), UIF is capped, and fixed deductions (medical aid, pension) reduce net pay. It is not possible to determine the required gross/basic by simple arithmetic.

**The solution:** Binary search (bisection) over the basic salary space, using the existing `calculateFromData()` engine on each trial, until the resulting net converges to the target within R0.01.

---

## 2. Algorithm: Binary Search (Bisection)

### Why bisection works here

Net pay is a **monotonically increasing function** of basic salary:
- As basic increases, gross increases
- As gross increases, PAYE increases (but less than 1:1 — marginal rate is always < 100%)
- UIF increases up to its cap then stays flat
- Deductions are fixed (independent of basic)

Therefore: net increases strictly with basic. A unique solution exists, and bisection is guaranteed to converge.

### Algorithm

```
lo = 0, hi = basicSalaryHi (default R500,000), tolerance = R0.01

while iterations < 100:
    mid = (lo + hi) / 2
    result = calculateFromData(basic=mid, ...known items...)
    diff = result.net - targetNet
    if |diff| ≤ 0.01: break
    if diff < 0: lo = mid   (mid is too low, search higher)
    if diff > 0: hi = mid   (mid is too high, search lower)

finalBasic = round2((lo + hi) / 2)
```

Typically converges in 30–50 iterations.

### Edge cases handled

| Scenario | Result |
|---|---|
| Basic = 0 and items already generate net ≥ target | `success=true`, `basic=0`, with explanatory note |
| Target net exceeds net at hi limit | `success=false`, descriptive error + suggestion to increase limit |
| `targetNet ≤ 0` | `success=false`, immediate validation error |

---

## 3. `calculateNetToGross()` — API Reference

**Location:** `frontend-payroll/js/payroll-engine.js` — added to `PayrollEngine` object

### Parameters

```javascript
PayrollEngine.calculateNetToGross({
    targetNet:        20000,          // Required. Amount to land in bank (R).
    items:            [               // Optional. Known items EXCLUDING basic salary.
        { type: 'income',     is_taxable: true,  amount: 2000 },  // Taxable allowance
        { type: 'income',     is_taxable: false, amount: 500  },  // Non-taxable (reimbursement)
        { type: 'deduction',  is_taxable: false, amount: 800  },  // Medical aid, pension, etc.
    ],
    employeeOptions: {
        age:            35,   // Optional. ≥65 → secondary rebate; ≥75 → tertiary rebate.
        medicalMembers: 2,    // Optional. Medical credit (Section 6A) applied to PAYE.
        taxDirective:   0,    // Optional. If >0, PAYE = gross × rate (bypasses brackets).
    },
    period:           '2026-03',   // Optional. 'YYYY-MM' → selects correct tax year tables.
    ytdData:          null,        // Optional. { ytdTaxableGross, ytdPAYE } for YTD method.
    basicSalaryHi:    500000       // Optional. Upper bound for bisection (default R500,000).
})
```

### Return value

```javascript
{
    success:       true,          // false if target is unreachable or invalid
    basic:         18250.42,      // Required basic salary
    gross:         20750.42,      // Total gross (basic + allowances)
    taxableGross:  20250.42,      // Gross used for PAYE/UIF base
    paye:          2345.67,       // PAYE withheld
    uif:           177.12,        // UIF (employee) — capped at R177.12
    sdl:           207.50,        // SDL (employer liability, informational)
    deductions:    800.00,        // Sum of deduction items
    net:           20000.01,      // Actual net (≈ targetNet, within R0.01)
    medicalCredit: 364.00,        // Monthly medical credit applied
    iterations:    42,            // Number of bisection iterations
    error:         undefined,     // Present when success=false
    note:          undefined,     // Present for edge-case successes (basic=0)
}
```

---

## 4. Item Types

| `type` value | `is_taxable` | Effect on calculation |
|---|---|---|
| `'income'` (or any non-`'deduction'`) | `true` | Added to taxable gross → increases PAYE base |
| `'income'` (or any non-`'deduction'`) | `false` | Added to gross but NOT taxable gross → does not increase PAYE |
| `'deduction'` | *(ignored)* | Subtracted from net pay only (fixed deduction) |

---

## 5. Net-to-Gross UI Page (`net-to-gross.html`)

### Location

`frontend-payroll/net-to-gross.html` — accessible from all payroll sidebar pages under `🔁 Net-to-Gross`.

### Workflow

1. **Target Net Pay** — enter the desired net amount (e.g. R20,000)
2. **Pay Period** — enter `YYYY-MM` to auto-select the correct SA tax year brackets
3. **Employee Tax Options** — optionally enter age, medical members, tax directive
4. **Known Items** — add any fixed allowances or deductions that will always apply:
   - Taxable Earning (e.g. commission, bonus)
   - Non-Taxable Earning (e.g. reimbursements, travel at fixed rate)
   - Deduction (e.g. medical aid contribution, pension, garnishee)
5. **Calculate** — the tool displays the required basic salary and full deduction breakdown
6. **Apply to Employee** — optionally select an employee and apply the basic salary directly to their payroll record in localStorage. The next pay run will use this value.

### Result display

- Summary cards: Required Basic, Total Gross, PAYE, UIF, Other Deductions, Actual Net
- Full line-by-line breakdown table
- Tax year and medical credit verification bar
- Net vs. target verification chip (green ✓ match / amber ⚠ if >R0.02 difference)

---

## 6. Integration with Existing Payroll Flow

### Calculation engine

`calculateNetToGross()` calls `calculateFromData()` internally — the same function used by all pay runs. Any Tax Config overrides (loaded from Supabase KV into the PayrollEngine object at startup) automatically apply because the function delegates to `getTablesForPeriod()`.

### Apply to Employee

Clicking "Apply to Employee" in the UI:
1. Reads `emp_payroll_{companyId}_{empId}` from localStorage
2. Updates `basic_salary` field
3. Writes back to localStorage
4. Writes an audit log entry via `AuditTrail.log()`

This does NOT create a payslip or pay run entry — it only updates the payroll setup record. The accountant then proceeds to Pay Runs to run the payroll normally.

### YTD method (optional)

If `ytdData` is provided (`{ ytdTaxableGross, ytdPAYE }`), the bisection will use `calculateMonthlyPAYE_YTD()` for each trial — giving a result that accounts for PAYE already withheld earlier in the tax year. This is important when using the SARS run-to-date method mid-year.

The UI does not currently expose YTD inputs (it is a planning tool). The API function supports it for programmatic use.

---

## 7. SA Tax Rules Applied

All tax rules come from the existing PayrollEngine — this function adds no new tax logic.

| Rule | Source |
|---|---|
| PAYE brackets (2026/2027 default) | `PayrollEngine.BRACKETS` |
| Historical bracket lookup | `PayrollEngine.getTablesForPeriod(period)` |
| Primary/Secondary/Tertiary rebates | `calculateAnnualPAYE()` |
| Medical Section 6A credit | `calculateMedicalCredit()` |
| UIF cap (R177.12/month, 1%) | `calculateUIF()` |
| SDL (1% of gross, employer) | `calculateSDL()` |
| Tax directive override | `calculateMonthlyPAYE()` option |

---

## 8. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: YTD exposure in Net-to-Gross UI
- What was done: YTD params are supported in calculateNetToGross() API
- Not yet done: The net-to-gross.html UI does not expose ytdData inputs
- Why: As a planning tool, the simple monthly-method result is sufficient.
  The accountant can check the actual PAYE after running the pay run.
- Risk if not done: For employees mid-tax-year with variable prior income,
  the calculated PAYE may differ slightly from the actual run-to-date PAYE.
- Recommended: Add a YTD section (collapsed by default) when accountants
  request more precision for mid-year reverse calculations.

FOLLOW-UP NOTE
- Area: PDF/Print output for Net-to-Gross result
- What was done: Screen display only
- Not yet done: Export to PDF or printable letter for client
- Risk if not done: Low — this is a planning tool, not a formal payslip
- Recommended: Add a browser print stylesheet or jsPDF export if clients
  request a "gross-up letter" for employment contracts.

FOLLOW-UP NOTE
- Area: Apply to Employee — server persistence
- What was done: Basic salary written to localStorage emp_payroll_ record
- Risk: If the employee's payroll data is stored server-side (Supabase),
  writing only to localStorage will cause it to be overwritten on next load
- Recommended: Audit whether emp_payroll_ records are server-backed or
  purely localStorage. If server-backed, the apply flow must POST to API.
```

---

## 9. Testing Checklist

**Basic calculation:**
- [ ] Enter target net R15,000, no items, no options → verify result.basic + PAYE + UIF ≈ R15,000 net
- [ ] Enter target net R50,000 → verify result is in the correct PAYE bracket
- [ ] Enter age=65 → verify secondary rebate reduces PAYE vs age=35
- [ ] Enter medical members=3 → verify medical credit reduces PAYE
- [ ] Enter tax directive=25 → verify PAYE = gross × 25% (bypasses brackets)
- [ ] Enter period=2025-01 → verify historical 2024/2025 tax tables are used

**Items:**
- [ ] Add a taxable earning R2,000 → gross and PAYE increase; net approaches target
- [ ] Add a non-taxable earning R2,000 → gross increases; PAYE unchanged vs no item
- [ ] Add a deduction R500 → basic increases to compensate; deductions shown in table

**Edge cases:**
- [ ] Target net = 0 → error message shown, no crash
- [ ] Target net > R100,000 (above R500k basic cap at default) → "search range exceeded" error
- [ ] Increase search limit to R2,000,000 → very high target net now resolves
- [ ] Large deduction that makes net negative at basic=0 → handled gracefully

**Apply to Employee:**
- [ ] Click Apply → modal opens with employee list
- [ ] Select employee, click Apply → success message, localStorage updated
- [ ] Reload pay run for that employee → basic salary shows the applied value

**Regression — existing pay runs:**
- [ ] Open a pay run after using this tool → no changes to any calculated payslip
- [ ] calculateFromData() still returns same results as before for same inputs
```
