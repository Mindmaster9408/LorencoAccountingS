# Sean — Path to "CFO" Roadmap

> Written 2026-07-22 from a planning conversation with Ruan. Read-only investigation
> was done first (no code changed) to ground this plan in what's actually built —
> see "Current State" below. Nothing in this document has been implemented yet.

---

## 1. The Vision

Sean should become a business advisor an accountant can actually consult — not a
generic chatbot bolted onto the ecosystem, but one that:

- **Understands** what's being asked (not just recognizes hardcoded phrases)
- **Remembers** what it's learned, so it gets faster/cheaper over time instead of
  "thinking from scratch" on every message
- **Is grounded in real numbers** — a specific client's actual cashflow, sales, GL
  data — not just generic tax knowledge
- **Shows its work** (citations) and **respects strict privacy boundaries**
  (industry-level anonymized learning, never cross-client data leakage)

That combination — not the LLM alone — is what makes it "a CFO", not just "ChatGPT
with a finance system prompt".

### One brain, contextual specialization

- **Sean Chat (general)** — broad, covers every aspect of the business
- **Sean in a Paytime context** — more focused on payroll, but still has access to
  the *same* underlying knowledge, so it can reason across domains when a question
  needs it (e.g. "should this director-shareholder be paid via dividends or salary
  this month?" spans payroll + company tax + individual tax at once — it must never
  be artificially walled off from that knowledge just because it's "the payroll one")
- **Coaching** — deliberately separate, deep, one-person-private (see §5 — explicitly
  deferred, not part of this roadmap's near-term scope)
- **Future**: the same industry-level learning pattern extended to POS/Inventory
  *process* data (stock turnover, seasonal sales patterns), so Sean can eventually
  advise on operational health, not just accounting

---

## 2. Current State (audited 2026-07-22, read-only)

### Already built and solid — reuse, don't rebuild

| Piece | Where | What it does |
|---|---|---|
| Intent routing | `app/api/chat/messages/route.ts` `classifyIntent()` | Regex/keyword classification into CALCULATION / TEACH / ALLOCATION / QUESTION / GENERAL |
| Codex | `lib/codex-engine.ts` | Structured tax rules, VAT rules, decision engines — queried before falling back to anything else |
| KB + LLM self-teaching loop | `lib/llm-bootstrap.ts` | Checks knowledge base first; if empty, asks a real LLM (Claude/OpenAI/Grok, configurable) and **saves the answer back into the KB** for next time |
| Bank allocation learning cascade | `lib/bank-allocations.ts` `suggestCategory()` | Client-specific learned rules → global rules → industry patterns → Codex → LLM fallback. `learnFromCorrection()` turns a human fix into a new learned rule |
| Industry-level anonymized learning | `lib/industry-learning.ts` | Patterns learned per SA industry (pre-seeded taxonomy incl. parent/child categories), **never tied to which client contributed** — occurrence count increments, contributor identity never stored |
| Privacy architecture | `lib/privacy.ts` | Per-client `dataIsolationLevel` (`STRICT` vs `INDUSTRY_LEARNING`) gate before any contribution; `anonymizeDescription()` strips account numbers/dates/amounts/phone/email before anything crosses client boundaries; `validateNoClientDataExposed()` is an explicit response-scanning safety check |
| Coaching module isolation | `accounting-ecosystem/backend/modules/coaching/*` | Already has its **own** JWT auth (`middleware/auth.js`), **own** DB access layer (`db.js`, direct `pg`), and a self-contained route set. Only 2 coupling points to the rest of the ecosystem: `services/photo-storage.js`'s use of the shared Supabase client, and the `has_coaching_access` gate that controls who even sees the tile. Genuinely close to extractable as its own product already. |

### Confirmed gaps — this roadmap exists to close these

1. **No live client financial data access anywhere.** Grepped the whole `app/`
   tree for cashflow/financial-data hooks — none exist. Sean can discuss generic
   tax rules or categorize a transaction description *typed in by the user*, but
   has zero connection to a client's actual cashflow/sales/GL data today. **This
   is the single biggest blocker to the whole vision** — everything else works
   better once this exists.

2. **Intent classification is regex-based, English-only, and will keep breaking
   as scope widens.** Concrete confirmed failure: the pattern `\bR\s*\d+` (meant
   to catch "Calculate VAT on R1000") also matches *any* message that happens to
   mention a Rand amount. Sean's own suggested prompt "What category is ENGEN
   SANDTON R850?" naturally rephrased as "What's this ENGEN SANDTON R850 for?"
   would get misclassified as a CALCULATION instead of an ALLOCATION, purely
   because it mentions "R850" — calculation is checked first. Separately, every
   pattern is hardcoded English (`what|how|why|should|could...`) — Afrikaans
   phrasing (which this practice actually uses daily) isn't recognized by any
   pattern and falls through to low-confidence GENERAL by accident, not by design.

3. **The "general question" path is tax/Codex-scoped only.** There is no
   category at all yet for open-ended "help me understand my business" questions
   — those would currently just miss and fall through to the KB/LLM bootstrap,
   which has no live data to reason over anyway (see gap #1).

4. **Minor code smell.** `chat/messages/route.ts` calls its own sibling API
   routes (`/api/reason`, `/api/codex/submit`) via self-HTTP `fetch()` with manual
   cookie re-forwarding, rather than calling the underlying functions directly.
   Adds latency and a fragile cookie-forwarding dependency. Worth fixing opportunistically
   when touching this file for Phase 2, not urgent on its own.

---

## 3. Recommended Build Order

**Rule for sequencing: don't start Phase 3 before Phase 1 is solid.** Accounting/tax
is already ~90% built (Codex, learning loop, industry patterns all exist) — get the
"CFO for accounting clients" experience genuinely excellent first, by adding the one
piece it's missing, before spreading effort into a third brand-new domain.

### Phase 1 — Live Data Connection (highest priority — do this first)

Build a company-scoped "financial context provider" that can safely fetch a
specific client's live cashflow/sales/GL summary on request, and wire it into the
existing chat pipeline so *any* current chat surface becomes grounded for whichever
client is in context.

Must-haves:
- Company/client scoping resolved from the **authenticated user's actual access**,
  never trusted from client-supplied input — this is non-negotiable given the
  cross-tenant exposure incidents found and fixed elsewhere in this ecosystem this
  same week (RLS gap on `payroll_snapshots` + 44 other tables; the `users.js`
  cross-company edit/delete gap). A live-data connector done carelessly here would
  repeat that exact class of mistake with even higher stakes.
- Every live-data-grounded answer must **cite what it used** — extend the existing
  citation convention (`[citationId]`) already used for Codex/KB answers to cover
  "as of [date], your cashflow was R[x], per [source]" style grounding, not bare
  conclusions.
- Respect `dataIsolationLevel` — a `STRICT` client's data must never flow into any
  shared/industry-level learning even via this new pathway.

### Phase 2 — LLM-based intent understanding, with a learned-pattern cache

Replace the regex `classifyIntent()` with the same cascade pattern already proven
in `suggestCategory()`:

1. Check a learned-pattern cache first (fast, free, no LLM call)
2. If the phrasing is novel, ask an LLM to classify intent (small, structured
   prompt — same style already used in `lib/allocation-engine.ts`'s
   `buildAllocationPrompt()`, which asks for an exact JSON shape back)
3. Persist that classification as a new learned pattern so the *next* occurrence
   (from anyone) skips the LLM call entirely

This naturally handles Afrikaans and English without hardcoding either, and stops
new phrasings from silently misfiring into the wrong intent bucket. Fix the
self-HTTP-fetch code smell (§2, gap 4) while in this file for Phase 2 work.

### Phase 3 — Extend industry-learning to POS/Inventory process data

Once Phase 1 + 2 are solid and proven for the accounting domain, apply the same
`industry-learning.ts` pattern to POS/Inventory operational data (stock turnover,
seasonal sales patterns, common vendor/product mixes per industry) — so Sean can
eventually advise on operational health ("why is your stock moving so fast/slow
compared to similar bakeries"), not just accounting categorization.

---

## 4. Constraints That Must Never Be Relaxed

- **Multi-tenant isolation discipline** applies with full force to the Phase 1
  live-data connector. Get this wrong and it's a repeat of the `payroll_snapshots`
  public-exposure incident and the cross-tenant `users.js` edit/delete gap found
  and fixed elsewhere in this ecosystem the same week this roadmap was written.
- **CLAUDE.md Rule F2 (Coaching hard isolation)** must never be weakened by any
  shared-knowledge-layer refactor done for Phases 1–3. Coaching's data must never
  enter any industry-learning pool or shared Codex, regardless of how tempting a
  "just reuse the same learning pipeline" shortcut looks.
- **A `STRICT`-privacy-level client's data must never contribute to industry
  learning**, even indirectly via the new live-data connector.

---

## 5. Explicitly Deferred (not in this roadmap)

- **Coaching backend.** Ruan confirmed the frontend chat UI (which he likes) has
  no backend behind it yet, but asked to deliberately *not* focus on Coaching right
  now — the architecture is already sound and well-isolated (§2 table), so this is
  a "come back later" item, not a gap that blocks anything else here.

---

## 6. Status

| Phase | Status |
|---|---|
| 1 — Live data connection | Not started |
| 2 — LLM-based intent + learned-pattern cache | Not started |
| 3 — POS/Inventory process learning | Not started |
| Coaching backend | Deferred by explicit user instruction |

Update this table as work progresses so a session that jumps back in later (from
working on another app) can see at a glance where things stand.
