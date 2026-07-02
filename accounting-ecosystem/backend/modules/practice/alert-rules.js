'use strict';

// Codebox 53 — Practice Alert Rules Engine + Manual Alert Configuration
// One central place partners/practice managers configure when alerts are
// raised — without changing code. Other modules (management-dashboard.js,
// and future modules) read thresholds via getRule()/getRules() instead of
// hardcoding them.
//
// NOT AI. NOT automatic threshold tuning. NOT machine learning.
// This module supplies thresholds only — it does not own risk/QMS/tax/
// capacity/compliance/documents/reminders data. Those modules remain owners
// of their own data (see docs/new-app/53_alert_rules_engine.md).

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const OPERATORS = ['>', '>=', '<', '<=', '=', '!=', 'between', 'contains'];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

const GROUPS = [
    { group_key: 'risk',          display_name: 'Risk',          description: 'Risk register banding and partner-acceptance thresholds.',                sort_order: 1 },
    { group_key: 'tax',           display_name: 'Tax',           description: 'Tax return, payment, SARS reconciliation and dispute alert severities.',   sort_order: 2 },
    { group_key: 'capacity',      display_name: 'Capacity',      description: 'Staff workload utilization bands.',                                        sort_order: 3 },
    { group_key: 'qms',           display_name: 'QMS',           description: 'Quality management finding and review alert severities.',                  sort_order: 4 },
    { group_key: 'client_health', display_name: 'Client Health', description: 'Client health score bands.',                                                sort_order: 5 },
    { group_key: 'compliance',    display_name: 'Compliance',    description: 'Compliance deadline and readiness-pack thresholds.',                        sort_order: 6 },
    { group_key: 'documents',     display_name: 'Documents',     description: 'Document request overdue thresholds.',                                     sort_order: 7 },
    { group_key: 'reminders',     display_name: 'Reminders',     description: 'Reminder overdue and upcoming-window thresholds.',                         sort_order: 8 },
    { group_key: 'communications',display_name: 'Communications',description: 'Client communication response alert severities.',                          sort_order: 9 },
    { group_key: 'knowledge',     display_name: 'Knowledge',     description: 'Knowledge base approval alert severities.',                                sort_order: 10 },
    { group_key: 'sop',           display_name: 'SOP',           description: 'SOP template approval alert severities.',                                  sort_order: 11 },
    { group_key: 'billing',       display_name: 'Billing',       description: 'Billing pack approval and WIP-age thresholds.',                            sort_order: 12 },
];

// Default rules. `wired: true` in settings means management-dashboard.js
// (Codebox 50) actually calls getRule()/getRules() for this key today —
// the remaining rules are seeded for administrative visibility and future
// adoption by their owning module (see Architecture Boundaries in the spec:
// risk-register.js, capacity.js, client-health.js, compliance-packs.js,
// reminders.js, document-requests.js, communications.js "remain owners of
// their data" and are NOT modified by this codebox).
//
// Every numeric default below is copied verbatim from the previously
// hardcoded value found during the pre-build audit — seeding these rows
// must not change any existing alert's behaviour.
const SEED_DEFAULTS = [
    // ── Risk ──
    { rule_key: 'risk_high_min', category: 'risk', display_name: 'High Risk Threshold', description: 'Minimum inherent risk score (likelihood × impact) treated as "high".', comparison_operator: '>=', threshold_value: 15, severity: 'high', sort_order: 1, settings: { unit: 'points', min_value: 1, max_value: 25, wired: true, maps_to: 'management-dashboard.js: computeSummary, computeAlerts, computePartnerReview, computePracticeScore' } },
    { rule_key: 'risk_critical_min', category: 'risk', display_name: 'Critical Risk Threshold', description: 'Minimum inherent risk score treated as "critical".', comparison_operator: '>=', threshold_value: 20, severity: 'critical', sort_order: 2, settings: { unit: 'points', min_value: 1, max_value: 25, wired: true, maps_to: 'management-dashboard.js: computeSummary, computeAlerts, computePartnerReview, computePracticeScore' } },
    { rule_key: 'risk_partner_acceptance_min', category: 'risk', display_name: 'Risk Requiring Partner Acceptance', description: 'Minimum inherent risk score that must be explicitly accepted by a partner.', comparison_operator: '>=', threshold_value: 15, severity: 'medium', sort_order: 3, settings: { unit: 'points', min_value: 1, max_value: 25, wired: true, maps_to: 'management-dashboard.js: computeAlerts, computePartnerReview' } },

    // ── Tax ──
    { rule_key: 'tax_return_blocked_alert', category: 'tax', display_name: 'Blocked Tax Return', description: 'Severity for a tax return whose readiness status is "blocked".', comparison_operator: '=', threshold_text: 'blocked', severity: 'high', sort_order: 1, settings: { wired: false, maps_to: 'tax-completion.js / tax modules (not yet wired)' } },
    { rule_key: 'tax_dispute_open_alert', category: 'tax', display_name: 'Open Tax Dispute', description: 'Severity for an open SARS dispute case.', comparison_operator: '=', threshold_text: 'open', severity: 'high', sort_order: 2, settings: { wired: false, maps_to: 'tax-disputes.js (not yet wired)' } },
    { rule_key: 'tax_payment_outstanding_alert', category: 'tax', display_name: 'Outstanding Tax Payment', description: 'Severity for an outstanding/partially-paid payable tax payment.', comparison_operator: '=', threshold_text: 'outstanding', severity: 'medium', sort_order: 3, settings: { wired: false, maps_to: 'tax-payments.js (not yet wired)' } },
    { rule_key: 'tax_sars_unmatched_alert', category: 'tax', display_name: 'Unmatched SARS Statement Line', description: 'Severity for an unmatched or disputed SARS reconciliation line.', comparison_operator: '=', threshold_text: 'unmatched', severity: 'low', sort_order: 4, settings: { wired: false, maps_to: 'sars-statement-recon.js (not yet wired)' } },

    // ── Capacity ──
    { rule_key: 'capacity_overloaded_ratio', category: 'capacity', display_name: 'Overloaded Utilization Ratio', description: 'Assigned/weekly-capacity ratio above which a staff member is "overloaded" (1.0 = 100%).', comparison_operator: '>', threshold_value: 1.0, severity: 'high', sort_order: 1, settings: { unit: 'ratio', min_value: 0.5, max_value: 3, wired: true, maps_to: 'management-dashboard.js: computeSummary, computePracticeScore' } },
    { rule_key: 'capacity_high_min_pct', category: 'capacity', display_name: 'High Utilization %', description: 'Utilization percentage above which a staff member is "high" (but not yet overloaded).', comparison_operator: '>=', threshold_value: 85, severity: 'medium', sort_order: 2, settings: { unit: 'percent', min_value: 0, max_value: 100, wired: false, maps_to: 'capacity.js (not yet wired)' } },
    { rule_key: 'capacity_normal_band_pct', category: 'capacity', display_name: 'Normal Utilization Band %', description: 'Utilization percentage range considered "normal".', comparison_operator: 'between', threshold_value: 50, warning_value: 85, severity: 'info', sort_order: 3, settings: { unit: 'percent', wired: false, maps_to: 'capacity.js (not yet wired)' } },

    // ── QMS ──
    { rule_key: 'qms_failed_review_alert', category: 'qms', display_name: 'Failed Quality Review', description: 'Severity for a quality review with status "failed".', comparison_operator: '=', threshold_text: 'failed', severity: 'critical', sort_order: 1, settings: { wired: false, maps_to: 'quality-management.js (not yet wired)' } },
    { rule_key: 'qms_critical_finding_alert', category: 'qms', display_name: 'Critical Finding Alert Severity', description: 'Severity for an open/in-progress quality finding marked "critical".', comparison_operator: 'contains', threshold_text: 'critical', severity: 'critical', sort_order: 2, settings: { wired: false, maps_to: 'quality-management.js (not yet wired)' } },
    { rule_key: 'qms_high_finding_alert', category: 'qms', display_name: 'High Finding Alert Severity', description: 'Severity for an open/in-progress quality finding marked "high".', comparison_operator: 'contains', threshold_text: 'high', severity: 'high', sort_order: 3, settings: { wired: false, maps_to: 'quality-management.js (not yet wired)' } },

    // ── Client Health ──
    { rule_key: 'health_good_min', category: 'client_health', display_name: 'Good Health Score Floor', description: 'Minimum client health score treated as "good".', comparison_operator: '>=', threshold_value: 85, severity: 'info', sort_order: 1, settings: { unit: 'points', min_value: 0, max_value: 100, wired: false, maps_to: 'client-health.js (not yet wired)' } },
    { rule_key: 'health_watch_min', category: 'client_health', display_name: 'Watch Health Score Floor', description: 'Minimum client health score treated as "watch".', comparison_operator: '>=', threshold_value: 65, severity: 'low', sort_order: 2, settings: { unit: 'points', min_value: 0, max_value: 100, wired: false, maps_to: 'client-health.js (not yet wired)' } },
    { rule_key: 'health_at_risk_min', category: 'client_health', display_name: 'At-Risk Health Score Floor', description: 'Minimum client health score treated as "at risk" (below this is "critical").', comparison_operator: '>=', threshold_value: 40, severity: 'medium', sort_order: 3, settings: { unit: 'points', min_value: 0, max_value: 100, wired: false, maps_to: 'client-health.js (not yet wired)' } },

    // ── Compliance ──
    { rule_key: 'compliance_deadline_overdue_grace_days', category: 'compliance', display_name: 'Compliance Deadline Overdue Grace (days)', description: 'Days of grace after a deadline’s due date before it is flagged overdue. 0 = overdue the day after due_date.', comparison_operator: '>=', threshold_value: 0, severity: 'high', sort_order: 1, settings: { unit: 'days', min_value: 0, max_value: 90, wired: true, maps_to: 'management-dashboard.js: computeSummary, computeAlerts, computePracticeScore' } },
    { rule_key: 'compliance_pack_ready_min_pct', category: 'compliance', display_name: 'Compliance Pack "Ready" Floor %', description: 'Minimum readiness score percentage for a compliance pack to be "ready".', comparison_operator: '>=', threshold_value: 85, severity: 'info', sort_order: 2, settings: { unit: 'percent', min_value: 0, max_value: 100, wired: false, maps_to: 'compliance-packs.js (not yet wired)' } },
    { rule_key: 'compliance_pack_partial_min_pct', category: 'compliance', display_name: 'Compliance Pack "Partial" Floor %', description: 'Minimum readiness score percentage for a compliance pack to be "partial" (below this is "incomplete").', comparison_operator: '>=', threshold_value: 50, severity: 'low', sort_order: 3, settings: { unit: 'percent', min_value: 0, max_value: 100, wired: false, maps_to: 'compliance-packs.js (not yet wired)' } },

    // ── Documents ──
    { rule_key: 'document_overdue_grace_days', category: 'documents', display_name: 'Document Request Overdue Grace (days)', description: 'Days of grace after a document’s required-by date before it is flagged overdue.', comparison_operator: '>=', threshold_value: 0, severity: 'medium', sort_order: 1, settings: { unit: 'days', min_value: 0, max_value: 90, wired: true, maps_to: 'management-dashboard.js: computeSummary, computeAlerts' } },

    // ── Reminders ──
    { rule_key: 'reminder_overdue_grace_days', category: 'reminders', display_name: 'Reminder Overdue Grace (days)', description: 'Days of grace after a reminder’s due date before it is flagged overdue.', comparison_operator: '>=', threshold_value: 0, severity: 'medium', sort_order: 1, settings: { unit: 'days', min_value: 0, max_value: 90, wired: true, maps_to: 'management-dashboard.js: computeSummary, computeAlerts' } },
    { rule_key: 'reminder_upcoming_window_days', category: 'reminders', display_name: 'Upcoming Reminder Window (days)', description: 'How many days ahead a reminder is surfaced as "upcoming".', comparison_operator: '>=', threshold_value: 7, severity: 'info', sort_order: 2, settings: { unit: 'days', min_value: 1, max_value: 60, wired: true, maps_to: 'management-dashboard.js: computeSummary' } },

    // ── Communications ──
    { rule_key: 'communication_response_overdue_alert', category: 'communications', display_name: 'Overdue Communication Response', description: 'Severity for a client communication whose response is overdue.', comparison_operator: '=', threshold_text: 'overdue', severity: 'medium', sort_order: 1, settings: { wired: false, maps_to: 'communications.js (not yet wired)' } },

    // ── Knowledge ──
    { rule_key: 'knowledge_under_review_alert', category: 'knowledge', display_name: 'Knowledge Article Awaiting Approval', description: 'Severity for a knowledge article under partner review.', comparison_operator: '=', threshold_text: 'under_review', severity: 'low', sort_order: 1, settings: { wired: false, maps_to: 'knowledge-base.js (not yet wired)' } },

    // ── SOP ──
    { rule_key: 'sop_under_review_alert', category: 'sop', display_name: 'SOP Template Awaiting Approval', description: 'Severity for an SOP template under partner review.', comparison_operator: '=', threshold_text: 'under_review', severity: 'low', sort_order: 1, settings: { wired: false, maps_to: 'practice-sop.js (not yet wired)' } },

    // ── Billing ──
    { rule_key: 'billing_awaiting_approval_alert', category: 'billing', display_name: 'Billing Pack Awaiting Approval', description: 'Severity for a billing pack with status "reviewed" (awaiting partner approval).', comparison_operator: '=', threshold_text: 'reviewed', severity: 'medium', sort_order: 1, settings: { wired: false, maps_to: 'billing.js (not yet wired)' } },
    { rule_key: 'billing_wip_age_max_days', category: 'billing', display_name: 'Old WIP Pack Age (days)', description: 'Age in days above which a draft/unlocked billing pack is flagged as stale WIP.', comparison_operator: '>=', threshold_value: 30, severity: 'low', sort_order: 2, settings: { unit: 'days', min_value: 1, max_value: 180, wired: false, maps_to: 'client-health.js (not yet wired)' } },
    { rule_key: 'billing_writeoff_max_pct', category: 'billing', display_name: 'High Write-off %', description: 'Write-off percentage of total billing above which is flagged high.', comparison_operator: '>=', threshold_value: 20, severity: 'medium', sort_order: 3, settings: { unit: 'percent', min_value: 0, max_value: 100, wired: false, maps_to: 'client-health.js (not yet wired)' } },
];

// Hardcoded, code-level fallback — used only if a company has never run
// Seed Defaults yet, or if a specific rule row is missing/unreadable. This
// guarantees getRule()/getRules() NEVER return undefined and existing
// alerts keep working even before the rules engine is seeded.
const SAFE_DEFAULTS = {};
SEED_DEFAULTS.forEach(r => {
    SAFE_DEFAULTS[r.rule_key] = {
        rule_key: r.rule_key,
        category: r.category,
        comparison_operator: r.comparison_operator,
        threshold_value: r.threshold_value ?? null,
        warning_value: r.warning_value ?? null,
        threshold_text: r.threshold_text ?? null,
        severity: r.severity,
        enabled: true,
        _fallback: true,
    };
});

// ── In-process cache ─────────────────────────────────────────────────────────
// Keeps hot-path consumers (management-dashboard.js compute functions, which
// can run several times per request — see partner-review-packs.js building
// a report from 5 parallel compute calls) from re-querying the rules table
// on every single call. Short TTL, invalidated immediately on any write.

const _cache = new Map(); // company_id -> { data: { rule_key: row }, expiresAt }
const CACHE_TTL_MS = 30000;

function _invalidateCache(cid) {
    _cache.delete(cid);
}

async function _loadAllRules(cid) {
    const cached = _cache.get(cid);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const { data, error } = await supabase.from('practice_alert_rules').select('*').eq('company_id', cid);
    if (error) {
        console.error('[alert-rules] _loadAllRules', error.message);
        return {};
    }
    const map = {};
    (data || []).forEach(r => { map[r.rule_key] = r; });
    _cache.set(cid, { data: map, expiresAt: Date.now() + CACHE_TTL_MS });
    return map;
}

// ── getRule() / getRules() — the reusable helper future modules call ──────────
// Returns the DB row when one exists for the company, otherwise falls back
// to SAFE_DEFAULTS so callers never have to null-check against "not seeded
// yet". Never throws.

async function getRules(cid, keys) {
    const all = await _loadAllRules(cid);
    const out = {};
    keys.forEach(k => {
        out[k] = all[k] || SAFE_DEFAULTS[k] || null;
        if (!out[k]) console.error(`[alert-rules] getRules: unknown rule_key "${k}" — no row and no SAFE_DEFAULTS fallback registered`);
    });
    return out;
}

async function getRule(cid, key) {
    const rules = await getRules(cid, [key]);
    return rules[key];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyRule(id, cid) {
    const { data } = await supabase.from('practice_alert_rules').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeEvent(cid, ruleId, ruleKey, eventType, oldValue, newValue, req, notes, meta) {
    await supabase.from('practice_alert_rule_events').insert({
        company_id: cid,
        rule_id: ruleId || null,
        rule_key: ruleKey || null,
        event_type: eventType,
        old_value: oldValue || null,
        new_value: newValue || null,
        actor_user_id: req.user?.userId || null,
        notes: notes || null,
        metadata: meta || {},
    });
}

function _validatePayload(payload, { isCreate, existingKeys }) {
    const errors = [];

    if (isCreate) {
        if (!payload.rule_key || typeof payload.rule_key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(payload.rule_key)) {
            errors.push('rule_key is required and must be lowercase snake_case (e.g. "my_custom_rule").');
        } else if (existingKeys.includes(payload.rule_key)) {
            errors.push(`Duplicate rule_key: "${payload.rule_key}" already exists for this company.`);
        }
        if (!payload.category || typeof payload.category !== 'string') errors.push('category is required.');
        if (!payload.display_name || typeof payload.display_name !== 'string') errors.push('display_name is required.');
        if (!payload.comparison_operator) errors.push('comparison_operator is required.');
        if (!payload.severity) errors.push('severity is required.');
    }

    if (payload.comparison_operator !== undefined && !OPERATORS.includes(payload.comparison_operator)) {
        errors.push(`Invalid comparison_operator: "${payload.comparison_operator}". Must be one of ${OPERATORS.join(', ')}.`);
    }
    if (payload.severity !== undefined && !SEVERITIES.includes(payload.severity)) {
        errors.push(`Invalid severity: "${payload.severity}". Must be one of ${SEVERITIES.join(', ')}.`);
    }

    const op = payload.comparison_operator;
    if (op === 'between') {
        if (payload.threshold_value == null || payload.warning_value == null) {
            errors.push('The "between" operator requires both threshold_value (low) and warning_value (high).');
        } else if (Number(payload.threshold_value) >= Number(payload.warning_value)) {
            errors.push('For "between", threshold_value must be less than warning_value.');
        }
    } else if (op === 'contains') {
        if (!payload.threshold_text && isCreate) errors.push('The "contains" operator requires threshold_text.');
    } else if (op === '=' || op === '!=') {
        if (isCreate && payload.threshold_value == null && !payload.threshold_text) {
            errors.push(`The "${op}" operator requires either threshold_value or threshold_text.`);
        }
    } else if (op && ['>', '>=', '<', '<='].includes(op)) {
        if (isCreate && (payload.threshold_value == null || isNaN(Number(payload.threshold_value)))) {
            errors.push(`The "${op}" operator requires a numeric threshold_value.`);
        }
    }

    if (payload.threshold_value !== undefined && payload.threshold_value !== null && isNaN(Number(payload.threshold_value))) {
        errors.push('threshold_value must be numeric.');
    }
    if (payload.warning_value !== undefined && payload.warning_value !== null && isNaN(Number(payload.warning_value))) {
        errors.push('warning_value must be numeric.');
    }

    if (payload.settings && typeof payload.settings === 'object') {
        const { min_value, max_value } = payload.settings;
        if (min_value != null && max_value != null && Number(min_value) > Number(max_value)) {
            errors.push('settings.min_value cannot be greater than settings.max_value.');
        }
        if (payload.threshold_value != null && min_value != null && Number(payload.threshold_value) < Number(min_value)) {
            errors.push(`threshold_value (${payload.threshold_value}) is below the configured minimum (${min_value}).`);
        }
        if (payload.threshold_value != null && max_value != null && Number(payload.threshold_value) > Number(max_value)) {
            errors.push(`threshold_value (${payload.threshold_value}) is above the configured maximum (${max_value}).`);
        }
    }

    return errors;
}

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
    try {
        const cid = req.companyId;
        const { data, error } = await supabase.from('practice_alert_rules').select('category, severity, enabled, system_rule').eq('company_id', cid);
        if (error) throw error;
        const rows = data || [];

        const byCategory = {};
        const bySeverity = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
        rows.forEach(r => {
            byCategory[r.category] = (byCategory[r.category] || 0) + 1;
            if (bySeverity[r.severity] != null) bySeverity[r.severity]++;
        });

        res.json({
            seeded: rows.length > 0,
            total_rules: rows.length,
            enabled_count: rows.filter(r => r.enabled).length,
            disabled_count: rows.filter(r => !r.enabled).length,
            system_rule_count: rows.filter(r => r.system_rule).length,
            custom_rule_count: rows.filter(r => !r.system_rule).length,
            by_category: byCategory,
            by_severity: bySeverity,
        });
    } catch (err) {
        console.error('GET /api/practice/alert-rules/summary', err);
        res.status(500).json({ error: 'Failed to load rules summary.' });
    }
});

// ── GET /groups ───────────────────────────────────────────────────────────────

router.get('/groups', async (req, res) => {
    try {
        const cid = req.companyId;
        const [groupsRes, rulesRes] = await Promise.all([
            supabase.from('practice_alert_rule_groups').select('*').eq('company_id', cid).order('sort_order'),
            supabase.from('practice_alert_rules').select('id, group_id, category, enabled').eq('company_id', cid),
        ]);
        if (groupsRes.error) throw groupsRes.error;
        if (rulesRes.error) throw rulesRes.error;

        const rules = rulesRes.data || [];
        const groups = (groupsRes.data || []).map(g => {
            const inGroup = rules.filter(r => r.group_id === g.id || r.category === g.group_key);
            return { ...g, rule_count: inGroup.length, enabled_count: inGroup.filter(r => r.enabled).length };
        });
        res.json({ groups, seeded: groups.length > 0 });
    } catch (err) {
        console.error('GET /api/practice/alert-rules/groups', err);
        res.status(500).json({ error: 'Failed to load rule groups.' });
    }
});

// ── POST /groups/:groupId/reset ────────────────────────────────────────────────
// Resets every rule in a group back to its seeded default_* values.

router.post('/groups/:groupId/reset', async (req, res) => {
    try {
        const cid = req.companyId;
        const groupId = Number(req.params.groupId);
        const { data: group } = await supabase.from('practice_alert_rule_groups').select('*').eq('id', groupId).eq('company_id', cid).maybeSingle();
        if (!group) return res.status(404).json({ error: 'Rule group not found.' });

        const { data: rules } = await supabase.from('practice_alert_rules').select('*').eq('company_id', cid).eq('group_id', groupId);
        const results = [];
        for (const rule of (rules || [])) {
            const before = { ...rule };
            const { data: updated, error } = await supabase.from('practice_alert_rules').update({
                threshold_value: rule.default_value,
                warning_value: rule.default_warning_value,
                threshold_text: rule.default_threshold_text,
                severity: rule.default_severity,
                enabled: rule.default_enabled,
                version: rule.version + 1,
                updated_by: req.user?.userId || null,
            }).eq('id', rule.id).eq('company_id', cid).select().single();
            if (error) throw error;
            await _writeEvent(cid, rule.id, rule.rule_key, 'rule_reset', before, updated, req, 'Reset via group reset.', { group_key: group.group_key });
            results.push(updated);
        }
        _invalidateCache(cid);
        await _writeEvent(cid, null, null, 'group_reset', null, { group_key: group.group_key, rule_count: results.length }, req);
        res.json({ group, rules: results });
    } catch (err) {
        console.error('POST /api/practice/alert-rules/groups/:groupId/reset', err);
        res.status(500).json({ error: 'Failed to reset group.' });
    }
});

// ── POST /seed-defaults ─────────────────────────────────────────────────────────
// Idempotent bootstrap: creates any missing groups/rules for this company.
// Never overwrites an existing row — safe to call again after a future
// codebox adds new rule_keys; existing edits are always preserved.

router.post('/seed-defaults', async (req, res) => {
    try {
        const cid = req.companyId;

        // Groups first (rules link to group_id).
        const { data: existingGroups } = await supabase.from('practice_alert_rule_groups').select('*').eq('company_id', cid);
        const existingGroupKeys = new Set((existingGroups || []).map(g => g.group_key));
        const groupsToInsert = GROUPS.filter(g => !existingGroupKeys.has(g.group_key)).map(g => ({ ...g, company_id: cid }));
        let insertedGroups = [];
        if (groupsToInsert.length) {
            const { data, error } = await supabase.from('practice_alert_rule_groups').insert(groupsToInsert).select();
            if (error) throw error;
            insertedGroups = data || [];
        }

        const { data: allGroups } = await supabase.from('practice_alert_rule_groups').select('*').eq('company_id', cid);
        const groupIdByKey = {};
        (allGroups || []).forEach(g => { groupIdByKey[g.group_key] = g.id; });

        const { data: existingRules } = await supabase.from('practice_alert_rules').select('rule_key').eq('company_id', cid);
        const existingRuleKeys = new Set((existingRules || []).map(r => r.rule_key));

        const rulesToInsert = SEED_DEFAULTS.filter(r => !existingRuleKeys.has(r.rule_key)).map(r => ({
            company_id: cid,
            group_id: groupIdByKey[r.category] || null,
            rule_key: r.rule_key,
            category: r.category,
            display_name: r.display_name,
            description: r.description || null,
            comparison_operator: r.comparison_operator,
            threshold_value: r.threshold_value ?? null,
            warning_value: r.warning_value ?? null,
            threshold_text: r.threshold_text ?? null,
            severity: r.severity,
            enabled: true,
            editable: true,
            system_rule: true,
            default_value: r.threshold_value ?? null,
            default_warning_value: r.warning_value ?? null,
            default_threshold_text: r.threshold_text ?? null,
            default_severity: r.severity,
            default_enabled: true,
            sort_order: r.sort_order || 0,
            settings: r.settings || {},
            version: 1,
            created_by: req.user?.userId || null,
            updated_by: req.user?.userId || null,
        }));

        let insertedRules = [];
        if (rulesToInsert.length) {
            const { data, error } = await supabase.from('practice_alert_rules').insert(rulesToInsert).select();
            if (error) throw error;
            insertedRules = data || [];
        }

        _invalidateCache(cid);
        await _writeEvent(cid, null, null, 'rules_seeded', null, {
            groups_created: insertedGroups.length, rules_created: insertedRules.length,
        }, req, `Seeded ${insertedGroups.length} group(s) and ${insertedRules.length} rule(s).`);

        res.json({
            groups_created: insertedGroups.length,
            rules_created: insertedRules.length,
            already_seeded: insertedGroups.length === 0 && insertedRules.length === 0,
        });
    } catch (err) {
        console.error('POST /api/practice/alert-rules/seed-defaults', err);
        res.status(500).json({ error: 'Failed to seed default rules.' });
    }
});

// ── GET /export ───────────────────────────────────────────────────────────────

router.get('/export', async (req, res) => {
    try {
        const cid = req.companyId;
        const { data, error } = await supabase.from('practice_alert_rules').select('*').eq('company_id', cid).order('category').order('sort_order');
        if (error) throw error;

        await _writeEvent(cid, null, null, 'rules_exported', null, { rule_count: (data || []).length }, req);

        res.json({
            exported_at: new Date().toISOString(),
            company_id: cid,
            rule_count: (data || []).length,
            rules: (data || []).map(r => _pick(r, [
                'rule_key', 'category', 'display_name', 'description', 'comparison_operator',
                'threshold_value', 'warning_value', 'threshold_text', 'severity', 'enabled',
                'sort_order', 'settings',
            ])),
        });
    } catch (err) {
        console.error('GET /api/practice/alert-rules/export', err);
        res.status(500).json({ error: 'Failed to export rules.' });
    }
});

// ── POST /import ─────────────────────────────────────────────────────────────
// Safe upsert only: existing rule_keys are updated (their threshold/severity/
// enabled fields), unknown rule_keys are validated and created as custom
// rules. Nothing is ever deleted by import.

router.post('/import', async (req, res) => {
    try {
        const cid = req.companyId;
        const incoming = Array.isArray(req.body?.rules) ? req.body.rules : null;
        if (!incoming || !incoming.length) return res.status(422).json({ error: 'Request body must include a non-empty "rules" array.' });

        const { data: existingRules } = await supabase.from('practice_alert_rules').select('*').eq('company_id', cid);
        const byKey = {};
        (existingRules || []).forEach(r => { byKey[r.rule_key] = r; });
        const existingKeys = Object.keys(byKey);

        const { data: allGroups } = await supabase.from('practice_alert_rule_groups').select('*').eq('company_id', cid);
        const groupIdByKey = {};
        (allGroups || []).forEach(g => { groupIdByKey[g.group_key] = g.id; });

        const errors = [];
        const updates = [];
        const creates = [];

        incoming.forEach((r, idx) => {
            if (!r.rule_key) { errors.push(`Row ${idx}: missing rule_key.`); return; }
            const existing = byKey[r.rule_key];
            const isCreate = !existing;
            const rowErrors = _validatePayload(r, { isCreate, existingKeys });
            if (rowErrors.length) { errors.push(...rowErrors.map(e => `Row ${idx} (${r.rule_key}): ${e}`)); return; }

            if (existing) {
                if (!existing.editable) { errors.push(`Row ${idx} (${r.rule_key}): rule is not editable — skipped.`); return; }
                updates.push({ existing, payload: r });
            } else {
                creates.push(r);
            }
        });

        if (errors.length) return res.status(422).json({ error: 'Import validation failed. No changes were applied.', details: errors });

        const results = { updated: [], created: [] };

        for (const { existing, payload } of updates) {
            const before = { ...existing };
            const patch = {
                display_name: payload.display_name ?? existing.display_name,
                description: payload.description ?? existing.description,
                comparison_operator: payload.comparison_operator ?? existing.comparison_operator,
                threshold_value: payload.threshold_value !== undefined ? payload.threshold_value : existing.threshold_value,
                warning_value: payload.warning_value !== undefined ? payload.warning_value : existing.warning_value,
                threshold_text: payload.threshold_text !== undefined ? payload.threshold_text : existing.threshold_text,
                severity: payload.severity ?? existing.severity,
                enabled: payload.enabled !== undefined ? !!payload.enabled : existing.enabled,
                sort_order: payload.sort_order !== undefined ? payload.sort_order : existing.sort_order,
                settings: payload.settings ?? existing.settings,
                version: existing.version + 1,
                updated_by: req.user?.userId || null,
            };
            const { data: updated, error } = await supabase.from('practice_alert_rules').update(patch).eq('id', existing.id).eq('company_id', cid).select().single();
            if (error) throw error;
            await _writeEvent(cid, existing.id, existing.rule_key, 'rule_updated', before, updated, req, 'Updated via import.');
            results.updated.push(updated);
        }

        for (const payload of creates) {
            const insertRow = {
                company_id: cid,
                group_id: groupIdByKey[payload.category] || null,
                rule_key: payload.rule_key,
                category: payload.category,
                display_name: payload.display_name,
                description: payload.description || null,
                comparison_operator: payload.comparison_operator,
                threshold_value: payload.threshold_value ?? null,
                warning_value: payload.warning_value ?? null,
                threshold_text: payload.threshold_text ?? null,
                severity: payload.severity,
                enabled: payload.enabled !== false,
                editable: true,
                system_rule: false,
                default_value: payload.threshold_value ?? null,
                default_warning_value: payload.warning_value ?? null,
                default_threshold_text: payload.threshold_text ?? null,
                default_severity: payload.severity,
                default_enabled: payload.enabled !== false,
                sort_order: payload.sort_order || 0,
                settings: payload.settings || {},
                version: 1,
                created_by: req.user?.userId || null,
                updated_by: req.user?.userId || null,
            };
            const { data: created, error } = await supabase.from('practice_alert_rules').insert(insertRow).select().single();
            if (error) throw error;
            await _writeEvent(cid, created.id, created.rule_key, 'rule_created', null, created, req, 'Created via import.');
            results.created.push(created);
        }

        _invalidateCache(cid);
        await _writeEvent(cid, null, null, 'rules_imported', null, { updated: results.updated.length, created: results.created.length }, req);

        res.json({ updated_count: results.updated.length, created_count: results.created.length, rules: [...results.updated, ...results.created] });
    } catch (err) {
        console.error('POST /api/practice/alert-rules/import', err);
        res.status(500).json({ error: 'Failed to import rules.' });
    }
});

// ── POST /validate ───────────────────────────────────────────────────────────
// Dry-run validation — no write. Used by the frontend before submitting a
// create/update so the user sees errors inline.

router.post('/validate', async (req, res) => {
    try {
        const cid = req.companyId;
        const body = req.body || {};
        const isCreate = !body.id;
        let existingKeys = [];
        if (isCreate) {
            const { data } = await supabase.from('practice_alert_rules').select('rule_key').eq('company_id', cid);
            existingKeys = (data || []).map(r => r.rule_key);
        }
        const errors = _validatePayload(body, { isCreate, existingKeys });
        res.json({ valid: errors.length === 0, errors });
    } catch (err) {
        console.error('POST /api/practice/alert-rules/validate', err);
        res.status(500).json({ error: 'Failed to validate rule.' });
    }
});

// ── GET /events ───────────────────────────────────────────────────────────────
// Global history feed (optionally filtered by rule_id).

router.get('/events', async (req, res) => {
    try {
        const cid = req.companyId;
        let q = supabase.from('practice_alert_rule_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(200);
        if (req.query.rule_id) q = q.eq('rule_id', Number(req.query.rule_id));
        const { data, error } = await q;
        if (error) throw error;
        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/alert-rules/events', err);
        res.status(500).json({ error: 'Failed to load rule history.' });
    }
});

// ── GET / (list rules) ───────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const cid = req.companyId;
        let q = supabase.from('practice_alert_rules').select('*').eq('company_id', cid).order('category').order('sort_order');
        if (req.query.category) q = q.eq('category', req.query.category);
        if (req.query.enabled !== undefined) q = q.eq('enabled', req.query.enabled === 'true');
        if (req.query.group_id) q = q.eq('group_id', Number(req.query.group_id));
        const { data, error } = await q;
        if (error) throw error;

        let rows = data || [];
        if (req.query.search) {
            const s = String(req.query.search).toLowerCase();
            rows = rows.filter(r => `${r.rule_key} ${r.display_name} ${r.description || ''}`.toLowerCase().includes(s));
        }
        res.json({ rules: rows, total: rows.length });
    } catch (err) {
        console.error('GET /api/practice/alert-rules', err);
        res.status(500).json({ error: 'Failed to load rules.' });
    }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
    try {
        const rule = await _verifyRule(req.params.id, req.companyId);
        if (!rule) return res.status(404).json({ error: 'Rule not found.' });
        const { data: events } = await supabase.from('practice_alert_rule_events').select('*').eq('company_id', req.companyId).eq('rule_id', rule.id).order('created_at', { ascending: false }).limit(20);
        res.json({ rule, recent_events: events || [] });
    } catch (err) {
        console.error('GET /api/practice/alert-rules/:id', err);
        res.status(500).json({ error: 'Failed to load rule.' });
    }
});

// ── POST / (create custom rule) ──────────────────────────────────────────────

router.post('/', async (req, res) => {
    try {
        const cid = req.companyId;
        const body = req.body || {};

        const { data: existingRules } = await supabase.from('practice_alert_rules').select('rule_key').eq('company_id', cid);
        const existingKeys = (existingRules || []).map(r => r.rule_key);
        const errors = _validatePayload(body, { isCreate: true, existingKeys });
        if (errors.length) return res.status(422).json({ error: 'Validation failed.', details: errors });

        let groupId = null;
        const { data: g } = await supabase.from('practice_alert_rule_groups').select('id').eq('company_id', cid).eq('group_key', body.category).maybeSingle();
        groupId = g ? g.id : null;

        const insertRow = {
            company_id: cid,
            group_id: groupId,
            rule_key: body.rule_key,
            category: body.category,
            display_name: body.display_name,
            description: body.description || null,
            comparison_operator: body.comparison_operator,
            threshold_value: body.threshold_value ?? null,
            warning_value: body.warning_value ?? null,
            threshold_text: body.threshold_text ?? null,
            severity: body.severity,
            enabled: body.enabled !== false,
            editable: true,
            system_rule: false,
            default_value: body.threshold_value ?? null,
            default_warning_value: body.warning_value ?? null,
            default_threshold_text: body.threshold_text ?? null,
            default_severity: body.severity,
            default_enabled: body.enabled !== false,
            sort_order: body.sort_order || 0,
            settings: body.settings || {},
            version: 1,
            created_by: req.user?.userId || null,
            updated_by: req.user?.userId || null,
        };

        const { data, error } = await supabase.from('practice_alert_rules').insert(insertRow).select().single();
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'A rule with this rule_key already exists.' });
            throw error;
        }
        _invalidateCache(cid);
        await _writeEvent(cid, data.id, data.rule_key, 'rule_created', null, data, req);
        res.status(201).json({ rule: data });
    } catch (err) {
        console.error('POST /api/practice/alert-rules', err);
        res.status(500).json({ error: 'Failed to create rule.' });
    }
});

// ── PUT /:id (update) ────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Rule not found.' });
        if (!rule.editable) return res.status(422).json({ error: 'This rule is not editable.' });

        const body = req.body || {};
        const merged = {
            comparison_operator: body.comparison_operator ?? rule.comparison_operator,
            threshold_value: body.threshold_value !== undefined ? body.threshold_value : rule.threshold_value,
            warning_value: body.warning_value !== undefined ? body.warning_value : rule.warning_value,
            threshold_text: body.threshold_text !== undefined ? body.threshold_text : rule.threshold_text,
            severity: body.severity ?? rule.severity,
            settings: body.settings ?? rule.settings,
        };
        const errors = _validatePayload(merged, { isCreate: false, existingKeys: [] });
        if (errors.length) return res.status(422).json({ error: 'Validation failed.', details: errors });

        const before = { ...rule };
        const patch = {
            display_name: body.display_name ?? rule.display_name,
            description: body.description !== undefined ? body.description : rule.description,
            comparison_operator: merged.comparison_operator,
            threshold_value: merged.threshold_value,
            warning_value: merged.warning_value,
            threshold_text: merged.threshold_text,
            severity: merged.severity,
            enabled: body.enabled !== undefined ? !!body.enabled : rule.enabled,
            sort_order: body.sort_order !== undefined ? body.sort_order : rule.sort_order,
            settings: merged.settings,
            version: rule.version + 1,
            updated_by: req.user?.userId || null,
        };

        const { data: updated, error } = await supabase.from('practice_alert_rules').update(patch).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        _invalidateCache(cid);
        await _writeEvent(cid, rule.id, rule.rule_key, 'rule_updated', before, updated, req, body.notes || null);
        res.json({ rule: updated });
    } catch (err) {
        console.error('PUT /api/practice/alert-rules/:id', err);
        res.status(500).json({ error: 'Failed to update rule.' });
    }
});

// ── POST /:id/reset ───────────────────────────────────────────────────────────

router.post('/:id/reset', async (req, res) => {
    try {
        const cid = req.companyId;
        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Rule not found.' });

        const before = { ...rule };
        const { data: updated, error } = await supabase.from('practice_alert_rules').update({
            threshold_value: rule.default_value,
            warning_value: rule.default_warning_value,
            threshold_text: rule.default_threshold_text,
            severity: rule.default_severity,
            enabled: rule.default_enabled,
            version: rule.version + 1,
            updated_by: req.user?.userId || null,
        }).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        _invalidateCache(cid);
        await _writeEvent(cid, rule.id, rule.rule_key, 'rule_reset', before, updated, req);
        res.json({ rule: updated });
    } catch (err) {
        console.error('POST /api/practice/alert-rules/:id/reset', err);
        res.status(500).json({ error: 'Failed to reset rule.' });
    }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    try {
        const cid = req.companyId;
        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Rule not found.' });
        if (rule.system_rule) return res.status(422).json({ error: 'System rules cannot be deleted. Disable it instead, or reset it to defaults.' });

        const { error } = await supabase.from('practice_alert_rules').delete().eq('id', rule.id).eq('company_id', cid);
        if (error) throw error;

        _invalidateCache(cid);
        await _writeEvent(cid, null, rule.rule_key, 'rule_deleted', rule, null, req);
        res.json({ deleted: true, rule_key: rule.rule_key });
    } catch (err) {
        console.error('DELETE /api/practice/alert-rules/:id', err);
        res.status(500).json({ error: 'Failed to delete rule.' });
    }
});

// ── GET /:id/events ───────────────────────────────────────────────────────────

router.get('/:id/events', async (req, res) => {
    try {
        const cid = req.companyId;
        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Rule not found.' });
        const { data, error } = await supabase.from('practice_alert_rule_events').select('*').eq('company_id', cid).eq('rule_id', rule.id).order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/alert-rules/:id/events', err);
        res.status(500).json({ error: 'Failed to load rule history.' });
    }
});

module.exports = router;

// Reusable helper other modules call in-process — see management-dashboard.js
// for the first consumer. Never throws; always resolves to a usable value
// (DB row, or SAFE_DEFAULTS fallback matching the originally-hardcoded
// behaviour if the company hasn't seeded yet or the row is missing).
module.exports.getRule = getRule;
module.exports.getRules = getRules;
module.exports.invalidateCache = _invalidateCache;
module.exports.SEED_DEFAULTS = SEED_DEFAULTS;
module.exports.GROUPS = GROUPS;
