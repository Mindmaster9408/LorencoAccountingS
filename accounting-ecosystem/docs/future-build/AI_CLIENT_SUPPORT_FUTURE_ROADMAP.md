# AI Client Support — Future Build Roadmap

**Status: deferred, not started.** Direction agreed 2026-08-18; nothing
implemented yet. Written up per Ruan's request to park this for later
rather than build it now.

## The business problem

Ruan wants to build client-facing support "in" so he doesn't need to hire
support staff right now — his instinct is AI. Specifically: clients are
going to chat with the system in natural language (English or Afrikaans),
and a purely rule-based bot won't handle the "difficult language and
explaining" part well.

## How this connects to existing project decisions

This sits directly on top of two standing decisions, and resolves a real
tension between them:

- [[project_sean_no_external_llm_intent]] — Ruan's stated design intent is
  that Sean must never call out to an external LLM. `sean-webapp` has 4
  call sites wired in anyway (dormant — no `LLM_API_KEY` set), built
  deliberately by Ruan himself on 2026-07-24, never removed.
- [[project_sean_roadmap_direction]] — the agreed autonomy model (human
  stays in the loop, autonomy only grows within one client's own data,
  never across clients). That memory is about *autonomy scope*; this one
  is about *external LLM usage* — a separate axis.

**2026-08-18 resolution of the tension:** the "no external LLM" intent was
about client financial data reaching a third party, not about LLMs as a
concept. A natural-language support chat realistically needs a real LLM
for the language/explanation part — that's solvable by scoping what data
ever reaches the LLM, not by avoiding LLMs entirely.

## What was actually found in the code (2026-08-18 audit)

Read all three dormant call sites directly (not just the memory summary)
to check what data each one actually sends externally, since that's what
determines whether "just turn it on" is safe:

| File | What it sends to the LLM | Client data exposure |
|---|---|---|
| `lib/llm-bootstrap.ts` | A **generic** SA tax/accounting question (e.g. "what is the VAT threshold") + a domain label | **None.** No client/account data of any kind. Answer is cached forever in the KB after the first call — one-time cost per unique question. |
| `lib/intent-classifier.ts` | The client's own raw chat message text, to classify intent (CALCULATION/TEACH/ALLOCATION/QUESTION/GENERAL) + domain | Whatever the client happens to type themselves — same exposure level as typing into any AI chat box. Already explicitly built to handle English **and Afrikaans**. |
| `lib/allocation-engine.ts` | A bank transaction's **description** string only (e.g. "WOOLWORTHS SANDTON") | No amounts, no balances, no account numbers. Occasionally a name in a salary description. |

None of the three send full account records, balances, or structured
client financial data. This is a materially safer starting point than the
"leaking client data to a third party" framing the original design intent
was reacting to.

## Recommended direction (not yet approved to build)

1. **Activate `llm-bootstrap.ts` and `intent-classifier.ts`** — set
   `LLM_API_KEY` / `LLM_PROVIDER` in `sean-webapp`'s environment. No new
   code needed; this is already fully built and just switched off.
   Directly addresses the stated need: general tax/accounting questions,
   explained naturally, in English or Afrikaans.
2. **Leave `allocation-engine.ts` (bank-transaction categorization) as its
   own, separate decision** — different use case, not part of client
   support chat, can be toggled independently.
3. Provider choice: not yet decided. Claude (Anthropic) was suggested as a
   natural fit since it's the model family the rest of this session already
   runs on, but Ruan hadn't confirmed this before asking to park the
   whole topic.

## What this does NOT cover — the bigger, unbuilt piece

The bootstrap system answers **general** tax/accounting knowledge
questions. It does **not** answer "why does *my* invoice/account look like
this" — a true client-specific Q&A bot needs Sean to first pull the actual
answer from real data (deterministically, from Lorenco's own systems), and
only hand the LLM an already-computed, minimal, non-sensitive fact to
phrase naturally — the LLM never sees raw account data or reasons about
the numbers itself. That separation (compute the fact vs. phrase the
fact) is not built. This is the natural "phase 2" once general-knowledge
support is live and proven.

## Next steps when picked back up

- Get explicit sign-off on provider (Claude vs. others) and confirm
  `LLM_API_KEY`/`LLM_PROVIDER` before flipping the switch.
- Re-verify this document against current code first — `sean-webapp` is
  under active development elsewhere in the ecosystem and these three
  files may have changed since 2026-08-18.
- Decide whether `allocation-engine.ts` gets activated on the same
  timeline or kept separate.
- Only after general-knowledge support is live: scope the client-specific
  "answer from my real data" phase 2 design referenced above.
