/**
 * ============================================================================
 * POS KV Store Routes — ECO Backend
 * ============================================================================
 * Generic key-value storage scoped per company.
 * Used by the ECO POS frontend localStorage bridge so all POS page data
 * (till config, product cache, customer list, etc.) is stored in Supabase
 * — survives browser history clears and works across all browsers / devices.
 *
 * Table (create in Supabase SQL editor if not present):
 *   CREATE TABLE IF NOT EXISTS pos_kv_store (
 *     company_id TEXT NOT NULL,
 *     key        TEXT NOT NULL,
 *     value      JSONB,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     PRIMARY KEY (company_id, key)
 *   );
 *
 * RULE: NO business data may be stored in browser localStorage.
 *       This endpoint IS the persistence layer — all writes go to Supabase.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany } = require('../../../middleware/auth');

const router = express.Router();
const TABLE = 'pos_kv_store';

router.use(authenticateToken);
router.use(requireCompany);

// ── GET /api/pos/kv  →  all key/value pairs for this company ────────────────
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from(TABLE)
            .select('key, value')
            .eq('company_id', req.companyId);

        if (error) throw error;

        const result = {};
        for (const row of (data || [])) {
            result[row.key] = row.value;
        }
        res.json(result);
    } catch (err) {
        console.error('GET /api/pos/kv error:', err.message);
        res.status(500).json({ error: 'Database read failed' });
    }
});

// ── PUT /api/pos/kv/:key  →  upsert a single key ─────────────────────────────
router.put('/:key', async (req, res) => {
    try {
        const key = req.params.key;
        let val = req.body.value;
        if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch (_) {}
        }

        const { error } = await supabase
            .from(TABLE)
            .upsert(
                { company_id: req.companyId, key, value: val, updated_at: new Date().toISOString() },
                { onConflict: 'company_id,key' }
            );

        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.error('PUT /api/pos/kv/:key error:', err.message);
        res.status(500).json({ error: 'Database write failed' });
    }
});

// ── DELETE /api/pos/kv/:key  →  remove a key ─────────────────────────────────
router.delete('/:key', async (req, res) => {
    try {
        const key = req.params.key;

        const { error } = await supabase
            .from(TABLE)
            .delete()
            .eq('company_id', req.companyId)
            .eq('key', key);

        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE /api/pos/kv/:key error:', err.message);
        res.status(500).json({ error: 'Database delete failed' });
    }
});

module.exports = router;
