/**
 * ============================================================================
 * POS Product Import Routes — Checkout Charlie  (Workstream 17)
 * ============================================================================
 * POST /api/pos/import/preview  — classify rows against DB, return annotated
 *                                 preview with new / update / skip / error counts
 * POST /api/pos/import/execute  — write validated rows, return summary + errors
 *
 * Permission gate: PRODUCTS.CREATE  (management roles only)
 * Company isolation: all queries filtered by req.companyId (set by middleware)
 *
 * Performance targets:
 *   100 products   — < 2 s
 *   1 000 products — < 8 s
 *   5 000 products — < 30 s
 *
 * Security guarantees:
 *   - No business data ever touches browser storage
 *   - All state lives in server-side req/res cycle
 *   - Company isolation enforced server-side; never trusted from client
 *   - Max 10 000 rows per request (hard limit)
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase }                          = require('../../../config/database');
const { requirePermission }                 = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS }       = require('../services/posAuditLogger');
const { auditFromReq }                      = require('../../../middleware/audit');

const router = express.Router();

const MAX_ROWS          = 10_000;
const BATCH_INSERT_SIZE = 200;   // rows per Supabase bulk insert
const BATCH_UPDATE_PAR  = 20;    // concurrent update promises per wave

// ── Field normalisation helpers ───────────────────────────────────────────────

function cleanStr(val) {
    if (val === null || val === undefined) return '';
    return String(val).trim();
}

function parseMoney(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Math.round(val * 100) / 100;
    const n = parseFloat(String(val).replace(/[R\s,]/g, ''));
    return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function parseVatRate(val) {
    if (val === null || val === undefined || val === '') return 15;
    const n = parseFloat(String(val).replace(/[%\s]/g, ''));
    return isNaN(n) ? 15 : Math.min(100, Math.max(0, n));
}

function parseBoolean(val) {
    if (val === null || val === undefined || val === '') return true;
    const s = String(val).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'active'].includes(s))   return true;
    if (['false', 'no',  'n', '0', 'inactive'].includes(s)) return false;
    return true;
}

function parseQty(val, defaultVal = 0) {
    if (val === null || val === undefined || val === '') return defaultVal;
    const n = parseInt(String(val).replace(/[^\d-]/g, ''), 10);
    return isNaN(n) ? defaultVal : n;
}

function normaliseRow(raw) {
    return {
        product_name:   cleanStr(raw.product_name),
        product_code:   cleanStr(raw.product_code),
        barcode:        cleanStr(raw.barcode),
        category:       cleanStr(raw.category),
        brand:          cleanStr(raw.brand),
        supplier:       cleanStr(raw.supplier),
        selling_price:  parseMoney(raw.selling_price),
        cost_price:     parseMoney(raw.cost_price),
        vat_rate:       parseVatRate(raw.vat_rate),
        stock_quantity: parseQty(raw.stock_quantity, 0),
        reorder_level:  parseQty(raw.reorder_level, 10),
        unit:           cleanStr(raw.unit) || 'each',
        description:    cleanStr(raw.description),
        active:         parseBoolean(raw.active),
        notes:          cleanStr(raw.notes),
    };
}

// ── Row validation ────────────────────────────────────────────────────────────

function validateRow(row) {
    const errors = [];
    if (!row.product_name)                          errors.push('Missing product name');
    if (row.product_name.length > 255)              errors.push('Product name exceeds 255 characters');
    if (row.selling_price !== null && row.selling_price < 0) errors.push('Selling price cannot be negative');
    if (row.cost_price    !== null && row.cost_price    < 0) errors.push('Cost price cannot be negative');
    if (row.vat_rate < 0 || row.vat_rate > 100)    errors.push('VAT rate must be 0–100');
    if (row.stock_quantity < 0)                     errors.push('Stock quantity cannot be negative');
    return errors;
}

// ── Core classification — does NOT write to DB ────────────────────────────────

async function classifyRows(normalisedRows, options, companyId) {
    const mode = options.mode || 'create_only'; // create_only | update_existing | create_and_update

    // Collect unique lookup keys from the file
    const barcodes = [...new Set(normalisedRows.map(r => r.barcode).filter(Boolean))];
    const codes    = [...new Set(normalisedRows.map(r => r.product_code).filter(Boolean))];

    // ── Single batch DB lookup for all existing products ──────────────────────
    const existingByBarcode = {};
    const existingByCode    = {};

    if (barcodes.length > 0 || codes.length > 0) {
        const orParts = [];
        if (barcodes.length) orParts.push(`barcode.in.(${barcodes.map(b => `"${b.replace(/"/g, '\\"')}"`).join(',')})`);
        if (codes.length)    orParts.push(`product_code.in.(${codes.map(c => `"${c.replace(/"/g, '\\"')}"`).join(',')})`);

        const { data: existing } = await supabase
            .from('products')
            .select('id, product_code, barcode, product_name, unit_price')
            .eq('company_id', companyId)
            .or(orParts.join(','));

        (existing || []).forEach(p => {
            if (p.barcode)      existingByBarcode[p.barcode]      = p;
            if (p.product_code) existingByCode[p.product_code]    = p;
        });
    }

    // ── Load categories + suppliers for this company ──────────────────────────
    const [{ data: catData }, { data: supData }] = await Promise.all([
        supabase.from('categories').select('id, name').eq('company_id', companyId).eq('is_active', true),
        supabase.from('suppliers').select('id, supplier_name').eq('company_id', companyId).eq('is_active', true),
    ]);
    const catMap = {};
    (catData || []).forEach(c => { catMap[c.name.toLowerCase()] = c; });
    const supMap = {};
    (supData || []).forEach(s => { supMap[s.supplier_name.toLowerCase()] = s; });

    // ── Intra-file duplicate detection ────────────────────────────────────────
    const fileBarcodesAt = {};
    const fileCodesAt    = {};

    let new_count = 0, update_count = 0, skip_count = 0, error_count = 0;
    const categoriesNeeded = new Set();
    const suppliersNeeded  = new Set();

    const annotated = normalisedRows.map((row, idx) => {
        const errors = validateRow(row);

        if (row.barcode) {
            if (fileBarcodesAt[row.barcode] !== undefined) {
                errors.push(`Duplicate barcode in file (already at row ${fileBarcodesAt[row.barcode] + 2})`);
            } else {
                fileBarcodesAt[row.barcode] = idx;
            }
        }
        if (row.product_code) {
            if (fileCodesAt[row.product_code] !== undefined) {
                errors.push(`Duplicate product code in file (already at row ${fileCodesAt[row.product_code] + 2})`);
            } else {
                fileCodesAt[row.product_code] = idx;
            }
        }

        // Find DB match (barcode takes priority over code for matching)
        let existingProduct =
            (row.barcode      && existingByBarcode[row.barcode])  ||
            (row.product_code && existingByCode[row.product_code]) ||
            null;

        // Resolve category
        let category_id = null;
        if (row.category) {
            const cat = catMap[row.category.toLowerCase()];
            if (cat) {
                category_id = cat.id;
            } else if (options.auto_create_categories) {
                categoriesNeeded.add(row.category);
            }
        }

        // Flag unknown suppliers (informational — no FK on products table)
        if (row.supplier && !supMap[row.supplier.toLowerCase()] && options.auto_create_suppliers) {
            suppliersNeeded.add(row.supplier);
        }

        // Classify the row
        let status;
        if (errors.length > 0) {
            status = 'error';
            error_count++;
        } else if (existingProduct) {
            status = mode === 'create_only' ? 'skip' : 'update';
            mode === 'create_only' ? skip_count++ : update_count++;
        } else {
            status = mode === 'update_existing' ? 'skip' : 'new';
            mode === 'update_existing' ? skip_count++ : new_count++;
        }

        return {
            ...row,
            _row_index:   idx,
            _status:      status,
            _errors:      errors,
            _matched_id:  existingProduct ? existingProduct.id : null,
            _category_id: category_id,
        };
    });

    return {
        rows:                  annotated,
        preview:               { new_count, update_count, skip_count, error_count, total: normalisedRows.length },
        categories_to_create:  [...categoriesNeeded],
        suppliers_to_create:   [...suppliersNeeded],
        catMap,
        supMap,
    };
}

// ── POST /api/pos/import/preview ─────────────────────────────────────────────

router.post('/preview', requirePermission('PRODUCTS.CREATE'), async (req, res) => {
    try {
        const { rows, options = {} } = req.body;

        if (!Array.isArray(rows) || rows.length === 0)
            return res.status(400).json({ error: 'rows array is required and must not be empty' });
        if (rows.length > MAX_ROWS)
            return res.status(400).json({ error: `Maximum ${MAX_ROWS.toLocaleString()} rows per import` });

        const normalised = rows.map(normaliseRow);
        const result     = await classifyRows(normalised, options, req.companyId);

        res.json({
            preview:              result.preview,
            rows:                 result.rows,
            categories_to_create: result.categories_to_create,
            suppliers_to_create:  result.suppliers_to_create,
        });
    } catch (err) {
        console.error('[pos/import/preview]', err);
        res.status(500).json({ error: 'Preview failed — server error' });
    }
});

// ── POST /api/pos/import/execute ─────────────────────────────────────────────

router.post('/execute', requirePermission('PRODUCTS.CREATE'), async (req, res) => {
    const startTime = Date.now();
    try {
        const { rows, options = {} } = req.body;

        if (!Array.isArray(rows) || rows.length === 0)
            return res.status(400).json({ error: 'rows array is required and must not be empty' });
        if (rows.length > MAX_ROWS)
            return res.status(400).json({ error: `Maximum ${MAX_ROWS.toLocaleString()} rows per import` });

        // Re-run classification server-side (never trust client state)
        const normalised = rows.map(normaliseRow);
        const classified = await classifyRows(normalised, options, req.companyId);
        let { catMap } = classified;

        // ── Auto-create categories ────────────────────────────────────────────
        let categories_created = 0;
        if (options.auto_create_categories && classified.categories_to_create.length > 0) {
            for (const catName of classified.categories_to_create) {
                const { data: newCat, error: catErr } = await supabase
                    .from('categories')
                    .insert({ company_id: req.companyId, name: catName, is_active: true })
                    .select('id, name')
                    .single();
                if (catErr) {
                    console.error('[pos/import] auto-create category failed:', catName, catErr.message);
                } else if (newCat) {
                    catMap = { ...catMap, [catName.toLowerCase()]: newCat };
                    categories_created++;
                }
            }
        }

        // ── Auto-create suppliers ─────────────────────────────────────────────
        let suppliers_created = 0;
        if (options.auto_create_suppliers && classified.suppliers_to_create.length > 0) {
            for (const supName of classified.suppliers_to_create) {
                const code = 'SUP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
                const { error: supErr } = await supabase
                    .from('suppliers')
                    .insert({ company_id: req.companyId, supplier_name: supName, supplier_code: code, is_active: true });
                if (!supErr) suppliers_created++;
            }
        }

        // ── Separate into insert / update / skip / error buckets ──────────────
        const toInsert = classified.rows.filter(r => r._status === 'new');
        const toUpdate = classified.rows.filter(r => r._status === 'update');
        const skipped  = classified.rows.filter(r => r._status === 'skip').length;

        let created = 0, updated = 0;
        const errors = [];

        // Carry forward validation errors
        classified.rows
            .filter(r => r._status === 'error')
            .forEach(r => errors.push({
                row:          r._row_index + 2, // +2: 1-indexed + header row
                product_name: r.product_name || '(unnamed)',
                product_code: r.product_code || '',
                reason:       r._errors.join('; '),
            }));

        // ── Batch inserts ─────────────────────────────────────────────────────
        function buildInsertPayload(r) {
            const cat = r.category ? catMap[r.category.toLowerCase()] : null;
            return {
                company_id:      req.companyId,
                product_name:    r.product_name,
                product_code:    r.product_code || `PRD-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                description:     r.description  || null,
                barcode:         r.barcode       || null,
                sku:             r.product_code  || null,
                category:        r.category      || null,
                category_id:     cat ? cat.id    : (r._category_id || null),
                unit_price:      r.selling_price !== null ? r.selling_price : 0,
                cost_price:      r.cost_price    !== null ? r.cost_price    : 0,
                stock_quantity:  r.stock_quantity,
                min_stock_level: r.reorder_level,
                requires_vat:    r.vat_rate > 0,
                vat_rate:        r.vat_rate,
                unit:            r.unit,
                is_active:       r.active,
            };
        }

        for (let i = 0; i < toInsert.length; i += BATCH_INSERT_SIZE) {
            const batch   = toInsert.slice(i, i + BATCH_INSERT_SIZE);
            const payload = batch.map(buildInsertPayload);

            const { data: inserted, error: insertErr } = await supabase
                .from('products')
                .insert(payload)
                .select('id');

            if (insertErr) {
                batch.forEach(r => errors.push({
                    row:          r._row_index + 2,
                    product_name: r.product_name,
                    product_code: r.product_code || '',
                    reason:       insertErr.message,
                }));
            } else {
                created += (inserted || []).length;
            }
        }

        // ── Parallel updates ──────────────────────────────────────────────────
        for (let i = 0; i < toUpdate.length; i += BATCH_UPDATE_PAR) {
            const wave = toUpdate.slice(i, i + BATCH_UPDATE_PAR);
            await Promise.all(wave.map(async (r) => {
                const cat = r.category ? catMap[r.category.toLowerCase()] : null;
                const fields = {
                    product_name:    r.product_name,
                    description:     r.description  || null,
                    barcode:         r.barcode       || null,
                    category:        r.category      || null,
                    category_id:     cat ? cat.id    : (r._category_id || null),
                    unit_price:      r.selling_price !== null ? r.selling_price : undefined,
                    cost_price:      r.cost_price    !== null ? r.cost_price    : undefined,
                    stock_quantity:  r.stock_quantity,
                    min_stock_level: r.reorder_level,
                    requires_vat:    r.vat_rate > 0,
                    vat_rate:        r.vat_rate,
                    unit:            r.unit,
                    is_active:       r.active,
                    updated_at:      new Date().toISOString(),
                };
                // Strip undefined — Supabase would overwrite with NULL otherwise
                Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

                const { error: updateErr } = await supabase
                    .from('products')
                    .update(fields)
                    .eq('id', r._matched_id)
                    .eq('company_id', req.companyId);

                if (updateErr) {
                    errors.push({
                        row:          r._row_index + 2,
                        product_name: r.product_name,
                        product_code: r.product_code || '',
                        reason:       updateErr.message,
                    });
                } else {
                    updated++;
                }
            }));
        }

        const duration_ms = Date.now() - startTime;

        // ── Audit events ──────────────────────────────────────────────────────
        const auditMeta = {
            total_rows:         rows.length,
            created,
            updated,
            skipped,
            failed:             errors.length,
            duration_ms,
            categories_created,
            suppliers_created,
            mode:               options.mode || 'create_only',
        };

        posAuditFromReq(req, POS_EVENTS.PRODUCT_IMPORT, { metadata: auditMeta });
        auditFromReq(req, 'PRODUCT_IMPORT', 'products', null, { module: 'pos', metadata: auditMeta });

        res.json({
            created,
            updated,
            skipped,
            failed:             errors.length,
            errors,
            duration_ms,
            categories_created,
            suppliers_created,
        });
    } catch (err) {
        console.error('[pos/import/execute]', err);
        res.status(500).json({ error: 'Import failed — server error' });
    }
});

module.exports = router;
