# Session Handoff — 2026-10-19 — Slip Capture app (Phase 1)

Concept and decisions: `docs/future-build/SLIP_CAPTURE_APP_CONCEPT.md`.
Status: **DB + storage ready and tested end-to-end; committed; NOT pushed, so not yet live on Zeabur.**

## Done after Ruan's go-ahead (same day)

- Migration 172 run in Supabase (`scripts/run-sql.js file`). RLS was added to the migration (RLS on, no policies: backend only) and re-run. The table, both triggers and RLS were verified.
- Private bucket `slip-files` created (20 MB limit, PDF/JPG/PNG/HEIC/HEIF/WEBP only). The public URL is refused.
- `slips` enabled on the test company: `eco_clients` 44 `apps` and `companies` 51 `modules_enabled` (Rule H2). PostgREST schema reloaded.
- E2E against the real DB and storage through the real auth/module/audit chain, as test users 36/37/38: 19/19 checks pass. These cover upload, duplicate refused (409), search, a byte-identical download via signed URL, private bucket, edit plus retention extension, permission on hide (store_manager 403), hide/restore, company isolation (404), the three DB guards, and the full audit trail.
- Headless Chrome UI test at phone size: login screen, app, camera upload of a 9.5 MB photo (stored at 2.3 MB, 1800x2400; real photos compress much more), preview, details, search, hide, and browser storage holding ONLY `slips_token`. No JS errors.
- **Bug found and fixed by the UI test:** a search cleared the list before the result came back, so a tap during loading did nothing. Now the list stays tappable and stale responses are discarded.
- 6 test slips remain in company 51 (hidden). They cannot be deleted for 7 years. That is by design.
- Correction: CI does NOT auto-apply migrations, because the GitHub secret is not set (see the memory reference). Migrations are run by hand.
- Also found: `collector_documents` has RLS **off** (other sensitive tables have it on). Not changed. Needs review.

## What was changed

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/172_slips_schema.sql` | New `slips` table. DB triggers: the stored original is immutable, `retain_until` can only move later, no DELETE before `retain_until`, company FK is `ON DELETE RESTRICT`. |
| `accounting-ecosystem/backend/modules/slips/index.js` | Module router: `/status`, `/context`, mounts the slip routes. |
| `accounting-ecosystem/backend/modules/slips/routes/slips.js` | List/search, upload (one file per request), get, edit details, signed file URL, hide/restore. Audit log on every write and file view. Duplicate (same SHA-256) is refused with 409. |
| `accounting-ecosystem/backend/modules/slips/services/storageService.js` | Private bucket `slip-files`, path `company/yyyy/mm/uuid_sha.ext`. |
| `accounting-ecosystem/backend/frontend-slips/` | Phone-first PWA: own login (incl. 2FA + company picker), camera capture, image downscale above 1.5 MB, in-memory upload queue with retry, detail sheet. Manifest, service worker (static shell only), icons. |
| `accounting-ecosystem/backend/config/modules.js` | `slips` module entry, on by default (`MODULE_SLIPS_ENABLED=false` switches it off). |
| `accounting-ecosystem/backend/server.js` | Mounts `/api/slips` (authenticateToken + requireModule + audit), serves `/slips`, and serves the SW with the build version. |
| `accounting-ecosystem/backend/shared/routes/auth.js` | Added `'slips'` to the `sso-launch` `validApps` list. One word; HIGH-protected file, see impact note below. |
| `accounting-ecosystem/frontend-ecosystem/dashboard.html` | New `APP_DEFS` tile "Slip Capture". |
| `accounting-ecosystem/backend/.eslintignore` | Ignore `frontend-slips` (browser code, same as the other frontend folders). |

## Checked

- `npm run lint`: 0 errors. `modules/slips` is clean.
- Unit checks: retention dates (incl. 29 Feb), amount parsing (`1 234,50`, `1,234.50`, `R 1 234.50`), date validation.
- Isolated HTTP harness (module mounted with a fake super-admin, company 51, **read-only**): status, context, upload validation (no file / wrong type / bad amount → 400), static files and manifest. The list endpoint fails until migration 172 runs (expected).
- The full server was NOT started locally, because startup runs `seedMasterAdmin` against the production DB.

## Not done / needs Ruan

1. ~~Migration 172~~, ~~bucket~~ and ~~test company~~ are done (see above).
2. Push to `main`, so Zeabur deploys it. Then do a real phone test: dashboard tile, SSO, "Add to Home Screen", own login from the home-screen app, a real camera photo.
3. Open questions: the app's name, the start point for the 7 years (currently the later of upload date and slip date), and whether every user in a company should see all of that company's slips (currently yes; you may hide your own, managers may hide any).

## Impact note — auth.js (HIGH, shared)

The only change is `'slips'` added to an allow-list. Login, select-company, the companyId in the JWT, eco_client resolution and coaching gates are untouched. No payroll path is affected. Rollback: remove the word.

## Found, not fixed (pre-existing)

`validApps` in `sso-launch` also lacks `collector` and `commander`, so their dashboard tiles most likely fail with "Invalid targetApp". Not changed, because that is outside this task. It also goes against the spirit of Rule F1 (a new app should work automatically).
