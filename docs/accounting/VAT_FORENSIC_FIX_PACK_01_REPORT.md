# VAT Forensic Fix Pack 01 Report

## 1. Summary

Fix Pack 01 has been implemented to establish the authoritative VAT engine foundation for pilot readiness blockers.

Delivered in this pack:

- Authoritative backend VAT report service from posted journal truth.
- New backend VAT report endpoint: GET /api/accounting/vat/report.
- VAT period key standardization to canonical YYYY-MM with legacy YYYY.MM normalization.
- Hard-block behavior for VAT-bearing bank allocations when VAT control account 1400/2300 is missing.
- VAT return frontend replaced with API-driven report view (no static VAT values).
- Future roadmap documentation for snapshots, adjustment queue, submission gate, and drilldown.

## 2. Risks Addressed

- Eliminated frontend-only VAT truth on vat-return page.
- Eliminated silent VAT gross fallback in bank allocation VAT split when control accounts are missing.
- Reduced period mismatch risk by canonical period key normalization (YYYY-MM).
- Added backend-generated VAT result payload with warnings and source breakdown.

## 3. Files Changed

- accounting-ecosystem/backend/modules/accounting/services/vatReportService.js
- accounting-ecosystem/backend/modules/accounting/routes/vat-report.js
- accounting-ecosystem/backend/modules/accounting/index.js
- accounting-ecosystem/backend/modules/accounting/routes/bank.js
- accounting-ecosystem/frontend-accounting/vat-return.html
- accounting-ecosystem/frontend-accounting/vat.html
- docs/future-build/VAT_ENGINE_FUTURE_ROADMAP.md

## 4. VAT Report Service

Implemented new service:

- File: backend/modules/accounting/services/vatReportService.js

Capabilities added:

- generateVatReport(companyId, periodKey, options)
- getVatPeriodRange(companyId, periodKey)
- getVatControlAccounts(companyId)
- calculateInputVat(companyId, dateFrom, dateTo)
- calculateOutputVat(companyId, dateFrom, dateTo)
- calculateOutOfPeriodVat(companyId, periodId)
- buildVat201Summary(outputVat, inputVat)
- buildSourceBreakdown(companyId, dateFrom, dateTo, periodId)
- normalizeVatPeriodKey(input)

Key enforcement:

- Uses posted journals only (journals.status = 'posted').
- Company-scoped queries only.
- VAT accounts anchored to code 1400 (input) and 2300 (output).
- Returns warnings when key normalization occurs or source classification is incomplete.

Returned metadata:

- generatedAt
- generatedBy
- calculationVersion = VAT_ENGINE_V1

## 5. Period Key Standardization

Canonical format implemented: YYYY-MM.

What was done:

- Backend service accepts legacy YYYY.MM and normalizes to YYYY-MM.
- Backend responses return canonical YYYY-MM.
- VAT reconciliation UI period selector now emits YYYY-MM.
- vat.html helper accepts legacy YYYY.MM and converts to canonical.

## 6. Bank Allocation VAT Hard Block

Updated file:

- backend/modules/accounting/routes/bank.js

Change made:

- If a VAT-bearing allocation line is present and required VAT control account is missing:
  - Money out: 422 with VAT Input account (1400) provisioning error.
  - Money in: 422 with VAT Output account (2300) provisioning error.
- Journal creation does not proceed in these cases.
- Transaction allocation status is not changed.
- Silent gross fallback behavior was removed.

## 7. VAT Return Frontend

Updated file:

- frontend-accounting/vat-return.html

Change made:

- Replaced static/hardcoded VAT values with backend API data from /api/accounting/vat/report.
- Added canonical period selector (YYYY-MM).
- Added loading, error, and empty states.
- Added summary cards:
  - Output VAT
  - Input VAT
  - Net Payable/Refundable
- Added warnings panel.
- Added source breakdown table.
- Added banner: Draft VAT report generated from posted accounting data.

No VAT values are written to localStorage.

## 8. Multi-Tenant Safety

Enforced by design:

- Endpoint derives companyId from authenticated backend context.
- No company_id request parameter is accepted for VAT report generation.
- Service query filters always include company scope.

## 9. What Was Not Changed

Intentionally not changed in this pack:

- JournalService posting architecture.
- VAT period assignment architecture.
- AR/AP invoice posting architecture.
- Core bank allocation journal architecture outside VAT-account hard-block compliance fix.
- Bank reconciliation architecture.
- Trial balance / general ledger reporting architecture.
- Historical comparatives.
- Opening balances.
- Full immutable snapshot persistence implementation (future hook prepared only).

## 10. Tests Run

Static and structural validations run in this implementation pass:

1. New backend files compile/lint in workspace diagnostics:
   - routes/vat-report.js: no errors
   - services/vatReportService.js: no errors
2. Updated bank route compiles in workspace diagnostics: no errors.
3. Updated vat-return.html has no diagnostics errors.
4. VAT period key check in vat.html confirms no remaining YYYY.MM split literals in script logic.
5. Endpoint wiring validated:
   - route mounted at /api/accounting/vat/report via accounting module index.

Notes:

- Full runtime integration tests requiring live DB fixtures were not executed in this codebox.
- Existing vat.html style-lint warnings are pre-existing and unrelated to Fix Pack 01 logic.

## 11. Remaining Risks

- Source classification still depends on available journal source_type/metadata; unknown types are warned, not fully classified.
- Immutable VAT snapshot persistence is not implemented yet (hook metadata only).
- SARS submission hard reconciliation gate is still future work.
- Out-of-period adjustment queue remains future work (current reroute logic retained per decision).
- Full automated end-to-end pilot test pack remains to be executed in an integrated environment.
