// lib/reasoning-engine.ts
// Core "answer a question from the knowledge base" logic, extracted from
// app/api/reason/route.ts so it can be called directly (from both that route
// and app/api/chat/messages/route.ts's ASK: branch) instead of the chat route
// self-fetching its own sibling endpoint over HTTP with manual
// cookie-forwarding. Auth, rate-limiting, and question validation stay in the
// route — only the actual KB-search/scoring/answer-generation logic moved.
//
// All diagnostic console.log("ASK_...") lines are preserved verbatim — they
// were added to diagnose real prior incidents (see BUGFIX_ASK_*.md,
// TASK_A_B_*.md in the repo root), not left over from casual debugging.
import prisma from "./db";

// Domain inference from question text
function inferDomain(question: string): string {
  const q = question.toLowerCase();

  const domainKeywords: Record<string, string[]> = {
    VAT: ["vat", "value added", "input tax", "output tax"],
    INCOME_TAX: ["income tax", "taxable income", "personal tax", "salary tax"],
    COMPANY_TAX: ["company tax", "corporate tax", "business tax", "profit tax"],
    PAYROLL: ["payroll", "salary", "wage", "employee tax", "paye"],
    CAPITAL_GAINS_TAX: ["cgt", "capital gains", "investment income", "property sale"],
    WITHHOLDING_TAX: ["withholding", "dividend tax", "interest tax"],
  };

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (keywords.some((kw) => q.includes(kw))) {
      return domain;
    }
  }

  return "OTHER"; // No specific domain match
}

// Topic inference from question text
function inferTopic(question: string): string {
  const q = question.toLowerCase();

  if (q.includes("threshold")) return "THRESHOLD";
  if (q.includes("rebate")) return "REBATE";
  if (q.includes("bracket") || q.includes("rate") || q.includes("marginal")) {
    return "BRACKET_RATE";
  }

  return "GENERAL"; // No specific topic match
}

// Extract qualifiers from question (numbers, age ranges, specific phrases)
function extractQualifiers(question: string): {
  numbers: string[];
  ageRanges: string[];
  phrases: string[];
} {
  const q = question.toLowerCase();
  const qualifiers = {
    numbers: [] as string[],
    ageRanges: [] as string[],
    phrases: [] as string[],
  };

  // Extract numbers
  const numbers = q.match(/\d+/g) || [];
  qualifiers.numbers = [...new Set(numbers)];

  // Extract age ranges (flexible: 75, 75+, aged 75, 75 years, etc)
  const agePatterns = [
    /\b(\d+)\+\b/,  // 75+
    /aged\s+(\d+)/i,  // aged 75
    /(\d+)\s+years?/i,  // 75 years
    /under\s+(\d+)/,
    /(\d+)\s+to\s+(\d+)/,
    /(\d+)\s+and\s+older/,
    /(\d+)\s+and\s+above/,
  ];
  agePatterns.forEach((pattern: RegExp) => {
    const match = q.match(pattern);
    if (match) {
      // Extract the full match or the first capturing group
      qualifiers.ageRanges.push(match[1] ? match[1] : match[0]);
    }
  });

  // Extract specific phrases
  const specificPhrases = ["rebate", "threshold", "rate", "limit", "allowance"];
  specificPhrases.forEach((phrase: string) => {
    if (q.includes(phrase)) qualifiers.phrases.push(phrase);
  });

  return qualifiers;
}

// Check if KB item matches qualifiers
function itemMatchesQualifier(item: any, qualifiers: any): boolean {
  const title = item.title.toLowerCase();
  const content = (item.contentText || "").toLowerCase();
  const combined = title + " " + content;

  // If no qualifiers extracted, item matches by default
  if (qualifiers.numbers.length === 0 && qualifiers.ageRanges.length === 0 && qualifiers.phrases.length === 0) {
    return true; // No qualifiers, match everything
  }

  // If we have specific qualifiers, at least one must match
  let hasMatch = false;

  // Check if any number appears
  if (qualifiers.numbers.length > 0) {
    if (qualifiers.numbers.some((num: string) => combined.includes(num))) {
      hasMatch = true;
    }
  }

  // Check if any age range appears
  if (qualifiers.ageRanges.length > 0) {
    if (qualifiers.ageRanges.some((range: string) => combined.includes(range))) {
      hasMatch = true;
    }
  }

  // Check if any phrase appears
  if (qualifiers.phrases.length > 0) {
    if (qualifiers.phrases.some((phrase: string) => combined.includes(phrase))) {
      hasMatch = true;
    }
  }

  // If qualifiers were extracted, at least one must match
  return hasMatch;
}

// Check if KB item matches the inferred domain
function itemMatchesDomain(item: any, inferredDomain: string): boolean {
  if (inferredDomain === "OTHER") return true;

  const title = (item.title || "").toLowerCase();
  const content = (item.contentText || "").toLowerCase();
  const combined = title + " " + content;

  // 🔧 CRITICAL FIX:
  // If DB domain is OTHER, but text clearly declares domain, allow it
  if (item.primaryDomain === "OTHER") {
    if (combined.includes(`domain: ${inferredDomain.toLowerCase()}`)) return true;
    if (combined.includes(inferredDomain.toLowerCase())) return true;
  }

  if (item.primaryDomain === inferredDomain) return true;

  const secondaryDomains = JSON.parse(item.secondaryDomains || "[]");
  return secondaryDomains.includes(inferredDomain);
}


// Check if KB item matches the inferred topic
function itemMatchesTopic(item: any, inferredTopic: string, question: string): boolean {
  const q = question.toLowerCase();
  const title = item.title.toLowerCase();
  const content = (item.contentText || "").toLowerCase();
  const combined = title + " " + content;

  if (inferredTopic === "GENERAL") {
    return true; // No topic filtering if GENERAL
  }

  if (inferredTopic === "THRESHOLD") {
    // Must contain "threshold" and must NOT be about rebates unless question includes rebate
    const hasThreshold = combined.includes("threshold");
    const isRebate = combined.includes("rebate");
    const questionIncludesRebate = q.includes("rebate");

    return hasThreshold && (!isRebate || questionIncludesRebate);
  }

  if (inferredTopic === "REBATE") {
    // Must contain "rebate"
    return combined.includes("rebate");
  }

  if (inferredTopic === "BRACKET_RATE") {
    // Must contain "rate" or "bracket" or "marginal"
    return (
      combined.includes("rate") ||
      combined.includes("bracket") ||
      combined.includes("marginal")
    );
  }

  return true;
}

// Calculate semantic similarity (basic scoring)
function calculateScore(question: string, item: any): number {
  const q = question.toLowerCase();
  const t = item.title.toLowerCase();
  const c = (item.contentText || "").toLowerCase();

  let score = 0;
  const qWords = q.split(/\s+/).filter((w) => w.length > 3);

  qWords.forEach((word) => {
    if (t.includes(word)) score += 10;
    if (c.includes(word)) score += 1;
  });

  return score;
}

// Generate answer based on matching items
function extractVersion(citationId: string | null | undefined): number {
  const m = String(citationId || "").match(/:v(\d+)$/i);
  return m ? parseInt(m[1], 10) : 0;
}

function pickBestItem(items: any[]) {
  return items
    .slice()
    .sort((a, b) => {
      // 1) Highest score first
      const scoreA = typeof a.score === "number" ? a.score : 0;
      const scoreB = typeof b.score === "number" ? b.score : 0;
      if (scoreB !== scoreA) return scoreB - scoreA;

      // 2) If score ties, highest version in citationId (e.g. :v3)
      const vA = extractVersion(a.citationId);
      const vB = extractVersion(b.citationId);
      return vB - vA;
    })[0];
}

function generateAnswer(
  question: string,
  relevantItems: any[]
): { answer: string; shouldAskClarification: boolean } {
  if (relevantItems.length === 0) {
    return {
      answer:
        "I don't have knowledge about that specific question yet. Could you teach me using TEACH: with the relevant information?",
      shouldAskClarification: false,
    };
  }

  // If multiple matches, auto-select best (score + latest version)
  const best =
    relevantItems.length === 1 ? relevantItems[0] : pickBestItem(relevantItems);

  return {
    answer: `${best.contentText} [${best.citationId}]`,
    shouldAskClarification: false,
  };
}

// Generate proposed actions based on reasoning outcome
function generateActions(
  scoredItems: any[],
  inferredDomain: string,
  inferredTopic: string,
  qualifiers: any,
  question: string
) {
  const actions: any[] = [];

  // If no relevant KB, suggest teaching
  if (scoredItems.length === 0) {
    actions.push({
      id: `proposed:suggest-teach-${Date.now()}`,
      type: "SUGGEST_KB_TEACH",
      title: "Teach system",
      summary: "No matching knowledge base. Use TEACH: prefix to teach me about this topic.",
      requiresApproval: false,
    });
  }
  // If multiple matches, ask for clarification
  else if (scoredItems.length > 1) {
    actions.push({
      id: `proposed:request-info-${Date.now()}`,
      type: "REQUEST_INFO",
      title: "Request clarification",
      summary: `Found ${scoredItems.length} matching items. More details would help narrow down the answer.`,
      requiresApproval: false,
      confidence: 0.6,
    });
  }
  // If exactly one match and topic is THRESHOLD or REBATE, flag risk if year missing
  else if (
    scoredItems.length === 1 &&
    (inferredTopic === "THRESHOLD" || inferredTopic === "REBATE")
  ) {
    const hasYearOrDate = /\d{4}|current|year|2025|2024/i.test(question);
    if (!hasYearOrDate) {
      actions.push({
        id: `proposed:flag-risk-${Date.now()}`,
        type: "FLAG_RISK",
        title: "Missing year reference",
        summary: `Threshold or rebate rules may vary by year. Please specify the tax year or period.`,
        requiresApproval: false,
        confidence: 0.5,
      });
    }
  }

  return actions;
}

export async function reasonAboutQuestion(
  question: string,
  clientId: string | null | undefined,
  layer: string | null | undefined,
  userId: string
) {
  // TASK A: DIAGNOSTIC LOGGING
  console.log("ASK_CTX_START", {
    question: question.substring(0, 50),
    clientId: clientId || "NONE",
    layer: layer || "NONE",
    timestamp: new Date().toISOString(),
  });

  // Search for relevant APPROVED knowledge items
  // ALWAYS include GLOBAL scope, optionally add CLIENT scope if clientId provided
  // Default layer filter = ALL (LEGAL, FIRM, CLIENT)
  // Restrict to specific layer only if explicitly specified
  const where: any = {
    status: "APPROVED",
    OR: [
      { scopeType: "GLOBAL" },
      ...(clientId ? [{ AND: [{ scopeType: "CLIENT" }, { scopeClientId: clientId }] }] : []),
    ],
  };

  // Apply layer filter only if explicitly specified
  if (layer && ["LEGAL", "FIRM", "CLIENT"].includes(layer)) {
    where.layer = layer;
  }
  // Otherwise all layers included (no layer filter in WHERE)

  // TASK 2: Log WHERE clause before query
  console.log("ASK_WHERE_CLAUSE", {
    hasLayerFilter: !!where.layer,
    layerValue: where.layer || "NONE (ALL layers)",
    scopeFilter: where.OR?.length || 0,
  });

  const allItems = await prisma.knowledgeItem.findMany({
    where,
  });

  // TASK A: LOG COUNTS AFTER QUERY
  console.log("ASK_CANDIDATES_AFTER_DB", {
    total: allItems.length,
    items: allItems.map((i) => ({
      id: i.id,
      title: i.title.substring(0, 40),
      layer: i.layer,
      scope: i.scopeType,
      domain: i.primaryDomain,
    })),
  });

  // Infer domain and topic from question
  const inferredDomain = inferDomain(question);
  const inferredTopic = inferTopic(question);

  // Extract qualifiers from question
  const qualifiers = extractQualifiers(question);

  console.log("ASK_FILTERS", {
    inferredDomain,
    inferredTopic,
    qualifiers,
  });

  // Filter by qualifiers first (strict matching)
  let matchedItems = allItems.filter((item) =>
    itemMatchesQualifier(item, qualifiers)
  );

  const candidatesAfterQualifier = matchedItems.length;
  console.log("ASK_AFTER_QUALIFIER", {
    count: candidatesAfterQualifier,
    items: matchedItems.map((i) => i.title.substring(0, 40)),
  });

  // Apply domain filter
  matchedItems = matchedItems.filter((item) =>
    itemMatchesDomain(item, inferredDomain)
  );

  const candidatesAfterDomain = matchedItems.length;
  console.log("ASK_AFTER_DOMAIN", {
    count: candidatesAfterDomain,
    items: matchedItems.map((i) => i.title.substring(0, 40)),
  });

  // Apply topic filter
  matchedItems = matchedItems.filter((item) =>
    itemMatchesTopic(item, inferredTopic, question)
  );

  const candidatesAfterTopic = matchedItems.length;
  console.log("ASK_AFTER_TOPIC", {
    count: candidatesAfterTopic,
    items: matchedItems.map((i) => i.title.substring(0, 40)),
  });

  // If qualifiers filtered too many, relax to basic keyword match
  if (matchedItems.length === 0 && qualifiers.numbers.length > 0) {
    matchedItems = allItems.filter(
      (item) =>
        ((item.contentText || "").toLowerCase().includes(question.split(/\s+/)[0]) ||
          item.title.toLowerCase().includes(question.split(/\s+/)[0])) &&
        itemMatchesDomain(item, inferredDomain) &&
        itemMatchesTopic(item, inferredTopic, question)
    );
  }

  // Score and sort remaining items
  const scoredItems = matchedItems
    .map((item) => ({
      ...item,
      score: calculateScore(question, item),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3); // Keep top 3 max

  console.log("ASK_FINAL_SELECTION", {
    finalCount: scoredItems.length,
    top3: scoredItems.map((i) => ({
      id: i.id,
      title: i.title?.substring(0, 60),
      citationId: i.citationId,
      score: i.score,
      hasContentText: !!i.contentText,
    })),
  });

  const citations = scoredItems.map((item) => ({
    citationId: item.citationId,
    title: item.title,
  }));

  // Generate answer
  const { answer, shouldAskClarification } = generateAnswer(
    question,
    scoredItems
  );

  // Generate proposed actions
  const actions = generateActions(
    scoredItems,
    inferredDomain,
    inferredTopic,
    qualifiers,
    question
  );

  // Build debug object
  const debugObject = {
    inferredDomain,
    inferredTopic,
    matchCount: scoredItems.length,
    appliedLayer: layer || "ALL",
    candidates: {
      afterDBQuery: allItems.length,
      afterQualifier: candidatesAfterQualifier,
      afterDomain: candidatesAfterDomain,
      afterTopic: candidatesAfterTopic,
      afterScoring: scoredItems.length,
    },
    topMatches: scoredItems.slice(0, 3).map((item) => ({
      citationId: item.citationId,
      title: item.title,
      score: item.score,
    })),
  };

  // Log reasoning query with domain/topic inference
  // TASK 2: COMPREHENSIVE DEBUG LOGGING
  console.log("ASK_DEBUG_FINAL", {
    question: question.substring(0, 60),
    filters: {
      clientId: clientId || "NONE",
      layer: layer || "ALL",
      inferredDomain,
      inferredTopic,
    },
    candidates: {
      afterDBQuery: allItems.length,
      afterQualifier: candidatesAfterQualifier,
      afterDomain: candidatesAfterDomain,
      afterTopic: candidatesAfterTopic,
      afterScoring: scoredItems.length,
    },
    result: {
      chosenCitationId: scoredItems.length === 1 ? scoredItems[0].citationId : (scoredItems.length > 1 ? "CLARIFICATION" : "NO_MATCH"),
      matchCount: scoredItems.length,
      topItem: scoredItems.length > 0 ? scoredItems[0].title.substring(0, 50) : "NONE",
    },
  });

  await prisma.auditLog.create({
    data: {
      userId,
      actionType: "REASON_QUERY",
      entityType: "None",
      detailsJson: JSON.stringify({
        question,
        clientId,
        layer: layer || "ALL",
        inferredDomain,
        inferredTopic,
        qualifiersExtracted: qualifiers,
        candidatesInitial: allItems.length,
        candidatesAfterQualifier,
        candidatesAfterDomain,
        candidatesAfterTopic,
        itemsMatched: scoredItems.length,
        citationsUsed: citations.map((c) => c.citationId),
        chosenCitationId: scoredItems.length === 1 ? scoredItems[0].citationId : null,
      }),
    },
  });

  return {
    outcome: answer,
    reason: shouldAskClarification
      ? "Multiple matching items found"
      : `Found ${scoredItems.length} matching knowledge item${scoredItems.length !== 1 ? "s" : ""}`,
    citations: scoredItems.length === 1 ? citations : [],
    answer,
    hasRelevantKB: scoredItems.length > 0,
    matchCount: scoredItems.length,
    inferredDomain,
    inferredTopic,
    appliedLayer: layer || "ALL",
    actions,
    debug: debugObject,
  };
}
