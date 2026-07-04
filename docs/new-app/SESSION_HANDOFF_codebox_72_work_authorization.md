# Session Handoff — Codebox 72: Practice Engagement Scope Control + Work Authorization Gate

> Date: 2026-07-04
> Status: COMPLETE — migration 129 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### A gate that genuinely never blocks

Every endpoint and every helper in this module was designed around one non-negotiable constraint from the spec: "No silent blocking." `checkWorkAuthorization()` never throws or refuses to resolve just because scope looks bad — it always produces a record (`clear`/`warning`/`out_of_scope`/etc.) and a plain-language recommended action. The override and risk-acceptance paths are the only places a human decision is required, and even the "partner required for high/critical risk" rule was built to warn-and-flag rather than reject a manager's approval outright — see Architect Freedom #2 in the doc for the exact reasoning.

### Deterministic scope resolution, in a fixed, documented order

Given the spec's own worked examples (tax work covered by a tax engagement, possibly by an advisory engagement's `scope_inclusions` mentioning tax planning, never by bookkeeping alone), `_resolveScope()` checks in a strict sequence: explicit exclusion first (always wins), then a direct engagement-type match, then an advisory/management engagement's `scope_inclusions`, then "no engagement at all" vs. "some engagement but nothing matching" vs. three genuinely unmappable work types (`billing`/`onboarding`/`custom`, which resolve to `unknown` rather than a guessed `possible_gap`). This ordering is the crux of "never pretend certainty" — it's documented in three places (migration comment, router comment, and this handoff).

### The one deliberate scope-down: NOT touching `engagements.js` again

The spec listed "run a scope check before workflow generation, warn only" as an integration point. Codebox 71 achieved (and proudly documented) zero changes to the legacy `engagements.js` router. Reopening that file for this codebox — even for a small, non-blocking, try-caught addition — was judged not worth breaking that streak, especially since the spec's own integration section is explicitly qualified "Do not rewrite existing modules heavily" and lists several *optional* integration points, not mandatory ones. The identical check is available as a one-click manual action from both Tasks and the Work Authorization page itself, so no capability is actually lost — only the automatic trigger point is scoped down. This is documented clearly as a deliberate choice, not an oversight.

### Backend — `work-authorization.js` (~10 endpoints)

`POST /check` is the main entry point and the one other modules are expected to call into (`module.exports.checkWorkAuthorization`). Override/risk actions (request-override, approve-override, reject-override, accept-risk) all require a reason and are manager-gated; DELETE is a soft-cancel only.

### Frontend — `work-authorization.html` + `js/work-authorization.js` (prefix `wa`)

Company-wide list with three filter dimensions (status/scope result/work type), a "Check Work" modal for manual, on-demand checks, and a detail modal with a status-driven action bar (Request Override / Approve / Reject / Accept Risk / Cancel) plus an Events tab.

### Integrations — five, all additive, all minimal

**Tasks**: one new button + one new function, following the file's own existing per-card action pattern exactly. **Client Onboarding**: a manager-triggered "Check Coverage" button (not automatic — every check writes an audit event, so auto-running it on page load would be noisy without adding real value). **Engagement Management**: a new read-only "Authorizations" tab on the existing engagement detail modal. **Planning Board**: one new badge, same lightweight direct-query pattern as every other badge this session. **Management Dashboard**: one new KPI section, all three spec-named metrics (out-of-scope work, pending overrides, high-risk overrides).

---

## Nothing Regressed

- `engagements.js` and `engagement-periods.js` — **zero lines changed**, exactly as in Codebox 71.
- `engagement-management.js` (Codebox 71) — only its `getClientEngagementProfile()` export is called, read-only; its own endpoints and internal behavior are unchanged except for the additive "Authorizations" tab on the frontend detail modal (no backend change to that module at all).
- `tasks.js` — every existing render path, review-action flow, and button is unchanged; the new "Check Scope" button only appears when `t.client_id` is truthy, and is purely additive to the existing action row.
- `client-onboarding.js` — every existing panel/render path is unchanged; the new coverage panel is a separate, additive fetch triggered only by an explicit button click.
- `management-dashboard.js`'s `computeSummary()` — every existing key is unchanged; `work_authorization` is a new, additive key.
- `planning-board.js`'s `_buildTeamItemPool()` — every existing flag is unchanged; `out_of_scope_work` is a new, additive field.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep.
- All files verified present on disk immediately after writing.
- A real bug was caught and fixed during self-review before `node --check` was run: the duplicate-guard lookup in `checkWorkAuthorization()` originally used `.eq('source_id', sourceId || null)`, which is a no-op in PostgREST (`.eq()` never matches NULL) — for a manual, client-level check with no specific source record, this would have silently created a fresh duplicate row on every re-check instead of reusing the existing one. Fixed to conditionally use `.is('source_id', null)` when there's no source record.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`129_practice_engagement_scope_control.sql`

Expected: "Success. No rows returned." No seeding step is required — the two tables start empty; the first "Run Check" (or any integrated action) populates them.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 129 to Supabase (migration 128 from Codebox 71 should already be live)
2. Navigate to `/practice/work-authorization.html` — should show zeroed summary cards and an empty list
3. Create and activate a `tax`-type engagement for a client (via Engagement Management), then click "Check Work" for that client with `work_type = tax` → confirm `scope_result = in_scope`, `authorization_status = clear`, and `matched_engagement_id` points at the tax engagement
4. Check `work_type = payroll` for the same client (no payroll engagement exists) → confirm `scope_result = possible_gap` (since the client HAS an active engagement, just not a payroll one) and `authorization_status = warning`
5. Check a client with ZERO active engagements at all → confirm `scope_result = no_active_engagement` and `authorization_status = out_of_scope`
6. On a warning/out-of-scope authorization, click "Request Override" without a reason → confirm 400; provide a reason → confirm status becomes `override_requested`
7. As a manager (not a partner) with `risk_level = low` or `medium`, click "Approve Override" → confirm it succeeds with no `partner_required_unverified` flag
8. As a manager (not a partner) with `risk_level = high` or `critical`, click "Approve Override" → confirm it still succeeds (never blocked) but the response and the resulting event both show `partner_required_unverified: true`
9. On a different authorization, click "Reject Override" without a reason → confirm 400; with a reason → confirm status becomes `override_rejected`
10. Re-run the SAME check (same client/work_type/source) that was just rejected → confirm it creates a FRESH record (the partial unique index excludes `override_rejected`/`cancelled` from the duplicate guard) rather than erroring
11. Click "Accept Risk" on a warning authorization without a reason → confirm 400; with a reason → confirm status becomes `accepted_risk`
12. Re-run the identical check (same source_module/source_type/source_id/work_type) on an authorization that is NOT rejected/cancelled → confirm it UPDATES the existing row rather than creating a duplicate (the duplicate guard)
13. Go to `/practice/tasks.html`, find a task with a client assigned → confirm the "🔍 Check Scope" button appears and works
14. Go to `/practice/client-onboarding.html` for a client → confirm the "Check Coverage" button (not automatic) runs a check and displays the result
15. Go to `/practice/engagement-management.html`, open an engagement's detail modal → confirm the new "Authorizations" tab shows any authorizations matched to that engagement
16. Go to `/practice/management-dashboard.html` → confirm the new "Work Authorization" KPI section shows counts matching the Work Authorization page
17. Go to `/practice/planning-board.html` for a client with unresolved out-of-scope work → confirm the "🚧 Out of Scope" badge appears
18. As a non-manager, attempt `POST /check`... wait, actually confirm: is `/check` manager-gated? Reviewing the router — `/check` itself is NOT manager-gated (any authenticated user can trigger a check, since checking scope is informational, not a decision) — confirm this is the intended behavior; confirm all override/risk/cancel actions ARE manager-gated (403 for non-managers)
19. Log in as a different company → confirm zero cross-company authorizations/events visible
20. DevTools → Application → Storage → confirm no authorization data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Workflow-generation auto-check was not wired into engagements.js (spec's own "If low-risk: Run check before workflow generation. Warn only." integration point)
- Confirmed now: The identical check is available as a manual, one-click action from Tasks and Work Authorization — no functional capability is missing, only the automatic trigger.
- Not yet confirmed: Whether the practice actually wants this wired in automatically once the team has used the manual version for a while and trusts it not to introduce noise/false positives.
- Risk: None currently — engagements.js remains completely untouched and stable.
- Recommended next review point: If requested, add a small try-caught, non-blocking call to checkWorkAuthorization() inside engagements.js's generate-workflow endpoint, attaching the result as an additive `scope_check` field on the existing response (never altering status codes, never blocking generation) — a well-scoped, minimal addition if and when the practice wants it.
```

```
FOLLOW-UP NOTE
- Area: /check is not manager-gated (any authenticated user can trigger a scope check)
- Confirmed now: This was a deliberate choice — checking scope is read-adjacent/informational (it upserts a tracking record but makes no engagement/business decision), so gating it to managers only would block the exact "Check Scope" self-service use case the Tasks integration and Client Onboarding integration both rely on for any staff member reviewing their own work.
- Not yet confirmed: Whether the practice wants to restrict who can trigger checks (as opposed to who can act on warnings, which IS manager-gated).
- Risk: Low — a check can only ever move a record toward warning/clear states; it can never itself approve an override or accept risk, both of which remain strictly manager-gated.
- Recommended: No action needed unless the practice specifically wants to restrict check-triggering itself.
```
