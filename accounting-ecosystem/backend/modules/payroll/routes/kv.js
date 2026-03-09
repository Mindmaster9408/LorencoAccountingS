/**
 * ============================================================================
 * Payroll KV Store Routes — ECO Backend
 * ============================================================================
 * Generic key-value storage scoped per company.
 * Used by the frontend localStorage bridge so all payroll page data
 * (attendance records, payroll configs, employee lists, etc.) is stored
 * in Supabase instead of the browser — survives history clears and works
 * across all browsers / devices.
 *
 * Table (create in Supabase SQL editor if not present):
 *   CREATE TABLE IF NOT EXISTS payroll_kv_store_eco (
 *     company_id TEXT NOT NULL,
 *     key        TEXT NOT NULL,
 *     value      JSONB,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     PRIMARY KEY (company_id, key)
 *   );
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany } = require('../../../middleware/auth');

const router = express.Router();
const TABLE = 'payroll_kv_store_eco';

router.use(authenticateToken);
router.use(requireCompany);

// ── GET /api/payroll/kv  →  all key/value pairs for this company ─────────────
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
        console.error('GET /api/payroll/kv error:', err.message);
        res.status(500).json({ error: 'Database read failed' });
    }
});

// ── PUT /api/payroll/kv/:key  →  upsert a single key ─────────────────────────
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
        console.error('PUT /api/payroll/kv/:key error:', err.message);
        res.status(500).json({ error: 'Database write failed' });
    }
});

// ── DELETE /api/payroll/kv/:key  →  remove a key ─────────────────────────────
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
        console.error('DELETE /api/payroll/kv/:key error:', err.message);
        res.status(500).json({ error: 'Database delete failed' });
    }
});

module.exports = router;
