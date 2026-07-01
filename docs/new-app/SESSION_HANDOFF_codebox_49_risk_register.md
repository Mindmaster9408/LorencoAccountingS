# Session Handoff — Codebox 49: Practice Risk Register + Internal Control Matrix

> Date: 2026-07-01
> Status: COMPLETE — migration 107 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Migration 107

Creates four tables — all `IF NOT EXISTS`, safe to re-run:

- **`practice_risks`**: One row per risk. 12-value `category` CHECK, 6-value `status` CHECK. `likelihood`/`impact` (1–5 each). `inherent_risk` always server-calculated (`likelihood * impact`, 1–25) — never accepted from the client. `residual_risk` manual (1–25, nullable). `review_frequency` 5-value CHECK. `source_type`/`source_id` nullable pair for QMS/Knowledge Base/Tax Dispute/Completion Pack provenance (direct columns, not a link table — a risk has at most one source). Auto-`updated_at` trigger. 7 indexes including a heat-map-optimized `(company_id, likelihood, impact)` index and a **partial unique index** (`uq_prisk_active_title_client`) enforcing the spec's duplicate rule at the DB level.
- **`practice_risk_controls`**: Internal Control Matrix. `control_type` is free TEXT (spec gave no "Allowed" list, matching the established Codebox 47 convention for unlisted enum-like fields). `effectiveness` 3-value CHECK. `is_active` boolean added for soft-delete (not in the spec's literal field list, but required to implement the requested "CRUD Controls" `DELETE` endpoint per this codebase's consistent never-hard-delete convention).
- **`practice_risk_reviews`**: Review history. Two-step lifecycle (draft → completed) with frozen snapshot fields (`likelihood_at_review`, `impact_at_review`, `residual_risk_at_review`) that never change after completion, even if the parent risk's current values change later.
- **`practice_risk_events`**: Append-only audit log covering risk/control/review-level events in one table (`control_id`/`review_id` nullable).

---

### Backend — `risk-register.js` (24 endpoints)

Key behaviours and judgment calls:

**`inherent_risk` is always server-calculated:**
Never accepted from the request body — always `likelihood * impact`, recomputed on create and on any `PUT /risks/:id` that changes either factor. This directly implements the spec's "Overall Rating" requirement without letting the client desynchronize it from the underlying likelihood/impact.

**`residual_risk` is manual (judgment call, consistent with Codebox 48's `quality_score` precedent):**
No automatic control-effectiveness discount formula (e.g. "3 effective controls reduce residual risk by X%"). Staff assess and enter it directly, either via `PUT /risks/:id` or when completing a review. This mirrors the same reasoning documented for QMS quality scores — manual entry now, automatic scoring can be layered on later without breaking existing values.

**Create-from-source client_id resolution — three different strategies:**
- `create-from-tax-dispute` / `create-from-completion-pack`: source tables carry `client_id` directly — inherited automatically
- `create-from-finding`: `practice_quality_findings` has no `client_id` column — resolved via the finding's parent `practice_quality_reviews.client_id` (an extra lookup query)
- `create-from-knowledge-article`: `practice_knowledge_articles` has no client concept at all (practice-wide, not client-specific) — `client_id` stays null unless explicitly passed in the request

**Duplicate guard — app layer + DB layer:**
- Application: `_findActiveDuplicate` does a case-insensitive title match scoped to the same `linked_client_id` (or no client), excluding `closed`/`cancelled` — returns 409 with `existing_risk_id`
- Database: partial unique index `uq_prisk_active_title_client` using `lower(title)` and a `COALESCE(linked_client_id, -1)` sentinel (PostgreSQL unique indexes don't treat two NULLs as equal, so the sentinel makes "no linked client" duplicates catchable too)

**Bug caught and fixed during this session:** The first draft of `_findActiveDuplicate` used `.eq('linked_client_id', linkedClientId || null)`, which is broken — PostgREST's `.eq()` never matches SQL NULL (a `column = NULL` comparison is always false/unknown in SQL, not "match null"). Fixed to branch between `.eq()` (when a client ID is given) and `.is('linked_client_id', null)` (when none is given), which is the correct PostgREST idiom for NULL checks.

**Multi-tenant:** Every query scoped to `req.companyId`. `_verifyRisk`, `_verifyControl`, `_verifyReview` re-verify ownership before every mutating action. `_verifyLinkedRecordOwnership`-equivalent checks happen inline in `_createFromSource` for all 4 source tables.

**Audit:** `_writeEvent` writes to `practice_risk_events` (append-only) on every risk/control/review lifecycle change, with `controlId`/`reviewId` passed through an options object so the same helper serves all three levels. `auditFromReq` writes to the shared ecosystem audit trail.

---

### `index.js` + `layout.js`

`risk-register` router mounted at `/risk-register` after the `/qms` block. "Risk Register" nav entry added between "Quality" and "Tax Config".

---

### Frontend — `risk-register.html` + `js/risk-register.js` (risk prefix)

- Summary cards (7): Open, Monitoring, Mitigated, Accepted, Closed, High Inherent Risk (≥15), Review Overdue — status cards clickable to filter
- **Heat map**: 5×5 colour-graded grid (blue → amber → red by count), likelihood rows 5→1 top-to-bottom, impact columns 1→5 left-to-right (conventional orientation), each cell clickable to filter the table to that exact combination
- Filter bar: category, status, client ID, free-text search
- Risks table: category chip, status pill, title, client, inherent/residual rating badges (colour-coded low/medium/high/critical by score band), next review date
- Create Risk modal — full field set
- Detail modal — 4 tabs:
  - **Overview**: metadata grid + mitigation/contingency/monitoring notes + source provenance (if created from another module)
  - **Controls**: effectiveness-badged list, add/remove
  - **Reviews**: history with snapshot display, schedule + complete actions
  - **Events**: full append-only audit log
- Complete Review modal: likelihood, impact, residual risk, next review date, notes — pre-filled from the risk's current values
- Context-sensitive footer: non-terminal → Close Risk + Cancel; closed/cancelled → Reopen
- `?source_type=X&source_id=Y` URL params render an info banner listing risks created from that source (via `GET /risks?source_type=&source_id=`), with a "Create one ↗" quick action that calls the matching `create-from-*` endpoint directly

### Integration Links (Codebox 49)

A small "Risk ↗" link was added in four places, additive only:
- `quality-management.js` — per-finding action row, alongside Resolve/Verify/Cancel → `?source_type=quality_finding&source_id=<id>`
- `knowledge-base.js` — article detail footer → `?source_type=knowledge_article&source_id=<id>`
- `tax-disputes.js` — dispute footer, alongside "Knowledge ↗" → `?source_type=tax_dispute&source_id=<id>`
- `tax-completion.js` — completion pack footer, alongside "Knowledge ↗"/"Procedure ↗"/"QMS Review ↗" → `?source_type=completion_pack&source_id=<id>`

---

## Nothing Regressed

- All existing practice routers: untouched
- Paytime: not touched (Codebox 49 has zero payroll-file overlap; no auto-trigger files touched)
- `quality-management.js`, `knowledge-base.js`, `tax-disputes.js`, `tax-completion.js`: only a new link appended to each existing render function; no existing buttons, endpoints, or logic changed
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` introduced in any new or modified file (confirmed via grep — the only match found was a pre-existing comment in `tax-completion.js`, not actual usage)
- `node --check` passes on `risk-register.js` (backend), `js/risk-register.js` (frontend), and all modified frontend JS files
- Every file re-verified present on disk via `ls` immediately after writing (per the file-write reliability discipline carried over from prior codeboxes)

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `107_practice_risk_register.sql`

Expected: "Success. No rows returned."

Apply previous migrations first if not done:
1. `105_practice_sop_library.sql` (with the `under_review` patch)
2. `106_practice_qms_foundation.sql`
3. `107_practice_risk_register.sql`

---

## Testing Required

*None of the following has been browser-tested. All verification was code-review, `node --check`, and grep for browser-storage violations only.*

1. Apply migration 107 to Supabase
2. Navigate to `/practice/risk-register.html` — summary cards load (all zero), empty heat map, empty table
3. Create a risk (title, category, likelihood 4, impact 5) → confirm `inherent_risk` = 20, shows in the "critical" rating band
4. Confirm the heat map now shows a count of 1 in the Likelihood-4/Impact-5 cell
5. Click that heat map cell → confirm the table filters to just that risk
6. Add a control (title, effectiveness) → confirm it appears in the Controls tab
7. Remove the control → confirm it disappears (soft-removed, `is_active = false`)
8. Schedule a review → confirm a "Draft" review appears in the Reviews tab
9. Complete the review with likelihood 2, impact 3, residual_risk 4 → confirm the review snapshot shows L2×I3, residual 4; confirm the parent risk's `inherent_risk` recalculates to 6 and `residual_risk` updates to 4
10. Try creating a second risk with the exact same title (any case) and no client → confirm 409 with `existing_risk_id`
11. Try creating a risk with the same title AND same linked client as an existing active risk → confirm 409
12. Create the same title again but with a DIFFERENT linked client → confirm success (duplicate guard is scoped per-client)
13. Close a risk → confirm status "Closed"; try editing it → confirm 422; Reopen it → confirm status "Open" again
14. From a Quality Finding → click "Risk ↗" → confirm it lands on risk-register.html with the source banner, offering "Create one ↗" if none exist
15. From a Knowledge Article, Tax Dispute, and Tax Completion Pack → same check for each
16. Use `create-from-tax-dispute` and `create-from-completion-pack` → confirm `client_id` is auto-inherited from the source
17. Use `create-from-finding` → confirm `client_id` is resolved via the finding's parent quality review
18. Use `create-from-knowledge-article` → confirm `client_id` is null unless explicitly passed
19. Log in as a different company → confirm zero cross-company risks/controls/reviews visible
20. DevTools → Application → Storage → confirm no risk register data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Residual risk — no automatic control-effectiveness calculation
- Confirmed now: residual_risk is manually entered (via PUT /risks/:id or when completing a review); no formula ties it to the number/effectiveness of active controls
- Not yet: An automatic residual-risk suggestion (e.g. "3 effective controls → suggest residual = inherent * 0.4")
- Risk: Low — manual entry is standard practice for risk registers at this scale; matches the same judgment call made for QMS quality_score in Codebox 48
- Recommended: If the practice wants computed suggestions, add an optional "suggest residual risk" endpoint that reads active controls' effectiveness and proposes a value — keep manual override available
```

```
FOLLOW-UP NOTE
- Area: Review scheduling — no automatic recurring review creation
- Confirmed now: Reviews are created manually via "Schedule Review"; review_frequency is stored on the risk but nothing automatically creates a new draft review when next_review_date arrives
- Not yet: A scheduled job or dashboard alert that auto-creates draft reviews when a risk's next_review_date passes (or is approaching)
- Risk: Medium — without this, review_frequency is descriptive only; overdue reviews rely on staff noticing the "Review Overdue" summary card
- Recommended: If the recommended Codebox 50 (Management Review Dashboard) surfaces overdue reviews prominently, that may be sufficient; otherwise consider a scheduled task in a future codebox
```

```
FOLLOW-UP NOTE
- Area: Control matrix — control_type is free text, not enum-constrained
- Confirmed now: control_type accepts any string (e.g. "preventive", "detective", "corrective", "directive" are suggested placeholder text in the UI, but nothing enforces these values)
- Not yet: A CHECK constraint or fixed dropdown if the practice wants standardized control-type reporting
- Risk: Low — matches the established precedent (Codebox 47's SOP category is also free text since the spec gave no "Allowed" list); free text is more flexible for a practice defining its own control taxonomy
- Recommended: If standardized reporting across control types becomes a requirement, add a CHECK constraint via a follow-up migration once the practice's preferred taxonomy is confirmed
```

```
FOLLOW-UP NOTE
- Area: create-from-source defaults — likelihood/impact default to 3/3 (medium) for all sources
- Confirmed now: All four create-from-* helpers default likelihood and impact to 3 unless explicitly provided in the request body
- Not yet: Smarter defaults based on source severity (e.g. a QMS finding with severity=critical could default to a higher likelihood/impact than one with severity=low)
- Risk: Low — defaults are always editable immediately after creation; this is a UX nicety, not a correctness issue
- Recommended: If desired, map finding severity → default likelihood/impact in a future refinement (e.g. critical→5, high→4, medium→3, low→2)
```
