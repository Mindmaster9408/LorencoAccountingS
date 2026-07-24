/**
 * ============================================================================
 * Mint a long-lived service token — for server-to-server calls into this
 * backend (e.g. the Sean webapp's live-data bridge, lib/accounting-context.ts
 * and the Paytime intelligence proxy).
 * ============================================================================
 * There is no special "service token" concept on this backend — the existing
 * authenticateToken / accounting-module authenticate() / hasPermission()
 * chain already fully supports this: any JWT signed with JWT_SECRET for a
 * real, active super-admin user works, and the X-Company-Id header override
 * (already implemented in middleware/auth.js for isGlobalAdmin/super_admin
 * roles) lets the caller pick which company's data to read.
 *
 * The only real gap is that normal login tokens expire in 8-24h — too short
 * to sit in an env var indefinitely. This script mints one with a long
 * (but bounded — never infinite) expiry instead.
 *
 * Usage:
 *   node scripts/mint_service_token.js [email] [expiresIn]
 *   node scripts/mint_service_token.js ruanvlog@lorenco.co.za 365d
 *
 * Defaults: email=ruanvlog@lorenco.co.za, expiresIn=365d
 *
 * The printed token is a secret — paste it into the CALLING app's env vars
 * (e.g. sean-webapp/.env → ECO_SERVICE_TOKEN and ECOSYSTEM_API_TOKEN), never
 * commit it, and re-run this script to rotate before it expires.
 * ============================================================================
 */

require('dotenv').config();
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set in this backend\'s environment.');
  process.exit(1);
}

const email = process.argv[2] || 'ruanvlog@lorenco.co.za';
const expiresIn = process.argv[3] || '365d';

(async () => {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, role, is_super_admin, is_active, full_name')
    .eq('email', email)
    .maybeSingle();

  if (error || !user) {
    console.error(`No user found for email "${email}":`, error?.message || 'not found');
    process.exit(1);
  }
  if (!user.is_active) {
    console.error(`User "${email}" exists but is not active — a service token for a disabled account is useless (the session check in middleware/auth.js rejects it).`);
    process.exit(1);
  }
  if (!user.is_super_admin) {
    console.error(`User "${email}" is not a super admin. A service token needs isGlobalAdmin to bypass per-company/per-permission checks on both the shared ecosystem middleware and every module's own auth bridge (e.g. modules/accounting/middleware/auth.js).`);
    process.exit(1);
  }

  const token = jwt.sign(
    {
      userId: user.id,
      role: user.role,
      isSuperAdmin: true,
      isGlobalAdmin: true,
      email: user.email,
      fullName: user.full_name,
      // Marks this token as a minted service credential, not an interactive
      // login session — purely informational, nothing currently branches on
      // it, but keeps intent visible if this token is ever inspected/audited.
      tokenPurpose: 'service',
    },
    JWT_SECRET,
    { expiresIn }
  );

  console.log('\n=== Service token minted ===');
  console.log(`User:       ${user.email} (id=${user.id}, role=${user.role})`);
  console.log(`Expires in: ${expiresIn}`);
  console.log('\nToken (secret — do not commit, do not log anywhere persistent):\n');
  console.log(token);
  console.log('\nPaste into the calling app\'s env, e.g. sean-webapp/.env:');
  console.log('  ECO_SERVICE_TOKEN=' + token);
  console.log('  ECOSYSTEM_API_TOKEN=' + token);
  console.log('\nAlso set the base URL, e.g.:');
  console.log('  ECO_BASE_URL=https://<your-accounting-ecosystem-deployment>');
  console.log('  ECOSYSTEM_API_URL=https://<your-accounting-ecosystem-deployment>');
  console.log('\nRotate before expiry by re-running this script and updating the env var.\n');
  // No explicit process.exit() — supabase-js's realtime client keeps a handle
  // open that segfaults on a forced exit on Windows; letting the event loop
  // drain naturally avoids that (node.js does not need `--exit`/exit() here
  // since nothing else is scheduled after this point).
})();
