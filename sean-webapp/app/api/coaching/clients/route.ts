import { NextRequest, NextResponse } from "next/server";
import { requireCoachingAccess, logCoachingDataAccess } from "@/lib/coaching-auth";

const COACHING_API_BASE = process.env.COACHING_API_URL || "http://localhost:3005";
const COACHING_API_TOKEN = process.env.COACHING_API_TOKEN;

/**
 * GET /api/coaching/clients
 * Fetch all coaching clients (Ruan only)
 */
export async function GET(request: NextRequest) {
  // Check coaching access
  const authResult = await requireCoachingAccess(request);
  if (authResult instanceof NextResponse) {
    return authResult; // Return error response
  }

  const { user } = authResult;

  // Log the access
  await logCoachingDataAccess(user.id, null, "VIEW", request);

  // Fetch from coaching API
  try {
    const response = await fetch(`${COACHING_API_BASE}/api/clients`, {
      headers: {
        Authorization: `Bearer ${COACHING_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error("Failed to fetch coaching clients");
    }

    const data = await response.json();

    return NextResponse.json({
      success: true,
      clients: data.clients || data,
      coachingAccess: true,
    });
  } catch (error) {
    console.error("Coaching API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch coaching data" },
      { status: 500 }
    );
  }
}
