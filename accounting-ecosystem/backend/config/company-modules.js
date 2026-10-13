'use strict';

/**
 * Single source of truth for which modules a company gets.
 * Used by registration (shared/routes/auth.js) and company creation
 * (shared/routes/companies.js) so the two paths can never drift apart.
 */

// The permanent, paid-by-default module set every company gets regardless of
// account type or trial state. 'sean' is deliberately always in this set —
// it is infrastructure the other apps use, never a separately-listed,
// separately-purchased product (dashboard.html already hides its tile from
// anyone but a super admin; it must never be presented as a trial "unlock").
const BASE_MODULES = ['pos', 'payroll', 'accounting', 'sean'];

/**
 * The full set of modules a company is EVER eligible for, by account type —
 * used both to grant the 30-day full-access trial at registration and as the
 * ceiling nothing (trial or otherwise) may exceed. Firmflow (practice) is
 * accounting-practice-only, unconditionally, trial included — a business
 * owner is never shown or granted it, at any point (Ruan's explicit rule).
 */
function trialModulesFor(holderType) {
  if (holderType === 'accounting_practice') return [...BASE_MODULES, 'inventory', 'practice'];
  if (holderType === 'business_owner')      return [...BASE_MODULES, 'inventory'];
  return [...BASE_MODULES];
}

const TRIAL_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — same convention as the Paytime demo company

module.exports = { BASE_MODULES, trialModulesFor, TRIAL_PERIOD_MS };
