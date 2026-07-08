/**
 * ============================================================================
 * POS Audit Logger — Enterprise Audit Trail Service
 * ============================================================================
 * Writes append-only audit events to pos_audit_events (migration 028).
 *
 * Key guarantees:
 *   - All writes are wrapped in try/catch — audit failure is logged loudly
 *     but NEVER propagated. A broken audit system must not block a live sale.
 *   - The table itself enforces append-only at the DB level (triggers).
 *   - Callers should fire-and-forget non-critical events (no await needed),
 *     or await for events that must be confirmed (e.g., SALE_CREATED).
 *
 * Usage:
 *   const { posAuditFromReq, POS_EVENTS } = require('./services/posAuditLogger');
 *   await posAuditFromReq(req, POS_EVENTS.SALE_CREATED, { saleId: 42, ... });
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

// ── Canonical event type constants ────────────────────────────────────────────
// Add new event types here before using them — keeps all constants in one place.

const POS_EVENTS = {
    // Sale lifecycle
    SALE_CREATED:           'SALE_CREATED',
    SALE_REPLAYED:          'SALE_REPLAYED',        // idempotency gate returned existing sale
    SALE_VOIDED:            'SALE_VOIDED',
    SALE_RETURNED:          'SALE_RETURNED',

    // Sale failure events (stock / server errors)
    SALE_STOCK_FAILED:      'SALE_STOCK_FAILED',    // pre-check stock insufficient
    SALE_RPC_FAILED:        'SALE_RPC_FAILED',       // atomic RPC / server error

    // Offline sync events
    OFFLINE_SYNC_RECEIVED:  'OFFLINE_SYNC_RECEIVED', // backend received offline sync POST
    OFFLINE_CONFLICT:       'OFFLINE_CONFLICT',       // 422 stock conflict on sync replay

    // Till session events
    TILL_OPENED:            'TILL_OPENED',
    TILL_CLOSED:            'TILL_CLOSED',
    CASHUP_COMPLETED:       'CASHUP_COMPLETED',
    CASH_VARIANCE_RECORDED: 'CASH_VARIANCE_RECORDED',
    // Legacy aliases — kept so existing Workstream 1A wiring in sales.js is unaffected
    SESSION_OPENED:         'SESSION_OPENED',
    SESSION_CLOSED:         'SESSION_CLOSED',

    // Receipt events
    RECEIPT_PRINTED:        'RECEIPT_PRINTED',
    RECEIPT_DELIVERED:      'RECEIPT_DELIVERED',

    // Auth events
    LOGIN_SUCCESS:          'LOGIN_SUCCESS',
    LOGIN_FAILED:           'LOGIN_FAILED',
    LOGOUT:                 'LOGOUT',
    COMPANY_SELECTED:       'COMPANY_SELECTED',
    // Legacy aliases
    POS_LOGIN:              'POS_LOGIN',
    POS_LOGOUT:             'POS_LOGOUT',

    // Manager / supervisor events
    MANAGER_OVERRIDE:       'MANAGER_OVERRIDE',
    MANAGER_OVERRIDE_USED:  'MANAGER_OVERRIDE_USED', // to be wired when override route exists

    // Product management events
    PRODUCT_CREATED:        'PRODUCT_CREATED',
    PRODUCT_UPDATED:        'PRODUCT_UPDATED',
    PRODUCT_PRICE_CHANGED:  'PRODUCT_PRICE_CHANGED',
    PRODUCT_DEACTIVATED:    'PRODUCT_DEACTIVATED',   // soft delete: is_active = false
    PRODUCT_DELETED:        'PRODUCT_DELETED',       // hard delete (future)
    PRODUCT_IMPORT:         'PRODUCT_IMPORT',        // bulk import (workstream 17)

    // Inventory events
    STOCK_ADJUSTED:              'STOCK_ADJUSTED',
    STOCK_TAKE_COMPLETED:        'STOCK_TAKE_COMPLETED',
    SUPPLIER_RECEIVE_COMPLETED:  'SUPPLIER_RECEIVE_COMPLETED',
    STOCK_TRANSFER_RECORDED:     'STOCK_TRANSFER_RECORDED',

    // Supplier-linked products events (Workstream 78)
    SUPPLIER_PRODUCT_LINKED:          'SUPPLIER_PRODUCT_LINKED',
    SUPPLIER_PRODUCT_UNLINKED:        'SUPPLIER_PRODUCT_UNLINKED',
    SUPPLIER_RETURN_COMPLETED:        'SUPPLIER_RETURN_COMPLETED',
    SUPPLIER_PRICE_INCREASE_DETECTED: 'SUPPLIER_PRICE_INCREASE_DETECTED',

    // Stock policy events
    STOCK_POLICY_CHANGED:        'STOCK_POLICY_CHANGED',        // admin toggled allow_negative_stock_sales
    NEGATIVE_STOCK_SALE_ALLOWED: 'NEGATIVE_STOCK_SALE_ALLOWED', // sale approved despite insufficient stock
    NEGATIVE_STOCK_CREATED:      'NEGATIVE_STOCK_CREATED',      // item stock dropped below zero

    // Manager recovery events (Workstream 4A)
    RECOVERY_RETRY_TRIGGERED:    'RECOVERY_RETRY_TRIGGERED',    // manager manually triggered a queue item retry
    RECOVERY_MARKED_FAILED:      'RECOVERY_MARKED_FAILED',      // manager marked queue item as permanently unrecoverable
    RECOVERY_NOTE_ADDED:         'RECOVERY_NOTE_ADDED',         // manager added a recovery note to a queue item
    SUPERVISOR_OVERRIDE_GRANTED: 'SUPERVISOR_OVERRIDE_GRANTED', // supervisor recorded a manual override action
    ABANDONED_SESSION_DETECTED:  'ABANDONED_SESSION_DETECTED',  // session open > 8h detected on health check

    // Manager emergency control events (Workstream 11B)
    EMERGENCY_SESSION_FORCE_CLOSED: 'EMERGENCY_SESSION_FORCE_CLOSED', // manager force-closed an open session
    EMERGENCY_TILL_LOCKED:          'EMERGENCY_TILL_LOCKED',          // manager locked a till
    EMERGENCY_TILL_UNLOCKED:        'EMERGENCY_TILL_UNLOCKED',        // manager unlocked a till
    EMERGENCY_SYNC_PAUSED:          'EMERGENCY_SYNC_PAUSED',          // manager paused offline sync
    EMERGENCY_SYNC_RESUMED:         'EMERGENCY_SYNC_RESUMED',         // manager resumed offline sync
    EMERGENCY_USER_FORCE_LOGOUT:    'EMERGENCY_USER_FORCE_LOGOUT',    // manager force-closed all sessions for a user
    EMERGENCY_PRINTER_DEGRADED:     'EMERGENCY_PRINTER_DEGRADED',     // manager marked till printer as degraded
    EMERGENCY_PRINTER_RESTORED:     'EMERGENCY_PRINTER_RESTORED',     // manager marked till printer as restored

    // PIN authentication events (Workstream 18)
    USER_PIN_SET:           'USER_PIN_SET',     // manager set or replaced a user's PIN
    USER_PIN_REMOVED:       'USER_PIN_REMOVED', // manager removed a user's PIN
    PIN_LOGIN_SUCCESS:      'PIN_LOGIN_SUCCESS', // cashier successfully logged in with PIN
    PIN_LOGIN_FAILED:       'PIN_LOGIN_FAILED',  // wrong PIN attempt
    PIN_LOGIN_LOCKED:       'PIN_LOGIN_LOCKED',  // account locked after max failed attempts
};

// Maps each event type to its action_category column value.
// action_category enables fast filtering without parsing action_type strings.
const EVENT_CATEGORY = {
    SALE_CREATED:           'sale',
    SALE_REPLAYED:          'sale',
    SALE_VOIDED:            'sale',
    SALE_RETURNED:          'sale',
    SALE_STOCK_FAILED:      'sale',
    SALE_RPC_FAILED:        'sale',
    OFFLINE_SYNC_RECEIVED:  'sync',
    OFFLINE_CONFLICT:       'sync',
    TILL_OPENED:            'session',
    TILL_CLOSED:            'session',
    CASHUP_COMPLETED:       'session',
    CASH_VARIANCE_RECORDED: 'session',
    SESSION_OPENED:         'session',
    SESSION_CLOSED:         'session',
    RECEIPT_PRINTED:        'receipt',
    RECEIPT_DELIVERED:      'receipt',
    LOGIN_SUCCESS:          'auth',
    LOGIN_FAILED:           'auth',
    LOGOUT:                 'auth',
    COMPANY_SELECTED:       'auth',
    POS_LOGIN:              'auth',
    POS_LOGOUT:             'auth',
    MANAGER_OVERRIDE:       'override',
    MANAGER_OVERRIDE_USED:  'override',
    PRODUCT_CREATED:        'product',
    PRODUCT_UPDATED:        'product',
    PRODUCT_PRICE_CHANGED:  'product',
    PRODUCT_DEACTIVATED:    'product',
    PRODUCT_DELETED:        'product',
    PRODUCT_IMPORT:         'product',
    STOCK_ADJUSTED:              'inventory',
    STOCK_TAKE_COMPLETED:        'inventory',
    SUPPLIER_RECEIVE_COMPLETED:  'inventory',
    STOCK_TRANSFER_RECORDED:     'inventory',
    SUPPLIER_PRODUCT_LINKED:          'inventory',
    SUPPLIER_PRODUCT_UNLINKED:        'inventory',
    SUPPLIER_RETURN_COMPLETED:        'inventory',
    SUPPLIER_PRICE_INCREASE_DETECTED: 'inventory',
    STOCK_POLICY_CHANGED:        'settings',
    NEGATIVE_STOCK_SALE_ALLOWED: 'inventory',
    NEGATIVE_STOCK_CREATED:      'inventory',
    RECOVERY_RETRY_TRIGGERED:    'recovery',
    RECOVERY_MARKED_FAILED:      'recovery',
    RECOVERY_NOTE_ADDED:         'recovery',
    SUPERVISOR_OVERRIDE_GRANTED: 'override',
    ABANDONED_SESSION_DETECTED:  'session',
    // Emergency control events — 'override' category so they appear in support timeline
    EMERGENCY_SESSION_FORCE_CLOSED: 'override',
    EMERGENCY_TILL_LOCKED:          'override',
    EMERGENCY_TILL_UNLOCKED:        'override',
    EMERGENCY_SYNC_PAUSED:          'override',
    EMERGENCY_SYNC_RESUMED:         'override',
    EMERGENCY_USER_FORCE_LOGOUT:    'override',
    EMERGENCY_PRINTER_DEGRADED:     'override',
    EMERGENCY_PRINTER_RESTORED:     'override',
    USER_PIN_SET:           'pin',
    USER_PIN_REMOVED:       'pin',
    PIN_LOGIN_SUCCESS:      'auth',
    PIN_LOGIN_FAILED:       'auth',
    PIN_LOGIN_LOCKED:       'auth',
};

// ── Core logger ───────────────────────────────────────────────────────────────

/**
 * Write a POS audit event to pos_audit_events.
 *
 * @param {Object} params
 * @param {number}      params.companyId       — required
 * @param {number|null} params.userId
 * @param {string}      params.userEmail
 * @param {string|null} params.userRole        — 'cashier' | 'manager' | 'admin' | 'system'
 * @param {number|null} params.tillId
 * @param {number|null} params.tillSessionId
 * @param {number|null} params.saleId
 * @param {number|null} params.productId
 * @param {string}      params.actionType      — one of POS_EVENTS constants
 * @param {string}      params.source          — 'online' | 'offline_sync' | 'system'
 * @param {string|null} params.entityType
 * @param {string|null} params.entityId
 * @param {Object|null} params.beforeSnapshot
 * @param {Object|null} params.afterSnapshot
 * @param {string|null} params.ipAddress
 * @param {string|null} params.userAgent
 * @param {string|null} params.notes
 * @param {Object}      params.metadata
 */
async function logPosEvent({
    companyId,
    userId          = null,
    userEmail       = 'system',
    userRole        = null,
    tillId          = null,
    tillSessionId   = null,
    saleId          = null,
    productId       = null,
    actionType,
    source          = 'online',
    entityType      = null,
    entityId        = null,
    beforeSnapshot  = null,
    afterSnapshot   = null,
    ipAddress       = null,
    userAgent       = null,
    notes           = null,
    metadata        = {},
}) {
    try {
        const actionCategory = EVENT_CATEGORY[actionType] || 'other';

        const { error } = await supabase.from('pos_audit_events').insert({
            company_id:      companyId,
            user_id:         userId,
            user_email:      userEmail,
            user_role:       userRole,
            till_id:         tillId          != null ? parseInt(tillId, 10)          || null : null,
            till_session_id: tillSessionId   != null ? parseInt(tillSessionId, 10)   || null : null,
            sale_id:         saleId          != null ? parseInt(saleId, 10)          || null : null,
            product_id:      productId       != null ? parseInt(productId, 10)       || null : null,
            action_category: actionCategory,
            action_type:     actionType,
            source,
            entity_type:     entityType,
            entity_id:       entityId        != null ? String(entityId) : null,
            before_snapshot: beforeSnapshot  || null,
            after_snapshot:  afterSnapshot   || null,
            ip_address:      ipAddress,
            user_agent:      userAgent,
            notes,
            metadata:        Object.keys(metadata || {}).length > 0 ? metadata : null,
        });

        if (error) {
            console.error('[posAuditLogger] insert error:', error.message, '| action:', actionType);
        }
    } catch (err) {
        // Audit failure must never propagate — log loudly and continue.
        console.error('[posAuditLogger] exception (non-fatal):', err.message, '| action:', actionType);
    }
}

/**
 * Build a logPosEvent call from an Express request object.
 * Extracts companyId, userId, userEmail, userRole, ip, and userAgent from req
 * automatically. Caller provides actionType and POS-specific fields via extra.
 *
 * @param {Object} req       — Express request
 * @param {string} actionType — POS_EVENTS constant
 * @param {Object} extra      — Any logPosEvent params to override/add
 */
function posAuditFromReq(req, actionType, extra = {}) {
    const user = req.user || {};
    return logPosEvent({
        companyId:    req.companyId || user.companyId || null,
        userId:       user.userId   || null,
        userEmail:    user.email    || user.username  || 'system',
        userRole:     user.role     || null,
        ipAddress:    req.ip        || req.connection?.remoteAddress || null,
        userAgent:    req.headers?.['user-agent'] || null,
        actionType,
        ...extra,
    });
}

module.exports = { logPosEvent, posAuditFromReq, POS_EVENTS };
