# Session handoff — 2026-11-12 — Clients request apps, Lorenco approves

## Why
Ruan saw a client (Warmbaths Mini Market, eco_client 54) press **+ Add** on its own client card and switch Paytime on by itself. Lorenco was never told, so pricing was never discussed and nothing got invoiced.

**Root cause:** `PUT /api/eco-clients/:id` let any manager of a client (business_owner, accountant, …) change `apps`/`addons`. A self-registered business owns a self-referencing eco_client row (`auth.js /register`), so it could switch on any app for itself. That bypassed the 2026-10-28 rule that Ruan approves every app himself. Also `POST /api/eco-clients` gave every non-admin-created client `pos/payroll/accounting` by default.

## What changed

| File | Purpose |
|---|---|
| `backend/config/migrations/179_app_subscription_requests.sql` | `eco_clients.billing_day` (1–31) + table `app_subscription_requests` (+ partial unique index: one open request per client per app). **RUN 2026-11-12, verified.** |
| `backend/shared/services/appSubscriptions.js` | All logic: request, cancel (scheduled for the next billing date), withdraw/undo, approve/decline, queue, billing day, hourly runner, emails. |
| `backend/shared/routes/app-subscriptions.js` | `/api/app-subscriptions/*`. Client side uses the same permission as editing a client (`loadManagedClient`). Lorenco side is super admin only. |
| `backend/config/app-pricing.js` | Price list placeholder. **Empty on purpose** (price lists not final). Fill it in and the modal shows prices + requires acceptance. |
| `backend/shared/routes/eco-clients.js` | PUT: non-admins may no longer change apps/addons/billing fields (403 with code). The PUT body was extracted into `applyEcoClientUpdate()` (exported, same logic), plus `validateAppAdditions()`. POST: a non-admin's ticked apps become requests and the client starts with nothing on. GET list now carries `open_app_requests` for the card badges. |
| `backend/server.js` | Mounts the routes and starts the hourly runner (`APP_SUBSCRIPTION_SCHEDULER=off` disables it). |
| `frontend-ecosystem/dashboard.html` | Non-admin "+ Add" opens **Manage apps** (Request / Cancel / Undo / Withdraw, plus the terms tick box). Super admins keep the old direct checkbox modal. Cards show "⏳ requested" / "🔻 ends dd/mm/yyyy". |
| `frontend-ecosystem/admin.html` | "App requests" panel (Approve with billing day / Decline with reason / scheduled cancellations / last 30 days) + "Bills on day X" button per client. |
| `frontend-ecosystem/client-detail.html` | Linked Apps is now display-only and is not sent on save. **This fixes an existing bug:** the form only knew 3 apps, so every save silently dropped Stockton/Firmflow/SEAN, even for super admins. |
| `backend/tests/app-subscriptions.test.js` (new, 16 tests), `tests/eco-clients-tenant.test.js` (NOSTUB test now runs as SUPER), `tests/helpers/fakeSupabase.js` (`lte`/`gte`) | Tests |

## Behaviour
- **Request:** emails ruanvlog@lorenco.co.za + antonjvr@lorenco.co.za (override with env `APP_REQUEST_NOTIFY_EMAILS`). Nothing is switched on until approval. Approve switches the app on through the same sync as the toggles, sets the billing day if it was empty, and emails the requester. Decline emails the requester the reason.
- **Cancel:** the app stays on until the day before the client's next billing date, and the runner switches it off on that date. The client can undo before then. Ruan + Anton are emailed on cancel and on undo. Data is never deleted. If no billing day is set, the day the client was created is assumed and the email says so.
- **Super admins** still switch everything directly (Rule F1).

## Confirmed
- Full backend suite: 1340 passed (8 skipped, pre-existing). Lint: 0 errors. Inline HTML scripts parse.
- **E2E against Supabase in TEST company 51 / eco_client 44: 18/18.** Covered cancel → runner before/on date → modules_enabled, undo, request → decline, request → approve → modules_enabled + billing day, double approve refused. State was restored exactly afterwards and the test rows deleted.

## Not changed
- Existing app assignments (Ruan: "hou soos dit is") — Warmbaths keeps Paytime.
- Super-admin toggles in admin.html (they still use PUT directly).

## Testing Ruan still needs to do
1. Log in as a non-admin owner (or create one in company 51), press + Add → Request, and check that the email arrives (needs SMTP_* on Render, see the Zoho note).
2. Approve it in /admin and check that the client gets the email and the tile appears.
3. Set billing days for existing paying clients in /admin.

## Follow-ups
```
FOLLOW-UP NOTE
- Area: Manage apps list
- Dependency: new apps 'slips' and 'insights' (still "Testing")
- What was done now: not in REQUESTABLE_APPS, so clients cannot request or cancel them via the modal
- What still needs to be checked: add them to APP_LABELS in appSubscriptions.js once they are sold
- Risk if not checked: a client with slips/insights active cannot cancel it themselves
- Recommended next review point: when Slips/Insights leave "Testing"

FOLLOW-UP NOTE
- Area: Practices on a 30-day trial
- Dependency: Ruan's decision
- What was done now: their clients' apps also go through requests
- What still needs to be checked: whether trial practices should be exempt
- Risk if not checked: friction during a trial
- Recommended next review point: next practice signup
```
