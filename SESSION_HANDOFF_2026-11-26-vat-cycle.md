# Session handoff — 2026-11-26 — Ledger Leo: VAT page follows the company's VAT cycle

## Problem (Ruan)

The VAT page only offered the last 12 calendar months, always monthly. Walkerpark files bi-monthly (even)
and still has to file 2025-10 (Sep–Oct 2025). There was no way to choose the cycle on the VAT page, so the
VAT report could not produce the figures to file.

## Root cause

- `vat.html` `setupPeriodSelector()` hard-coded 12 calendar months, and `parsePeriodKey()` always sent
  monthly dates.
- The company's cycle (`companies.vat_period` + `vat_cycle_type`) already existed and `journalService` used
  it, but the VAT page ignored it.
- `vatPeriodUtils` had no 4-monthly (Category F) or 6-monthly (Category D) cycle.
- `/vat/categorized` (VAT201 tab) and the `getVatPeriodRange` fallback assumed one calendar month.
- Walkerpark (co 3) has no cycle set and is not ticked as VAT registered.

## Changed

| File | Purpose |
|---|---|
| `backend/modules/accounting/services/vatPeriodUtils.js` | Adds `four-monthly` (ends Feb/Jun/Oct) and `six-monthly` (ends Feb/Aug) through a generic `_periodFromEndMonths`. Existing cycles are unchanged. |
| `backend/modules/accounting/services/vatCycleService.js` | NEW. `periodOptions` (36 months back, newest first, merged with stored rows; locked/filed rows keep their filed dates; unlocked rows from another cycle are hidden). `ensureCyclePeriod` (creates the row with the cycle's dates, or realigns an unlocked, unfiled row; refuses a key that is not a period end). `setCycle`. |
| `backend/modules/accounting/routes/vatRecon.js` | `POST /periods`: the server derives the dates from the cycle (falls back to the page's dates only when no cycle is set). NEW `GET /cycle/period-options`, `PUT /cycle` (admin/accountant, audit-logged). |
| `backend/modules/accounting/services/vatReportService.js` | `getVatPeriodRange` fallback follows the cycle when there is no row. |
| `backend/modules/accounting/routes/vat-report.js` | `/vat/categorized` (VAT201 tab) uses the stored period's dates. |
| `backend/modules/mcp/lorencoApi.js` | The bot may not change the VAT cycle. |
| `frontend-accounting/vat.html` | Period list comes from the cycle (36 months, labels such as "Sep – Oct 2025", filed/locked markers; default = latest ended period). New "VAT cycle" selector with confirm. Warns when no cycle is set. Title and due date use the period's own dates. |
| `frontend-accounting/company.html` | Settings offer the 4- and 6-monthly options and show the SARS categories. |
| `backend/tests/vat-cycle.test.js` | NEW, 15 tests. |

## Confirmed

- Full suite: 1609 pass, 0 fail. Lint: 0 errors. Inline script parses.
- E2E in test company 51: 14/14 (no cycle → months; bi-monthly even lists only even ends; 2025-10 = Sep–Oct;
  report + detail use Sep–Oct; old monthly DRAFT row realigned; odd key refused; LOCKED keeps dates;
  4-/6-monthly; bi-monthly without odd/even refused). Company 51 restored exactly afterwards.
- Real data (read-only): Turkstra (monthly, configured) is unchanged; Walkerpark shows "no cycle set".

## Ruan to do

- Walkerpark: on the VAT page choose "Every 2 months, even". Also tick VAT registered + VAT number in
  Company settings (journalService only places entries in VAT periods for VAT-registered companies).

## Follow-ups

- Annually (Category E) is still March–February; SARS uses the company's own financial year end.
- Old unlocked monthly rows under another cycle are hidden, not deleted.
- Not committed / pushed.

## Part 2 — Firmflow follows Leo's VAT registration + cycle

**Problem.** Firmflow kept its own VAT settings (`practice_clients.vat_registered`, `vat_payment_sequence`,
`vat_bi_monthly_parity`) with no link to Leo, and the two already disagreed: Walkerpark, Turkstra (practice 38)
and Dronedog.

**Fix.** This extends the existing COMPLIANCE_FIELD_MAP model (Leo canonical for linked clients: read-through
and write-through) to VAT registration and the VAT cycle.

| File | Purpose |
|---|---|
| `backend/modules/practice/lib/company-vat-sync.js` | NEW. Maps between the two vocabularies: monthly; bi_monthly + odd/even ↔ bi-monthly + odd/even; "quarterly (every 4 months)" ↔ four-monthly; 6_monthly ↔ six-monthly; annual ↔ annually. `overlayCompanyVat` puts Leo's values on linked clients. Leo wins only when it says VAT-registered, so a client Leo hasn't set up keeps Firmflow's values and its deadlines. |
| `backend/modules/practice/index.js` | Overlay in GET /clients (VAT filter now applied after the overlay), GET /clients/:id, POST /deadlines/generate and compliance suggestions. PUT /clients/:id writes VAT registered + cycle back to the company ("Not set" never clears Leo's cycle). Deadline generation now also handles every 4 months (Feb/Jun/Oct) and every 6 months (Feb/Aug) using Leo's period maths; annual is still skipped. |
| `backend/modules/accounting/services/vatCycleService.js` | `setCycle` also sets `is_vat_registered = true`: choosing a SARS cycle means the company is a VAT vendor, so journals get VAT periods and Firmflow takes the cycle over. |
| `backend/tests/practice-company-vat-sync.test.js` | NEW, 14 tests. |

**Confirmed.**
- Real routes, E2E in co 51 with a temporary practice client (removed afterwards): 10/10. Covers: Leo not set
  up → Firmflow's own values; cycle set on the VAT page → client detail, list and VAT filter show it;
  6-monthly → VAT deadline in Aug, none in Jul; Firmflow save of bi-monthly odd → Leo company bi-monthly odd
  and the VAT page lists odd period ends; "quarterly" → four-monthly; /team still works; suggestions see VAT.
- Full suite: 1623 pass. Lint: 0 errors.

**Behaviour change after deploy.** Turkstra (practice 38) and Dronedog are VAT-registered and monthly in Leo,
so Firmflow will show them that way and generate monthly VAT deadlines for them. Walkerpark keeps Firmflow's
values until its cycle is set in Leo.

**Not changed.** The Commander copy of Firmflow (left alone on purpose).

## Part 3 — Name, numbers, address and contact follow through (Leo, Paytime, Firmflow, ECO Hub, Charlie)

**Audit findings.**
- `companies` holds one record per client, but its columns were split. The real data is in `address_street/
  suburb/city/province/postal_code` (30 companies filled) and `contact_email/contact_phone` (29/30); invoices,
  statements, Paytime, EMP501, Charlie and Eco billing read these. Leo's company page read and wrote
  `physical_address/city/postal_code` and `email/phone` (empty for all, or for all but one). So Leo showed no
  address, and a Leo edit never reached invoices or payslips.
- Firmflow already took the numbers from the company (COMPLIANCE_FIELD_MAP), but not the address, email/phone
  or name. A Paytime edit never reached the ECO Hub client record, and an ECO Hub edit never reached the company.
- Charlie receipts print `companies.address` (only 1 company has it filled).
- Data mismatch, left as is: Turkstra is "Turkstra Bakkery (Pty) Ltd" in Firmflow/ECO Hub and "Turkstra Bakkery"
  on the company. Ruan to choose.

| File | Purpose |
|---|---|
| `backend/shared/services/companyIdentitySync.js` | NEW. Defines the canonical columns. `mirrorCompanyToEcoClients` (name, contact, one-line address → eco_clients) and `mirrorEcoClientToCompany` (name/email/phone → company; the structured address is never overwritten from the one-line field). Only columns that really changed are mirrored (`changedColumns`). |
| `backend/modules/accounting/routes/company.js` | Leo reads/writes `address_*` and `contact_email/contact_phone`; mirrors to ECO Hub (changed only). |
| `frontend-accounting/company.html` | Structured address (street, suburb, city, province, postal code), as in Paytime. |
| `backend/shared/routes/companies.js` | Paytime/ECO company edit → ECO Hub client (changed only). |
| `backend/shared/routes/eco-clients.js` | ECO Hub client edit → company (applyEcoClientUpdate step 2b). |
| `backend/modules/practice/lib/company-sync.js` | Renamed from company-vat-sync. COMPANY_FIELD_MAP (moved from index.js) now also covers the address (line1 → street, line2 → suburb, city, province, postal code) and email/phone → contact_*. Overlay used for the list as well. |
| `backend/modules/practice/index.js` | Uses the shared map. A Firmflow rename renames the company (only when it changed). Company edits from Firmflow mirror on to ECO Hub. |
| `backend/modules/pos/routes/receipts.js` | Receipt address falls back to the registered address when the till's own receipt address is empty. |
| `backend/tests/company-identity-sync.test.js` | NEW, 9 tests (test file `practice-company-vat-sync` renamed to `practice-company-sync`). |

**Confirmed.**
- E2E against the real Leo, Paytime (signed token) and Firmflow routes, co 51 + eco client 44 + temporary
  practice client: 14/14 (Leo address → Paytime columns + ECO Hub; Firmflow detail and list show it; Firmflow
  edit → company + ECO Hub; Paytime edit → ECO Hub (unchanged name not touched) + Firmflow; Charlie receipt
  fallback; ECO Hub edit → company + Firmflow; Firmflow rename → company + ECO Hub + Leo). Everything restored.
- The ECO Hub PUT route itself was not called in E2E (it triggers a background Eco billing sync into co 40);
  its mirror function was called directly.
- Full suite: 1638 pass. Lint: 0 errors. company.html and vat.html inline scripts parse.

**Commit warning.** Another session has uncommitted changes in the same working tree: middleware/auth.js,
shared/routes/auth.js, shared/routes/users.js, frontend-ecosystem/dashboard.html, shared/services/
clientAccess.js and tests/client-access.test.js. Its changes are mixed into `shared/routes/eco-clients.js`,
`modules/mcp/lorencoApi.js` and `tests/mcp-server.test.js`. Those files must be committed together with that
session's work, or staged per hunk.

**Follow-ups.**
- The Firmflow postal address (postal_*) is not yet linked to `companies.postal_address` (one text field).
- Firmflow secretarial profiles (paye/uif/sdl numbers, registered address) are a third copy; all 4 rows are empty
  today. They should read from the company.
- Legacy columns (`physical_address, city, postal_code, paye_reference, coid_number, email, phone`) can be dropped
  once nothing reads them.

## Part 4 — VAT cycle lock (authorised change only)

**Rule.** Once a company is VAT registered with a cycle, its VAT registration and cycle are locked:
- The first time, an admin or accountant can choose the cycle on the Leo VAT page.
- After that, the registration and cycle can only change through Firmflow → client → "Change VAT cycle". This
  needs a practice manager role (lib/team-access: owner, partner, admin, manager; a super admin who is not on the
  roster gets owner through the existing bypass) and a reason. The change is audit-logged (before, after, reason,
  who authorised it).
- A super admin may also change the cycle on the Leo VAT page, with a reason.
- Saving the same values (the forms send every field) is never treated as a change.

| File | Purpose |
|---|---|
| `backend/modules/accounting/services/vatCycleService.js` | `settings().locked`; `setCycle(…, {reason, registered}, {authorised})` refuses a locked change without authorisation (409 `VAT_CYCLE_LOCKED`) or without a reason (400). Pure helpers: `isChange`, `changeIsLockedOut`, `describeCycle`. |
| `backend/modules/accounting/routes/vatRecon.js` | PUT /cycle: only super admins are authorised there; `settings.canChange` is returned for the page; audit action is VAT_CYCLE_SET or VAT_CYCLE_CHANGED, with the reason. |
| `backend/modules/accounting/routes/company.js` | PUT refuses a registration or cycle change on a locked company (unless super admin). GET returns `vatLocked` and `vatCycleCanChange`. |
| `frontend-accounting/company.html`, `frontend-accounting/vat.html` | Fields are read-only when locked, with a note. A super admin is prompted for a reason. The first-set confirm says the cycle locks. |
| `backend/modules/practice/lib/company-sync.js` | `vat_settings_locked` on the overlay; `desiredVatFromPractice`. |
| `backend/modules/practice/index.js` | The ordinary PUT /clients/:id refuses a locked change (409). NEW POST /clients/:id/vat-cycle (manager roles + reason) → vatCycleService (authorised); keeps practice_clients in step; audit-logged. |
| `backend/frontend-practice/js/client-detail.js` | Lock box with a "Change VAT cycle" button (fields unlock, reason field, "Save VAT change"). |
| `backend/modules/mcp/lorencoApi.js` | The bot may not call the Firmflow vat-cycle route. |
| `backend/tests/vat-cycle.test.js` | +5 lock tests. |

**Confirmed.**
- E2E in co 51, real routes: 15/15. First set by staff; then locked. A staff change on the VAT page, in company
  settings and through the Firmflow ordinary save is refused (409), while saves with the same values still work.
  The Firmflow change is refused for a non-manager (403) and without a reason (400). With a reason it changes
  Leo and writes to the audit trail. A super admin on the VAT page needs a reason. Everything restored.
- Full suite: 1643 pass. Lint: 0 errors.

**Locked as soon as this is deployed:** co 1 (bi-monthly even), Walkerpark co 3 (bi-monthly even — set outside
this session on 2026-11-26), Turkstra co 7 (monthly), Dronedog co 41 (monthly).

**Roster note.** Ruan is owner in practices 1 and 38; MJ, Anton and Anrich are partners in practice 1. In test
co 51's roster Ruan is 'staff', so there the real roster role applies (existing team-access rule) and Ruan can't
change it there.
