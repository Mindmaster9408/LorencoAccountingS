import { v4 as uuidv4 } from "uuid";
import prisma from "./db";

// ============================================
// SUPER USER SYSTEM
// The Sean webapp is ONLY accessible to Super Users.
// Regular users can only interact with Sean through
// other apps (POS, Payroll, etc.) via their Sean APIs.
// ============================================

// Hardcoded super users (always have access, cannot be removed)
// Only ruanvlog@lorenco.co.za has coaching access
const CORE_SUPER_USERS = [
  { email: "ruanvlog@lorenco.co.za", hasCoachingAccess: true },
  { email: "antonjvr@lorenco.co.za", hasCoachingAccess: false },
  { email: "mj@lorenco.co.za", hasCoachingAccess: false },
];

// Additional super admin placeholders
const ADDITIONAL_SUPER_ADMINS = [
  "user3@lorenco.co.za",
  "user4@lorenco.co.za",
];

// Check if an email is a Super User (ONLY super users can access Sean webapp)
export async function isSuperUserEmail(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();

  // Core super users always have access
  if (CORE_SUPER_USERS.some(u => u.email === normalizedEmail)) {
    return true;
  }

  // Additional super admins
  if (ADDITIONAL_SUPER_ADMINS.includes(normalizedEmail)) {
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
  if (CORE_SUPER_USERS.some(u => u.email === normalizedEmail)) {
    return { success: false, error: "Cannot remove core super user emails" };
  }

  // Don't allow removing additional super admins
  if (ADDITIONAL_SUPER_ADMINS.includes(normalizedEmail)) {
    return { success: false, error: "Cannot remove super admin emails" };
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
    for (const user of CORE_SUPER_USERS) {
      const inDb = dbEmails.find(e => e.email === user.email);
      result.push({
        email: user.email,
        role: "SUPER_USER",
        addedBy: null,
        createdAt: inDb?.createdAt || new Date(),
        isCore: true,
      });
    }

    // Add additional super admins
    for (const email of ADDITIONAL_SUPER_ADMINS) {
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
    const allSuperAdminEmails = [...CORE_SUPER_USERS.map(u => u.email), ...ADDITIONAL_SUPER_ADMINS];
    for (const dbEmail of dbEmails) {
      if (!allSuperAdminEmails.includes(dbEmail.email)) {
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
    return CORE_SUPER_USERS.map(user => ({
      email: user.email,
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
  if (CORE_SUPER_USERS.some(u => u.email === normalizedEmail)) {
    return true;
  }

  // Additional super admins
  if (ADDITIONAL_SUPER_ADMINS.includes(normalizedEmail)) {
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

// Check if user has coaching data access (only ruanvlog@lorenco.co.za)
export async function hasCoachingAccess(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();

  // Check core super users
  const coreUser = CORE_SUPER_USERS.find(u => u.email === normalizedEmail);
  if (coreUser) {
    return coreUser.hasCoachingAccess;
  }

  // Additional super admins don't have coaching access
  if (ADDITIONAL_SUPER_ADMINS.includes(normalizedEmail)) {
    return false;
  }

  // Check database
  try {
    const allowed = await prisma.allowedEmail.findUnique({
      where: { email: normalizedEmail },
    });
    return allowed?.hasCoachingAccess || false;
  } catch {
    return false;
  }
}

// Log coaching data access for audit purposes
export async function logCoachingAccess(
  userId: string,
  clientId: string | null,
  accessType: string,
  ipAddress?: string
) {
  try {
    await prisma.coachingDataAccess.create({
      data: {
        userId,
        clientId,
        accessType,
        ipAddress,
      },
    });
  } catch (error) {
    console.error("Failed to log coaching access:", error);
  }
}
