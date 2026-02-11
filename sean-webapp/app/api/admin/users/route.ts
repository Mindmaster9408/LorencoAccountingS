import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";
import { isUserAdmin, addAllowedEmail, removeAllowedEmail, listAllowedEmails } from "@/lib/auth";

// GET - List all allowed emails
export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    // Check if user is admin
    const isAdmin = await isUserAdmin(user.email);
    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const allowedEmails = await listAllowedEmails();

    // Get user stats
    const users = await prisma.user.findMany({
      include: {
        _count: {
          select: {
            conversations: true,
            knowledgeItems: true,
            auditLogs: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      allowedEmails,
      users: users.map(u => ({
        id: u.id,
        email: u.email,
        createdAt: u.createdAt,
        conversationCount: u._count.conversations,
        knowledgeItemCount: u._count.knowledgeItems,
        auditLogCount: u._count.auditLogs,
      })),
    });
  } catch (error) {
    console.error("List users error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST - Add new allowed email
export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const isAdmin = await isUserAdmin(user.email);
    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const { email, role } = await request.json();

    if (!email) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    const result = await addAllowedEmail(
      email,
      role === "SUPER_USER" ? "SUPER_USER" : "ADMIN",
      user.email
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // Log the action
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: "USER_ALLOWLIST_ADD",
        entityType: "AllowedEmail",
        detailsJson: JSON.stringify({ email, role, addedBy: user.email }),
      },
    });

    return NextResponse.json({ success: true, email });
  } catch (error) {
    console.error("Add user error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE - Remove allowed email
export async function DELETE(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const isAdmin = await isUserAdmin(user.email);
    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const email = searchParams.get("email");

    if (!email) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    const result = await removeAllowedEmail(email);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // Log the action
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: "USER_ALLOWLIST_REMOVE",
        entityType: "AllowedEmail",
        detailsJson: JSON.stringify({ email, removedBy: user.email }),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Remove user error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
