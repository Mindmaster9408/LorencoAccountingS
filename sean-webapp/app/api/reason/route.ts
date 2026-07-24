import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";
import { validateQuery } from "@/lib/validation";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";
import { reasonAboutQuestion } from "@/lib/reasoning-engine";

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();
    const userId = user.id;

    // Rate limiting: max 60 requests per hour
    const rateLimitKey = getRateLimitKey(userId, "reason");
    if (!checkRateLimit(rateLimitKey, 60)) {
      return NextResponse.json(
        { error: "Rate limited: maximum 60 queries per hour" },
        { status: 429 }
      );
    }

    const { question, clientId, layer } = await request.json();

    // Validate question
    const questionValidation = validateQuery(question);
    if (!questionValidation.valid) {
      return NextResponse.json(
        { error: questionValidation.error },
        { status: 400 }
      );
    }

    const result = await reasonAboutQuestion(question, clientId, layer, userId);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Reasoning error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
