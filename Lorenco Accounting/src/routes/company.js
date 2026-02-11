const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/company/list - Get all companies for the user
router.get('/list', authenticate, async (req, res) => {
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.registration_number as "regNumber", c.is_active as "isActive"
       FROM companies c
       INNER JOIN user_companies uc ON c.id = uc.company_id
       WHERE uc.user_id = $1
       ORDER BY c.name`,
      [userId]
    );

    res.json({ companies: result.rows });
  } catch (err) {
    console.error('Get companies error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// GET /api/company/:id - Get company details
router.get('/:id', authenticate, async (req, res) => {
  const companyId = req.params.id;
  const userId = req.user.userId;

  try {
    // Verify user has access to this company
    const accessCheck = await db.query(
      'SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [userId, companyId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this company' });
    }

    const result = await db.query(
      `SELECT
        id, name, trading_as as "tradingAs", registration_number as "regNumber",
        company_type as "companyType", income_tax_number as "incomeTaxNo",
        vat_number as "vatNumber", paye_reference as "payeRef",
        uif_reference as "uifRef", sdl_reference as "sdlRef",
        coid_number as "coidNumber", financial_year_end as "yearEnd",
        vat_period as "vatPeriod", physical_address as "physicalAddress",
        city, postal_code as "postalCode", postal_address as "postalAddress",
        phone, email, website, bank_name as "bankName",
        branch_code as "branchCode", account_number as "accountNumber",
        account_type as "accountType", account_holder as "accountHolder",
        logo_url as "logoUrl", is_active as "isActive"
       FROM companies WHERE id = $1`,
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get company details error:', err);
    res.status(500).json({ error: 'Failed to fetch company details' });
  }
});

// POST /api/company - Create new company
router.post('/', authenticate, authorize('ADMIN'), async (req, res) => {
  const userId = req.user.userId;
  const { name, regNumber } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Company name is required' });
  }

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // Create company
    const companyResult = await client.query(
      `INSERT INTO companies (name, registration_number, is_active)
       VALUES ($1, $2, true)
       RETURNING id`,
      [name, regNumber || null]
    );

    const companyId = companyResult.rows[0].id;

    // Link user to company as admin
    await client.query(
      `INSERT INTO user_companies (user_id, company_id, role)
       VALUES ($1, $2, 'ADMIN')`,
      [userId, companyId]
    );

    await client.query('COMMIT');

    res.status(201).json({ id: companyId, name, regNumber });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create company error:', err);
    res.status(500).json({ error: 'Failed to create company' });
  } finally {
    client.release();
  }
});

// PUT /api/company/:id - Update company
router.put('/:id', authenticate, authorize('ADMIN', 'ACCOUNTANT'), async (req, res) => {
  const companyId = req.params.id;
  const userId = req.user.userId;
  const data = req.body;

  try {
    // Verify user has access to this company
    const accessCheck = await db.query(
      'SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [userId, companyId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this company' });
    }

    await db.query(
      `UPDATE companies SET
        name = $1, trading_as = $2, registration_number = $3,
        company_type = $4, income_tax_number = $5, vat_number = $6,
        paye_reference = $7, uif_reference = $8, sdl_reference = $9,
        coid_number = $10, financial_year_end = $11, vat_period = $12,
        physical_address = $13, city = $14, postal_code = $15,
        postal_address = $16, phone = $17, email = $18, website = $19,
        bank_name = $20, branch_code = $21, account_number = $22,
        account_type = $23, account_holder = $24, updated_at = CURRENT_TIMESTAMP
       WHERE id = $25`,
      [
        data.name, data.tradingAs, data.regNumber,
        data.companyType, data.incomeTaxNo, data.vatNumber,
        data.payeRef, data.uifRef, data.sdlRef,
        data.coidNumber, data.yearEnd, data.vatPeriod,
        data.physicalAddress, data.city, data.postalCode,
        data.postalAddress, data.phone, data.email, data.website,
        data.bankName, data.branchCode, data.accountNumber,
        data.accountType, data.accountHolder, companyId
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Update company error:', err);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// DELETE /api/company/:id - Deactivate company (soft delete)
router.delete('/:id', authenticate, authorize('ADMIN'), async (req, res) => {
  const companyId = req.params.id;
  const userId = req.user.userId;

  try {
    // Verify user has admin access to this company
    const accessCheck = await db.query(
      "SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2 AND role = 'ADMIN'",
      [userId, companyId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.query(
      'UPDATE companies SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [companyId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Delete company error:', err);
    res.status(500).json({ error: 'Failed to deactivate company' });
  }
});

module.exports = router;
