// app/api/chat/external/route.ts
// External chat requests from other apps (2026-08-30, Ledger Leo widget).
// Already anticipated in middleware.ts's apiKeyAuthRoutes allowlist — this
// is that route, finally built.
//
// Auth mirrors app/api/allocations/run/route.ts exactly: x-api-key checked
// against process.env.SEAN_API_KEY, x-system-id for audit logging. The
// caller is always a trusted backend (never a browser) — Leo's own backend
// proxies its already-authenticated widget requests here server-to-server,
// so this route trusts the identity fields in the body instead of
// re-validating a foreign JWT it has no verification story for.
//
// This does NOT grant sean-webapp login access. The User row created below
// is a lightweight anchor for Message/Conversation ownership and the audit
// trail only — the session-cookie login gate in middleware.ts/lib/auth.ts's
// isSuperUserEmail is completely untouched.
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { generateChatResponse } from "@/lib/chat-engine";

export async function POST(request: NextRequest) {
  try {
    const apiKey = request.headers.get("x-api-key");
    const systemId = request.headers.get("x-system-id");
    const validApiKey = process.env.SEAN_API_KEY;

    if (!apiKey || !validApiKey || apiKey !== validApiKey) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message, leoUserEmail, ecoCompanyId, companyName } = await request.json();

    if (!message || !leoUserEmail || !ecoCompanyId) {
      return NextResponse.json(
        { error: "message, leoUserEmail and ecoCompanyId are required." },
        { status: 400 }
      );
    }

    // Lightweight anchor row — not a sean-webapp login. See file header.
    const user = await prisma.user.upsert({
      where: { email: leoUserEmail },
      create: { email: leoUserEmail },
      update: {},
    });

    // One Client row per Leo company, auto-provisioned on first chat. Keyed
    // on ecoCompanyId (unique) — the same field lib/accounting-context.ts
    // reads to fetch live trial balance / bank / VAT data for this company.
    const ecoCompanyIdStr = String(ecoCompanyId);
    const client = await prisma.client.upsert({
      where: { ecoCompanyId: ecoCompanyIdStr },
      create: {
        name: companyName || `Company ${ecoCompanyIdStr}`,
        code: `eco-${ecoCompanyIdStr}`,
        ecoCompanyId: ecoCompanyIdStr,
      },
      update: companyName ? { name: companyName } : {},
    });

    // One conversation per (Leo user, Leo company) — no sidebar/multi-
    // conversation UI needed for a widget, unlike the full /chat page.
    let conversation = await prisma.conversation.findFirst({
      where: { userId: user.id, clientId: client.id, module: "accounting_widget" },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userId: user.id,
          clientId: client.id,
          module: "accounting_widget",
          title: `Ledger Leo — ${client.name}`,
        },
      });
    }

    const userMessage = await prisma.message.create({
      data: { conversationId: conversation.id, role: "user", content: message },
    });

    const { assistantResponse, responseMetadata } = await generateChatResponse({
      conversationId: conversation.id,
      content: message,
      userId: user.id,
      request,
    });

    const assistantMessage = await prisma.message.create({
      data: { conversationId: conversation.id, role: "assistant", content: assistantResponse },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: "MESSAGE_SEND",
        entityType: "Message",
        entityId: userMessage.id,
        detailsJson: JSON.stringify({
          conversationId: conversation.id,
          systemId: systemId || "unknown",
          messageLength: message.length,
          responseMetadata,
        }),
      },
    });

    return NextResponse.json({
      answer: assistantResponse,
      metadata: responseMetadata,
    });
  } catch (error) {
    console.error("[chat/external] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
