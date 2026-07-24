import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";
import { submitTeachContent } from "@/lib/teach-submission";

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request); if (!user) return unauthorized(); const userId = user.id;

    // Rate limiting: max 30 submissions per hour
    const rateLimitKey = getRateLimitKey(userId, "kb-submit");
    if (!checkRateLimit(rateLimitKey, 30)) {
      return NextResponse.json(
        { error: "Rate limited: maximum 30 submissions per hour" },
        { status: 429 }
      );
    }

    const { content, conversationId } = await request.json();

    if (!content) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    const result = await submitTeachContent(content, conversationId, userId);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      knowledgeItem: result.knowledgeItem,
      message: result.message,
    });
  } catch (error) {
    console.error("KB submit error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
