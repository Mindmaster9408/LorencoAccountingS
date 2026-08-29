# Firmflow VAT Status Integration — Future Build

Status: **Not started.** Planning note only, written 2026-08-29 per Ruan's request during the
VAT Reports rebuild session. No code has been written for this yet.

## The Opportunity

Firmflow (`backend/frontend-practice`) already has the right home for cross-client compliance
tracking — `sars-recon.html`, `tax-dashboard.html`, `tax-pipeline.html`, `deadlines.html` — and
VAT already appears across these as one of several tax types. But none of them are wired to
Leo's real VAT data. Confirmed by search: no reference to `vat_periods`, `vat_reconciliations`,
or the Control Account Tie-Out anywhere under `backend/modules/practice`.

Practically, this means Firmflow's VAT rows today are whatever a human typed in (a due date,
a status) — not the true state of the period in Leo. It doesn't know:
- whether a client's VAT period is DRAFT / APPROVED / LOCKED in `vat_periods`
- whether the reconciliation has been authorized/approved in `vat_reconciliations`
- whether the Control Account Tie-Out (built 2026-08-29, in `vat.html`'s Reconciliation tab)
  shows a non-zero difference that still needs investigating before that period should be
  trusted for filing

Wiring real status into Firmflow would let an accountant see, across every client, which VAT
periods are genuinely ready to file versus which still have an open discrepancy — without
opening each client's Leo instance one by one.

## Hard Architectural Constraint (do not violate)

**Leo is single-company-scoped by design, on every VAT endpoint, always.** `req.companyId`
comes from the authenticated session's selected company (JWT), and every `vat-recon`/`vat`
route filters by that one `company_id`. There is no cross-tenant query anywhere in the
accounting module, and there must never be one — this is the same multi-tenant safety
boundary audited in `docs/accounting/VAT_FORENSIC_AUDIT.md` (§13) and is a hard rule, not an
oversight to "fix" by opening it up.

**Consequence:** a cross-client VAT status view can only be built by *Firmflow* calling into
Leo **once per client company**, looping over the practice's `eco_clients` → their linked
`companies.id`, and aggregating the per-company results itself. Leo does not gain a new
"give me everyone's VAT status" endpoint. The aggregation, and the authorization to see across
clients, belongs entirely to the practice layer, which already has that concept (a practice
user's session already spans multiple client companies by nature of the practice model).

## Rough Shape (not designed in detail yet)

1. A new practice-side service that, for each client company under the logged-in practice:
   - calls the existing `GET /api/accounting/vat-recon/periods` (or a lighter equivalent) for
     that one `companyId`
   - calls `GET /api/accounting/vat-recon/reconciliations/period/:periodKey` for the current
     open period, to read `status`, `diff_authorized`, `soa_authorized`
   - reuses the Control Account Tie-Out math (already built in `vat.html` / could be exposed
     as a reusable Leo endpoint returning just the difference, e.g.
     `GET /api/accounting/vat-recon/periods/:id/tie-out`, rather than duplicating that logic
     in Firmflow) to get a pass/fail flag per client per period.
2. Firmflow renders this as a table/dashboard: client | period | status | tie-out flag |
   days until due — presumably surfaced on `sars-recon.html` or `tax-dashboard.html` rather
   than a brand-new page, since those already exist as the intended home.
3. Performance: this means N sequential (or parallelized) calls into Leo for N clients every
   time the dashboard loads. Needs a sensible caching/refresh strategy once real client counts
   are large — not a concern yet at current scale, but should not be assumed away later.

## Open Questions (for whenever this is picked up)

- Does the practice backend already have a clean "list of client companies I manage" lookup to
  loop over, or does that need building too? (Likely yes via `eco_clients` — not confirmed.)
- Should the Control Account Tie-Out check become a proper reusable Leo endpoint (recommended,
  avoids duplicating the math in two modules) or should Firmflow just re-derive it from raw
  trial-balance/report data it pulls itself?
- Where exactly does this render — a new tab on `sars-recon.html`, or a new row-type on
  `tax-dashboard.html`? Not decided.

## Related

- `docs/accounting/VAT_FORENSIC_AUDIT.md` — original audit, multi-tenant safety section (§13)
- `docs/future-build/VAT_ENGINE_FUTURE_ROADMAP.md` — the underlying VAT201 engine vision
- `accounting-ecosystem/frontend-accounting/vat.html` — Reconciliation tab, Control Account
  Tie-Out implementation (2026-08-29)
