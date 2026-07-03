# Session Handoff — Codebox 65: Secretarial Beneficial Ownership + Ownership Chain Foundation

> Date: 2026-07-03
> Status: COMPLETE — migration 122 NOT yet applied to Supabase — not committed or pushed
> Codeboxes 60-64 are ALSO still uncommitted from prior session turns — all six are staged together for the next push.

---

## What Was Built

### An audit that ruled out a false-positive collision before writing schema

Before migration 122, a search for pre-existing beneficial-ownership tables/code (per RULE A1) found `'beneficial_ownership'` already appears — but only as a plain `TASK_TYPE`/`DEADLINE_TYPE` enum value (migration 011, and a compliance-suggestion entry in `index.js`), a lightweight tag on unrelated tables, not a recordkeeping system. Confirmed no real collision; both untouched.

### One shared percentage function serving two different tables

The spec's Percentage Logic section describes rules that read as if written for a single generic "record" (owner OR chain): manual override wins; direct owner uses direct percentage; a chain multiplies its steps; otherwise unknown, never guessed. `_calcEffectivePercentage()` implements this once and is called from both `POST/PUT /owners` (which never populates `chain_path`, so that branch is naturally skipped) and `POST/PUT /chains` (which does) — one function, not two near-duplicates, with the exact same "never guess" discipline in both call sites.

### Readiness generation designed for incremental growth, not a one-shot wall

Unlike Codebox 63's checklist generation (which blocks a second call unless `?force=true` clears and rebuilds everything), `_generateReadinessItems()` here is idempotent by construction: it only inserts items for `(beneficial_owner_id | ownership_chain_id, item_type)` combinations that don't already exist. This matters because BO registers are built up incrementally over weeks — adding a third beneficial owner next month and clicking "Generate Items" again should add exactly the new items that owner needs, not either duplicate everything or refuse to run again. This was a deliberate design choice under "Architect Freedom: readiness scoring... helper functions," not something the spec mandated literally.

### A genuine schema-fit wrinkle, documented rather than hidden

`bo_readiness_recalculated` is inherently a client-level event (the whole readiness picture was recomputed, not one specific item), but the migration's `source_type` CHECK constraint only allows `beneficial_owner`/`ownership_chain`/`readiness_item` — there's no `'client'` option. Rather than silently picking something and hoping nobody notices, this was resolved explicitly: `source_type='readiness_item'` is reused with `source_id` set to the `clientId` itself, documented in-code as a placeholder (not a real readiness_item id), with the event's own `client_id` column being the reliable field to filter on. This is called out in both the code comment and the documentation so a future reader querying `source_id` for this one event type isn't misled.

### Backend — `beneficial-ownership.js` (~26 endpoints)

Key judgment calls:

**`is_reportable` computation treats "unknown" as a real, distinct state — never coerced to false.** `reporting_threshold_met` is `null` (not `false`) whenever `effective_percentage` itself is `null`. This matters because BO compliance is exactly the domain where "we haven't determined this yet" and "this person doesn't meet the threshold" are meaningfully different statements, and conflating them would understate reportable risk.

**Linking validation (`root_holder_reference_id`, `ultimate_owner_id`) is independently re-verified against the SAME client's records**, not just checked for existence anywhere in the company — a shareholder or beneficial owner belonging to a different client can never be silently linked into the wrong client's chain.

### Frontend — `beneficial-ownership.html` + `js/beneficial-ownership.js` (prefix `bo`)

- Summary cards, client picker (with `?client_id=` deep-link support), a readiness banner showing live score/status/reportable-count/missing-info-count, and 4 tabs (Beneficial Owners / Ownership Chains / Readiness / Events)
- The Beneficial Owners tab shows direct shareholders read-only alongside beneficial owners, for the "who's a direct holder vs. who's the ultimate owner" comparison the spec's UX goal calls for
- Readiness items update inline via a per-row status dropdown — no separate edit modal needed for the single field that changes most often
- No graph visualization (explicitly out of scope per Future Enhancements), no chart library, no AI

### Integrations

**Secretarial page** (Codebox 62): a "Beneficial Ownership" panel alongside the existing Statutory Changes/Governance panels (Codeboxes 63-64).
**Client Detail**: Section 22 now also shows BO readiness status, reportable owner count, and missing information count.
**Planning Board**: a `bo_readiness_concern` flag — scoped to blocked required items only (a cheap, plain query), not the full readiness score, per the spec's own "Optional" marking and this session's established preference for lightweight badge queries over per-client score replication.
**Management Dashboard**: a new "Beneficial Ownership" KPI section — verified/incomplete owner counts, reportable owner count, clients-with-blocked-items count — following the identical low-risk, count-only precedent Codebox 61 set for its Client Relationship section.
**Secretarial Governance**: NOT integrated this pass — see Follow-Up Notes below.

---

## Nothing Regressed

- `secretarial.js` (Codeboxes 62-64) — completely untouched by this codebox; `beneficial-ownership.js` does not require or call into it.
- `secretarial.html`/`js` — the existing Corporate Profile/Directors/Shareholders/Annual Returns/Timeline/Statutory Changes/Governance panels are unchanged; the new "Beneficial Ownership" panel is purely additive.
- `client-detail.js`'s Section 22 — the existing status/directors/changes/governance lines are unchanged; the BO line is a new, additively-appended block wrapped in its own try/catch.
- `planning-board.js`'s `_buildTeamItemPool()` — the existing at-risk-client (Codebox 61), annual-return-due (Codebox 62), and pending-statutory-change (Codebox 63) flags are unchanged; `bo_readiness_concern` is a new, additive field.
- `management-dashboard.js`'s `computeSummary()` — every existing key (including `client_relationship` from Codebox 61) is unchanged; `beneficial_ownership` is a new, additive key computed via two extra count-only queries.
- `practice_company_shareholders` (Codebox 62) — read-only throughout; never written to by this codebox.
- `secretarial-workflows.js`, `secretarial-governance.js`, `client-success.js`, `client-health.js`, `work-queue.js`, `capacity.js`, `delegation.js`, `skills-matrix.js`, `learning-centre.js`, `notifications.js` — completely untouched.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run, in order:
1. `117_practice_learning_centre.sql` (still pending)
2. `118_practice_client_success.sql` (still pending)
3. `119_practice_secretarial_foundation.sql` (still pending)
4. `120_practice_secretarial_workflows.sql` (still pending)
5. `121_practice_secretarial_resolutions_minutes.sql` (still pending)
6. `122_practice_secretarial_beneficial_ownership.sql`

Expected: "Success. No rows returned." for each.

No seeding step is required or provided — beneficial owners, ownership chains, and readiness items all start empty and are created entirely by managers as needed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migrations 117 through 122 to Supabase
2. Navigate to `/practice/beneficial-ownership.html` — should show zeroed summary cards and an empty client picker prompt
3. Select a client → confirm the Beneficial Owners tab shows any existing direct shareholders (from the Shareholder Register) read-only, and an empty beneficial owners list
4. Add a natural person owner with `direct_percentage: 30` → confirm `effective_percentage` auto-calculates to 30, `calculation_method: 'direct'`; confirm the readiness banner updates
5. Add a trust owner with no percentage fields → confirm `effective_percentage` is `null`, `confidence: 'unknown'`, and `missing_information` explains why
6. Add an ownership chain with `chain_path: [{"holder_name":"ABC Trust","holder_type":"trust","percentage":60},{"holder_name":"XYZ Co","holder_type":"company","percentage":50}]` → confirm `effective_percentage` = 30 (60% × 50%), `calculation_method: 'multiplied_chain'`, `confidence: 'medium'`
7. Click "Generate Items" on the Readiness tab → confirm items appear matching each owner's type (identity for all, address for the natural person, trust deed for the trust) plus one chain-support item and one review item
8. Update several readiness items to "Received"/"Verified" → click "Recalculate" → confirm the readiness banner status/score updates and an event is logged
9. Set one required readiness item to "Blocked" → confirm the readiness status becomes "Blocked" regardless of score; go to `/practice/planning-board.html` for that client → confirm the "🛑 BO Readiness Blocked" badge appears
10. Click "Verify" on the natural person owner → confirm status becomes "Verified" and `verification_status` becomes "verified"; confirm an event is logged
11. Click "Verify" on the ownership chain → confirm `chain_status` becomes "Verified"
12. Click "Generate Items" again after adding a NEW owner → confirm only new items for the new owner are created, existing items/statuses untouched
13. Go to `/practice/secretarial.html`, select the same client → confirm the "Beneficial Ownership" panel shows matching readiness status, reportable count, and missing info count
14. Go to `/practice/client-detail.html?id=<clientId>` → confirm the Secretarial section's summary line includes "BO readiness: ..."
15. Go to `/practice/management-dashboard.html` → confirm the new "Beneficial Ownership" KPI section renders with plausible counts
16. As a non-manager, attempt to create/edit/verify/archive any owner or chain, or update a readiness item → confirm 403 on each; confirm all `GET` reads still succeed
17. Attempt to create a chain with `ultimate_owner_id` pointing to a beneficial owner belonging to a DIFFERENT client → confirm 400
18. Log in as a different company → confirm zero cross-company owners/chains/readiness items/events visible
19. DevTools → Application → Storage → confirm no BO data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Secretarial Governance integration ("link resolutions to BO readiness where safe") was not built
- Confirmed now: The spec marks this fully "Optional." Neither practice_secretarial_resolutions (Codebox 64) nor practice_bo_readiness_items has an existing cross-reference field to the other, and adding one would mean altering an already-applied table from Codebox 64 for a feature explicitly marked optional in this codebox — judged not worth the risk for an optional integration with no concrete UI requirement given.
- Not yet confirmed: Whether a real workflow need exists (e.g. "this resolution formalizes a beneficial owner's appointment") that would justify a resolution_id column on practice_beneficial_owners, or vice versa.
- Risk: None currently — no functionality is broken; a genuinely optional, unspecified integration was correctly left unbuilt.
- Recommended: If this becomes a real need, add a nullable resolution_id to practice_beneficial_owners (mirroring how practice_secretarial_decisions already links to resolutions) rather than the reverse — a beneficial owner record is the more natural "many can reference one resolution" side of that relationship.
```

```
FOLLOW-UP NOTE
- Area: bo_readiness_recalculated event's source_id is a placeholder (the clientId), not a real readiness_item id
- Confirmed now: The migration's source_type CHECK constraint (beneficial_owner | ownership_chain | readiness_item) has no 'client' option, and this event is inherently client-level, not tied to one item. Documented explicitly in code and in docs/new-app/65_beneficial_ownership.md Architect Freedom #6 — the event's own client_id column is what should be used to filter/query this event type, never source_id.
- Not yet confirmed: Whether a future codebox reading practice_beneficial_ownership_events generically (across all source_types) needs to special-case this, or whether it's better to add a genuine 'client' source_type value in a later, dedicated migration.
- Risk: Low — purely a documentation/data-modeling nicety; no data integrity or multi-tenant issue, since client_id is still correctly set and company_id scoping is unaffected.
- Recommended: Revisit only if a future codebox needs to treat all beneficial-ownership events uniformly by source_id — until then, the documented exception is sufficient.
```

```
FOLLOW-UP NOTE
- Area: Planning Board and Management Dashboard BO integrations only check for 'blocked' readiness items, not the full incomplete/partial/ready score
- Confirmed now: Both integrations are explicitly "Optional" in the spec. Computing the full _computeReadiness() aggregation per client on every Planning Board/Dashboard load (rather than one shared client BO profile fetch) would mean N queries where N = number of clients with any BO data, on every unrelated page render — judged not worth the cost for an optional, secondary signal. "Blocked" is the single status genuinely urgent enough to warrant a badge on pages that aren't the BO page itself.
- Not yet confirmed: Whether managers will want to also see "incomplete" (not just "blocked") flagged on these secondary pages once real usage patterns emerge.
- Risk: Low — the full readiness picture is always one click away on /practice/beneficial-ownership.html; this is a badge-visibility scope decision, not a data gap.
- Recommended: If requested, this could be added as a cached/batch readiness-status lookup (compute once per company per page load, not per client) rather than naively running _computeReadiness() N times.
```
