import { hasCoachingAccess, validateSession, logCoachingAccess } from "./auth";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * Middleware to check if user has coaching data access
 * Use this on all coaching-related API routes
 * Only ruanvlog@lorenco.co.za has coaching access
 */
export async function requireCoachingAccess(request: NextRequest) {
  const token = cookies().get("session")?.value;

  if (!token) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
  }

  const user = await validateSession(token);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid session" },
      { status: 401 }
    );
  }

  const hasAccess = await hasCoachingAccess(user.email);
  if (!hasAccess) {
    return NextResponse.json(
      {
        error: "Coaching data access denied",
        message:
          "You do not have permission to access coaching client data. Please contact Ruan for coaching-related inquiries.",
      },
      { status: 403 }
    );
  }

  return { user, hasAccess: true };
}

/**
 * Helper to log coaching data access with IP address
 */
export async function logCoachingDataAccess(
  userId: string,
  clientId: string | null,
  accessType: "VIEW" | "QUERY" | "EXPORT",
  request: NextRequest
) {
  const ipAddress = request.headers.get("x-forwarded-for") || request.ip || "unknown";
  await logCoachingAccess(userId, clientId, accessType, ipAddress);
}
