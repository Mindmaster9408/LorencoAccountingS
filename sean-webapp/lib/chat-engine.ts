// lib/chat-engine.ts
// Shared chat-answer generation, extracted from app/api/chat/messages/route.ts
// so the session-based chat route and the new API-key-authenticated
// app/api/chat/external/route.ts (used by other apps, e.g. the Ledger Leo
// widget) produce answers through exactly one code path. The only thing
// that differs between callers is how `userId`/`conversation` get resolved
// — not how an answer gets generated — so that resolution stays in each
// route, and this function only knows about conversationId/content/userId.
import prisma from "@/lib/db";
import { bootstrapAnswer } from "@/lib/llm-bootstrap";
import { processCalculation } from "@/lib/calculations";
import { queryCodex, checkDeductibility, CodexQueryResult } from "@/lib/codex-engine";
import { getAccountingContext, buildContextSummary, hasLiveData, AccountingContext } from "@/lib/accounting-context";
import { hasClientAccess, logDataAccess } from "@/lib/privacy";
import { classifyIntent } from "@/lib/intent-classifier";
import { submitTeachContent } from "@/lib/teach-submission";
import { reasonAboutQuestion } from "@/lib/reasoning-engine";

export interface ChatAnswerResult {
  assistantResponse: string;
  responseMetadata: Record<string, unknown>;
  isTeachMode: boolean;
  isAskMode: boolean;
}

/**
 * Generates an assistant response for one chat message, exactly matching
 * the behavior that lived inline in app/api/chat/messages/route.ts before
 * this extraction (2026-08-30, Ledger Leo widget integration). Does NOT
 * persist the user/assistant Message rows or the MESSAGE_SEND audit log —
 * callers do that themselves, since they differ in what else they log
 * (e.g. the external route also logs an EXTERNAL_CHAT_MESSAGE event).
 */
export async function generateChatResponse(params: {
  conversationId: string;
  content: string;
  userId: string;
  request?: Request;
}): Promise<ChatAnswerResult> {
  const { conversationId, content, userId, request } = params;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  // Live accounting-ecosystem grounding — resolve the linked client (if any)
  // and kick off the live-data fetch immediately so it overlaps with the
  // Codex/LLM work below instead of adding sequential latency. Only actually
  // prepended to the response for QUESTION/GENERAL/ALLOCATION intents (see
  // `shouldGround` below) — a CALCULATION or TEACH message has no use for it.
  let groundingClient: { id: string; name: string; ecoCompanyId: string } | null = null;
  let contextPromise: Promise<AccountingContext> | null = null;
  if (conversation?.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: conversation.clientId },
      select: { id: true, name: true, ecoCompanyId: true },
    });
    const ecoBaseUrl = process.env.ECO_BASE_URL;
    if (client?.ecoCompanyId && ecoBaseUrl && (await hasClientAccess(userId, client.id))) {
      groundingClient = { id: client.id, name: client.name, ecoCompanyId: client.ecoCompanyId };
      contextPromise = getAccountingContext(client.ecoCompanyId, ecoBaseUrl);
    }
  }
  let shouldGround = false;

  // Check for explicit prefixes first
  const teachMatch = content.match(/^(LEER:|TEACH:|SAVE TO KNOWLEDGE:)/i);
  const askMatch = content.match(/^ASK:\s*/i);
  let assistantResponse = "";
  let responseMetadata: Record<string, unknown> = {};

  if (teachMatch) {
    try {
      const result = await submitTeachContent(content, conversationId, userId);
      if (result.success) {
        assistantResponse = result.message;
        responseMetadata = { mode: "teach", citationId: result.citationId };
      } else {
        assistantResponse = `Failed to process teach message: ${result.error}`;
      }
    } catch (error) {
      console.error("Knowledge submission error:", error);
      assistantResponse = "Failed to process teach message. Please try again.";
    }
  } else if (askMatch) {
    const question = content.substring(askMatch[0].length).trim();
    try {
      const result = await reasonAboutQuestion(question, null, null, userId);
      assistantResponse = result.answer;
      responseMetadata = {
        mode: "reason",
        citations: result.citations,
        domain: result.inferredDomain,
      };
    } catch (error) {
      console.error("Reasoning error:", error);
      assistantResponse = "Failed to process question.";
    }
  } else {
    const intent = await classifyIntent(content);
    console.log(`[Chat] Intent: ${intent.type}, Domain: ${intent.domain}, Confidence: ${intent.confidence}`);

    if (intent.type === "TEACH") {
      assistantResponse = `It looks like you want to teach me something! To ensure I learn correctly, please use this format:

**TEACH:**
**TITLE:** Your topic title
**DOMAIN:** ${intent.domain}
**CONTENT:** The information you want me to remember

For example:
\`\`\`
TEACH:
TITLE: SA VAT Registration Threshold
DOMAIN: VAT
CONTENT: In South Africa, a business must register for VAT if its taxable turnover exceeds R1 million in any consecutive 12-month period.
\`\`\``;
      responseMetadata = { mode: "teach_guide", suggestedDomain: intent.domain };

    } else if (intent.type === "ALLOCATION") {
      shouldGround = true;
      const { suggestCategory, ALLOCATION_CATEGORIES } = await import("@/lib/bank-allocations");

      const descMatch = content.match(/["']([^"']+)["']/);
      if (descMatch) {
        const suggestion = await suggestCategory(descMatch[1]);
        if (suggestion.category) {
          assistantResponse = `For the transaction "${descMatch[1]}", I suggest categorizing it as **${suggestion.categoryLabel}** (${suggestion.category}) with ${(suggestion.confidence * 100).toFixed(0)}% confidence.

${suggestion.matchType === "learned" ? "This is based on patterns I've learned from previous allocations." : ""}
${suggestion.matchType === "keyword" ? "This is based on keyword matching." : ""}

If this is incorrect, you can teach me the correct category by going to the Bank Allocations page and correcting it there.`;
          responseMetadata = {
            mode: "allocation",
            suggestion,
            description: descMatch[1],
          };
        } else {
          assistantResponse = `I couldn't confidently categorize "${descMatch[1]}". Here are the available categories:\n\n${ALLOCATION_CATEGORIES.slice(0, 10).map(c => `- **${c.label}** (${c.code})`).join("\n")}\n\n...and more. Please allocate it manually in the Bank Allocations page, and I'll learn from your choice!`;
          responseMetadata = { mode: "allocation_unknown" };
        }
      } else {
        assistantResponse = `I can help with transaction allocations! Please put the transaction description in quotes, like:\n\n"How should I allocate 'TELKOM MONTHLY BILL R599'?"\n\nOr visit the **Bank Allocations** page to process transactions in bulk.`;
        responseMetadata = { mode: "allocation_help" };
      }

    } else if (intent.type === "CALCULATION") {
      const calcResult = processCalculation(content);
      if (calcResult) {
        assistantResponse = calcResult;
        responseMetadata = { mode: "calculation", domain: intent.domain };
      } else {
        try {
          const result = await bootstrapAnswer(content, intent.domain, userId);
          assistantResponse = result.answer;
          if (result.citationId) {
            assistantResponse += `\n\n📚 *[${result.citationId}]*`;
          }
          responseMetadata = { mode: "bootstrap_calculation", source: result.source };
        } catch {
          assistantResponse = `I couldn't understand that calculation. Try phrases like:
- "Calculate VAT on R1000"
- "What is the VAT on R5000 including?"
- "Income tax on R500000"
- "PAYE on R45000 monthly salary"`;
          responseMetadata = { mode: "calculation_help" };
        }
      }

    } else if (intent.type === "QUESTION" || intent.type === "GENERAL") {
      shouldGround = true;
      let codexResult: CodexQueryResult | null = null;
      try {
        codexResult = await queryCodex(content, intent.domain);
        console.log(`[Chat] Codex query: ${codexResult.taxRules.length} tax rules, ${codexResult.vatRules.length} VAT rules, ${codexResult.decisionEngines.length} decision engines`);
      } catch (error) {
        console.error("Codex query error:", error);
      }

      const isDeductibilityQuestion = /\b(deductible|deduct|claim|write.?off|expense|allowable)\b/i.test(content);
      let deductibilityResult = null;
      if (isDeductibilityQuestion && intent.domain === "INCOME_TAX") {
        try {
          deductibilityResult = await checkDeductibility(intent.domain, content, undefined);
        } catch (error) {
          console.error("Deductibility check error:", error);
        }
      }

      if (codexResult?.hasCodifiedKnowledge) {
        assistantResponse = codexResult.formattedContext;

        if (deductibilityResult) {
          assistantResponse += `\n\n💰 **Deductibility Analysis:**\n`;
          assistantResponse += `- **Status:** ${deductibilityResult.isDeductible ? "✅ Deductible" : "❌ Not Deductible"}\n`;
          assistantResponse += `- **Percentage:** ${deductibilityResult.percentage}%\n`;
          assistantResponse += `- **Reason:** ${deductibilityResult.reason}\n`;
          if (deductibilityResult.conditions.length > 0) {
            assistantResponse += `- **Conditions:**\n`;
            for (const cond of deductibilityResult.conditions) {
              assistantResponse += `  - ${cond}\n`;
            }
          }
          if (deductibilityResult.vatImplication) {
            assistantResponse += `- **VAT Implication:** ${deductibilityResult.vatImplication}\n`;
          }
        }

        responseMetadata = {
          mode: "codex",
          taxRulesCount: codexResult.taxRules.length,
          vatRulesCount: codexResult.vatRules.length,
          decisionEnginesCount: codexResult.decisionEngines.length,
          citations: [
            ...codexResult.taxRules.map(r => r.citationId),
            ...codexResult.vatRules.map(r => r.citationId),
            ...codexResult.decisionEngines.map(e => e.citationId),
          ],
          deductibilityResult: deductibilityResult ? {
            isDeductible: deductibilityResult.isDeductible,
            percentage: deductibilityResult.percentage,
          } : null,
        };
      } else {
        try {
          const result = await bootstrapAnswer(content, intent.domain, userId);

          assistantResponse = result.answer;

          if (result.citationId) {
            assistantResponse += `\n\n📚 *[${result.citationId}]*`;
          }

          if (result.source === "LLM" && result.provider) {
            assistantResponse += `\n\n💡 *This answer was generated by ${result.provider} and saved to my knowledge base for future reference.*`;
          }

          responseMetadata = {
            mode: "bootstrap",
            source: result.source,
            cached: result.cached,
            citationId: result.citationId,
            domain: result.domain,
            provider: result.provider,
          };
        } catch (error) {
          console.error("Bootstrap error:", error);
          assistantResponse = "I encountered an error while looking up the answer. Please try again or rephrase your question.";
          responseMetadata = { mode: "error" };
        }
      }
    }
  }

  // Prepend live accounting-ecosystem context, if this message's intent
  // warranted it and the fetch actually returned something. Fails safe:
  // getAccountingContext never throws (see lib/accounting-context.ts), and
  // any missing piece (no linked client, no ecoCompanyId, ECO_BASE_URL unset,
  // ecosystem backend unreachable) just leaves shouldGround/contextPromise
  // false/null and the response is unchanged.
  if (shouldGround && contextPromise && groundingClient) {
    const ctx = await contextPromise;
    if (hasLiveData(ctx)) {
      const summary = buildContextSummary(ctx);
      assistantResponse = summary + "\n" + assistantResponse;
      responseMetadata.groundedClientId = groundingClient.id;
      responseMetadata.groundedCompanyId = groundingClient.ecoCompanyId;

      await logDataAccess({
        userId,
        clientId: groundingClient.id,
        actionType: "VIEW",
        dataType: "REPORT",
        description: "Chat grounded with live accounting context",
        request,
      });
    }
  }

  return {
    assistantResponse,
    responseMetadata,
    isTeachMode: !!teachMatch,
    isAskMode: !!askMatch,
  };
}
