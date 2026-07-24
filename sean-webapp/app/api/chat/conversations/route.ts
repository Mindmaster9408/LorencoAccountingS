import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { title, clientId } = await request.json();

    const conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        title: title || "New Conversation",
        clientId: clientId || undefined,
      },
    });

    return NextResponse.json(conversation);
  } catch (error) {
    console.error("Create conversation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const conversations = await prisma.conversation.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(conversations);
  } catch (error) {
    console.error("Get conversations error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("id");

    if (!conversationId) {
      return NextResponse.json({ error: "Conversation ID required" }, { status: 400 });
    }

    // Verify conversation belongs to user
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.userId !== user.id) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    // Delete all messages first (cascade)
    await prisma.message.deleteMany({
      where: { conversationId },
    });

    // Delete conversation
    await prisma.conversation.delete({
      where: { id: conversationId },
    });

    // Log delete action
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: "CONVERSATION_DELETE",
        entityType: "Conversation",
        entityId: conversationId,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete conversation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { conversationId, title, clientId } = await request.json();

    if (!conversationId || (title === undefined && clientId === undefined)) {
      return NextResponse.json(
        { error: "Conversation ID and at least one of title/clientId required" },
        { status: 400 }
      );
    }

    // Verify conversation belongs to user
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.userId !== user.id) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const updateData: { title?: string; clientId?: string | null } = {};
    if (title !== undefined) updateData.title = title;
    // "" from the UI means "unlink client" — store as null, not an empty string
    if (clientId !== undefined) updateData.clientId = clientId || null;

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: updateData,
    });

    // Log rename/relink action
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: title !== undefined ? "CONVERSATION_RENAME" : "CONVERSATION_RELINK",
        entityType: "Conversation",
        entityId: conversationId,
        detailsJson: JSON.stringify({
          oldTitle: conversation.title,
          newTitle: title,
          oldClientId: conversation.clientId,
          newClientId: updateData.clientId,
        }),
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Rename conversation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
