import { NextRequest, NextResponse } from "next/server";
import { validateSession, isSuperUserEmail } from "./auth";

export async function getUserFromRequest(request: NextRequest) {
  const token = request.cookies.get("session")?.value;
  if (!token) return null;
  
  const user = await validateSession(token);
  if (!user) return null;
  
  // Verify user is still a super user (in case role was revoked)
  const isSuperUser = await isSuperUserEmail(user.email);
  if (!isSuperUser) return null;
  
  return user;
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized - Super user access required" }, { status: 401 });
}
