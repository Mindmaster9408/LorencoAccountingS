/**
 * Accounting Module — Company Routes
 * Uses Supabase JS client (same as the rest of the ECO Hub) — NOT the pg Pool,
 * since ACCOUNTING_DATABASE_URL / DATABASE_URL is not required in this path.
 * On PUT, also syncs overlapping fields back to eco_clients (bidirectional sync with ECO Hub).
 */
const express = require('express');
const router = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { buildDisplayConfig } = require('../../../shared/services/jurisdiction');
const companyIdentitySync = require('../../../shared/services/companyIdentitySync');

// ── field mapping helpers ─────────────────────────────────────────────────────

function mapCompanyRow(row) {
  if (!row) return null;
  return {
    id:              row.id,
    name:            row.company_name,
    tradingAs:       row.trading_name,
    regNumber:       row.registration_number,
    companyType:     row.company_type,
    incomeTaxNo:     row.income_tax_number,
    vatNumber:          row.vat_number,
    isVatRegistered:    row.is_vat_registered || false,
    vatCycleType:       row.vat_cycle_type,
    vatRegisteredDate:  row.vat_registered_date,
    // Canonical column names (2026-07-24) — this module used to read/write
    // paye_reference/uif_reference/sdl_reference/coid_number, a DIFFERENT set of
    // column names than Payroll's company-details page uses on the exact same
    // companies row (paye_reference_number/uif_reference_number/
    // sdl_reference_number/coid_reference_number). Confirmed live: every one of
    // the 49 companies in the DB had null in the old names and real data in
    // the new ones — Accounting's own company page was silently blank for
    // these fields the whole time. Repointed to match Payroll's (and the
    // shared PUT /api/companies/:id route's) already-correct naming instead.
    payeRef:         row.paye_reference_number,
    uifRef:          row.uif_reference_number,
    sdlRef:          row.sdl_reference_number,
    coidNumber:      row.coid_reference_number,
    yearEnd:         row.financial_year_end,
    vatPeriod:       row.vat_period,
    // International rollout (2026-09-13) — jurisdiction/currency_code live on
    // this same companies row since migration 167 (shared with POS/Inventory).
    // Raw values here for anything that wants them directly; GET /:id below
    // also merges the full buildDisplayConfig() bundle (symbol/tax label/tax
    // authority/locale) since navigation.js already fetches this route on
    // every accounting page — one shared place to derive currency/tax display
    // from, not a second per-page fetch.
    jurisdiction:    row.jurisdiction,
    currencyCode:    row.currency_code,
    // Address (2026-11-26): the canonical structured columns that Paytime,
    // invoices, statements, EMP501 and Eco billing already use. This page used
    // to read physical_address / city / postal_code — empty for every company,
    // so the address showed blank here and edits never reached invoices.
    addressStreet:     row.address_street,
    addressSuburb:     row.address_suburb,
    addressCity:       row.address_city,
    addressProvince:   row.address_province,
    addressPostalCode: row.address_postal_code,
    postalAddress:   row.postal_address,
    // contact_email / contact_phone are the columns Paytime, Checkout Charlie,
    // invoices and Eco billing use (email / phone are legacy, almost all empty)
    phone:           row.contact_phone || row.phone,
    email:           row.contact_email || row.email,
    website:         row.website,
    bankName:        row.bank_name,
    branchCode:      row.branch_code,
    accountNumber:   row.account_number,
    accountType:     row.account_type,
    accountHolder:   row.account_holder,
    logoUrl:         row.logo_url,
    isActive:        row.is_active,
  };
}

// ── GET /api/accounting/company/list — companies scoped to this practice ──────
// ISOLATION RULE: only returns client companies managed by the same practice that
// owns the current JWT company. Super admin status does NOT bypass this — a super
// admin logged into Practice A must never see Practice B's clients.
router.get('/list', authenticate, async (req, res) => {
  try {
    // Step 1: resolve the practice company ID from the current JWT company.
    // The JWT company may be:
    //   (a) a client_company_id  → look up its managing practice via eco_clients
    //   (b) the practice company itself (direct login, not SSO'd into a client)
    let practiceCompanyId = req.companyId;

    const { data: clientRecord } = await supabase
      .from('eco_clients')
      .select('company_id')
      .eq('client_company_id', req.companyId)
      .maybeSingle();

    if (clientRecord?.company_id) {
      // JWT company is a client — its practice is clientRecord.company_id
      practiceCompanyId = clientRecord.company_id;
    }
    // else: JWT company IS the practice (direct login) — use req.companyId as-is

    // Step 2: get all client companies belonging to this practice
    const { data: ecoClients, error: ecoErr } = await supabase
      .from('eco_clients')
      .select('client_company_id')
      .eq('company_id', practiceCompanyId)
      .not('client_company_id', 'is', null);

    if (ecoErr) throw ecoErr;

    const clientCompanyIds = (ecoClients || []).map(r => r.client_company_id);

    if (clientCompanyIds.length === 0) {
      // No clients registered for this practice yet
      return res.json({ companies: [] });
    }

    // Step 3: fetch those companies
    const { data, error } = await supabase
      .from('companies')
      .select('id, company_name, registration_number, is_active')
      .in('id', clientCompanyIds)
      .eq('is_active', true)
      .order('company_name');

    if (error) throw error;

    const companies = (data || []).map(r => ({
      id:        r.id,
      name:      r.company_name,
      regNumber: r.registration_number,
      isActive:  r.is_active,
    }));

    res.json({ companies });
  } catch (err) {
    console.error('[Accounting] Get companies error:', err.message, '| companyId:', req.companyId);
    res.status(500).json({ error: 'Failed to fetch companies', detail: err.message });
  }
});

// ── GET /api/accounting/company/:id — full company details ────────────────────
router.get('/:id', authenticate, async (req, res) => {
  const companyId = req.params.id;
  const isSuperAdmin = req.user.isGlobalAdmin || req.user.isSuperAdmin || req.user.is_super_admin;

  if (!isSuperAdmin && String(req.companyId) !== String(companyId)) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  try {
    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .eq('id', companyId)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Company not found' });

    // Top-level merge (not nested) — navigation.js's existing fetch already
    // reads d.name directly off this response; every accounting page can now
    // also read d.currency_symbol/d.tax_label/d.tax_authority/d.jurisdiction
    // from the exact same call, no second round-trip.
    res.json({ ...mapCompanyRow(data), ...buildDisplayConfig(data) });
  } catch (err) {
    console.error('[Accounting] Get company details error:', err.message);
    res.status(500).json({ error: 'Failed to fetch company details', detail: err.message });
  }
});

// ── POST /api/accounting/company — redirect to ECO dashboard ─────────────────
router.post('/', authenticate, (req, res) => {
  res.status(400).json({
    error: 'Companies are managed from the ECO Dashboard. Please create companies there.',
    redirectTo: '/dashboard'
  });
});

// ── PUT /api/accounting/company/:id — update SA tax + banking details ─────────
router.put('/:id', authenticate, authorize('admin', 'accountant'), async (req, res) => {
  const companyId = req.params.id;
  const isSuperAdmin = req.user.isGlobalAdmin || req.user.isSuperAdmin || req.user.is_super_admin;
  const d = req.body;

  if (!isSuperAdmin && String(req.companyId) !== String(companyId)) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  try {
    // Build update object — only include non-empty values so COALESCE behaviour is preserved
    const updates = {};
    if (d.name)            updates.company_name        = d.name;
    if (d.tradingAs)       updates.trading_name        = d.tradingAs;
    if (d.regNumber)       updates.registration_number = d.regNumber;
    if (d.companyType)     updates.company_type        = d.companyType;
    if (d.incomeTaxNo)     updates.income_tax_number   = d.incomeTaxNo;
    if (d.vatNumber)          updates.vat_number           = d.vatNumber;
    // is_vat_registered is a boolean — handle explicit false correctly
    if (d.isVatRegistered !== undefined) updates.is_vat_registered = !!d.isVatRegistered;
    if (d.vatCycleType)       updates.vat_cycle_type       = d.vatCycleType;
    if (d.vatRegisteredDate)  updates.vat_registered_date  = d.vatRegisteredDate;
    if (d.payeRef)         updates.paye_reference_number = d.payeRef;
    if (d.uifRef)          updates.uif_reference_number  = d.uifRef;
    if (d.sdlRef)          updates.sdl_reference_number  = d.sdlRef;
    if (d.coidNumber)      updates.coid_reference_number = d.coidNumber;
    if (d.yearEnd)         updates.financial_year_end  = d.yearEnd;
    if (d.vatPeriod)       updates.vat_period          = d.vatPeriod;
    if (d.addressStreet)     updates.address_street      = d.addressStreet;
    if (d.addressSuburb)     updates.address_suburb      = d.addressSuburb;
    if (d.addressCity)       updates.address_city        = d.addressCity;
    if (d.addressProvince)   updates.address_province    = d.addressProvince;
    if (d.addressPostalCode) updates.address_postal_code = d.addressPostalCode;
    if (d.postalAddress)   updates.postal_address      = d.postalAddress;
    if (d.phone)           updates.contact_phone       = d.phone;
    if (d.email)           updates.contact_email       = d.email;
    if (d.website)         updates.website             = d.website;
    if (d.bankName)        updates.bank_name           = d.bankName;
    if (d.branchCode)      updates.branch_code         = d.branchCode;
    if (d.accountNumber)   updates.account_number      = d.accountNumber;
    if (d.accountType)     updates.account_type        = d.accountType;
    if (d.accountHolder)   updates.account_holder      = d.accountHolder;
    updates.updated_at = new Date().toISOString();

    // Previous values, so only fields that really changed are mirrored to ECO Hub
    const { data: oldIdentity } = await supabase
      .from('companies').select('company_name, contact_email, contact_phone, address_street, address_suburb, address_city, address_province, address_postal_code')
      .eq('id', companyId).maybeSingle();

    const { error: updateErr } = await supabase
      .from('companies')
      .update(updates)
      .eq('id', companyId);

    if (updateErr) throw updateErr;

    // Mirror name / email / phone / address to the ECO Hub client record
    // (shared/services/companyIdentitySync.js — same path as Paytime's edits).
    await companyIdentitySync.mirrorCompanyToEcoClients(parseInt(companyId, 10), companyIdentitySync.changedColumns(oldIdentity, updates));

    // eco_clients.id_number carries the registration number for businesses
    const ecoUpdates = {};
    if (d.regNumber)       ecoUpdates.id_number  = d.regNumber;

    if (Object.keys(ecoUpdates).length > 0) {
      ecoUpdates.updated_at = new Date().toISOString();
      const { error: syncErr } = await supabase
        .from('eco_clients')
        .update(ecoUpdates)
        .eq('client_company_id', parseInt(companyId));

      if (syncErr) {
        // Non-fatal — log but don't fail the main save
        console.warn('[Accounting] eco_clients sync skipped:', syncErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Accounting] Update company error:', err.message);
    res.status(500).json({ error: 'Failed to update company details', detail: err.message });
  }
});

// ── DELETE — managed via ECO dashboard ───────────────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  res.status(400).json({
    error: 'Companies are managed from the ECO Dashboard.',
    redirectTo: '/dashboard'
  });
});

module.exports = router;
