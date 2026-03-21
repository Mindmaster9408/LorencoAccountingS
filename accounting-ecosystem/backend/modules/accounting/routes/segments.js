/**
 * Accounting Module — Segment / Division Routes
 *
 * Segments = named tracking dimensions per company (e.g. "Business Division").
 * Segment Values = the actual categories (e.g. Cattle, Nuts, General).
 *
 * Journal lines carry a segment_value_id for filtered P&L reporting.
 * One company can have multiple segments (tracking dimensions), each with
 * multiple values (the divisions).
 *
 * Architecture rule: Transactions tag the segment value — the same account is
 * shared across all divisions (no account duplication per division).
 */
const express = require('express');
const router  = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate } = require('../middleware/auth');

// ─── GET /api/accounting/segments ─────────────────────────────────────────────
// List all segments + their active values for this company.
router.get('/', authenticate, async (req, res) => {
  const companyId = req.companyId;
  try {
    const { data: segments, error: segsError } = await supabase
      .from('coa_segments')
      .select('id, name, code, description, is_active')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('name');

    if (segsError) throw new Error(segsError.message);

    if (!segments || segments.length === 0) {
      return res.json({ segments: [] });
    }

    const segIds = segments.map(s => s.id);

    const { data: vals, error: valsError } = await supabase
      .from('coa_segment_values')
      .select('id, segment_id, code, name, color, sort_order, is_active')
      .in('segment_id', segIds)
      .eq('is_active', true)
      .order('sort_order')
      .order('name');

    if (valsError) throw new Error(valsError.message);

    segments.forEach(seg => {
      seg.values = (vals || []).filter(v => v.segment_id === seg.id);
    });

    res.json({ segments });
  } catch (err) {
    console.error('[Segments] GET error:', err.message);
    res.status(500).json({ error: 'Failed to fetch segments' });
  }
});

// ─── POST /api/accounting/segments ────────────────────────────────────────────
// Create a new segment (tracking dimension) with optional initial values.
// Body: { name, code, description, values: [{ code, name, color, sort_order }] }
router.post('/', authenticate, async (req, res) => {
  const companyId = req.companyId;
  const { name, code, description, values } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Segment name is required' });
  }

  try {
    // Generate a safe code if not provided
    const segCode = (code || name).toUpperCase().replace(/[^A-Z0-9_]/g, '_').substring(0, 50);

    const { data: seg, error: segErr } = await supabase
      .from('coa_segments')
      .insert({ company_id: companyId, name: name.trim(), code: segCode, description: description || null })
      .select('id, name, code, description, is_active')
      .single();

    if (segErr) throw new Error(segErr.message);

    let createdValues = [];
    if (values && values.length > 0) {
      const valueRows = values.map((v, i) => ({
        segment_id:  seg.id,
        code:        (v.code || v.name).toUpperCase().replace(/[^A-Z0-9_]/g, '_').substring(0, 50),
        name:        v.name,
        color:       v.color || null,
        sort_order:  v.sort_order != null ? v.sort_order : i + 1
      }));

      const { data: vals, error: valErr } = await supabase
        .from('coa_segment_values')
        .insert(valueRows)
        .select('id, segment_id, code, name, color, sort_order');

      if (valErr) throw new Error(valErr.message);
      createdValues = vals || [];
    }

    res.status(201).json({ segment: { ...seg, values: createdValues } });
  } catch (err) {
    console.error('[Segments] POST error:', err.message);
    res.status(500).json({ error: 'Failed to create segment' });
  }
});

// ─── PUT /api/accounting/segments/:id ─────────────────────────────────────────
// Update a segment's name or description.
router.put('/:id', authenticate, async (req, res) => {
  const companyId = req.companyId;
  const { id } = req.params;
  const { name, description } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Segment name is required' });
  }

  try {
    const { data, error } = await supabase
      .from('coa_segments')
      .update({ name: name.trim(), description: description || null })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id, name, code, description, is_active')
      .single();

    if (error || !data) return res.status(404).json({ error: 'Segment not found' });
    res.json({ segment: data });
  } catch (err) {
    console.error('[Segments] PUT error:', err.message);
    res.status(500).json({ error: 'Failed to update segment' });
  }
});

// ─── DELETE /api/accounting/segments/:id ──────────────────────────────────────
// Soft-delete a segment (hides it from UI; data is preserved for reporting).
router.delete('/:id', authenticate, async (req, res) => {
  const companyId = req.companyId;
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('coa_segments')
      .update({ is_active: false })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id')
      .single();

    if (error || !data) return res.status(404).json({ error: 'Segment not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Segments] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to deactivate segment' });
  }
});

// ─── POST /api/accounting/segments/:id/values ─────────────────────────────────
// Add a new value (division) to an existing segment.
// Body: { name, code, color, sort_order }
router.post('/:id/values', authenticate, async (req, res) => {
  const companyId = req.companyId;
  const segmentId = req.params.id;
  const { name, code, color, sort_order } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Division name is required' });
  }

  try {
    // Verify segment belongs to this company
    const { data: seg, error: segErr } = await supabase
      .from('coa_segments')
      .select('id')
      .eq('id', segmentId)
      .eq('company_id', companyId)
      .single();

    if (segErr || !seg) return res.status(404).json({ error: 'Segment not found' });

    const valueCode = (code || name).toUpperCase().replace(/[^A-Z0-9_]/g, '_').substring(0, 50);

    const { data: val, error: valErr } = await supabase
      .from('coa_segment_values')
      .insert({ segment_id: segmentId, code: valueCode, name: name.trim(), color: color || null, sort_order: sort_order || 99 })
      .select('id, segment_id, code, name, color, sort_order, is_active')
      .single();

    if (valErr) {
      if (valErr.message.includes('unique')) return res.status(409).json({ error: 'A division with that code already exists' });
      throw new Error(valErr.message);
    }

    res.status(201).json({ value: val });
  } catch (err) {
    console.error('[Segments] POST value error:', err.message);
    res.status(500).json({ error: 'Failed to add division' });
  }
});

// ─── PUT /api/accounting/segments/:id/values/:valueId ─────────────────────────
// Update a division's name, color, or sort order.
router.put('/:id/values/:valueId', authenticate, async (req, res) => {
  const companyId = req.companyId;
  const { id: segmentId, valueId } = req.params;
  const { name, color, sort_order } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Division name is required' });
  }

  try {
    // Verify segment belongs to this company
    const { data: seg } = await supabase
      .from('coa_segments').select('id').eq('id', segmentId).eq('company_id', companyId).single();
    if (!seg) return res.status(404).json({ error: 'Segment not found' });

    const updates = { name: name.trim() };
    if (color !== undefined)      updates.color      = color;
    if (sort_order !== undefined)  updates.sort_order = sort_order;

    const { data: val, error } = await supabase
      .from('coa_segment_values')
      .update(updates)
      .eq('id', valueId)
      .eq('segment_id', segmentId)
      .select('id, segment_id, code, name, color, sort_order, is_active')
      .single();

    if (error || !val) return res.status(404).json({ error: 'Division not found' });
    res.json({ value: val });
  } catch (err) {
    console.error('[Segments] PUT value error:', err.message);
    res.status(500).json({ error: 'Failed to update division' });
  }
});

// ─── DELETE /api/accounting/segments/:id/values/:valueId ──────────────────────
// Soft-delete a division value (preserves historical data on journal lines).
router.delete('/:id/values/:valueId', authenticate, async (req, res) => {
  const companyId = req.companyId;
  const { id: segmentId, valueId } = req.params;

  try {
    const { data: seg } = await supabase
      .from('coa_segments').select('id').eq('id', segmentId).eq('company_id', companyId).single();
    if (!seg) return res.status(404).json({ error: 'Segment not found' });

    const { data: val, error } = await supabase
      .from('coa_segment_values')
      .update({ is_active: false })
      .eq('id', valueId)
      .eq('segment_id', segmentId)
      .select('id')
      .single();

    if (error || !val) return res.status(404).json({ error: 'Division not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Segments] DELETE value error:', err.message);
    res.status(500).json({ error: 'Failed to deactivate division' });
  }
});

// ─── POST /api/accounting/segments/seed-farming ───────────────────────────────
// Seed default farming segments (Cattle, Nuts, General) if none exist.
// Used when the Farming overlay template is applied to a company.
router.post('/seed-farming', authenticate, async (req, res) => {
  const companyId = req.companyId;
  try {
    // Check if a FARM_TYPE segment already exists
    const { data: existing, error: checkError } = await supabase
      .from('coa_segments')
      .select('id')
      .eq('company_id', companyId)
      .eq('code', 'FARM_TYPE');

    if (checkError) throw new Error(checkError.message);

    if (existing && existing.length > 0) {
      return res.json({ seeded: false, message: 'Farming segments already exist for this company' });
    }

    const { data: segData, error: segError } = await supabase
      .from('coa_segments')
      .insert({ company_id: companyId, name: 'Farm Division', code: 'FARM_TYPE', description: 'Farming enterprise divisions (e.g. Cattle, Nuts, General)' })
      .select('id')
      .single();

    if (segError) throw new Error(segError.message);
    const segId = segData.id;

    const { error: valuesError } = await supabase
      .from('coa_segment_values')
      .insert([
        { segment_id: segId, code: 'CATTLE',  name: 'Cattle',          color: '#f59e0b', sort_order: 1 },
        { segment_id: segId, code: 'NUTS',    name: 'Macadamia / Nuts', color: '#10b981', sort_order: 2 },
        { segment_id: segId, code: 'GENERAL', name: 'General / Mixed',  color: '#6b7280', sort_order: 3 },
      ]);

    if (valuesError) throw new Error(valuesError.message);

    const { data: values, error: fetchValError } = await supabase
      .from('coa_segment_values')
      .select('id, segment_id, code, name, color, sort_order')
      .eq('segment_id', segId)
      .order('sort_order');

    if (fetchValError) throw new Error(fetchValError.message);

    res.json({
      seeded: true,
      segment: { id: segId, name: 'Farm Division', code: 'FARM_TYPE', values: values || [] }
    });
  } catch (err) {
    console.error('[Segments] Seed farming error:', err.message);
    res.status(500).json({ error: 'Failed to seed farming segments' });
  }
});

module.exports = router;
