# Workstream 100 — Company-Link Dual Supplier/Customer Mirroring + Recon Statement — Implemented + Live Verified

## Background

Follow-on from Workstream 99. The user's confirmed design rule: "as daar supplier by een is word hy customer by die ander een gemaak" (if there's a supplier on one side, it must become a customer on the other) — then extended in this workstream to: both companies must have BOTH record types for each other (a company can sell to *or* buy from its trading partner at different times), and there must be a report where both sides' invoices "vergelyk met mekaar en recon met mekaar" (compare and reconcile with each other).

Confirmed scope before building:
- On relationship activation, auto-create the missing supplier/customer record on BOTH sides — always both types on both sides, not just a mirror of whichever type was requested.
- New POS report: both companies' invoices side by side, matched/reconciled.

## Part 1 — Dual mirroring (`company-links.js`)

`ensureMirroredRecords(relationship)` runs after `POST /:id/confirm` brings a relationship to `active`. For each of the two companies, it checks (by `linked_relationship_id`, never `company_id` alone — the same lesson learned the hard way in Workstream 99) whether a supplier row and a customer row already exist for this relationship; whichever is missing gets auto-created, named after the partner company (`companies.trading_name` or `company_name`), with `link_status: 'active'` from the moment it's created. An existing, manually-created record (e.g. the one that originated the link request) is always reused, never duplicated or overwritten.

Each auto-created record is logged via the new `COMPANY_LINK_MIRROR_RECORD_CREATED` POS audit event (`posAuditLogger.js`), written with `logPosEvent()` directly (not `posAuditFromReq`) since the function must write audit rows for **both** companies, only one of which is the actual confirming request's `req.companyId`.

## Part 2 — Recon statement (`GET /api/pos/company-links/:id/statement`)

Because `inter_company_invoices` is a single shared row per invoice (`sender_company_id`/`receiver_company_id` on the same row — see Workstream 87's InvoiceSender reuse), the two companies' figures can never numerically disagree with each other the way two independent ledgers could. The real reconciliation signal this report surfaces is **approval/payment lag**: has the receiving side approved it yet, is it paid, or is it disputed. Each invoice between the relationship's two companies (either direction) gets a `reconStatus`:

| reconStatus | Meaning |
|---|---|
| `reconciled` | `payment_status = 'paid'` |
| `disputed` | `receiver_status = 'rejected'` |
| `awaiting_approval` | `receiver_status = 'pending'` |
| `partially_paid` | `payment_status = 'partial'` |
| `approved_unpaid` | approved but nothing paid yet |

Response includes a summary (`totalSold`, `totalBought`, `netBalance`, `totalOutstanding`) computed relative to the requesting company, so the same relationship produces a correctly mirrored (flipped sold/bought) view from either side. Gated on `PURCHASE_ORDERS.VIEW` (`SUPERVISOR_ROLES`) — a superset of the `INVENTORY.ADJUST` (`MANAGEMENT_ROLES`) tier that already gates the Company Link section, so nobody who can see the new "View Statement" button gets a 403.

## Frontend

Settings → Suppliers → edit a linked supplier → Company Link panel now has a **View Statement** button next to Revoke, opening a modal with 4 summary tiles (Sold / Bought / Net Balance / Outstanding) and a scrollable invoice table (date, invoice #, direction, total, outstanding, recon-status badge). Dark-theme vars throughout (`var(--surface)`, `var(--border)`, `var(--text)`, `var(--text-secondary)`, `var(--text-muted)`, `var(--accent)`).

Note: the pre-existing status-note copy in this same panel ("No pricing, stock, or invoice data is shared automatically") was left untouched — still accurate, since mirroring only creates empty supplier/customer *records*, never shares actual pricing/stock/invoice data.

## Live Verification

Two fresh isolated test companies + one dual-access test user, run against the real production Supabase via the actual Express routes (not direct DB manipulation) for every assertion that matters. 25 assertions, all passed:

| Check | Result |
|---|---|
| Company A's pre-existing supplier record for B is reused, not duplicated, on confirm | PASS |
| Company B gets an auto-created supplier record for A | PASS |
| Company A gets an auto-created customer record for B | PASS |
| Company B gets an auto-created customer record for A | PASS |
| All four auto/reused records read `link_status: 'active'` | PASS |
| Auto-created records are correctly named after the partner company | PASS |
| Exactly one supplier + one customer per company per relationship (no duplicate-on-duplicate-confirm risk) | PASS |
| Statement endpoint: 3 synthetic invoices (2 sold, 1 bought, one direction each of paid/approved-unpaid/pending) all appear, correctly directioned | PASS |
| Summary totals (totalSold, totalBought, netBalance, totalOutstanding) correct for Company A | PASS |
| Same relationship's statement from Company B's side shows correctly mirrored (flipped) totals | PASS |
| `reconStatus` computed correctly for reconciled / approved_unpaid / awaiting_approval cases | PASS |
| Non-existent relationship id returns 404 | PASS |

## Cleanup

All synthetic invoices, the test relationship, and both mirrored supplier/customer rows were hard-deleted. The two test companies and the dual-access test user could not be hard-deleted (blocked by a real FK from `audit_log`, populated by the test login/select-company/link actions going through the real API) — deactivated instead (`is_active: false`), the same pattern used for every prior workstream's test cleanup this session.
