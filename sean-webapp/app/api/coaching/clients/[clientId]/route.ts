import { NextRequest, NextResponse } from "next/server";
import { requireCoachingAccess, logCoachingDataAccess } from "@/lib/coaching-auth";

const COACHING_API_BASE = process.env.COACHING_API_URL || "http://localhost:3005";
const COACHING_API_TOKEN = process.env.COACHING_API_TOKEN;

/**
 * GET /api/coaching/clients/[clientId]
 * Fetch specific coaching client details (Ruan only)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { clientId: string } }
) {
  const authResult = await requireCoachingAccess(request);
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const { user } = authResult;
  const { clientId } = params;

  // Log the access
  await logCoachingDataAccess(user.id, clientId, "VIEW", request);

  try {
    const response = await fetch(`${COACHING_API_BASE}/api/clients/${clientId}`, {
      headers: {
        Authorization: `Bearer ${COACHING_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error("Failed to fetch client details");
    }

    const data = await response.json();

    return NextResponse.json(data);
  } catch (error) {
    console.error("Coaching API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch client data" },
      { status: 500 }
    );
  }
}
