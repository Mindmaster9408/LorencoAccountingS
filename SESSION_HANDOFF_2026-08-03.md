# SESSION HANDOFF — 2026-08-03

## What was changed

**New POS role: `receiving_clerk`** — for staff who receive/book-in Purchase
Order deliveries (including partial deliveries) but must never see Reports,
the Dashboard, or any sales/revenue figures.

- `accounting-ecosystem/backend/config/permissions.js`
  - Added `receiving_clerk: 25` to `ROLE_LEVELS` — deliberately NOT added to
    `SUPERVISOR_ROLES`/`MANAGEMENT_ROLES`/`ALL_ROLES` (those arrays also gate
    `REPORTS.VIEW`, which must stay closed to this role).
  - Explicitly granted `receiving_clerk` on: `PRODUCTS.VIEW`, `INVENTORY.VIEW`,
    `PURCHASE_ORDERS.VIEW`, `PURCHASE_ORDERS.RECEIVE`, `SETTINGS.VIEW`.
  - Left `REPORTS.VIEW`, `PURCHASE_ORDERS.CREATE/APPROVE/DISPATCH/CLOSE`,
    `TILLS.*`, `SALES.*` untouched — role has none of these.
- `accounting-ecosystem/backend/modules/pos/routes/pin.js`
  - Added `receiving_clerk` to `PIN_ELIGIBLE_ROLES` (comment there says "all
    roles can receive a PIN" — this role was simply missing).
- `accounting-ecosystem/frontend-pos/index.html`
  - Added "Receiving Clerk" option to all 3 role dropdowns (Create User,
    Link Existing User, Edit User).
  - `applyRoleBasedVisibility()`: split Stock-tab visibility out of the
    combined Reports/Dashboard/Stock/Loyalty `SUPERVISOR_TIER_ROLES` check —
    Stock now uses its own `STOCK_TAB_ROLES = [...SUPERVISOR_TIER_ROLES,
    'receiving_clerk']` list. Reports/Dashboard/Loyalty remain
    `SUPERVISOR_TIER_ROLES`-only (receiving_clerk excluded).
  - `renderPoDetail()` / `renderPoDeliveryBlock()`: added a
    `poActionsAllowed = userRole !== 'receiving_clerk'` guard so Accept/
    Reject/Dispatch/Cancel/Force-Close/Resolve-Variance buttons don't render
    for this role (backend already 403s these; this just avoids the
    visible-button-that-403s UX gap for the new role specifically).
  - `completeLogin()`: `receiving_clerk` lands on the Stock tab instead of
    Till, and skips `checkSession()`'s "Please open a till session" prompt
    (meaningless for a role with no Till access).

**Bundled in the same commit (pre-existing, uncommitted work from earlier in
this session, unrelated to the above):** Serial Number "Details" drill-down
(purchase-to-sale history for one serial-tracked unit) —
`GET /api/pos/products/serials/:id/history` in `products.js`, supporting
`receive_id`/`transfer_id` FK writes in `inventory.js` and
`purchase-orders.js`, and migration `075_pos_serial_purchase_linkage.sql`.
User confirmed migration 075 was already applied in Supabase before this was
pushed.

## Root cause addressed

The user needed a POS user who can receive Purchase Order deliveries
(supporting partial/staggered deliveries — Codebox 87 already supports this
natively) but must have zero visibility into sales figures or reports. The
existing role architecture had `PURCHASE_ORDERS.VIEW`/`RECEIVE` and
`REPORTS.VIEW`/Dashboard/Stock/Loyalty visibility all wired to the exact same
`SUPERVISOR_ROLES` array — there was no way to grant one without the other.
Root-caused by adding a new, narrowly-scoped role with only the specific
permissions it needs, rather than patching around the existing role tiers.

## Confirmed working

- Backend lint (`npm run lint` scope) clean on all touched files
  (`permissions.js`, `pin.js`, `inventory.js`, `products.js`,
  `purchase-orders.js`).
- `canManageRole()` / user-creation route (`shared/routes/users.js`) require
  no separate role-validation-list change — they resolve purely off
  `ROLE_LEVELS`, which now includes `receiving_clerk`.
- Pushed to `origin/main` after explicit user confirmation the till was not
  in active/trading use (CLAUDE.md Rule G1).

## What was NOT changed / not tested

- Not live-verified in the browser — no dev server was run this session.
  Before relying on this in production, walk through: create a user with
  role "Receiving Clerk", log in, confirm Dashboard/Reports/Loyalty tabs are
  absent, Stock tab is visible, Purchase Orders modal opens, a delivery can
  be received (including a partial delivery leaving the PO
  `partially_fulfilled`), and none of Accept/Reject/Dispatch/Cancel/
  Force-Close/Resolve-Variance buttons appear.
- Did not touch `docs/ecosystem-architecture.md` or
  `WORKING_FEATURES_REGISTRY.md` — should be updated to list the new role if
  those documents enumerate POS roles.
- The Serial History drill-down feature bundled into this commit was not
  independently re-verified by this session — it was pre-existing work found
  already sitting in the working tree; only the migration-applied status was
  confirmed with the user before pushing.

## FOLLOW-UP NOTE

- Area: POS role-based access control
- Dependency: `permissions.js` SUPERVISOR_ROLES/MANAGEMENT_ROLES/ALL_ROLES
  arrays, and every frontend role-mirror list that duplicates them
  (documented drift risk already called out repeatedly in
  `frontend-pos/index.html` comments near `applyRoleBasedVisibility()`)
- Confirmed now: `receiving_clerk` is excluded from all three shared arrays
  and only explicitly listed on the 5 permissions it needs
- Not yet confirmed: live end-to-end test in the browser (see above)
- Risk if wrong: a future refactor that "cleans up" by folding
  `receiving_clerk` into `SUPERVISOR_ROLES` for convenience would silently
  give her Reports/Dashboard access again — the inline comments at each
  grant point exist specifically to prevent this
- Recommended next review point: first time she actually uses the account
  in production; also next time any new SUPERVISOR_ROLES-gated POS feature
  is added, check whether receiving_clerk needs (or must be kept out of) it
