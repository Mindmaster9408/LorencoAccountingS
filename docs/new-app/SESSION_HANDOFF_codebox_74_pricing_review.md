# Session Handoff — Codebox 74: Practice Pricing Review + Fee Adjustment Workflow

> Date: 2026-07-04
> Status: COMPLETE — migration 131 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### A governance layer, deliberately kept dumb about numbers

The single hardest constraint in this codebox's spec was explicit and repeated: the system may recommend a review *category* ("review realization", "review write-offs") but must **never** recommend a specific fee amount. Every other engine built this session (Profitability's `calculateProfitability()`, Work Authorization's `checkWorkAuthorization()`) computes a number or a verdict. This one deliberately does not. `buildPricingReview()` reads the current fee snapshot and the most recent saved profitability data, then returns only a suggested *reason* and a list of *evidence items* — `proposed_fee_basis`/`proposed_fee_amount`/`recommended_action` are always left blank for a human to fill in. This asymmetry (rich evidence gathering, zero fee computation) is the module's entire design center.

### Point-in-time fee snapshot, not a live link

`current_fee_basis`/`current_fee_amount` are copied onto a pricing review the moment it's created — a deliberate snapshot, documented in the migration header, so that if the engagement's live fee changes later for some unrelated reason, an in-flight review's record of "what the fee was when we opened this conversation" doesn't silently drift. The engagement's own `fee_amount`/`fee_basis` fields remain the only source of truth for "what is the fee right now."

### Approval is expected, never silently blocking

The workflow has a distinct `partner_review` status and an `approve` action, but — following the same precedent set by Work Authorization's override handling in Codebox 72 — approval by a team member who isn't recorded with an `owner`/`partner` role is never rejected outright. It succeeds, but the response carries `partner_approval_unverified: true` and the audit event records the approver's actual role, so the exception is visible and reviewable rather than either silently allowed or hard-blocked.

### Backend — `pricing-review.js`

`GET /prepare` (evidence-gathering, read-only), full review CRUD, evidence-item CRUD, 5 workflow actions built as literal `router.put()` handlers (not a generic transitions-map loop, since each action has slightly different side effects — e.g. `approve` needs the partner-verification flag, `reject`/cancel need a required `reason`), events log.

### Frontend — `pricing-review.html` + `js/pricing-review.js` (prefix `pr`)

A single reviews list (no multi-tab split was needed — unlike Profitability's Analysis/Snapshots/Reviews, this module has one primary object type) with a "New Pricing Review" modal. Selecting a client calls `/prepare` and pre-fills the suggested reason, current fee, and a checkbox list of suggested evidence items the user can accept or skip. Two permanent banners state the governance framing and the "never recommends a fee amount" rule.

### Integrations — five, all read-only reuse or query-string handoff

**Engagement Management**: a "Pricing" detail tab, same pattern as the existing Profitability tab. **Profitability**: a "Create Pricing Review" button that hands off `client_id`/`engagement_id` via the URL rather than either module calling into the other's internals. **Client Success**: a "Pricing Reviews" section plus a deterministic "commercial review due" flag (low margin + no active review in progress). **Management Dashboard**: a KPI block, count-only query. **Planning Board**: a `commercial_review_due` badge, same lightweight per-client-ID-set pattern as every other badge this session.

---

## Nothing Regressed

- `billing.js`, `engagements.js` — **not touched at all.**
- `profitability.js`'s engine (`calculateProfitability`) — not modified; only its frontend gained one new button that navigates away.
- `engagement-management.js` backend router — not modified; only its frontend gained one new read-only tab.
- `client-success.js`, `management-dashboard.js`, `planning-board.js` — every existing key/flag/export is unchanged; all Codebox 74 additions are new, additive keys (`pricing_review` KPI block, `commercial_review_due` flag, `pricingReviewsBody` panel).
- `node --check` passes on every new/modified JS file (verified individually as each was written, and as a full batch below).
- Two dead no-op leftovers (an empty-condition `if` block and a ternary with identical branches) were caught and removed from `js/pricing-review.js` during self-review, immediately after the file was written — the same category of bug flagged in Codebox 73's `client-success.js` and Codebox 66's `_syncItemFromDocumentRequest()`. Recurring lesson: always re-scan freshly-written frontend JS for accidental no-op conditionals before moving on.
- Full router chain (`require('./modules/practice/index.js')` with dummy `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`JWT_SECRET`) loads cleanly with `pricing-review.js` mounted.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`131_practice_pricing_reviews.sql`

Expected: "Success. No rows returned." No seeding step required — all three tables start empty.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 131 to Supabase (migration 130 from Codebox 73 should already be live).
2. Navigate to `/practice/pricing-review.html` — should show zeroed summary cards and both governance banners.
3. Click "New Pricing Review", select a client → confirm `/prepare` populates current fee (if the client has an engagement with one), a suggested reason, and any suggested evidence items (requires that client to have a saved Profitability snapshot from Codebox 73 testing).
4. Create a review with title + reason + at least one checked evidence item → confirm it appears in the list with status "Draft".
5. Open the review → Submit for Review → confirm status becomes "Under Review" and an event is recorded.
6. Send to Partner → confirm status becomes "Partner Review".
7. Approve as a non-partner-role team member → confirm the toast notes "approver is not recorded as a partner role" and the review still moves to "Approved".
8. Mark Implemented → confirm status becomes "Implemented" and — critically — confirm `practice_client_engagements.fee_amount`/`fee_basis` for the linked engagement are UNCHANGED (this module must never write to that table).
9. Create a second review and Reject it (with a reason) → confirm the rejection reason is stored and displayed.
10. Create a third review and Cancel it (with a reason) → confirm `DELETE` requires the reason field and 400s without one.
11. Add an evidence item manually via "Add Evidence Item" on an in-progress review → confirm it appears in the Evidence Items list.
12. Go to `/practice/engagement-management.html`, open an engagement with a linked pricing review → confirm the new "Pricing" tab lists it.
13. Go to `/practice/profitability.html`, run an analysis for a client, click "Create Pricing Review" → confirm it navigates to Pricing Review with the New Review modal pre-opened and pre-filled for that client.
14. Go to `/practice/client-success.html`, open a client with a low-margin Profitability snapshot and no active pricing review → confirm the "📌 Commercial review due" flag appears; create an active review for that client → confirm the flag disappears on next detail open.
15. Go to `/practice/management-dashboard.html` → confirm the new "Pricing Reviews" KPI section shows counts matching the Pricing Reviews page.
16. Go to `/practice/planning-board.html` for a client with the same low-margin-no-active-review condition → confirm the "📌 Commercial Review Due" badge appears on that client's work items.
17. As a non-manager, attempt to create/update/action a review or evidence item → confirm 403 on each; confirm all `GET` reads still succeed.
18. Log in as a different company → confirm zero cross-company reviews/items/events visible.
19. DevTools → Application → Storage → confirm no pricing-review data in localStorage/sessionStorage/IndexedDB.

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: "implemented" pricing reviews currently have no consumer — they record that a commercial decision was accepted, but nothing yet acts on that fact
- Confirmed now: implement() only sets pricing_status = 'implemented', implemented_by, implemented_at. practice_client_engagements is never touched by this module, by design.
- Not yet confirmed: Whether a future codebox should read implemented reviews and offer a partner-triggered "apply this fee to the engagement" action (still requiring explicit confirmation, never automatic), or whether fee changes should continue to happen manually in Engagement Management with the pricing review serving purely as the audit trail.
- Risk: Low today — no data integrity risk, since nothing currently consumes "implemented" reviews. Would become relevant only if/when that future codebox is built.
- Recommended next review point: When engagement fee-editing is revisited, decide whether to wire "implemented" pricing reviews into that flow as a documented follow-up.
```

```
FOLLOW-UP NOTE
- Area: partner-approval verification uses the same team-member role check as every other module (owner/partner), not a dedicated "verified partner" flag
- Confirmed now: approve() checks _isPartner(member) (role in ['owner','partner']) and flags partner_approval_unverified: true when false, but never blocks the approval itself — consistent with the Work Authorization precedent from Codebox 72.
- Not yet confirmed: Whether partners specifically want approvals by non-partner managers to be hard-blocked instead (a stricter reading of "partner approval" as a hard gate rather than a flagged exception).
- Risk: Low — the flag is always visible in both the API response and the event's metadata, never hidden.
- Recommended: No action needed unless partners explicitly request approval to be hard-gated to the partner role.
```
