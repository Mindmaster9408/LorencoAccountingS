import { NextRequest, NextResponse } from "next/server";
import { requireCoachingAccess, logCoachingDataAccess } from "@/lib/coaching-auth";

const COACHING_API_BASE = process.env.COACHING_API_URL || "http://localhost:3005";
const COACHING_INTERNAL_API_TOKEN = process.env.COACHING_INTERNAL_API_TOKEN;

/**
 * GET /api/coaching/clients/[clientId]
 * Fetch specific coaching client details (Ruan only)
 * Proxies to Coaching App's internal API — /api/internal/clients/:clientId
 * Uses COACHING_INTERNAL_API_TOKEN (service-to-service shared secret, NOT coach JWT)
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

  const targetUrl = `${COACHING_API_BASE}/api/internal/clients/${clientId}`;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${COACHING_INTERNAL_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`[coaching-proxy] GET /clients/${clientId} → ${targetUrl} — status=${response.status}`);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[coaching-proxy] Non-OK response: ${response.status} ${body.substring(0, 200)}`);
      throw new Error(`Coaching internal API returned ${response.status}`);
    }

    const data = await response.json();

    return NextResponse.json(data);
  } catch (error) {
    console.error("[coaching-proxy] Error fetching client:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Failed to fetch client data" },
      { status: 500 }
    );
  }
}
