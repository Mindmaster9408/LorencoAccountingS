# PAYTIME — Known Pre-existing Test Failures

**File:** `tests/teach-paytime.test.js`
**Service under test:** `sean/teach-paytime-service.js` → `TeachPaytimeService.parseInput()`
**Documented:** 2026-06-04
**Status:** Deferred — post-rollout work. Do not fix during the current KV→DB payroll items migration.

---

## TEST-TP-04

**Test:** `Minimum valid extraction requires only item_name`

**Input:**
```
Item Name
Commission
```

**Expected:** `result.items[0].item_name === 'Commission'`
**Actual:** `result.items[0].item_name === 'Item Name'`

### Root cause

The parser's header-detection only runs inside `parseCsvLines` (comma-delimited) and
`parseTableLines` (pipe-delimited). When input has no commas and no pipes, `detectFormat`
classifies it as `'bullet'` and hands it to `parseBulletLines`.

`parseBulletLines` has no header-detection logic — it treats every non-empty line as a
potential item name. So the literal string `"Item Name"` (the column header) is extracted
as the first item, and `"Commission"` as the second. The test expects only `"Commission"`
to appear (i.e., the header line should be skipped).

**Affected code:** `parseBulletLines()` in `sean/teach-paytime-service.js` — no header
skip for lines that look like column names (`/^item\s*name$/i`, etc.).

### Why unrelated to the PAYE/UIF session

This test exercises `TeachPaytimeService.parseInput()`, a Sean text-parsing utility for
teaching payroll items via pasted text. It has no involvement in:
- PAYE calculation logic (`payroll-engine.js`, `PayrollCalculationService.js`)
- UIF calculation logic
- `payroll_items_master` DB reads/writes
- The KV→DB migration completed in commits `32ac9e5` and `83f45c5`

It was failing in identical form on clean `main` before any changes in this session
(confirmed by `git stash` + re-run).

### Estimated impact

**Low — isolated to the "Teach Sean" onboarding flow.** An accountant pasting a plain
single-column list of item names (no comma header) would get "Item Name" returned as
the first extracted item, which would then fail validation downstream (no IRP5 code,
generic name). The UI should surface a validation warning; no payroll data is written.
PAYE, UIF, and payslip calculations are completely unaffected.

---

## TEST-TP-08

**Test:** `Text with no extractable items returns success=false`

**Input:** `'hello world this has nothing useful'`

**Expected:** `result.success === false`
**Actual:** `result.success === true`

### Root cause

`detectFormat` classifies the input as `'bullet'` (no commas, no pipes). `parseBulletLines`
then walks each word/line and — because it has no minimum-quality threshold — extracts
`"hello world this has nothing useful"` as a valid `item_name` string. Since at least one
item is returned, `items.length > 0` and the function reports `success: true`.

The gap is that `parseBulletLines` does not apply any heuristic to reject free prose
(e.g., minimum word count, absence of IRP5-pattern nearby, length limits, or checking
against a known-item vocabulary). Any non-empty string passes the `filter(i => i.item_name)`
gate.

**Affected code:** `parseBulletLines()` and the `success` gate in `parseInput()` in
`sean/teach-paytime-service.js` — no quality check before declaring success.

### Why unrelated to the PAYE/UIF session

Same reasoning as TEST-TP-04 — entirely within `TeachPaytimeService.parseInput()`, which
is a Sean text-ingestion utility. No connection to payroll calculation, PAYE, UIF, or the
`payroll_items_master` table. Confirmed pre-existing by stash test.

### Estimated impact

**Low — cosmetic false-positive in the Teach Sean UI.** If an accountant pastes random
prose into the "Teach Sean" input, the UI would show extracted "items" that are actually
garbage words. The downstream save call would likely fail IRP5 validation (no valid code),
preventing any bad data from reaching the DB. No payroll calculation is affected.
The worst outcome is a confusing error message rather than a silent data corruption.

---

## Recommended Fix (deferred)

Both failures share the same underlying gap in `parseBulletLines`:

1. **Header skip:** detect lines that match `/^item\s*name$/i` or similar column-label
   patterns and skip them (fixes TEST-TP-04).
2. **Quality gate:** after parsing, if zero items have a valid IRP5 code AND the item
   names look like generic prose (no digits, no known payroll keywords), return
   `success: false` with a clear error (fixes TEST-TP-08).

Neither fix touches PAYE, UIF, or the payroll calculation path.
