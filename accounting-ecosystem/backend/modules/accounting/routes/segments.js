/**
 * Accounting Module — Segment Routes
 * Supports cost-centre / dimension reporting (e.g. farming: Cattle vs Macadamia).
 * Segments are stored in coa_segments + coa_segment_values.
 * Journal lines can be tagged with a segment_value_id for filtered P&L reporting.
 */
const express = require('express');
const router  = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate } = require('../middleware/auth');

// GET /api/accounting/segments — list all segments + their values for this company
router.get('/', authenticate, async (req, res) => {
  const companyId = req.companyId;
  try {
    const { data: segments, error: segsError } = await supabase
      .from('coa_segments')
      .select('id, name, code')
      .eq('company_id', companyId)
      .order('name');

    if (segsError) throw new Error(segsError.message);

    if (!segments || segments.length === 0) {
      return res.json({ segments: [] });
    }

    const segIds = segments.map(s => s.id);

    const { data: vals, error: valsError } = await supabase
      .from('coa_segment_values')
      .select('id, segment_id, code, name, color, sort_order')
      .in('segment_id', segIds)
      .order('sort_order')
      .order('name');

    if (valsError) throw new Error(valsError.message);

    // Attach values to their parent segment
    segments.forEach(seg => {
      seg.values = (vals || []).filter(v => v.segment_id === seg.id);
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
    const { data: existing, error: checkError } = await supabase
      .from('coa_segments')
      .select('id')
      .eq('company_id', companyId)
      .eq('code', 'FARM_TYPE');

    if (checkError) throw new Error(checkError.message);

    if (existing && existing.length > 0) {
      return res.json({ seeded: false, message: 'Farming segments already exist for this company' });
    }

    // Create the segment
    const { data: segData, error: segError } = await supabase
      .from('coa_segments')
      .insert({ company_id: companyId, name: 'Farm Type', code: 'FARM_TYPE' })
      .select('id')
      .single();

    if (segError) throw new Error(segError.message);
    const segId = segData.id;

    // Create the values: Cattle, Macadamia/Nuts, General
    const { error: valuesError } = await supabase
      .from('coa_segment_values')
      .insert([
        { segment_id: segId, code: 'CATTLE',  name: 'Cattle',           color: '#f59e0b', sort_order: 1 },
        { segment_id: segId, code: 'NUTS',    name: 'Macadamia / Nuts',  color: '#10b981', sort_order: 2 },
        { segment_id: segId, code: 'GENERAL', name: 'General / Mixed',   color: '#6b7280', sort_order: 3 },
      ]);

    if (valuesError) throw new Error(valuesError.message);

    // Return the newly created segment + values
    const { data: values, error: fetchValError } = await supabase
      .from('coa_segment_values')
      .select('id, segment_id, code, name, color, sort_order')
      .eq('segment_id', segId)
      .order('sort_order');

    if (fetchValError) throw new Error(fetchValError.message);

    res.json({
      seeded: true,
      segment: { id: segId, name: 'Farm Type', code: 'FARM_TYPE', values: values || [] }
    });
  } catch (err) {
    console.error('[Accounting] Seed farming segments error:', err.message);
    res.status(500).json({ error: 'Failed to seed farming segments' });
  }
});

module.exports = router;
