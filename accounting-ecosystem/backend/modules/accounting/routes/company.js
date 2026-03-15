/**
 * Accounting Module — Company Routes
 * Uses Supabase schema: companies table + user_company_access for access control.
 * Maps Supabase column names to the format Lorenco Accounting frontend expects.
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { supabase } = require('../../../config/database');

// GET /api/accounting/company/list — companies this user can access
router.get('/list', authenticate, async (req, res) => {
  const userId = req.user.userId || req.user.id;
  const isSuperAdmin = req.user.isGlobalAdmin || req.user.isSuperAdmin || req.user.is_super_admin;

  try {
    let result;

    if (isSuperAdmin) {
      result = await db.query(
        `SELECT id,
                company_name AS name,
                registration_number AS "regNumber",
                is_active AS "isActive"
         FROM companies
         WHERE is_active = true
         ORDER BY company_name`
      );
    } else {
      result = await db.query(
        `SELECT c.id,
                c.company_name AS name,
                c.registration_number AS "regNumber",
                c.is_active AS "isActive"
         FROM companies c
         INNER JOIN user_company_access uca ON c.id = uca.company_id
         WHERE uca.user_id = $1
           AND uca.is_active = true
           AND c.is_active = true
         ORDER BY c.company_name`,
        [userId]
      );
    }

    res.json({ companies: result.rows });
  } catch (err) {
    console.error('[Accounting] Get companies error:', err.message);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// GET /api/accounting/company/:id — full company details
router.get('/:id', authenticate, async (req, res) => {
  const companyId = req.params.id;
  const userId = req.user.userId || req.user.id;
  const isSuperAdmin = req.user.isGlobalAdmin || req.user.isSuperAdmin || req.user.is_super_admin;

  try {
    if (!isSuperAdmin) {
      const accessCheck = await db.query(
        'SELECT 1 FROM user_company_access WHERE user_id = $1 AND company_id = $2 AND is_active = true',
        [userId, companyId]
      );
      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied to this company' });
      }
    }

    const result = await db.query(
      `SELECT
         id,
         company_name        AS name,
         trading_name        AS "tradingAs",
         registration_number AS "regNumber",
         company_type        AS "companyType",
         income_tax_number   AS "incomeTaxNo",
         vat_number          AS "vatNumber",
         paye_reference      AS "payeRef",
         uif_reference       AS "uifRef",
         sdl_reference       AS "sdlRef",
         coid_number         AS "coidNumber",
         financial_year_end  AS "yearEnd",
         vat_period          AS "vatPeriod",
         physical_address    AS "physicalAddress",
         city,
         postal_code         AS "postalCode",
         postal_address      AS "postalAddress",
         phone,
         email,
         website,
         bank_name           AS "bankName",
         branch_code         AS "branchCode",
         account_number      AS "accountNumber",
         account_type        AS "accountType",
         account_holder      AS "accountHolder",
         logo_url            AS "logoUrl",
         is_active           AS "isActive"
       FROM companies
       WHERE id = $1`,
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Accounting] Get company details error:', err.message);
    res.status(500).json({ error: 'Failed to fetch company details' });
  }
});

// POST /api/accounting/company — redirect to ECO dashboard for company creation
router.post('/', authenticate, (req, res) => {
  res.status(400).json({
    error: 'Companies are managed from the ECO Dashboard. Please create companies there.',
    redirectTo: '/dashboard'
  });
});

// PUT /api/accounting/company/:id — update SA tax + banking details
router.put('/:id', authenticate, authorize('ADMIN', 'ACCOUNTANT'), async (req, res) => {
  const companyId = req.params.id;
  const userId = req.user.userId || req.user.id;
  const isSuperAdmin = req.user.isGlobalAdmin || req.user.isSuperAdmin || req.user.is_super_admin;
  const data = req.body;

  try {
    if (!isSuperAdmin) {
      const accessCheck = await db.query(
        'SELECT 1 FROM user_company_access WHERE user_id = $1 AND company_id = $2 AND is_active = true',
        [userId, companyId]
      );
      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied to this company' });
      }
    }

    await db.query(
      `UPDATE companies SET
         company_name        = COALESCE($1,  company_name),
         trading_name        = COALESCE($2,  trading_name),
         registration_number = COALESCE($3,  registration_number),
         company_type        = COALESCE($4,  company_type),
         income_tax_number   = COALESCE($5,  income_tax_number),
         vat_number          = COALESCE($6,  vat_number),
         paye_reference      = COALESCE($7,  paye_reference),
         uif_reference       = COALESCE($8,  uif_reference),
         sdl_reference       = COALESCE($9,  sdl_reference),
         coid_number         = COALESCE($10, coid_number),
         financial_year_end  = COALESCE($11, financial_year_end),
         vat_period          = COALESCE($12, vat_period),
         physical_address    = COALESCE($13, physical_address),
         city                = COALESCE($14, city),
         postal_code         = COALESCE($15, postal_code),
         postal_address      = COALESCE($16, postal_address),
         phone               = COALESCE($17, phone),
         email               = COALESCE($18, email),
         website             = COALESCE($19, website),
         bank_name           = COALESCE($20, bank_name),
         branch_code         = COALESCE($21, branch_code),
         account_number      = COALESCE($22, account_number),
         account_type        = COALESCE($23, account_type),
         account_holder      = COALESCE($24, account_holder),
         updated_at          = NOW()
       WHERE id = $25`,
      [
        data.name           || null,
        data.tradingAs      || null,
        data.regNumber      || null,
        data.companyType    || null,
        data.incomeTaxNo    || null,
        data.vatNumber      || null,
        data.payeRef        || null,
        data.uifRef         || null,
        data.sdlRef         || null,
        data.coidNumber     || null,
        data.yearEnd        || null,
        data.vatPeriod      || null,
        data.physicalAddress|| null,
        data.city           || null,
        data.postalCode     || null,
        data.postalAddress  || null,
        data.phone          || null,
        data.email          || null,
        data.website        || null,
        data.bankName       || null,
        data.branchCode     || null,
        data.accountNumber  || null,
        data.accountType    || null,
        data.accountHolder  || null,
        companyId
      ]
    );

    // Sync overlapping fields back to eco_clients (if this company is a client's own company)
    // eco_clients.client_company_id links a client record to its isolated companies row.
    // Fields in common: name ↔ company_name, email ↔ email, phone ↔ phone, address ↔ physical_address
    const ecoSync = {};
    if (data.name)            ecoSync.name    = data.name;
    if (data.email)           ecoSync.email   = data.email;
    if (data.phone)           ecoSync.phone   = data.phone;
    if (data.physicalAddress) ecoSync.address = data.physicalAddress;

    if (Object.keys(ecoSync).length > 0) {
      const { error: syncErr } = await supabase
        .from('eco_clients')
        .update(ecoSync)
        .eq('client_company_id', companyId);
      if (syncErr) {
        // Non-fatal — log and continue. Not all companies are eco-clients.
        console.warn('[Accounting] eco_clients sync warning:', syncErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Accounting] Update company error:', err.message);
    res.status(500).json({ error: 'Failed to update company details' });
  }
});

// DELETE — managed via ECO dashboard
router.delete('/:id', authenticate, (req, res) => {
  res.status(400).json({
    error: 'Companies are managed from the ECO Dashboard.',
    redirectTo: '/dashboard'
  });
});

module.exports = router;
