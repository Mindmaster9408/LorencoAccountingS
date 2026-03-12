/**
 * ============================================================================
 * Sean Webapp — Paytime Intelligence API Proxy
 * ============================================================================
 * Catch-all Next.js API route that proxies all /api/paytime/* requests to the
 * ecosystem backend /api/sean/paytime/* endpoints.
 *
 * Environment variables required:
 *   ECOSYSTEM_API_URL   — Base URL of the ecosystem backend
 *                         e.g. https://ecosystem.lorenco.co.za
 *                         Defaults to http://localhost:3001 for local dev.
 *   ECOSYSTEM_API_TOKEN — Bearer token for ecosystem backend auth
 *                         Must belong to a user with ecosystem superuser role.
 *
 * Pattern:
 *   /api/paytime/stats           → GET  /api/sean/paytime/stats
 *   /api/paytime/proposals       → GET  /api/sean/paytime/proposals
 *   /api/paytime/proposals/5/approve → POST /api/sean/paytime/proposals/5/approve
 *   etc.
 *
 * Auth: The Sean webapp user's session is checked first (must be logged in).
 * The ecosystem backend call uses the ECOSYSTEM_API_TOKEN service token.
 * ============================================================================
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";

const ECOSYSTEM_API_BASE =
  process.env.ECOSYSTEM_API_URL || "http://localhost:3001";
const ECOSYSTEM_API_TOKEN = process.env.ECOSYSTEM_API_TOKEN;

/** Forward a request to the ecosystem backend and return the response. */
async function proxy(
  request: NextRequest,
  pathSegments: string[]
): Promise<NextResponse> {
  // Auth check — must be a logged-in Sean webapp user
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  if (!ECOSYSTEM_API_TOKEN) {
    console.error("[Paytime Proxy] ECOSYSTEM_API_TOKEN is not set");
    return NextResponse.json(
      { error: "Ecosystem API token not configured" },
      { status: 503 }
    );
  }

  const subPath = pathSegments.join("/");
  const targetUrl = `${ECOSYSTEM_API_BASE}/api/sean/paytime/${subPath}`;

  // Forward any query params
  const searchParams = request.nextUrl.searchParams.toString();
  const fullUrl = searchParams ? `${targetUrl}?${searchParams}` : targetUrl;

  try {
    let body: string | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.text();
    }

    const upstream = await fetch(fullUrl, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ECOSYSTEM_API_TOKEN}`,
        // Forward the Sean user's identity for audit purposes
        "X-Sean-User-Id": user.id,
        "X-Sean-User-Email": user.email,
      },
      ...(body ? { body } : {}),
    });

    const data = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    console.error("[Paytime Proxy] Upstream error:", error);
    return NextResponse.json(
      { error: "Failed to reach ecosystem backend" },
      { status: 502 }
    );
  }
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

type Params = { params: Promise<{ path?: string[] }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { path = [] } = await params;
  return proxy(request, path);
}

export async function POST(request: NextRequest, { params }: Params) {
  const { path = [] } = await params;
  return proxy(request, path);
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { path = [] } = await params;
  return proxy(request, path);
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { path = [] } = await params;
  return proxy(request, path);
}
