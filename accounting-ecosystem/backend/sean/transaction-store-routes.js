/**
 * ============================================================================
 * SEAN Transaction Store — Generic Approval Engine API Routes
 * ============================================================================
 * A generic approval queue for ecosystem-wide standardization.
 * Supports: payroll_item, product, account, bank_rule, supplier_template
 *
 * When a new or edited item is created in any app (e.g. a new payroll item in
 * Paytime), it is submitted here. The super admin reviews the queue and can:
 *   OPTION 1 — APPROVE & SYNC: approve the item and apply it globally
 *   OPTION 2 — DISCARD: keep local only, no global propagation
 *   OPTION 3 — EDIT THEN APPROVE: modify the payload, then sync globally
 *
 * SAFETY RULES (Rule B6/B9 from CLAUDE.md):
 *   - Global sync ONLY fills fields that are blank/null/missing in each company
 *   - A company with a different existing value is flagged as a conflict — NEVER overwritten
 *   - Every sync action is recorded in sean_sync_log
 *
 * Routes prefix: /api/sean/store
 *
 * POST   /submit               — Submit an item to the queue (called by any app)
 * GET    /pending              — List pending items (super admin)
 * GET    /                     — List all store items with optional filters
 * POST   /:id/approve          — Approve + queue for global sync (super admin)
 * POST   /:id/discard          — Discard item (keep local only)
 * POST   /:id/edit             — Edit payload, then approve (super admin)
 * POST   /:id/sync             — Execute global sync for an approved item
 * GET    /library              — List approved global library items
 * GET    /library/:entityType  — Library items for a specific entity type
 * GET    /sync-log             — Sync audit log (super admin)
 * POST   /sync-back/:companyId — Get library items that apply to a company (for sync-back on load)
 * ============================================================================
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { supabase } = require('../config/database');
const { authenticateToken, requireSuperAdmin } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateToken);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeKey(name) {
    if (!name) return '';
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

// ─── POST /submit — App submits an item to the queue ────────────────────────
//
// Body: {
//   entityType:    'payroll_item',                     // required
//   sourceApp:     'paytime',                          // required
//   companyId:     123,                                // required
//   itemName:      'Basic Salary',                     // required — display name
//   payload:       { ...full item object... },         // required
//   proposedField: 'irp5_code',                        // optional — key field being proposed globally
//   proposedValue: '3801',                             // optional — value for that field
//   previousValue: null,                               // optional — prior value (for edits)
//   changeType:    'create' | 'update',                // optional (default: 'create')
//   submittedBy:   'user@email.com'                    // optional
// }

router.post('/submit', async (req, res) => {
    try {
        const {
            entityType,
            sourceApp,
            companyId,
            itemName,
            payload,
            proposedField,
            proposedValue,
            previousValue,
            changeType,
            submittedBy
        } = req.body;

        if (!entityType || !sourceApp || !companyId || !itemName || !payload) {
            return res.status(400).json({
                error: 'entityType, sourceApp, companyId, itemName, and payload are required'
            });
        }

        const itemKey = normalizeKey(itemName);

        // Check if an identical pending item already exists for this company+key+field
        // to avoid duplicate submissions (idempotent submit)
        if (proposedField && proposedValue) {
            const { data: existing } = await supabase
                .from('sean_transaction_store')
                .select('id, status')
                .eq('company_id', parseInt(companyId))
                .eq('entity_type', entityType)
                .eq('item_key', itemKey)
                .eq('proposed_field', proposedField)
                .eq('proposed_value', String(proposedValue))
                .eq('status', 'pending')
                .limit(1);

            if (existing && existing.length > 0) {
                // Already pending — update the payload silently (item may have been further edited)
                const { data: updated } = await supabase
                    .from('sean_transaction_store')
                    .update({
                        payload,
                        item_name: itemName,
                        previous_value: previousValue != null ? String(previousValue) : null,
                        change_type: changeType || 'update',
                        submitted_by: submittedBy || req.user?.email || null,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', existing[0].id)
                    .select()
                    .single();
                return res.status(200).json({ success: true, action: 'updated_existing', item: updated });
            }
        }

        const { data, error } = await supabase
            .from('sean_transaction_store')
            .insert({
                entity_type:    entityType,
                source_app:     sourceApp,
                company_id:     parseInt(companyId),
                item_name:      itemName,
                item_key:       itemKey,
                payload:        payload,
                proposed_field: proposedField || null,
                proposed_value: proposedValue != null ? String(proposedValue) : null,
                previous_value: previousValue != null ? String(previousValue) : null,
                change_type:    changeType || 'create',
                submitted_by:   submittedBy || req.user?.email || null,
                status:         'pending'
            })
            .select()
            .single();

        if (error) throw new Error(error.message);

        res.status(201).json({ success: true, action: 'submitted', item: data });
    } catch (err) {
        console.error('[SEAN Store] /submit error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /pending — List pending items for super admin review ─────────────────

router.get('/pending', requireSuperAdmin, async (req, res) => {
    try {
        const { entityType, sourceApp } = req.query;

        let q = supabase
            .from('sean_transaction_store')
            .select('*')
            .eq('status', 'pending')
            .order('submitted_at', { ascending: true });

        if (entityType) q = q.eq('entity_type', entityType);
        if (sourceApp)  q = q.eq('source_app', sourceApp);

        const { data, error } = await q;
        if (error) throw new Error(error.message);

        res.json({ count: data?.length || 0, items: data || [] });
    } catch (err) {
        console.error('[SEAN Store] /pending error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET / — List all store items with filters ───────────────────────────────

router.get('/', requireSuperAdmin, async (req, res) => {
    try {
        const { entityType, sourceApp, status, limit } = req.query;
        const maxLimit = Math.min(parseInt(limit) || 100, 500);

        let q = supabase
            .from('sean_transaction_store')
            .select('*')
            .order('submitted_at', { ascending: false })
            .limit(maxLimit);

        if (entityType) q = q.eq('entity_type', entityType);
        if (sourceApp)  q = q.eq('source_app', sourceApp);
        if (status)     q = q.eq('status', status);

        const { data, error } = await q;
        if (error) throw new Error(error.message);

        res.json({ count: data?.length || 0, items: data || [] });
    } catch (err) {
        console.error('[SEAN Store] / GET error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /:id/approve — Approve item and add to global library ───────────────
//
// Body: { notes?: string }
// After approval the item is added/updated in sean_global_library.
// Global sync is triggered immediately for all matching companies.

router.post('/:id/approve', requireSuperAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { notes } = req.body;

        const { data: item, error: fetchErr } = await supabase
            .from('sean_transaction_store')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchErr || !item) return res.status(404).json({ error: 'Store item not found' });
        if (item.status !== 'pending') {
            return res.status(409).json({ error: `Item is already '${item.status}' — only pending items can be approved` });
        }

        if (!item.proposed_field || !item.proposed_value) {
            return res.status(400).json({ error: 'Item has no proposed_field/proposed_value — cannot add to global library. Use /discard or set these fields when submitting.' });
        }

        // Upsert into global library
        const { data: libItem, error: libErr } = await supabase
            .from('sean_global_library')
            .upsert({
                entity_type:    item.entity_type,
                item_key:       item.item_key,
                item_name:      item.item_name,
                standard_field: item.proposed_field,
                standard_value: item.proposed_value,
                payload:        item.payload,
                approved_by:    req.user?.userId || req.user?.email || 'superadmin',
                approved_at:    new Date().toISOString(),
                source_store_id: id,
                updated_at:     new Date().toISOString()
            }, { onConflict: 'entity_type,item_key,standard_field' })
            .select()
            .single();

        if (libErr) throw new Error('Global library upsert failed: ' + libErr.message);

        // Mark store item as approved
        await supabase
            .from('sean_transaction_store')
            .update({
                status:      'approved',
                reviewed_by: req.user?.userId || req.user?.email || 'superadmin',
                reviewed_at: new Date().toISOString(),
                review_notes: notes || null,
                updated_at:  new Date().toISOString()
            })
            .eq('id', id);

        // Run immediate global sync for this library entry
        const syncResult = await _runGlobalSync(libItem, req.user?.userId || 'superadmin');

        res.json({
            success:    true,
            message:    'Item approved and added to global library. Sync complete.',
            libraryItem: libItem,
            sync:       syncResult
        });
    } catch (err) {
        console.error('[SEAN Store] /approve error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /:id/discard — Discard item, keep local only ───────────────────────

router.post('/:id/discard', requireSuperAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { notes } = req.body;

        const { data: item } = await supabase
            .from('sean_transaction_store')
            .select('id, status')
            .eq('id', id)
            .single();

        if (!item) return res.status(404).json({ error: 'Store item not found' });
        if (item.status !== 'pending') {
            return res.status(409).json({ error: `Item is already '${item.status}'` });
        }

        const { data, error } = await supabase
            .from('sean_transaction_store')
            .update({
                status:      'discarded',
                reviewed_by: req.user?.userId || req.user?.email || 'superadmin',
                reviewed_at: new Date().toISOString(),
                review_notes: notes || 'Discarded — local only',
                updated_at:  new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw new Error(error.message);

        res.json({ success: true, message: 'Item discarded. No global sync will occur.', item: data });
    } catch (err) {
        console.error('[SEAN Store] /discard error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /:id/edit — Edit payload then approve ───────────────────────────────
//
// Body: { editedPayload: {...}, proposedValue?: 'new_value', notes?: string }
// Saves the edited version into edited_payload, then runs approve logic.

router.post('/:id/edit', requireSuperAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { editedPayload, proposedValue, notes } = req.body;

        if (!editedPayload) {
            return res.status(400).json({ error: 'editedPayload is required' });
        }

        const { data: item, error: fetchErr } = await supabase
            .from('sean_transaction_store')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchErr || !item) return res.status(404).json({ error: 'Store item not found' });
        if (item.status !== 'pending') {
            return res.status(409).json({ error: `Item is already '${item.status}'` });
        }

        // Save edited version
        await supabase
            .from('sean_transaction_store')
            .update({
                edited_payload: editedPayload,
                proposed_value: proposedValue != null ? String(proposedValue) : item.proposed_value,
                updated_at:     new Date().toISOString()
            })
            .eq('id', id);

        // Re-fetch with edits, then approve
        req.body = { notes };
        req.params.id = id;

        // Inline approve with edited values
        const finalPayload = editedPayload;
        const finalProposedValue = proposedValue != null ? String(proposedValue) : item.proposed_value;

        if (!item.proposed_field || !finalProposedValue) {
            return res.status(400).json({ error: 'proposed_field and proposed_value are required for global sync' });
        }

        const { data: libItem, error: libErr } = await supabase
            .from('sean_global_library')
            .upsert({
                entity_type:    item.entity_type,
                item_key:       item.item_key,
                item_name:      item.item_name,
                standard_field: item.proposed_field,
                standard_value: finalProposedValue,
                payload:        finalPayload,
                approved_by:    req.user?.userId || req.user?.email || 'superadmin',
                approved_at:    new Date().toISOString(),
                source_store_id: id,
                updated_at:     new Date().toISOString()
            }, { onConflict: 'entity_type,item_key,standard_field' })
            .select()
            .single();

        if (libErr) throw new Error('Global library upsert failed: ' + libErr.message);

        await supabase
            .from('sean_transaction_store')
            .update({
                status:       'approved',
                reviewed_by:  req.user?.userId || req.user?.email || 'superadmin',
                reviewed_at:  new Date().toISOString(),
                review_notes: notes || 'Edited then approved',
                updated_at:   new Date().toISOString()
            })
            .eq('id', id);

        const syncResult = await _runGlobalSync(libItem, req.user?.userId || 'superadmin');

        res.json({
            success:     true,
            message:     'Item edited, approved, and synced globally.',
            libraryItem: libItem,
            sync:        syncResult
        });
    } catch (err) {
        console.error('[SEAN Store] /edit error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /:id/sync — Re-run sync for an already approved item ───────────────
//
// Useful if new companies were added after the initial approval.

router.post('/:id/sync', requireSuperAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        const { data: item } = await supabase
            .from('sean_transaction_store')
            .select('*')
            .eq('id', id)
            .single();

        if (!item) return res.status(404).json({ error: 'Store item not found' });
        if (item.status !== 'approved') {
            return res.status(409).json({ error: 'Only approved items can be synced' });
        }

        // Find the library entry
        const { data: libItem } = await supabase
            .from('sean_global_library')
            .select('*')
            .eq('source_store_id', id)
            .single();

        if (!libItem) return res.status(404).json({ error: 'Library entry not found for this store item' });

        const syncResult = await _runGlobalSync(libItem, req.user?.userId || 'superadmin');
        res.json({ success: true, sync: syncResult });
    } catch (err) {
        console.error('[SEAN Store] /sync error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /library — List all global library items ────────────────────────────

router.get('/library', async (req, res) => {
    try {
        const { entityType } = req.query;

        let q = supabase
            .from('sean_global_library')
            .select('*')
            .order('entity_type')
            .order('item_name');

        if (entityType) q = q.eq('entity_type', entityType);

        const { data, error } = await q;
        if (error) throw new Error(error.message);

        res.json({ count: data?.length || 0, items: data || [] });
    } catch (err) {
        console.error('[SEAN Store] /library error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /library/:entityType — Library items for a specific entity type ─────

router.get('/library/:entityType', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('sean_global_library')
            .select('*')
            .eq('entity_type', req.params.entityType)
            .order('item_name');

        if (error) throw new Error(error.message);
        res.json({ count: data?.length || 0, items: data || [] });
    } catch (err) {
        console.error('[SEAN Store] /library/:entityType error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /sync-log — Sync audit log ──────────────────────────────────────────

router.get('/sync-log', requireSuperAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const { action, entityType } = req.query;

        let q = supabase
            .from('sean_sync_log')
            .select(`
                id, target_company_id, action, field_written,
                value_written, previous_value, authorized_by, notes, created_at,
                library:library_id (entity_type, item_name, standard_field, standard_value)
            `)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (action) q = q.eq('action', action);

        const { data, error } = await q;
        if (error) throw new Error(error.message);

        res.json({ count: data?.length || 0, log: data || [] });
    } catch (err) {
        console.error('[SEAN Store] /sync-log error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /sync-back/:companyId — Get applicable library items for a company ──
//
// Called by Paytime on page load. Returns global library items that this company
// doesn't have yet (where the local value is blank/null).
//
// Body: { entityType: 'payroll_item', localItems: [...] }
// Returns: { updates: [{ itemKey, itemName, field, value, payload }] }
//
// The frontend applies these silently to localStorage — bringing the company
// up to the global standard without any forced overwrite.

router.post('/sync-back/:companyId', async (req, res) => {
    try {
        const companyId = parseInt(req.params.companyId);
        const { entityType, localItems } = req.body;

        if (!entityType || !Array.isArray(localItems)) {
            return res.status(400).json({ error: 'entityType and localItems array are required' });
        }

        // Get all global library items for this entity type
        const { data: libItems, error } = await supabase
            .from('sean_global_library')
            .select('*')
            .eq('entity_type', entityType);

        if (error) throw new Error(error.message);
        if (!libItems || libItems.length === 0) {
            return res.json({ updates: [] });
        }

        const updates = [];

        for (const libItem of libItems) {
            // Find the matching local item by normalized key
            const localMatch = localItems.find(li => {
                const localKey = normalizeKey(li.item_name || li.name || '');
                return localKey === libItem.item_key;
            });

            if (!localMatch) continue; // Company doesn't have this item — nothing to sync

            // Check if the local item's field is blank/null (safe to fill)
            const localFieldValue = localMatch[libItem.standard_field];
            const isBlank = localFieldValue === null || localFieldValue === undefined || String(localFieldValue).trim() === '';

            if (isBlank) {
                updates.push({
                    localItemId:  localMatch.id,
                    itemKey:      libItem.item_key,
                    itemName:     libItem.item_name,
                    field:        libItem.standard_field,
                    value:        libItem.standard_value,
                    libraryId:    libItem.id
                });
            }
            // If localFieldValue is set and different: conflict — skip silently (Rule B9)
        }

        // Log the sync-back action for each update
        if (updates.length > 0) {
            const logRows = updates.map(u => ({
                library_id:        u.libraryId,
                target_company_id: companyId,
                action:            'sync_back_applied',
                field_written:     u.field,
                value_written:     u.value,
                previous_value:    null,
                authorized_by:     'global_library',
                notes:             `Sync-back on page load: ${u.itemName}`
            }));
            await supabase.from('sean_sync_log').insert(logRows);
        }

        res.json({ updates, count: updates.length });
    } catch (err) {
        console.error('[SEAN Store] /sync-back error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Internal: Run Global Sync ───────────────────────────────────────────────
//
// For payroll_item: updates localStorage-based data server-side is not possible
// (payroll items are localStorage-only). Instead we record the standard in the
// global library and let each client's Paytime page pick it up on load via sync-back.
//
// For future entity types that ARE server-backed (e.g. accounting accounts),
// this function would also write to the DB directly for missing-value rows.

async function _runGlobalSync(libItem, authorizedBy) {
    const syncResult = {
        entityType:   libItem.entity_type,
        itemKey:      libItem.item_key,
        field:        libItem.standard_field,
        value:        libItem.standard_value,
        authorizedBy,
        syncedAt:     new Date().toISOString(),
        applied:      0,
        skipped:      0,
        exceptions:   0,
        syncMethod:   'pending',
        note:         ''
    };

    // ── payroll_item irp5_code: direct DB sync ──────────────────────────────
    // payroll_items_master IS server-backed — update directly.
    // SAFETY (Rules B6/B9): only fill NULL codes; never overwrite existing codes.
    if (libItem.entity_type === 'payroll_item' && libItem.standard_field === 'irp5_code') {
        const { data: allItems, error: scanErr } = await supabase
            .from('payroll_items_master')
            .select('id, company_id, name, irp5_code')
            .eq('is_active', true);

        if (scanErr) {
            syncResult.syncMethod = 'error';
            syncResult.note = 'Scan failed: ' + scanErr.message;
        } else {
            const now = new Date().toISOString();
            const logRows = [];

            for (const item of (allItems || [])) {
                if (normalizeKey(item.name) !== libItem.item_key) continue;

                const existingCode = item.irp5_code;
                const isBlank = existingCode === null || existingCode === undefined || String(existingCode).trim() === '';

                if (!isBlank) {
                    const isSame = String(existingCode).trim() === String(libItem.standard_value).trim();
                    const action = isSame ? 'skipped_existing' : 'skipped_exception';
                    if (!isSame) syncResult.exceptions++;
                    else syncResult.skipped++;
                    logRows.push({
                        library_id:        libItem.id,
                        target_company_id: item.company_id,
                        action,
                        field_written:     'irp5_code',
                        value_written:     libItem.standard_value,
                        previous_value:    String(existingCode),
                        authorized_by:     String(authorizedBy),
                        notes:             isSame
                            ? `Already has correct code: ${existingCode}`
                            : `Exception: has different code (${existingCode}). Manual review required.`
                    });
                    continue;
                }

                // NULL code — safe to fill
                const { error: updateErr } = await supabase
                    .from('payroll_items_master')
                    .update({
                        irp5_code:            libItem.standard_value,
                        irp5_code_updated_at: now,
                        irp5_code_updated_by: String(authorizedBy)
                    })
                    .eq('id', item.id);

                if (updateErr) {
                    logRows.push({
                        library_id:        libItem.id,
                        target_company_id: item.company_id,
                        action:            'error',
                        field_written:     'irp5_code',
                        value_written:     libItem.standard_value,
                        previous_value:    null,
                        authorized_by:     String(authorizedBy),
                        notes:             `Update failed: ${updateErr.message}`
                    });
                    continue;
                }

                syncResult.applied++;
                logRows.push({
                    library_id:        libItem.id,
                    target_company_id: item.company_id,
                    action:            'applied',
                    field_written:     'irp5_code',
                    value_written:     libItem.standard_value,
                    previous_value:    null,
                    authorized_by:     String(authorizedBy),
                    notes:             `SEAN global sync: ${libItem.item_name} → ${libItem.standard_value}`
                });
            }

            if (logRows.length > 0) {
                await supabase.from('sean_sync_log').insert(logRows);
            }

            syncResult.syncMethod = 'direct_db';
            const exNote = syncResult.exceptions > 0
                ? ` ${syncResult.exceptions} exception(s) with conflicting codes were not overwritten.`
                : '';
            syncResult.note = `Applied IRP5 code ${libItem.standard_value} to ${syncResult.applied} payroll item(s). ${syncResult.skipped} already correct.${exNote}`;
        }

    } else {
        // Other entity types: library updated; clients pick up via /sync-back on page load
        syncResult.syncMethod = 'sync_back_on_load';
        syncResult.note = 'Global library updated. Clients will receive this standard on next page load via /store/sync-back.';
    }

    // Update library sync count
    await supabase
        .from('sean_global_library')
        .update({
            sync_count:     (libItem.sync_count || 0) + 1,
            last_synced_at: new Date().toISOString(),
            updated_at:     new Date().toISOString()
        })
        .eq('id', libItem.id);

    return syncResult;
}

module.exports = router;
