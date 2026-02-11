import { v4 as uuidv4 } from "uuid";
import prisma from "./db";

// ============================================
// SUPER USER SYSTEM
// The Sean webapp is ONLY accessible to Super Users.
// Regular users can only interact with Sean through
// other apps (POS, Payroll, etc.) via their Sean APIs.
// ============================================

// Hardcoded super users (always have access, cannot be removed)
const CORE_SUPER_USERS = [
  "ruanvlog@lorenco.co.za",
  "antonjvr@lorenco.co.za",
  "mj@lorenco.co.za",
];

// Check if an email is a Super User (ONLY super users can access Sean webapp)
export async function isSuperUserEmail(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();

  // Core super users always have access
  if (CORE_SUPER_USERS.includes(normalizedEmail)) {
    return true;
  }

  // Check database for SUPER_USER role
  try {
    const allowed = await prisma.allowedEmail.findUnique({
      where: { email: normalizedEmail },
    });
    return allowed?.role === "SUPER_USER";
  } catch (error) {
    console.warn("AllowedEmail table check failed, using fallback:", error);
    return false;
  }
}

// Legacy compatibility - isEmailAllowed now checks for SUPER_USER only
// The Sean webapp is exclusively for super users
export async function isEmailAllowed(email: string): Promise<boolean> {
  return isSuperUserEmail(email);
}

export async function addAllowedEmail(
  email: string,
  role: "SUPER_USER" | "ADMIN" = "ADMIN",
  addedBy?: string
): Promise<{ success: boolean; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return { success: false, error: "Invalid email format" };
  }

  try {
    // Check if already exists
    const existing = await prisma.allowedEmail.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      return { success: false, error: "Email already allowed" };
    }

    await prisma.allowedEmail.create({
      data: {
        email: normalizedEmail,
        role,
        addedBy,
      },
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to add allowed email:", error);
    return { success: false, error: "Database error" };
  }
}

export async function removeAllowedEmail(email: string): Promise<{ success: boolean; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Don't allow removing core super user emails
  if (CORE_SUPER_USERS.includes(normalizedEmail)) {
    return { success: false, error: "Cannot remove core super user emails" };
  }

  try {
    await prisma.allowedEmail.delete({
      where: { email: normalizedEmail },
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: "Email not found or database error" };
  }
}

export async function listAllowedEmails(): Promise<Array<{
  email: string;
  role: string;
  addedBy: string | null;
  createdAt: Date;
  isCore: boolean;
}>> {
  try {
    const dbEmails = await prisma.allowedEmail.findMany({
      orderBy: { createdAt: "asc" },
    });

    const result = [];

    // Add core super users first (always present, cannot be removed)
    for (const email of CORE_SUPER_USERS) {
      const inDb = dbEmails.find(e => e.email === email);
      result.push({
        email,
        role: "SUPER_USER",
        addedBy: null,
        createdAt: inDb?.createdAt || new Date(),
        isCore: true,
      });
    }

    // Add other DB emails (only SUPER_USER role can access the Sean app)
    for (const dbEmail of dbEmails) {
      if (!CORE_SUPER_USERS.includes(dbEmail.email)) {
        result.push({
          email: dbEmail.email,
          role: dbEmail.role,
          addedBy: dbEmail.addedBy,
          createdAt: dbEmail.createdAt,
          isCore: false,
        });
      }
    }

    return result;
  } catch (error) {
    // Return core super users if DB not available
    return CORE_SUPER_USERS.map(email => ({
      email,
      role: "SUPER_USER",
      addedBy: null,
      createdAt: new Date(),
      isCore: true,
    }));
  }
}

export async function createSession(userId: string) {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await prisma.session.create({
    data: {
      userId,
      token,
      expiresAt,
    },
  });

  return token;
}

export async function validateSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!session) return null;

  // Check if session expired
  if (new Date() > session.expiresAt) {
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  return session.user;
}

export async function deleteSession(token: string) {
  await prisma.session.delete({ where: { token } }).catch(() => null);
}

export async function getOrCreateUser(email: string) {
  const normalizedEmail = email.toLowerCase().trim();
  let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!user) {
    user = await prisma.user.create({
      data: { email: normalizedEmail },
    });
  }

  return user;
}

// Check if user is admin (Super Users are always admins)
export async function isUserAdmin(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();

  // Core super users are always admins
  if (CORE_SUPER_USERS.includes(normalizedEmail)) {
    return true;
  }

  try {
    const allowed = await prisma.allowedEmail.findUnique({
      where: { email: normalizedEmail },
    });
    return allowed?.role === "SUPER_USER" || allowed?.role === "ADMIN";
  } catch {
    return false;
  }
}
