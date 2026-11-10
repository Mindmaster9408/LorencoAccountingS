import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";
import { generateChatResponse } from "@/lib/chat-engine";

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { conversationId, content } = await request.json();

    if (!conversationId || !content) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Verify conversation belongs to user
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.userId !== user.id) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    // Save user message
    const userMessage = await prisma.message.create({
      data: {
        conversationId,
        role: "user",
        content,
      },
    });

    // Answer generation itself lives in lib/chat-engine.ts, shared with
    // app/api/chat/external/route.ts (2026-08-30, Ledger Leo widget) — this
    // route only differs in how it resolves/authorizes the conversation.
    const { assistantResponse, responseMetadata, isTeachMode, isAskMode } =
      await generateChatResponse({ conversationId, content, userId: user.id, request });

    // Save assistant response
    const assistantMessage = await prisma.message.create({
      data: {
        conversationId,
        role: "assistant",
        content: assistantResponse,
      },
    });

    // Log message send action with metadata
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: "MESSAGE_SEND",
        entityType: "Message",
        entityId: userMessage.id,
        detailsJson: JSON.stringify({
          conversationId,
          messageLength: content.length,
          isTeachMode,
          isAskMode,
          responseMetadata,
        }),
      },
    });

    return NextResponse.json({
      userMessage,
      assistantMessage,
      metadata: responseMetadata,
    });
  } catch (error) {
    console.error("Send message error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversationId");

    if (!conversationId) {
      return NextResponse.json({ error: "conversationId required" }, { status: 400 });
    }

    // Verify conversation belongs to user
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.userId !== user.id) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json(messages);
  } catch (error) {
    console.error("Get messages error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
