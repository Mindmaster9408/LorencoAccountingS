import { NextRequest, NextResponse } from "next/server";
import { requireCoachingAccess, logCoachingDataAccess } from "@/lib/coaching-auth";

const COACHING_API_BASE = process.env.COACHING_API_URL || "http://localhost:3005";
const COACHING_INTERNAL_API_TOKEN = process.env.COACHING_INTERNAL_API_TOKEN;

/**
 * GET /api/coaching/clients
 * Fetch all coaching clients (Ruan only)
 * Proxies to Coaching App's internal API — /api/internal/clients
 * Uses COACHING_INTERNAL_API_TOKEN (service-to-service shared secret, NOT coach JWT)
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

  const targetUrl = `${COACHING_API_BASE}/api/internal/clients`;

  // Fetch from coaching internal API
  try {
    const response = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${COACHING_INTERNAL_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`[coaching-proxy] GET /clients → ${targetUrl} — status=${response.status}`);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[coaching-proxy] Non-OK response: ${response.status} ${body.substring(0, 200)}`);
      throw new Error(`Coaching internal API returned ${response.status}`);
    }

    const data = await response.json();
    const clients = data.clients || data;
    console.log(`[coaching-proxy] clients returned: count=${Array.isArray(clients) ? clients.length : "n/a"}`);

    return NextResponse.json({
      success: true,
      clients,
      coachingAccess: true,
    });
  } catch (error) {
    console.error("[coaching-proxy] Error fetching clients:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Failed to fetch coaching data" },
      { status: 500 }
    );
  }
}
