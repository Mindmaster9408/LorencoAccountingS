import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ============================================
// SUPER USER ONLY ACCESS
// The Sean webapp is restricted to super users.
// Regular users access Sean through other apps
// (POS, Payroll, Accounting) via their Sean APIs.
// ============================================

// Routes that don't require session auth
const publicRoutes = ["/login", "/api/auth/login"];

// API routes that handle their own auth (API key based)
// These remain open so other apps can call Sean's API
const apiKeyAuthRoutes = [
  "/api/cron/",
  "/api/allocations/import",
  "/api/allocations/run",
  "/api/ai/",          // External app AI calls (POS, Payroll, etc.)
  "/api/chat/external", // External chat requests from other apps
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip middleware for public routes and static files
  if (publicRoutes.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // Skip middleware for API routes that handle their own auth
  // These routes use x-api-key header authentication
  // This allows other apps to use Sean without webapp access
  if (apiKeyAuthRoutes.some((route) => pathname.startsWith(route))) {
    return NextResponse.next();
  }

  // Check for session cookie (lightweight check for Edge Runtime)
  const token = request.cookies.get("session")?.value;

  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Session validation (including super user check) happens in 
  // API routes/pages using Node.js runtime via validateSession + isSuperUserEmail
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
