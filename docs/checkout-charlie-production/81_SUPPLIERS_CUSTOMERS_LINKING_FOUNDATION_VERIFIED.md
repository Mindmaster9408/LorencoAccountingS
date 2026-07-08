# Workstream 80 — Verification
## Checkout Charlie

**Date:** 2026-07-08
**Method:** `node --check` + module-load smoke test on every touched backend file; a real headless-Chromium (Playwright) test against the **actual, unmodified `index.html`** served over a local HTTP server (not `file://` — see note below) with mocked API responses, exercising every CRUD/linking flow end to end.

**Testing note on `file://` vs a real server:** earlier workstreams' Playwright tests loaded `index.html` directly via `file://`, which worked for layout/DOM-structure checks but silently breaks any test that depends on mocked `fetch()` data — `API_URL = window.location.origin + '/api'` resolves to `file:///api` under `file://`, and the browser rejects that scheme before Playwright's route interception ever sees the request (confirmed via the "Fetch API cannot load file:///api/... URL scheme 'file' is not supported" console errors present in every prior file://-loaded test, previously dismissed as harmless since those tests didn't depend on the mocked data resolving). This workstream's verification instead serves the real, unmodified file over a throwaway local HTTP server (`http://localhost:58231`), which is also a more accurate approximation of production (the app is never actually loaded via `file://`).

---

## Backend Checks

| Check | Result |
|---|---|
| `node --check` on all 7 touched/new backend files | ✅ all pass |
| Full POS module tree (`modules/pos/index.js`, which requires every route file including the new `company-links.js`) loads without a require-time error | ✅ confirmed via direct `require()` smoke test |
| `INVENTORY.ADJUST` gate on all supplier CRUD writes, link-company, confirm, revoke | ✅ confirmed via code read-through — matches the existing management-only pattern from Workstream 78 |
| `INVENTORY.VIEW` gate on list/read routes | ✅ confirmed |
| Live schema pre-check: confirmed `companies.invitation_code`/`inter_company_enabled` already exist; confirmed `inter_company_relationships` columns (`company_a_id, company_b_id, initiated_by, status, company_a_confirmed, company_b_confirmed, permissions, created_at`) match exactly what `network.js`/`supabase-store.js` assume, and confirmed `updated_at` was genuinely missing (400 error probing it) before this workstream's defensive `ALTER TABLE` | ✅ confirmed via direct Supabase REST API query with service-role credentials |
| `git diff` — no `localStorage`/`sessionStorage`/`safeLocalStorage` writes introduced anywhere in this workstream | ✅ confirmed (zero matches) |

---

## Frontend Verification (real headless-Chromium, real file, real HTTP server, mocked API)

| Check | Result |
|---|---|
| Settings → Suppliers is no longer "coming soon" — list renders both mocked suppliers | ✅ `supplierRowCount: 2` |
| Company Link badge shows "Link Pending" for a supplier with `link_status: 'pending'` | ✅ confirmed in row text |
| "Add Supplier" opens with an empty form, correct title, Company Link section hidden (no ID to attach a relationship to yet) | ✅ `addModalTitle: "Add Supplier"`, `addModalLinkSectionHidden: "none"` |
| Saving a new supplier sends the exact form data as the create payload | ✅ `createBody` matches every field entered, including the untouched fields as empty strings (not silently dropped) |
| "Edit Supplier" opens pre-filled with the selected supplier's real data | ✅ `editModalTitle: "Edit Supplier"`, `editNamePrefilled: "Turkstra Hardware"` |
| Editing a supplier with `link_status: 'pending'` shows the correct badge and status box | ✅ `linkSectionShowsPendingBadge: "Pending Approval"`, `linkActiveBoxVisible: "block"` |
| Editing a supplier with `link_status: 'none'` shows the invitation-code input, not the status box | ✅ `noLinkBoxVisible: "block"` |
| Requesting a company link sends the invitation code to the correct endpoint | ✅ `linkRequestBody: { invitationCode: "IC-TESTCODE" }` sent to `POST /suppliers/1/link-company` |
| Revoking a link sends the request to the correct relationship ID | ✅ `revokedRelationshipId: 55` — matches the supplier's `linked_relationship_id`, not an arbitrary/wrong ID |
| Archiving a supplier calls the correct endpoint for the correct ID | ✅ `archivedId: 1` |
| Enterprise Dashboard shows real company-link counts, not fabricated numbers | ✅ `dashboardCompanyLinksVisible: "block"`, `dashboardCompanyLinksText: "1 active company linked, 1 pending approval"` — computed from the exact mocked `GET /company-links` response (1 active + 1 pending), not hardcoded |
| Console/page errors | ✅ none, aside from one expected 404 for `/pos/service-worker.js` — an artifact of the minimal test HTTP server not serving the PWA service-worker path used in production, unrelated to this workstream's code |

---

## Cross-Company Data Leakage — Verified

- `POST /lookup` and `POST /:id/link-company` code inspection confirms both return only `{id, name, preview: {city, industry}}` for a matched company — no financial, contact, or catalogue fields, matching `InterCompanyNetwork.findCompanies()`'s existing redaction (verified by reading its implementation, not assumed).
- `GET /company-links` (list) code inspection confirms the response is built from `getAllRelationships()` (company-scoped `.or(company_a_id.eq / company_b_id.eq)`) plus a single follow-up `companies` query limited to `.select('id, company_name, trading_name')` for the counterparty names only — no other company fields are ever fetched or returned.
- No route in this workstream accepts or exposes a raw, unscoped company list. Every lookup path requires an exact invitation code.

## Permissions Enforced — Verified

- Every write route (`POST /`, `PUT /:id`, `PATCH /:id/deactivate`, `PATCH /:id/activate`, `POST /:id/link-company`, `POST /company-links/:id/confirm`, `POST /company-links/:id/revoke`) requires `INVENTORY.ADJUST`, which maps to `MANAGEMENT_ROLES` in `permissions.js` — confirmed via `grep` across both route files, matching Workstream 78's established pattern exactly.
- `confirmRelationship`/`revokeRelationship` additionally verify server-side that the requesting company is actually `company_a_id` or `company_b_id` on the relationship before acting — confirmed via code read-through; this is new authorization logic added in this workstream (the pre-existing `confirmRelationship` had no such check at all).

## Audit Events — Verified

- Code inspection confirms all 7 new events (`SUPPLIER_CREATED`, `SUPPLIER_UPDATED`, `SUPPLIER_DEACTIVATED`, `SUPPLIER_REACTIVATED`, `COMPANY_RELATIONSHIP_REQUESTED`, `COMPANY_RELATIONSHIP_APPROVED`, `COMPANY_RELATIONSHIP_REVOKED`) are registered in `POS_EVENTS` with category mappings, and fired at the correct point in each route with only non-sensitive metadata (relationship ID, company/supplier name — never financial or contact fields).
- `COMPANY_RELATIONSHIP_APPROVED` specifically confirmed to fire only when the relationship's status actually transitions to `active` (not on every confirm call — a first-side confirm that leaves the relationship still `pending` does not fire it), matching the ticket's intent.

---

## Not Independently Re-Verified (documented, not hidden)

- **Live database write path.** As with prior workstreams, the actual `INSERT`/`UPDATE` behaviour against a real Postgres instance was not exercised (no reachable DB connection from this environment). The two shared-module fixes (`confirmRelationship` persistence, `getRelationshipById`) are structurally identical to already-proven-working query patterns elsewhere in the same files (`findRelationship`, `addRelationship`), so this is a low-but-nonzero risk gap.
- **The accounting side of the relationship confirm flow** (`/api/inter-company/relationships/:id/confirm`, unchanged route, now backed by fixed internals) was not re-tested against real accounting invoice data — out of scope for a POS-focused workstream, but worth a quick smoke test given the persistence bug fix changes its actual behaviour (from "silently no-ops" to "actually works").
- **Concurrent link requests** (two managers on the same supplier racing to link different codes) — not tested. The `/:id/link-company` route's pending/active check reduces but doesn't eliminate a narrow race window; low risk given this is a rare, management-only, deliberate action.

FOLLOW-UP NOTE
- Area: Inter-company relationship confirm/revoke — live database + accounting-side smoke test
- Dependency: Zeabur-hosted Postgres, unreachable from this local environment
- Confirmed now: SQL/query structure, full route logic, and complete UI request/response contracts (via mocked-network browser test over a real HTTP server)
- Not yet confirmed: actual row-level persistence against the live database, and that the accounting module's own confirm UI (if any) still behaves correctly now that confirmRelationship actually persists
- Risk if wrong: low for POS (mirrors already-working query patterns) — the accounting-side behavior change (confirm now actually works, previously silently didn't) is the one item worth a deliberate look, since it changes real, live behavior rather than just adding new capability
- Recommended next review point: first real supplier-to-company link request and confirmation performed in production; independently, a check that accounting's inter-company invoice confirm flow still behaves as expected now that it actually persists
