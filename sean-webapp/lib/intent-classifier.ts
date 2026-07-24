// lib/intent-classifier.ts
// Phase 2 (SEAN_CFO_ROADMAP.md): chat-message intent classification.
//
// Replaces the old regex-only classifyIntent() that used to live in
// app/api/chat/messages/route.ts. That version had two confirmed bugs:
//   1. \bR\s*\d+ (meant for "calculate VAT on R1000") fired on ANY message
//      mentioning a Rand amount, checked before allocation patterns — so
//      "What category is ENGEN SANDTON R850?" was misclassified as CALCULATION.
//   2. Every pattern was English-only — Afrikaans phrasing matched nothing and
//      silently fell through to low-confidence GENERAL.
//
// This version is not a patch of that regex — it's a narrow, structurally-safe
// deterministic fast path (Step 1) for genuinely unambiguous messages, backed by
// a learned-pattern cache (Step 2) and LLM fallback (Step 3) for everything else,
// mirroring the cache-first/LLM-fallback/persist shape lib/allocation-engine.ts
// already uses for bank-transaction categorization.

import prisma from "./db";
import { callLLM, resolveProvider } from "./llm-client";

export type IntentType = "CALCULATION" | "TEACH" | "ALLOCATION" | "QUESTION" | "GENERAL";

export interface IntentResult {
  type: IntentType;
  domain: string;
  confidence: number;
}

const VALID_INTENTS: IntentType[] = ["CALCULATION", "TEACH", "ALLOCATION", "QUESTION", "GENERAL"];

// ── Normalization ────────────────────────────────────────────────────────────
// Deliberately NOT lib/bank-allocations.ts's normalizeDescription() — that one
// strips Rand amounts/long numbers by design (correct for matching a vendor
// description, where the amount is noise). Here the presence of an amount is a
// discriminating signal for intent (it's part of *why* bug #1 happened), so it
// must be preserved rather than stripped.
export function normalizeIntentQuery(content: string): string {
  return content
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/g, "");
}

// ── Step 1: narrow deterministic fast path ──────────────────────────────────
// Only fires on genuinely unambiguous shapes. Anything with overlapping
// signals, or that doesn't cleanly match a bucket — including all Afrikaans
// phrasing — falls through to Step 2/3. No Afrikaans keyword list is
// maintained here; that would just recreate bug #2 in a different language as
// phrasing drifts. The LLM in Step 3 is natively multilingual instead.
const ALLOCATION_SIGNAL = /\b(allocate|categorize|classify|what category|which account|bank statement|transaction|debit|credit|atm|eft|pos|card payment)\b/i;
const QUOTED_DESCRIPTION = /["']([^"']+)["']/;
const CALCULATION_VERB = /\b(calculate|calc|vat|btw|paye|income tax|tax on)\b/i;
const TEACH_SIGNAL = /^(remember|note|fyi|learn|know that|the rule is|you should know|for future reference|always remember)\b/i;
const QUESTION_SHAPE = /^(what|how|why|when|where|who|which|can|does|is|are|should|would|could|tell me|explain|describe|show me)\b/i;
const ENDS_IN_QUESTION_MARK = /\?$/;

function fastPathClassify(content: string): IntentResult | null {
  const c = content.trim();
  const hasAllocationSignal = ALLOCATION_SIGNAL.test(c) || QUOTED_DESCRIPTION.test(c);
  const hasCalculationVerb = CALCULATION_VERB.test(c);

  // Allocation-shaped signals win over calculation-shaped ones — this is the
  // structural fix for bug #1. A Rand amount alone never reaches this function
  // classifying as CALCULATION; only a calculation verb WITHOUT any allocation
  // signal does.
  if (hasAllocationSignal) {
    return { type: "ALLOCATION", domain: "ACCOUNTING_GENERAL", confidence: 0.9 };
  }
  if (hasCalculationVerb) {
    return { type: "CALCULATION", domain: "VAT", confidence: 0.9 };
  }
  if (TEACH_SIGNAL.test(c)) {
    return { type: "TEACH", domain: "OTHER", confidence: 0.85 };
  }
  if ((QUESTION_SHAPE.test(c) || ENDS_IN_QUESTION_MARK.test(c)) && c.split(" ").length <= 20) {
    // Narrow: only short, clearly-interrogative English phrasing. Longer or
    // ambiguous phrasing (and anything not matching this English-only shape,
    // e.g. Afrikaans) intentionally falls through to Step 2/3 rather than
    // guessing GENERAL here.
    return { type: "QUESTION", domain: "OTHER", confidence: 0.75 };
  }

  return null;
}

// ── Step 3: LLM classification ──────────────────────────────────────────────
function buildIntentPrompt(content: string): string {
  return `Classify the intent of this chat message from a South African accounting practice's Sean AI assistant. The message may be in English or Afrikaans — classify regardless of language.

Message: "${content}"

Intent types:
- CALCULATION: user wants a tax/VAT/PAYE/income-tax number computed
- TEACH: user is offering Sean a fact or rule to remember for later
- ALLOCATION: user is asking how to categorize a bank transaction
- QUESTION: user is asking Sean something and expects an explanatory answer
- GENERAL: anything else, including small talk or unclear intent

Also infer a domain: VAT, INCOME_TAX, COMPANY_TAX, PAYROLL, CAPITAL_GAINS_TAX, WITHHOLDING_TAX, ACCOUNTING_GENERAL, or OTHER.

Respond in this exact JSON format only:
{"type": "QUESTION", "domain": "VAT", "confidence": 0.8}`;
}

function parseIntentResponse(response: string): IntentResult | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*?"type"[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!VALID_INTENTS.includes(parsed.type)) return null;

    return {
      type: parsed.type,
      domain: typeof parsed.domain === "string" ? parsed.domain : "OTHER",
      confidence: Math.min(Math.max(parsed.confidence || 0.5, 0.1), 0.95),
    };
  } catch {
    return null;
  }
}

// ── Main cascade ─────────────────────────────────────────────────────────────
export async function classifyIntent(content: string): Promise<IntentResult> {
  // Step 1: narrow deterministic fast path — no DB, no LLM.
  const fastResult = fastPathClassify(content);
  if (fastResult) return fastResult;

  // Step 2: learned-pattern cache lookup — fast, free, no LLM call.
  const normalized = normalizeIntentQuery(content);
  const cached = await prisma.intentPattern.findUnique({
    where: { normalizedPattern: normalized },
  });

  if (cached) {
    await prisma.intentPattern.update({
      where: { id: cached.id },
      data: { usedCount: { increment: 1 }, updatedAt: new Date() },
    });
    return {
      type: cached.intentType as IntentType,
      domain: cached.domain,
      confidence: cached.confidence,
    };
  }

  // Step 3: novel phrasing — ask the LLM. Fails safe to GENERAL/low-confidence
  // if not configured or the call/parse fails, since this runs on every message.
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    return { type: "GENERAL", domain: "OTHER", confidence: 0.5 };
  }

  const provider = resolveProvider();
  try {
    const prompt = buildIntentPrompt(content);
    const textResponse = await callLLM(prompt, { provider, apiKey });
    const parsed = parseIntentResponse(textResponse);

    if (!parsed) {
      console.error("[IntentClassifier] Failed to parse LLM response");
      return { type: "GENERAL", domain: "OTHER", confidence: 0.5 };
    }

    // Step 4: persist — the next occurrence of this exact phrasing, from any
    // user, becomes a free Step-2 cache hit.
    await prisma.intentPattern.create({
      data: {
        normalizedPattern: normalized,
        intentType: parsed.type,
        domain: parsed.domain,
        confidence: parsed.confidence,
        source: "llm",
        provider,
      },
    });

    return parsed;
  } catch (error) {
    console.error("[IntentClassifier] LLM call failed:", error);
    return { type: "GENERAL", domain: "OTHER", confidence: 0.5 };
  }
}
