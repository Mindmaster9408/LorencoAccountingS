// lib/teach-submission.ts
// Core "submit a TEACH: message to the knowledge base" logic, extracted from
// app/api/codex/submit/route.ts so it can be called directly (from both that
// route and app/api/chat/messages/route.ts's TEACH: branch) instead of the
// chat route self-fetching its own sibling endpoint over HTTP with manual
// cookie-forwarding.
import { parseTeachMessage, generateSlug, generateCitationId } from "./kb";
import prisma from "./db";
import type { KnowledgeItem } from "@prisma/client";

export type SubmitTeachResult =
  | { success: true; message: string; citationId: string; knowledgeItem: KnowledgeItem }
  | { success: false; error: string };

export async function submitTeachContent(
  content: string,
  conversationId: string | null | undefined,
  userId: string
): Promise<SubmitTeachResult> {
  const parsed = parseTeachMessage(content);
  if (!parsed.success) {
    return { success: false, error: parsed.error || "Invalid teach format" };
  }

  const teachData = parsed.data!;
  const slug = generateSlug(teachData.title);
  const citationId = generateCitationId(teachData.layer, slug, 1);

  const existing = await prisma.knowledgeItem.findUnique({ where: { citationId } });

  if (existing) {
    const latestVersion = await prisma.knowledgeItem.findFirst({
      where: { slug },
      orderBy: { kbVersion: "desc" },
    });

    const newVersion = (latestVersion?.kbVersion || 1) + 1;
    const newCitationId = generateCitationId(teachData.layer, slug, newVersion);

    const knowledgeItem = await prisma.knowledgeItem.create({
      data: {
        layer: teachData.layer,
        scopeType: teachData.scopeType,
        scopeClientId: teachData.scopeClientId,
        title: teachData.title,
        slug,
        contentText: teachData.contentText,
        language: teachData.language,
        tags: JSON.stringify(teachData.tags),
        primaryDomain: teachData.primaryDomain,
        secondaryDomains: JSON.stringify(teachData.secondaryDomains),
        status: "PENDING",
        kbVersion: newVersion,
        citationId: newCitationId,
        submittedByUserId: userId,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        actionType: "KB_SUBMIT",
        entityType: "KnowledgeItem",
        entityId: knowledgeItem.id,
        detailsJson: JSON.stringify({
          conversationId,
          layer: teachData.layer,
          citationId: newCitationId,
          primaryDomain: teachData.primaryDomain,
          secondaryDomains: teachData.secondaryDomains,
          isNewVersion: true,
        }),
      },
    });

    return {
      success: true,
      knowledgeItem,
      citationId: newCitationId,
      message: `Saved as PENDING knowledge for admin approval. Ref: [${newCitationId}]`,
    };
  }

  const knowledgeItem = await prisma.knowledgeItem.create({
    data: {
      layer: teachData.layer,
      scopeType: teachData.scopeType,
      scopeClientId: teachData.scopeClientId,
      title: teachData.title,
      slug,
      contentText: teachData.contentText,
      language: teachData.language,
      tags: JSON.stringify(teachData.tags),
      primaryDomain: teachData.primaryDomain,
      secondaryDomains: JSON.stringify(teachData.secondaryDomains),
      status: "PENDING",
      kbVersion: 1,
      citationId,
      submittedByUserId: userId,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId,
      actionType: "KB_SUBMIT",
      entityType: "KnowledgeItem",
      entityId: knowledgeItem.id,
      detailsJson: JSON.stringify({
        conversationId,
        layer: teachData.layer,
        citationId,
        primaryDomain: teachData.primaryDomain,
        secondaryDomains: teachData.secondaryDomains,
      }),
    },
  });

  return {
    success: true,
    knowledgeItem,
    citationId,
    message: `Saved as PENDING knowledge for admin approval. Ref: [${citationId}]`,
  };
}
