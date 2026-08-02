/**
 * ============================================================================
 * POS Brands Routes - Checkout Charlie Module
 * ============================================================================
 * Mirrors categories.js exactly (same CRUD shape, same permissions) minus
 * color (no swatch needed) and parent_id (brands are a flat list, unlike
 * categories' hierarchy). See categories.js for the pattern this follows.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/brands
 */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('brands')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .order('name');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ brands: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/brands
 */
router.post('/', requirePermission('PRODUCTS.CREATE'), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data, error } = await supabase
      .from('brands')
      .insert({
        company_id: req.companyId,
        name,
        description,
        is_active: true
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ brand: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/brands/:id
 */
router.put('/:id', requirePermission('PRODUCTS.EDIT'), async (req, res) => {
  try {
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.is_active !== undefined) updates.is_active = req.body.is_active;

    const { data, error } = await supabase
      .from('brands')
      .update(updates)
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ brand: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/pos/brands/:id (soft delete)
 */
router.delete('/:id', requirePermission('PRODUCTS.DELETE'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('brands')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
