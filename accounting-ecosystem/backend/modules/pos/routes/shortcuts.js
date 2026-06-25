/**
 * POS User Product Shortcuts
 * GET    /api/pos/shortcuts           — list current user's shortcuts
 * POST   /api/pos/shortcuts           — add a shortcut (idempotent)
 * DELETE /api/pos/shortcuts/:product_id — remove a shortcut
 * PATCH  /api/pos/shortcuts/reorder   — update sort order
 *
 * All routes are scoped to req.companyId + req.user.userId from JWT.
 * No localStorage — DB is the only source of truth.
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const router = express.Router();

// GET /api/pos/shortcuts
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pos_user_product_shortcuts')
            .select('product_id, sort_order')
            .eq('company_id', req.companyId)
            .eq('user_id', req.user.userId)
            .order('sort_order', { ascending: true })
            .order('created_at', { ascending: true });

        if (error) return res.status(500).json({ error: error.message });
        res.json({ shortcuts: data || [] });
    } catch (err) {
        console.error('[pos/shortcuts] GET error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PATCH /api/pos/shortcuts/reorder — must be before /:product_id
router.patch('/reorder', async (req, res) => {
    try {
        const { product_ids } = req.body;
        if (!Array.isArray(product_ids)) {
            return res.status(400).json({ error: 'product_ids array required' });
        }

        const now = new Date().toISOString();
        const updates = product_ids.map((productId, index) => ({
            company_id: req.companyId,
            user_id: req.user.userId,
            product_id: parseInt(productId, 10),
            sort_order: index,
            updated_at: now
        }));

        const { error } = await supabase
            .from('pos_user_product_shortcuts')
            .upsert(updates, { onConflict: 'company_id,user_id,product_id' });

        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (err) {
        console.error('[pos/shortcuts] PATCH reorder error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/pos/shortcuts
router.post('/', async (req, res) => {
    try {
        const productId = parseInt(req.body.product_id, 10);
        if (!productId) return res.status(400).json({ error: 'product_id is required' });

        // Verify product belongs to this company
        const { data: product } = await supabase
            .from('products')
            .select('id')
            .eq('id', productId)
            .eq('company_id', req.companyId)
            .maybeSingle();

        if (!product) return res.status(404).json({ error: 'Product not found' });

        const { error } = await supabase
            .from('pos_user_product_shortcuts')
            .upsert(
                {
                    company_id: req.companyId,
                    user_id: req.user.userId,
                    product_id: productId,
                    updated_at: new Date().toISOString()
                },
                { onConflict: 'company_id,user_id,product_id' }
            );

        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (err) {
        console.error('[pos/shortcuts] POST error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/pos/shortcuts/:product_id
router.delete('/:product_id', async (req, res) => {
    try {
        const productId = parseInt(req.params.product_id, 10);
        if (!productId) return res.status(400).json({ error: 'Invalid product_id' });

        const { error } = await supabase
            .from('pos_user_product_shortcuts')
            .delete()
            .eq('company_id', req.companyId)
            .eq('user_id', req.user.userId)
            .eq('product_id', productId);

        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true });
    } catch (err) {
        console.error('[pos/shortcuts] DELETE error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
