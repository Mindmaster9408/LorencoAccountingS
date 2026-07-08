/**
 * ============================================================================
 * INTER-COMPANY NETWORK — Company Discovery & Matching
 * ============================================================================
 * Enables companies on the platform to discover and connect with each other.
 *
 * Matching strategies:
 *   1. Tax Number — Exact match on company registration / VAT number
 *   2. Email Domain — Match by email domain (e.g., @turkstra.co.za)
 *   3. Company Name — Fuzzy match on company name
 *   4. Invitation Code — Direct invite via unique code
 *
 * Both companies must opt-in. No data shared without consent.
 * ============================================================================
 */

const crypto = require('crypto');
const { supabase } = require('../config/database');

class InterCompanyNetwork {

  /**
   * @param {object} dataStore - Supabase data store for relationships/invoices
   */
  constructor(dataStore) {
    this.store = dataStore;
  }

  // ─── Enable Inter-Company for a Company ──────────────────────────────

  /**
   * Enable inter-company features for a company.
   * Generates an invitation code other companies can use to connect, and
   * PERSISTS it to companies.invitation_code / inter_company_enabled.
   *
   * Idempotent: a company that already has a code gets that same code back,
   * never a freshly-rotated one — rotating silently would break any partner
   * who already holds the old code and has used it to link.
   *
   * NOTE (bug fix): this previously built an "enablement record" object and
   * returned it, but never actually wrote it to the database at all — every
   * call minted a new code that vanished the moment the response was sent.
   * Confirmed live: every company in production had invitation_code = NULL,
   * inter_company_enabled = false, with no way to ever change that (no
   * frontend called this route either). Fixed here; contract unchanged for
   * the one existing caller (POST /api/inter-company/enable).
   */
  async enable(companyId, companyDetails = {}) {
    const { data: existing } = await supabase
      .from('companies')
      .select('id, invitation_code, inter_company_enabled')
      .eq('id', companyId)
      .maybeSingle();

    if (existing && existing.invitation_code) {
      return {
        success: true,
        invitationCode: existing.invitation_code,
        message: 'Inter-company features already enabled.',
        alreadyEnabled: true,
      };
    }

    const invitationCode = this.generateInviteCode();
    const updates = { invitation_code: invitationCode, inter_company_enabled: true };
    if (companyDetails.taxNumber)  updates.tax_number   = companyDetails.taxNumber;
    if (companyDetails.vatNumber)  updates.vat_number    = companyDetails.vatNumber;
    if (companyDetails.emailDomain) updates.email_domain = companyDetails.emailDomain;

    const { data: updated, error } = await supabase
      .from('companies')
      .update(updates)
      .eq('id', companyId)
      .select('id, invitation_code, inter_company_enabled')
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: true,
      invitationCode: updated.invitation_code,
      message: 'Inter-company features enabled. Share your invitation code with trading partners.',
    };
  }

  // ─── Find Companies on the Platform ──────────────────────────────────

  /**
   * Search for companies on the platform
   * @param {object} searchParams
   * @param {string} [searchParams.name] - Company name (fuzzy)
   * @param {string} [searchParams.taxNumber] - Tax/registration number (exact)
   * @param {string} [searchParams.vatNumber] - VAT number (exact)
   * @param {string} [searchParams.emailDomain] - Email domain (exact)
   * @param {string} [searchParams.invitationCode] - Direct invitation code
   * @param {number} requestingCompanyId - The company doing the search
   */
  async findCompanies(searchParams, requestingCompanyId) {
    // Query real companies from Supabase
    const { data: companies, error } = await supabase
      .from('companies')
      .select('id, company_name, trading_name, tax_number, vat_number, email_domain, invitation_code, inter_company_enabled, city, industry')
      .eq('is_active', true);

    if (error || !companies) {
      console.error('InterCompany findCompanies error:', error?.message);
      return [];
    }

    const results = [];

    for (const company of companies) {
      // Don't return the requesting company
      if (company.id === requestingCompanyId) continue;
      // Only return companies with inter-company enabled
      if (!company.inter_company_enabled) continue;

      let matchScore = 0;
      let matchType = null;

      // Invitation code — exact match (highest priority)
      if (searchParams.invitationCode && company.invitation_code === searchParams.invitationCode) {
        matchScore = 100;
        matchType = 'invitation_code';
      }

      // Tax number — exact match
      if (searchParams.taxNumber && company.tax_number &&
          company.tax_number.replace(/[\s/-]/g, '') === searchParams.taxNumber.replace(/[\s/-]/g, '')) {
        matchScore = Math.max(matchScore, 95);
        matchType = matchType || 'tax_number';
      }

      // VAT number — exact match
      if (searchParams.vatNumber && company.vat_number &&
          company.vat_number.replace(/[\s/-]/g, '') === searchParams.vatNumber.replace(/[\s/-]/g, '')) {
        matchScore = Math.max(matchScore, 95);
        matchType = matchType || 'vat_number';
      }

      // Email domain — exact match
      if (searchParams.emailDomain && company.email_domain &&
          company.email_domain.toLowerCase() === searchParams.emailDomain.toLowerCase()) {
        matchScore = Math.max(matchScore, 85);
        matchType = matchType || 'email_domain';
      }

      // Company name — fuzzy match
      const companyName = company.trading_name || company.company_name;
      if (searchParams.name && companyName) {
        const similarity = this.nameSimilarity(searchParams.name, companyName);
        if (similarity > 0.6) {
          const nameScore = Math.round(similarity * 80);
          if (nameScore > matchScore) {
            matchScore = nameScore;
            matchType = 'name_fuzzy';
          }
        }
      }

      if (matchScore > 0) {
        results.push({
          companyId: company.id,
          companyName: company.trading_name || company.company_name,
          matchScore,
          matchType,
          // Don't reveal sensitive info until connected
          preview: {
            city: company.city || null,
            industry: company.industry || null
          }
        });
      }
    }

    return results.sort((a, b) => b.matchScore - a.matchScore);
  }

  // ─── Create Relationship ─────────────────────────────────────────────

  /**
   * Create a relationship between two companies
   * Both companies must confirm for invoices to flow
   *
   * @param {number} companyAId
   * @param {number} companyBId
   * @param {number} initiatedBy
   * @param {object} [extraPermissions] — additional permission flags merged
   *   into the default set (e.g. POS's stock_transfer/receive_transfer/
   *   return_transfer/pricing_visible/invoice_reference_visible flags — see
   *   Workstream 80). All extra flags default to false unless explicitly
   *   passed true — a relationship existing must never itself grant access.
   */
  async createRelationship(companyAId, companyBId, initiatedBy, extraPermissions = {}) {
    // Check if relationship already exists
    if (this.store && this.store.findRelationship) {
      const existing = await this.store.findRelationship(companyAId, companyBId);
      if (existing) {
        return {
          success: false,
          error: 'Relationship already exists',
          relationship: existing
        };
      }
    }

    const relationship = {
      company_a_id: companyAId,
      company_b_id: companyBId,
      initiated_by: initiatedBy,
      status: 'pending',  // pending → active → revoked
      company_a_confirmed: initiatedBy === companyAId,
      company_b_confirmed: initiatedBy === companyBId,
      permissions: {
        send_invoices: true,
        receive_invoices: true,
        auto_match_payments: false,  // Must be explicitly enabled
        stock_transfer: false,
        receive_transfer: false,
        return_transfer: false,
        pricing_visible: false,
        invoice_reference_visible: false,
        ...extraPermissions,
      },
      created_at: new Date().toISOString()
    };

    if (this.store && this.store.addRelationship) {
      const saved = await this.store.addRelationship(relationship);
      relationship.id = saved.id;
    }

    return {
      success: true,
      relationship,
      message: 'Relationship request sent. The other company must confirm to enable invoice syncing.'
    };
  }

  // ─── Confirm Relationship ────────────────────────────────────────────

  /**
   * Confirm this company's side of a pending relationship.
   *
   * NOTE (Workstream 80 fix): this previously read the relationship via
   * getRelationships(companyId), which only returns status='active' rows —
   * so a still-pending relationship (the exact case this method exists to
   * handle) could never be found, and even when found the mutated object
   * was never written back to the database at all. Both are fixed here:
   * lookup is by ID (any status) and the result is persisted via
   * updateRelationship(). External behaviour/response shape is unchanged.
   */
  async confirmRelationship(relationshipId, companyId) {
    if (!this.store || !this.store.getRelationshipById) {
      return { success: false, error: 'Data store not available' };
    }

    const rel = await this.store.getRelationshipById(relationshipId);
    if (!rel) {
      return { success: false, error: 'Relationship not found' };
    }
    if (rel.company_a_id !== companyId && rel.company_b_id !== companyId) {
      return { success: false, error: 'Not authorized to confirm this relationship' };
    }
    if (rel.status === 'revoked') {
      return { success: false, error: 'This relationship has been revoked' };
    }

    const updates = {};
    if (rel.company_a_id === companyId) updates.company_a_confirmed = true;
    if (rel.company_b_id === companyId) updates.company_b_confirmed = true;

    const aConfirmed = rel.company_a_confirmed || updates.company_a_confirmed;
    const bConfirmed = rel.company_b_confirmed || updates.company_b_confirmed;
    if (aConfirmed && bConfirmed) updates.status = 'active';

    const updated = this.store.updateRelationship
      ? await this.store.updateRelationship(relationshipId, updates)
      : { ...rel, ...updates };

    return {
      success: true,
      relationship: updated || { ...rel, ...updates },
      message: (updated || {}).status === 'active'
        ? 'Relationship confirmed! You can now trade with this company.'
        : 'Your confirmation recorded. Waiting for the other company to confirm.'
    };
  }

  // ─── Revoke Relationship ─────────────────────────────────────────────

  /**
   * Revoke an active or pending relationship. Either side may revoke.
   * Revocation is immediate and one-directional — the other company is not
   * asked to confirm the revocation, only notified of the resulting status
   * (via their own relationship listing).
   */
  async revokeRelationship(relationshipId, companyId) {
    if (!this.store || !this.store.getRelationshipById) {
      return { success: false, error: 'Data store not available' };
    }

    const rel = await this.store.getRelationshipById(relationshipId);
    if (!rel) {
      return { success: false, error: 'Relationship not found' };
    }
    if (rel.company_a_id !== companyId && rel.company_b_id !== companyId) {
      return { success: false, error: 'Not authorized to revoke this relationship' };
    }

    const updated = this.store.updateRelationship
      ? await this.store.updateRelationship(relationshipId, { status: 'revoked' })
      : { ...rel, status: 'revoked' };

    return {
      success: true,
      relationship: updated || { ...rel, status: 'revoked' },
      message: 'Relationship revoked.'
    };
  }

  // ─── Get Active Relationships ────────────────────────────────────────

  async getRelationships(companyId) {
    if (!this.store || !this.store.getRelationships) {
      return [];
    }
    return await this.store.getRelationships(companyId);
  }

  /**
   * Get every relationship for this company regardless of status
   * (pending/active/revoked) — see getAllRelationships() on the store.
   */
  async getAllRelationships(companyId) {
    if (!this.store || !this.store.getAllRelationships) {
      return [];
    }
    return await this.store.getAllRelationships(companyId);
  }

  // ─── Utilities ───────────────────────────────────────────────────────

  generateInviteCode() {
    return 'IC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  nameSimilarity(a, b) {
    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim().split(/\s+/);
    const wordsA = new Set(normalize(a));
    const wordsB = new Set(normalize(b));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union === 0 ? 0 : intersection / union;
  }
}

module.exports = InterCompanyNetwork;
