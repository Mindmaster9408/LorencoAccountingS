import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import prisma from "@/lib/db";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";
import { validateQuery } from "@/lib/validation";
import { ProposedAction, ActionPreviewResponse } from "@/lib/actions";

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { question, clientId, layer, debugMode } = await request.json();

    // Validate question
    const queryValidation = validateQuery(question);
    if (!queryValidation.valid) {
      return NextResponse.json(
        { error: queryValidation.error },
        { status: 400 }
      );
    }

    // Fetch approved global knowledge items
    const knowledgeItems = await prisma.knowledgeItem.findMany({
      where: {
        status: "APPROVED",
        scopeType: "GLOBAL",
        contentText: { not: null }, // sean_knowledge_items.content_text is nullable (shared table) — never match against an empty-body row
        citationId: { not: null },
      },
      take: 10,
      orderBy: {
        createdAt: "desc",
      },
    });

    // Simple keyword scoring against knowledge items
    const lowerQuestion = question.toLowerCase();
    let bestMatch: typeof knowledgeItems[0] | null = null;
    let bestScore = 0;

    for (const item of knowledgeItems) {
      const titleLower = item.title.toLowerCase();
      const contentLower = (item.contentText as string).toLowerCase();
      let score = 0;

      // Extract keywords from question (simple heuristic)
      const words = lowerQuestion
        .split(/\s+/)
        .filter((w: string) => w.length > 3);
      for (const word of words) {
        if (titleLower.includes(word)) score += 3;
        if (contentLower.includes(word)) score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }

    // Build outcomeText
    let outcomeText: string;
    const matchedCitations: { citationId: string; title?: string }[] = [];

    if (!bestMatch || bestScore === 0) {
      outcomeText =
        "I don't have knowledge about this topic yet. Teach me using TEACH: or LEER: prefix to help me learn!";
    } else {
      outcomeText = `${bestMatch.contentText} [${bestMatch.citationId}]`;
      matchedCitations.push({
        citationId: bestMatch.citationId as string,
        title: bestMatch.title,
      });
    }

    // Build actions heuristically
    const actions: ProposedAction[] = [];

    const allocationKeywords = [
      "fuel",
      "petrol",
      "rent",
      "salary",
      "wage",
      "repairs",
      "advertising",
    ];
    const anomalyKeywords = [
      "mismatch",
      "error",
      "wrong",
      "unauthorized",
      "doesn't balance",
    ];

    const isVague =
      lowerQuestion.length < 15 ||
      /^(help|explain|how|what|why|who|when|where)/i.test(
        lowerQuestion
      );
    const hasAllocationKeyword = allocationKeywords.some((kw) =>
      lowerQuestion.includes(kw)
    );
    const hasAnomalyKeyword = anomalyKeywords.some((kw) =>
      lowerQuestion.includes(kw)
    );

    // REQUEST_MORE_INFO
    if (isVague && actions.length < 3) {
      actions.push({
        id: uuidv4(),
        type: "REQUEST_MORE_INFO",
        title: "Request clarification",
        description: "Your question is quite general. Could you provide more details?",
        risk: "LOW",
        citations: matchedCitations,
      });
    }

    // PROPOSE_ALLOCATION
    if (hasAllocationKeyword && actions.length < 3) {
      actions.push({
        id: uuidv4(),
        type: "PROPOSE_ALLOCATION",
        title: "Propose resource allocation",
        description: `Based on keywords in your question, consider allocating resources appropriately.`,
        risk: "MEDIUM",
        payload: {
          suggestedAllocationCategory: allocationKeywords.find((kw) =>
            lowerQuestion.includes(kw)
          ),
        },
        citations: matchedCitations,
      });
    }

    // FLAG_ANOMALY
    if (hasAnomalyKeyword && actions.length < 3) {
      actions.push({
        id: uuidv4(),
        type: "FLAG_ANOMALY",
        title: "Flag potential anomaly",
        description: `Your question suggests a potential discrepancy or issue that needs investigation.`,
        risk: "HIGH",
        citations: matchedCitations,
      });
    }

    // CREATE_DRAFT_JOURNAL (if we have matched knowledge and good clarity)
    if (
      bestMatch &&
      bestScore > 0 &&
      !isVague &&
      actions.length < 3
    ) {
      actions.push({
        id: uuidv4(),
        type: "CREATE_DRAFT_JOURNAL",
        title: "Create draft journal entry",
        description: `Based on the matched knowledge, a draft journal entry can be prepared for your review.`,
        risk: "LOW",
        citations: matchedCitations,
      });
    }

    // Build response
    const response: ActionPreviewResponse = {
      outcomeText,
      actions,
      hasActions: actions.length > 0,
    };

    // Add debug info if requested
    if (debugMode) {
      response.debug = {
        clientId,
        layer,
        matchedCitations,
        actionsCount: actions.length,
        questionLength: question.length,
        knowledgeItemsQueried: knowledgeItems.length,
        bestMatchScore: bestScore,
      };
    }

    // Write audit log
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: "ACTION_PREVIEW",
        entityType: "None",
        detailsJson: JSON.stringify({
          question,
          clientId,
          layer,
          debugMode,
          actionsCount: actions.length,
          citationIds: matchedCitations.map((c) => c.citationId),
        }),
      },
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("Action preview error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
