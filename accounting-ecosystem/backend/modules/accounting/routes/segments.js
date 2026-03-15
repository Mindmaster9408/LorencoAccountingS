/**
 * Accounting Module — Segment Routes
 * Supports cost-centre / dimension reporting (e.g. farming: Cattle vs Macadamia).
 * Segments are stored in coa_segments + coa_segment_values.
 * Journal lines can be tagged with a segment_value_id for filtered P&L reporting.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { authenticate } = require('../middleware/auth');

// GET /api/accounting/segments — list all segments + their values for this company
router.get('/', authenticate, async (req, res) => {
  const companyId = req.companyId;
  try {
    const segsResult = await db.query(
      `SELECT id, name, code FROM coa_segments WHERE company_id = $1 ORDER BY name`,
      [companyId]
    );
    const segments = segsResult.rows;

    if (!segments.length) {
      return res.json({ segments: [] });
    }

    const segIds = segments.map(s => s.id);
    const valsResult = await db.query(
      `SELECT id, segment_id, code, name, color, sort_order
         FROM coa_segment_values
        WHERE segment_id = ANY($1)
        ORDER BY sort_order, name`,
      [segIds]
    );

    // Attach values to their parent segment
    segments.forEach(seg => {
      seg.values = valsResult.rows.filter(v => v.segment_id === seg.id);
    });

    res.json({ segments });
  } catch (err) {
    console.error('[Accounting] Get segments error:', err.message);
    res.status(500).json({ error: 'Failed to fetch segments' });
  }
});

// POST /api/accounting/segments/seed-farming — seed default farming segments if none exist
router.post('/seed-farming', authenticate, async (req, res) => {
  const companyId = req.companyId;
  try {
    // Check if segments already exist
    const existing = await db.query(
      `SELECT id FROM coa_segments WHERE company_id = $1 AND code = 'FARM_TYPE'`,
      [companyId]
    );
    if (existing.rows.length > 0) {
      return res.json({ seeded: false, message: 'Farming segments already exist for this company' });
    }

    // Create the segment
    const segResult = await db.query(
      `INSERT INTO coa_segments (company_id, name, code)
       VALUES ($1, 'Farm Type', 'FARM_TYPE')
       RETURNING id`,
      [companyId]
    );
    const segId = segResult.rows[0].id;

    // Create the values: Cattle, Macadamia/Nuts, General
    await db.query(
      `INSERT INTO coa_segment_values (segment_id, code, name, color, sort_order)
       VALUES ($1, 'CATTLE',  'Cattle',          '#f59e0b', 1),
              ($1, 'NUTS',    'Macadamia / Nuts', '#10b981', 2),
              ($1, 'GENERAL', 'General / Mixed',  '#6b7280', 3)`,
      [segId]
    );

    // Return the newly created segment + values
    const values = await db.query(
      `SELECT id, segment_id, code, name, color, sort_order
         FROM coa_segment_values WHERE segment_id = $1 ORDER BY sort_order`,
      [segId]
    );

    res.json({
      seeded: true,
      segment: { id: segId, name: 'Farm Type', code: 'FARM_TYPE', values: values.rows }
    });
  } catch (err) {
    console.error('[Accounting] Seed farming segments error:', err.message);
    res.status(500).json({ error: 'Failed to seed farming segments' });
  }
});

module.exports = router;
