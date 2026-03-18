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
    payeRef:         row.paye_reference,
    uifRef:          row.uif_reference,
    sdlRef:          row.sdl_reference,
    coidNumber:      row.coid_number,
    yearEnd:         row.financial_year_end,
    vatPeriod:       row.vat_period,
    physicalAddress: row.physical_address,
    city:            row.city,
    postalCode:      row.postal_code,
    postalAddress:   row.postal_address,
    phone:           row.phone,
    email:           row.email,
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

    res.json(mapCompanyRow(data));
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
    if (d.payeRef)         updates.paye_reference      = d.payeRef;
    if (d.uifRef)          updates.uif_reference       = d.uifRef;
    if (d.sdlRef)          updates.sdl_reference       = d.sdlRef;
    if (d.coidNumber)      updates.coid_number         = d.coidNumber;
    if (d.yearEnd)         updates.financial_year_end  = d.yearEnd;
    if (d.vatPeriod)       updates.vat_period          = d.vatPeriod;
    if (d.physicalAddress) updates.physical_address    = d.physicalAddress;
    if (d.city)            updates.city                = d.city;
    if (d.postalCode)      updates.postal_code         = d.postalCode;
    if (d.postalAddress)   updates.postal_address      = d.postalAddress;
    if (d.phone)           updates.phone               = d.phone;
    if (d.email)           updates.email               = d.email;
    if (d.website)         updates.website             = d.website;
    if (d.bankName)        updates.bank_name           = d.bankName;
    if (d.branchCode)      updates.branch_code         = d.branchCode;
    if (d.accountNumber)   updates.account_number      = d.accountNumber;
    if (d.accountType)     updates.account_type        = d.accountType;
    if (d.accountHolder)   updates.account_holder      = d.accountHolder;
    updates.updated_at = new Date().toISOString();

    const { error: updateErr } = await supabase
      .from('companies')
      .update(updates)
      .eq('id', companyId);

    if (updateErr) throw updateErr;

    // Sync overlapping fields back to eco_clients (bidirectional ECO Hub sync)
    const ecoUpdates = {};
    if (d.name)            ecoUpdates.name       = d.name;
    if (d.email)           ecoUpdates.email      = d.email;
    if (d.phone)           ecoUpdates.phone      = d.phone;
    if (d.physicalAddress) ecoUpdates.address    = d.physicalAddress;
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
