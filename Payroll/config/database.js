/**
 * ============================================================================
 * Lorenco Paytime — Database Configuration (Supabase)
 * ============================================================================
 * Mirrors the accounting-ecosystem pattern.
 * Uses Supabase JS client with service-role key for backend operations.
 * ============================================================================
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables');
  console.error('   Copy .env.example to .env and fill in your Supabase credentials');
  process.exit(1);
}

// Service-role client (bypasses RLS — use for backend operations only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Anon client (respects RLS — use when forwarding user context)
const supabaseAnon = SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/**
 * Health check — verify Supabase connection is working
 */
async function checkConnection(maxRetries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase
        .from('payroll_kv_store')
        .select('key')
        .limit(1);
      if (error) throw error;
      return true;
    } catch (err) {
      console.error(`❌ Supabase connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        console.log(`   Retrying in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  return false;
}

module.exports = { supabase, supabaseAnon, checkConnection };
