// lib/llm-bootstrap.ts
// Bootstrap Learning System - Call external LLM ONCE, store forever
import prisma from "./db";
import { generateSlug, generateCitationId } from "./kb";
import { callLLM, resolveProvider } from "./llm-client";

export interface BootstrapResult {
  answer: string;
  source: "KB" | "LLM";
  citationId?: string;
  cached: boolean;
  provider?: string;
  domain?: string;
}

// Normalize query for deduplication - removes noise, sorts words
export function normalizeQuery(query: string): string {
  const stopWords = ["the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below", "between",
    "under", "again", "further", "then", "once", "here", "there", "when", "where",
    "why", "how", "all", "each", "few", "more", "most", "other", "some", "such",
    "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "what", "which", "who", "whom", "this", "that", "these", "those", "am", "i", "me", "my"];

  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // Remove punctuation
    .replace(/\s+/g, " ")    // Normalize whitespace
    .trim()
    .split(" ")
    .filter(w => w.length > 2 && !stopWords.includes(w))
    .sort()                  // Alphabetize for consistency
    .join(" ");
}

// Generate hash for query lookup
export function hashQuery(query: string): string {
  const normalized = normalizeQuery(query);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `QH${Math.abs(hash).toString(36)}`;
}

// Infer domain from question text
export function inferDomainFromQuestion(question: string): string {
  const q = question.toLowerCase();

  const domainKeywords: Record<string, string[]> = {
    VAT: ["vat", "value added", "input tax", "output tax", "zero rated", "exempt"],
    INCOME_TAX: ["income tax", "taxable income", "personal tax", "salary tax", "rebate", "threshold", "bracket", "tax table"],
    COMPANY_TAX: ["company tax", "corporate tax", "business tax", "profit tax", "sbc", "small business"],
    PAYROLL: ["payroll", "salary", "wage", "employee tax", "paye", "uif", "sdl"],
    CAPITAL_GAINS_TAX: ["cgt", "capital gains", "capital gain", "investment income", "property sale", "disposal"],
    WITHHOLDING_TAX: ["withholding", "dividend tax", "interest tax", "dwt"],
    ACCOUNTING_GENERAL: ["accounting", "journal", "ledger", "debit", "credit", "balance sheet", "income statement"],
  };

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (keywords.some((kw) => q.includes(kw))) {
      return domain;
    }
  }

  return "OTHER";
}

// Main bootstrap function - check DB first, then LLM
export async function bootstrapAnswer(
  question: string,
  domain: string | null,
  userId: string
): Promise<BootstrapResult> {
  const queryHash = hashQuery(question);
  const inferredDomain = domain || inferDomainFromQuestion(question);

  // Step 1: Check if we have a cached answer for this exact query hash
  const cachedItem = await prisma.knowledgeItem.findFirst({
    where: {
      slug: { contains: queryHash },
      status: "APPROVED",
    },
  });

  if (cachedItem) {
    console.log(`[Bootstrap] Cache HIT for hash ${queryHash}`);
    return {
      answer: cachedItem.contentText,
      source: "KB",
      citationId: cachedItem.citationId,
      cached: true,
      domain: cachedItem.primaryDomain,
    };
  }

  // Step 2: Search existing KB with keyword matching
  const existingKB = await prisma.knowledgeItem.findMany({
    where: {
      status: "APPROVED",
      OR: [
        { primaryDomain: inferredDomain },
        { primaryDomain: "OTHER" },
      ],
    },
    take: 200,
  });

  // Score items by keyword overlap
  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  let bestMatch: typeof existingKB[0] | null = null;
  let bestScore = 0;

  for (const item of existingKB) {
    const content = (item.title + " " + item.contentText).toLowerCase();
    const matchCount = keywords.filter(k => content.includes(k)).length;
    const score = matchCount / keywords.length;

    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = item;
    }
  }

  if (bestMatch && bestScore >= 0.6) {
    console.log(`[Bootstrap] KB match found with score ${bestScore.toFixed(2)}`);
    return {
      answer: bestMatch.contentText,
      source: "KB",
      citationId: bestMatch.citationId,
      cached: false,
      domain: bestMatch.primaryDomain,
    };
  }

  // Step 3: No good KB match - call external LLM ONCE
  console.log(`[Bootstrap] No KB match, calling external LLM...`);

  const provider = resolveProvider();
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    console.warn("[Bootstrap] LLM_API_KEY not configured, returning fallback");
    return {
      answer: "I don't have knowledge about that yet, and external AI is not configured. Please teach me using TEACH: prefix.",
      source: "KB",
      cached: false,
      domain: inferredDomain,
    };
  }

  try {
    const llmAnswer = await callExternalLLM(question, inferredDomain, provider, apiKey);

    // Step 4: Store the answer in KB for future use
    const slug = generateSlug(`bootstrap-${queryHash}`);
    const citationId = generateCitationId("FIRM", slug, 1);

    const newItem = await prisma.knowledgeItem.create({
      data: {
        layer: "FIRM",
        scopeType: "GLOBAL",
        title: `Bootstrap: ${question.substring(0, 80)}${question.length > 80 ? "..." : ""}`,
        slug,
        contentText: llmAnswer,
        language: "EN",
        tags: JSON.stringify(["bootstrap", "auto-generated", provider.toLowerCase()]),
        primaryDomain: inferredDomain,
        secondaryDomains: JSON.stringify([]),
        status: "APPROVED", // Auto-approve bootstrap answers
        kbVersion: 1,
        citationId,
        submittedByUserId: userId,
        sourceType: "llm-bootstrap",
        sourceUrl: `query:${queryHash}`,
        sourceSection: `provider:${provider}`,
      },
    });

    // Log the bootstrap event
    await prisma.auditLog.create({
      data: {
        userId,
        actionType: "LLM_BOOTSTRAP",
        entityType: "KnowledgeItem",
        entityId: newItem.id,
        detailsJson: JSON.stringify({
          question: question.substring(0, 200),
          queryHash,
          domain: inferredDomain,
          provider,
          responseLength: llmAnswer.length,
        }),
      },
    });

    console.log(`[Bootstrap] Stored LLM answer as ${citationId}`);

    return {
      answer: llmAnswer,
      source: "LLM",
      citationId,
      cached: false,
      provider,
      domain: inferredDomain,
    };
  } catch (error) {
    console.error("[Bootstrap] LLM call failed:", error);
    return {
      answer: `I couldn't fetch an answer from ${provider}. Error: ${error instanceof Error ? error.message : "Unknown error"}. Please try again or teach me directly using TEACH: prefix.`,
      source: "KB",
      cached: false,
      domain: inferredDomain,
    };
  }
}

// Call external LLM based on provider
async function callExternalLLM(
  question: string,
  domain: string,
  provider: string,
  apiKey: string
): Promise<string> {
  const systemPrompt = `You are Sean AI, a South African accounting and tax assistant for Lorenco Accounting.

Key instructions:
- Answer questions accurately and concisely
- Focus on South African regulations (SARS, Companies Act, etc.)
- For tax questions, cite relevant tax years when applicable
- Current domain context: ${domain}
- If you're unsure about current rates/thresholds, say so and provide the general principle
- Keep answers focused and practical for accounting professionals

Remember: Your answer will be cached and reused, so be accurate and include relevant context.`;

  return await callLLM(question, {
    provider: resolveProvider(provider),
    apiKey,
    systemPrompt,
    maxTokens: 1500,
  });
}

// Check if bootstrap is configured
export function isBootstrapConfigured(): boolean {
  return !!(process.env.LLM_API_KEY && process.env.LLM_PROVIDER);
}

// Get bootstrap stats
export async function getBootstrapStats(userId?: string) {
  const where = userId ? { userId } : {};

  const total = await prisma.auditLog.count({
    where: { ...where, actionType: "LLM_BOOTSTRAP" },
  });

  const recentLogs = await prisma.auditLog.findMany({
    where: { ...where, actionType: "LLM_BOOTSTRAP" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return {
    totalBootstraps: total,
    recentBootstraps: recentLogs.map(log => ({
      createdAt: log.createdAt,
      details: log.detailsJson ? JSON.parse(log.detailsJson) : null,
    })),
  };
}
