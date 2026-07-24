// lib/allocation-engine.ts
// Sean's Autonomous Allocation Engine
// Processes bank transactions automatically with LLM fallback

import prisma from "./db";
import {
  suggestCategory,
  learnFromCorrection,
  normalizeDescription,
  ALLOCATION_CATEGORIES,
} from "./bank-allocations";
import { callLLM, resolveProvider, type LLMProviderName } from "./llm-client";

type LLMProvider = LLMProviderName;

// Build allocation prompt for LLM
function buildAllocationPrompt(description: string): string {
  const categories = ALLOCATION_CATEGORIES.map(
    (c) => `- ${c.code}: ${c.label}`
  ).join("\n");

  return `You are a South African accounting assistant. Categorize this bank transaction into the correct accounting category.

Transaction description: "${description}"

Available categories:
${categories}

Instructions:
1. Analyze the transaction description
2. Consider South African business context
3. Choose the MOST appropriate category

Respond in this exact JSON format only:
{"category": "CATEGORY_CODE", "confidence": 0.8, "reasoning": "Brief explanation"}

If truly uncertain, use "OTHER" with lower confidence.`;
}

// Parse LLM response for allocation
function parseAllocationResponse(response: string): {
  category: string;
  confidence: number;
  reasoning: string;
} | null {
  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*?"category"[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate category exists
    const validCategory = ALLOCATION_CATEGORIES.find(
      (c) => c.code === parsed.category
    );
    if (!validCategory) return null;

    return {
      category: parsed.category,
      confidence: Math.min(Math.max(parsed.confidence || 0.5, 0.1), 0.95),
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return null;
  }
}

// Call LLM for allocation suggestion
export async function getLLMAllocation(
  description: string,
  provider?: LLMProvider
): Promise<{
  category: string;
  categoryLabel: string;
  confidence: number;
  reasoning: string;
  provider: string;
  cached: boolean;
} | null> {
  const normalized = normalizeDescription(description);

  // Check cache first (bootstrap pattern)
  const cached = await prisma.allocationLLMCache.findUnique({
    where: { normalizedPattern: normalized },
  });

  if (cached) {
    // Increment usage count
    await prisma.allocationLLMCache.update({
      where: { id: cached.id },
      data: { usedCount: { increment: 1 }, updatedAt: new Date() },
    });

    const cat = ALLOCATION_CATEGORIES.find((c) => c.code === cached.suggestedCategory);
    return {
      category: cached.suggestedCategory,
      categoryLabel: cat?.label || cached.suggestedCategory,
      confidence: cached.confidence,
      reasoning: cached.reasoning || "",
      provider: cached.provider,
      cached: true,
    };
  }

  // Determine which provider to use
  const llmProvider = resolveProvider(provider);
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    console.error("[AllocationEngine] No LLM_API_KEY configured");
    return null;
  }

  try {
    const prompt = buildAllocationPrompt(description);
    const textResponse = await callLLM(prompt, { provider: llmProvider, apiKey });
    const parsed = parseAllocationResponse(textResponse);

    if (!parsed) {
      console.error("[AllocationEngine] Failed to parse LLM response");
      return null;
    }

    // Cache the response (bootstrap - never call again for same pattern)
    await prisma.allocationLLMCache.create({
      data: {
        normalizedPattern: normalized,
        suggestedCategory: parsed.category,
        reasoning: parsed.reasoning,
        provider: llmProvider,
        confidence: parsed.confidence,
      },
    });

    // Log the LLM call
    await prisma.auditLog.create({
      data: {
        actionType: "LLM_ALLOCATION",
        entityType: "AllocationLLMCache",
        detailsJson: JSON.stringify({
          description: description.substring(0, 100),
          normalized,
          category: parsed.category,
          confidence: parsed.confidence,
          provider: llmProvider,
        }),
      },
    });

    const cat = ALLOCATION_CATEGORIES.find((c) => c.code === parsed.category);
    return {
      category: parsed.category,
      categoryLabel: cat?.label || parsed.category,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      provider: llmProvider,
      cached: false,
    };
  } catch (error) {
    console.error("[AllocationEngine] LLM call failed:", error);
    return null;
  }
}

// Get or create the Sean agent
export async function getSeanAgent() {
  let agent = await prisma.seanAgent.findFirst();

  if (!agent) {
    agent = await prisma.seanAgent.create({
      data: {
        name: "Sean",
        status: "INACTIVE",
        authorizedActions: JSON.stringify(["ALLOCATE", "RESPOND", "LEARN"]),
        autoAllocateEnabled: false,
        autoAllocateInterval: 60,
        autoAllocateMinConfidence: 0.8,
        llmFallbackEnabled: true,
      },
    });
  }

  return agent;
}

// Check if Sean is authorized for an action
export async function isSeanAuthorized(action: string): Promise<boolean> {
  const agent = await getSeanAgent();

  if (agent.status !== "ACTIVE") {
    return false;
  }

  try {
    const actions = JSON.parse(agent.authorizedActions) as string[];
    return actions.includes(action);
  } catch {
    return false;
  }
}

// Process a single transaction with full pipeline
export async function processTransaction(
  transactionId: string,
  options: {
    autoConfirmAbove?: number; // Auto-confirm if confidence >= this
    useLLMFallback?: boolean;
  } = {}
): Promise<{
  success: boolean;
  category: string | null;
  confidence: number;
  source: "exact" | "learned" | "keyword" | "client_keyword" | "industry" | "llm" | "none";
  autoConfirmed: boolean;
  needsReview: boolean;
  industryName?: string;
}> {
  const { autoConfirmAbove = 0.9, useLLMFallback = true } = options;

  const transaction = await prisma.bankTransaction.findUnique({
    where: { id: transactionId },
  });

  if (!transaction) {
    return {
      success: false,
      category: null,
      confidence: 0,
      source: "none",
      autoConfirmed: false,
      needsReview: true,
    };
  }

  // Skip if already processed and confirmed
  if (transaction.confirmedCategory && transaction.processed) {
    return {
      success: true,
      category: transaction.confirmedCategory,
      confidence: 1,
      source: "exact",
      autoConfirmed: false,
      needsReview: false,
    };
  }

  // Step 1: Try local suggestion (learned rules + keywords)
  // Pass clientId for client-specific rules
  const suggestion = await suggestCategory(transaction.rawDescription, transaction.clientId);

  if (suggestion.matchType !== "none" && suggestion.confidence >= autoConfirmAbove) {
    // High confidence - auto-confirm
    await prisma.bankTransaction.update({
      where: { id: transactionId },
      data: {
        suggestedCategory: suggestion.category,
        suggestedConfidence: suggestion.confidence,
        confirmedCategory: suggestion.category,
        processed: true,
        updatedAt: new Date(),
      },
    });

    return {
      success: true,
      category: suggestion.category,
      confidence: suggestion.confidence,
      source: suggestion.matchType,
      autoConfirmed: true,
      needsReview: false,
      industryName: suggestion.industryName,
    };
  }

  if (suggestion.matchType !== "none") {
    // Medium confidence - suggest but don't confirm
    await prisma.bankTransaction.update({
      where: { id: transactionId },
      data: {
        suggestedCategory: suggestion.category,
        suggestedConfidence: suggestion.confidence,
        updatedAt: new Date(),
      },
    });

    return {
      success: true,
      category: suggestion.category,
      confidence: suggestion.confidence,
      source: suggestion.matchType,
      autoConfirmed: false,
      needsReview: true,
      industryName: suggestion.industryName,
    };
  }

  // Step 2: No local match - try LLM if enabled
  if (useLLMFallback) {
    const llmResult = await getLLMAllocation(transaction.rawDescription);

    if (llmResult) {
      const shouldAutoConfirm = llmResult.confidence >= autoConfirmAbove;

      await prisma.bankTransaction.update({
        where: { id: transactionId },
        data: {
          suggestedCategory: llmResult.category,
          suggestedConfidence: llmResult.confidence,
          confirmedCategory: shouldAutoConfirm ? llmResult.category : null,
          processed: shouldAutoConfirm,
          updatedAt: new Date(),
        },
      });

      // If LLM is confident, also learn this pattern for future
      if (shouldAutoConfirm) {
        await learnFromCorrection(
          transaction.rawDescription,
          llmResult.category,
          `Auto-learned from ${llmResult.provider}: ${llmResult.reasoning}`,
          "system"
        );
      }

      return {
        success: true,
        category: llmResult.category,
        confidence: llmResult.confidence,
        source: "llm",
        autoConfirmed: shouldAutoConfirm,
        needsReview: !shouldAutoConfirm,
      };
    }
  }

  // No match at all
  await prisma.bankTransaction.update({
    where: { id: transactionId },
    data: {
      suggestedCategory: "OTHER",
      suggestedConfidence: 0.1,
      updatedAt: new Date(),
    },
  });

  return {
    success: true,
    category: "OTHER",
    confidence: 0.1,
    source: "none",
    autoConfirmed: false,
    needsReview: true,
  };
}

// Run batch allocation job
export async function runAllocationJob(options: {
  userId?: string;
  limit?: number;
  autoConfirmAbove?: number;
  useLLMFallback?: boolean;
}): Promise<{
  jobId: string;
  processed: number;
  autoAllocated: number;
  llmAllocated: number;
  needsReview: number;
  errors: number;
}> {
  const {
    userId,
    limit = 100,
    autoConfirmAbove = 0.85,
    useLLMFallback = true,
  } = options;

  const agent = await getSeanAgent();

  // Create job record
  const job = await prisma.allocationJobRun.create({
    data: {
      agentId: agent.id,
      status: "RUNNING",
    },
  });

  let processed = 0;
  let autoAllocated = 0;
  let llmAllocated = 0;
  let needsReview = 0;
  let errors = 0;

  try {
    // Get unprocessed transactions
    const whereClause: Record<string, unknown> = {
      processed: false,
      confirmedCategory: null,
    };
    if (userId) {
      whereClause.userId = userId;
    }

    const transactions = await prisma.bankTransaction.findMany({
      where: whereClause,
      take: limit,
      orderBy: { date: "desc" },
    });

    for (const tx of transactions) {
      try {
        const result = await processTransaction(tx.id, {
          autoConfirmAbove,
          useLLMFallback,
        });

        processed++;

        if (result.autoConfirmed) {
          if (result.source === "llm") {
            llmAllocated++;
          } else {
            autoAllocated++;
          }
        } else if (result.needsReview) {
          needsReview++;
        }
      } catch (error) {
        console.error(`[AllocationJob] Error processing tx ${tx.id}:`, error);
        errors++;
      }
    }

    // Update job record
    await prisma.allocationJobRun.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        transactionsProcessed: processed,
        autoAllocated,
        llmAllocated,
        needsReview,
        errors,
        detailsJson: JSON.stringify({
          autoConfirmAbove,
          useLLMFallback,
          userId,
        }),
      },
    });

    // Update agent stats
    await prisma.seanAgent.update({
      where: { id: agent.id },
      data: {
        totalAllocations: { increment: autoAllocated + llmAllocated },
        totalLLMCalls: { increment: llmAllocated },
        autoAllocateLastRun: new Date(),
        autoAllocateNextRun: new Date(
          Date.now() + agent.autoAllocateInterval * 60 * 1000
        ),
      },
    });

    // Log completion
    await prisma.auditLog.create({
      data: {
        actionType: "ALLOCATION_JOB_COMPLETE",
        entityType: "AllocationJobRun",
        entityId: job.id,
        detailsJson: JSON.stringify({
          processed,
          autoAllocated,
          llmAllocated,
          needsReview,
          errors,
        }),
      },
    });

    return {
      jobId: job.id,
      processed,
      autoAllocated,
      llmAllocated,
      needsReview,
      errors,
    };
  } catch (error) {
    // Mark job as failed
    await prisma.allocationJobRun.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });

    throw error;
  }
}

// Check if auto-allocation should run
export async function shouldRunAutoAllocation(): Promise<boolean> {
  const agent = await getSeanAgent();

  if (agent.status !== "ACTIVE" || !agent.autoAllocateEnabled) {
    return false;
  }

  // Check if it's time for next run
  if (agent.autoAllocateNextRun && new Date() < agent.autoAllocateNextRun) {
    return false;
  }

  // Check authorization
  if (!(await isSeanAuthorized("ALLOCATE"))) {
    return false;
  }

  return true;
}

// Update agent status
export async function updateAgentStatus(
  status: "ACTIVE" | "INACTIVE" | "PAUSED",
  settings?: {
    autoAllocateEnabled?: boolean;
    autoAllocateInterval?: number;
    autoAllocateMinConfidence?: number;
    llmFallbackEnabled?: boolean;
    llmFallbackProvider?: string;
    authorizedActions?: string[];
  }
): Promise<void> {
  const agent = await getSeanAgent();

  const updateData: Record<string, unknown> = { status };

  if (settings) {
    if (settings.autoAllocateEnabled !== undefined) {
      updateData.autoAllocateEnabled = settings.autoAllocateEnabled;
    }
    if (settings.autoAllocateInterval !== undefined) {
      updateData.autoAllocateInterval = settings.autoAllocateInterval;
    }
    if (settings.autoAllocateMinConfidence !== undefined) {
      updateData.autoAllocateMinConfidence = settings.autoAllocateMinConfidence;
    }
    if (settings.llmFallbackEnabled !== undefined) {
      updateData.llmFallbackEnabled = settings.llmFallbackEnabled;
    }
    if (settings.llmFallbackProvider !== undefined) {
      updateData.llmFallbackProvider = settings.llmFallbackProvider;
    }
    if (settings.authorizedActions) {
      updateData.authorizedActions = JSON.stringify(settings.authorizedActions);
    }
  }

  // If activating, calculate next run time
  if (status === "ACTIVE" && settings?.autoAllocateEnabled) {
    updateData.autoAllocateNextRun = new Date(
      Date.now() + (settings.autoAllocateInterval || agent.autoAllocateInterval) * 60 * 1000
    );
  }

  await prisma.seanAgent.update({
    where: { id: agent.id },
    data: updateData,
  });

  // Log status change
  await prisma.auditLog.create({
    data: {
      actionType: "AGENT_STATUS_CHANGE",
      entityType: "SeanAgent",
      entityId: agent.id,
      detailsJson: JSON.stringify({ status, settings }),
    },
  });
}

// Get allocation summary for dashboard
export async function getAllocationSummary() {
  const agent = await getSeanAgent();

  const pendingCount = await prisma.bankTransaction.count({
    where: { processed: false, confirmedCategory: null },
  });

  const processedCount = await prisma.bankTransaction.count({
    where: { processed: true },
  });

  const needsReviewCount = await prisma.bankTransaction.count({
    where: {
      processed: false,
      suggestedCategory: { not: null },
      confirmedCategory: null,
    },
  });

  const recentJobs = await prisma.allocationJobRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 5,
  });

  const llmCacheCount = await prisma.allocationLLMCache.count();

  return {
    agent: {
      status: agent.status,
      autoAllocateEnabled: agent.autoAllocateEnabled,
      autoAllocateInterval: agent.autoAllocateInterval,
      autoAllocateMinConfidence: agent.autoAllocateMinConfidence,
      llmFallbackEnabled: agent.llmFallbackEnabled,
      autoAllocateLastRun: agent.autoAllocateLastRun,
      autoAllocateNextRun: agent.autoAllocateNextRun,
      totalAllocations: agent.totalAllocations,
      totalLLMCalls: agent.totalLLMCalls,
    },
    transactions: {
      pending: pendingCount,
      processed: processedCount,
      needsReview: needsReviewCount,
    },
    llmCacheCount,
    recentJobs: recentJobs.map((j) => ({
      id: j.id,
      status: j.status,
      startedAt: j.startedAt,
      processed: j.transactionsProcessed,
      autoAllocated: j.autoAllocated,
      llmAllocated: j.llmAllocated,
      needsReview: j.needsReview,
    })),
  };
}
