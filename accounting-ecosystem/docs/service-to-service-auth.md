# Service-to-Service Auth — How Another App Talks to This Backend

> Written 2026-07-24, from building the Sean webapp's live accounting-data bridge.
> Read this before adding any new "app X needs to call the ecosystem backend without
> a logged-in user in the loop" integration — the mechanism already exists, and
> re-inventing it (a new service-token concept, a bypass header, an API-key system)
> is both unnecessary and a security regression.

---

## The short version

**There is no special "service token" mechanism on this backend, and there doesn't
need to be one.** Any valid ecosystem JWT for a real, active super-admin user already
gets full cross-company access, on every route, in every module — that's Rule F1 in
`CLAUDE.md` ("super users have unrestricted access to all apps"). The only thing a
server-to-server caller needs that a normal browser session doesn't is a token that
doesn't expire in 8-24 hours like a login session does.

So: **mint a long-lived JWT for a real super-admin user, and use it like any other
Bearer token.** That's the entire pattern.

---

## How to mint one

```bash
cd accounting-ecosystem/backend
node scripts/mint_service_token.js [email] [expiresIn]
# e.g.
node scripts/mint_service_token.js ruanvlog@lorenco.co.za 365d
```

This signs a JWT with `JWT_SECRET` (same secret every other token in this ecosystem
uses) containing `{ userId, role: 'super_admin', isSuperAdmin: true, isGlobalAdmin:
true, email, fullName }` and the expiry you asked for. The script refuses to run for
a user that isn't `is_active` or isn't `is_super_admin` — a service token for a
non-super-admin account can't bypass the per-company/per-permission checks below, so
it wouldn't be useful as a service credential anyway.

**Treat the output as a secret.** Don't commit it, don't log it anywhere persistent.
Paste it straight into the calling app's `.env` (which must be gitignored — verified
for `sean-webapp/.env` and `accounting-ecosystem/backend/.env` before this pattern
was used). Rotate before expiry by re-running the script and swapping the env var.

There's no revocation list — if a minted token needs to be killed before its expiry,
the only lever today is rotating `JWT_SECRET` itself (which invalidates every token
ecosystem-wide, including real user sessions). If per-token revocation ever becomes
necessary, that's a real gap worth closing, not something to work around silently.

---

## What actually makes this work (verified 2026-07-24)

Three layers, in request order, and why a minted super-admin token clears each one:

1. **Shared `authenticateToken`** (`backend/middleware/auth.js`) — verifies the JWT,
   sets `req.user` and `req.companyId`. Critically, it also honors an
   `X-Company-Id` request header override **only** when `decoded.isGlobalAdmin ||
   decoded.role === 'super_admin'` — which is exactly what the minted token sets.
   This is how a caller picks *which* company's data it wants without a real login
   session for that company.
   `_checkActiveSession` (same file) requires the `userId` in the token to be a real,
   `is_active` row in `users` — this is why the mint script insists on a real,
   active super-admin account rather than a synthetic user id.

2. **Per-module auth bridges** (e.g. `modules/accounting/middleware/auth.js`'s
   `authenticate()`) — every module adapts the shared JWT shape to its own
   `req.user` conventions, but each one independently promotes
   `isSuperAdmin`/`is_super_admin` to its own `isGlobalAdmin` flag. Any module you
   add in the future should follow this same adapter pattern rather than inventing
   a new admin-detection rule.

3. **Route-level permission checks** (e.g. `hasPermission('report.view')`,
   `enforceCompanyStatus`, `enforceCompanyScope`) — every one of these already has
   an explicit `if (req.user.isGlobalAdmin) return next();` early-out. Nothing new
   was added here; this is just confirming the existing bypass covers the routes a
   service caller needs.

Net effect: `Authorization: Bearer <minted token>` + `X-Company-Id: <companyId>` on
any route in this backend behaves exactly like Ruan logging in and switching to that
company — because structurally, that's what it is.

---

## Current consumers of this pattern

| Consumer | Env vars | What it calls |
|---|---|---|
| `sean-webapp/lib/accounting-context.ts` | `ECO_BASE_URL`, `ECO_SERVICE_TOKEN` | `GET /api/accounting/reports/trial-balance`, `GET /api/accounting/bank/transactions`, `GET /api/accounting/vat-recon/periods` |
| `sean-webapp/app/api/paytime/[[...path]]/route.ts` | `ECOSYSTEM_API_URL`, `ECOSYSTEM_API_TOKEN` | proxies to `/api/sean/paytime/*` |

Both env-var pairs are set to the **same minted token** in practice — they're the
same conceptual credential under two historical naming conventions from when each
bridge was built separately. Unifying the naming is a nice-to-have cleanup, not a
functional requirement (both names work identically today).

## Adding a new consumer

1. Confirm the routes you need are reachable by an `isGlobalAdmin` caller (true for
   effectively everything today — check for a bare `authorize('some_specific_role')`
   call that doesn't have the `isGlobalAdmin` early-out if you're unsure).
2. Mint a token with `scripts/mint_service_token.js` (or reuse an existing unexpired
   one — no need for a token per consumer).
3. Send `Authorization: Bearer <token>` and, if the call needs a specific company's
   data, `X-Company-Id: <companyId>`.
4. Don't build new auth logic for this. If step 1 turns up a route that genuinely
   should be blocked even from a super-admin service caller, that's a real design
   question — raise it rather than routing around it.
