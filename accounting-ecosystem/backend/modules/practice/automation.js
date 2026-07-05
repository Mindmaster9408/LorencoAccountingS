'use strict';

// Codebox 78 — Practice Automation Foundation + Workflow Orchestration
// The nervous system of Practice Management: safe, deterministic rules that
// react to a trigger and run a small set of known-safe actions.
//
// NOT AI. NOT autonomous decision making. NOT cron-heavy background
// processing. NOT workflow replacement. NOT task engine replacement. NOT
// external integration automation.
//
// SCOPE NOTE: this codebox builds the rule register, condition engine,
// action engine, and manual execution (test/run-now) only. No existing
// module is modified to automatically FIRE a trigger when e.g. a pricing
// review is approved — per the spec's own "Do not wire every module yet.
// This codebox builds the foundation and safe manual execution," every
// trigger_type on a rule is metadata describing what the rule is FOR; the
// only way a rule actually executes in this codebox is POST .../test
// (always a dry run) or POST .../run (a manager explicitly running it now,
// passing the trigger context by hand). A future codebox may wire real
// module-to-module event firing on top of this foundation.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const { auditFromReq } = require('../../middleware/audit');
const notifications = require('./notifications');
const teamAccess = require('./lib/team-access');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const RULE_STATUSES = ['draft', 'active', 'paused', 'disabled', 'archived', 'cancelled'];
const TERMINAL_RULE_STATUSES = ['archived', 'cancelled'];
const EDITABLE_RULE_STATUSES = ['draft', 'paused', 'disabled'];

const TRIGGER_TYPES = [
    'manual', 'notification_created', 'task_completed', 'workflow_completed',
    'pricing_review_approved', 'engagement_renewal_due', 'executive_report_published',
    'executive_action_created', 'strategic_review_completed',
    'secretarial_change_implemented', 'secretarial_integrity_critical',
    'onboarding_completed', 'risk_created', 'qms_finding_created', 'custom',
];
const RULE_CATEGORIES = [
    'notifications', 'reminders', 'executive', 'strategy', 'pricing', 'engagement',
    'secretarial', 'qms', 'risk', 'onboarding', 'planning', 'custom',
];
const SAFETY_LEVELS = ['low', 'medium', 'high', 'critical'];
const HIGH_RISK_SAFETY_LEVELS = ['high', 'critical'];

const RUN_STATUSES = ['dry_run', 'running', 'completed', 'completed_with_warnings', 'failed', 'cancelled', 'skipped'];
const STEP_TYPES = ['condition', 'action', 'safety_check', 'idempotency_check', 'output'];
const STEP_STATUSES = ['pending', 'passed', 'skipped', 'completed', 'failed', 'warning'];

// ── Condition Engine ──────────────────────────────────────────────────────────
// Deterministic, no eval, no dynamic code. Every field path's root must be
// one of these — anything else is rejected outright.

const CONDITION_OPERATORS = [
    'equals', 'not_equals', 'exists', 'not_exists',
    'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal',
    'contains', 'in', 'not_in',
];
const ALLOWED_FIELD_ROOTS = ['source', 'rule', 'context', 'company', 'user'];

function _getPath(obj, path) {
    return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function _fieldRoot(field) {
    return String(field || '').split('.')[0];
}

function validateConditions(conditions) {
    const errors = [];
    if (!Array.isArray(conditions)) return { valid: false, errors: ['conditions must be an array.'] };
    conditions.forEach((c, i) => {
        if (!c || typeof c !== 'object') { errors.push(`Condition ${i + 1}: must be an object.`); return; }
        if (!c.field || typeof c.field !== 'string') { errors.push(`Condition ${i + 1}: field is required.`); return; }
        if (!ALLOWED_FIELD_ROOTS.includes(_fieldRoot(c.field))) {
            errors.push(`Condition ${i + 1}: field root "${_fieldRoot(c.field)}" is not allowed. Allowed roots: ${ALLOWED_FIELD_ROOTS.join(', ')}.`);
        }
        if (!CONDITION_OPERATORS.includes(c.operator)) {
            errors.push(`Condition ${i + 1}: operator "${c.operator}" is not supported. Allowed: ${CONDITION_OPERATORS.join(', ')}.`);
        }
        if (!['exists', 'not_exists'].includes(c.operator) && !('value' in c)) {
            errors.push(`Condition ${i + 1}: value is required for operator "${c.operator}".`);
        }
    });
    return { valid: errors.length === 0, errors };
}

function _applyOperator(operator, actual, expected) {
    switch (operator) {
        case 'equals': return actual === expected;
        case 'not_equals': return actual !== expected;
        case 'exists': return actual !== undefined && actual !== null;
        case 'not_exists': return actual === undefined || actual === null;
        case 'greater_than': return Number(actual) > Number(expected);
        case 'greater_or_equal': return Number(actual) >= Number(expected);
        case 'less_than': return Number(actual) < Number(expected);
        case 'less_or_equal': return Number(actual) <= Number(expected);
        case 'contains': return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected));
        case 'in': return Array.isArray(expected) && expected.includes(actual);
        case 'not_in': return Array.isArray(expected) && !expected.includes(actual);
        default: throw new Error(`Unsupported operator "${operator}".`);
    }
}

// AND semantics only — every condition must pass. An empty array always
// passes (an unconditional rule), matching "Every rule must be explainable"
// rather than an implicit, undocumented default.
function evaluateConditions(conditions, ctx) {
    const results = (conditions || []).map(c => {
        const actual = _getPath(ctx, c.field);
        const passed = _applyOperator(c.operator, actual, c.value);
        return { field: c.field, operator: c.operator, value: c.value, actual, passed };
    });
    return { passed: results.every(r => r.passed), results };
}

// Safe, non-eval string interpolation for action config text fields —
// {{source.report_title}} style tokens only, resolved via _getPath.
function _interpolate(str, ctx) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path) => {
        const v = _getPath(ctx, path);
        return v == null ? '' : String(v);
    });
}

// ── Action Engine ─────────────────────────────────────────────────────────────
// Explicitly supported actions only. Anything else — including the
// spec's own named-forbidden list — fails safely with a clear error, never
// silently, never partially.

const SUPPORTED_ACTIONS = ['create_notification', 'create_reminder', 'create_executive_action', 'add_note_event', 'flag_for_review'];
// Named explicitly so a rule author gets a clear, specific rejection reason
// instead of a generic "unknown action type."
const EXPLICITLY_FORBIDDEN_ACTIONS = ['send_email', 'create_invoice', 'submit_to_sars', 'submit_to_cipc', 'update_accounting', 'auto_assign_work', 'change_engagement_fee'];

// Mirrors reminders.js's own REMINDER_TYPES exactly (that module exports no
// constant) — deliberately duplicated as a small, documented allow-list
// rather than a new reminder concept; kept in sync manually if
// reminders.js's list ever changes (see docs Architect Freedom note).
const REMINDER_TYPES = [
    'deadline_due', 'deadline_overdue', 'review_waiting', 'approval_waiting',
    'billing_waiting', 'health_action', 'period_waiting', 'engagement_setup',
    'capacity_warning', 'general',
];
const REMINDER_SEVERITIES = ['low', 'normal', 'high', 'urgent'];

function validateActions(actions) {
    const errors = [];
    if (!Array.isArray(actions)) return { valid: false, errors: ['actions must be an array.'] };
    if (!actions.length) errors.push('At least one action is required.');
    actions.forEach((a, i) => {
        if (!a || typeof a !== 'object' || !a.type) { errors.push(`Action ${i + 1}: type is required.`); return; }
        if (EXPLICITLY_FORBIDDEN_ACTIONS.includes(a.type)) {
            errors.push(`Action ${i + 1}: "${a.type}" is not a supported automation action in this codebox (external/financial/government side effects are out of scope).`);
            return;
        }
        if (!SUPPORTED_ACTIONS.includes(a.type)) {
            errors.push(`Action ${i + 1}: "${a.type}" is not a recognized action type. Supported: ${SUPPORTED_ACTIONS.join(', ')}.`);
            return;
        }
        if (a.type === 'create_notification') {
            if (!a.category || !notifications.CATEGORIES.includes(a.category)) errors.push(`Action ${i + 1}: create_notification requires a valid category (${notifications.CATEGORIES.join(', ')}).`);
            if (!a.severity || !notifications.SEVERITIES.includes(a.severity)) errors.push(`Action ${i + 1}: create_notification requires a valid severity (${notifications.SEVERITIES.join(', ')}).`);
            if (!a.title) errors.push(`Action ${i + 1}: create_notification requires a title.`);
        }
        if (a.type === 'create_reminder') {
            if (!a.reminder_type || !REMINDER_TYPES.includes(a.reminder_type)) errors.push(`Action ${i + 1}: create_reminder requires a valid reminder_type (${REMINDER_TYPES.join(', ')}).`);
            if (!a.title) errors.push(`Action ${i + 1}: create_reminder requires a title.`);
        }
        if (a.type === 'create_executive_action') {
            if (!a.action_title) errors.push(`Action ${i + 1}: create_executive_action requires an action_title.`);
            if (!a.report_id && !a.report_id_field) errors.push(`Action ${i + 1}: create_executive_action requires either a fixed report_id or a report_id_field to resolve one from the trigger context.`);
        }
        if (a.type === 'flag_for_review' && a.notify && (!a.notification || !a.notification.category || !a.notification.severity || !a.notification.title)) {
            errors.push(`Action ${i + 1}: flag_for_review with notify=true requires a complete notification config (category, severity, title).`);
        }
    });
    return { valid: errors.length === 0, errors };
}

async function _actionCreateNotification(a, ctx, opts) {
    const title = _interpolate(a.title, ctx);
    const message = a.message ? _interpolate(a.message, ctx) : null;
    if (opts.dryRun) return { status: 'passed', output: { would_create_notification: { title, category: a.category, severity: a.severity, assignment: a.assignment || null } } };

    const result = await notifications.notify({
        cid: opts.cid,
        notificationKey: a.notificationKey ? _interpolate(a.notificationKey, ctx) : `automation:${opts.ruleId}:${opts.runId}`,
        title, message,
        category: a.category, severity: a.severity,
        sourceModule: 'automation', sourceType: a.sourceType || null, sourceId: a.sourceId || null,
        dueDate: a.dueDate || null,
        metadata: Object.assign({}, a.metadata || {}, { automation_rule_id: opts.ruleId, automation_run_id: opts.runId }),
        createdBy: opts.userId,
        assignment: a.assignment || null,
    });
    return {
        status: result.created === false ? 'warning' : 'completed',
        output: { notification_id: result.notificationId, deduped: result.created === false, resolution_method: result.resolution_method },
    };
}

async function _actionCreateReminder(a, ctx, opts) {
    const title = _interpolate(a.title, ctx);
    const message = a.message ? _interpolate(a.message, ctx) : null;
    if (opts.dryRun) return { status: 'passed', output: { would_create_reminder: { title, reminder_type: a.reminder_type, severity: a.severity || 'normal' } } };

    const now = new Date().toISOString();
    const { data, error } = await supabase.from('practice_reminders').insert({
        company_id: opts.cid,
        reminder_type: a.reminder_type,
        source_type: a.source_type || 'automation',
        source_id: a.source_id || null,
        client_id: a.client_id || null,
        assigned_team_member_id: a.assigned_team_member_id || null,
        title, message,
        severity: REMINDER_SEVERITIES.includes(a.severity) ? a.severity : 'normal',
        status: 'open',
        due_date: a.due_date || null,
        action_url: a.action_url || null,
        metadata: Object.assign({}, a.metadata || {}, { automation_rule_id: opts.ruleId, automation_run_id: opts.runId }),
        created_at: now, updated_at: now,
        created_by: opts.userId,
    }).select().single();
    if (error) return { status: 'failed', error: `Failed to create reminder: ${error.message}` };
    return { status: 'completed', output: { reminder_id: data.id } };
}

async function _actionCreateExecutiveAction(a, ctx, opts) {
    const reportId = a.report_id || (a.report_id_field ? _getPath(ctx, a.report_id_field) : null);
    if (!reportId) return { status: 'failed', error: 'create_executive_action requires a resolvable report_id in the trigger context.' };

    const { data: report } = await supabase.from('practice_executive_reports').select('id').eq('id', reportId).eq('company_id', opts.cid).maybeSingle();
    if (!report) return { status: 'failed', error: `create_executive_action: report_id ${reportId} does not belong to this company.` };

    const actionTitle = _interpolate(a.action_title, ctx);
    if (opts.dryRun) return { status: 'passed', output: { would_create_executive_action: { report_id: reportId, action_title: actionTitle } } };

    const { data, error } = await supabase.from('practice_executive_action_register').insert({
        company_id: opts.cid, report_id: reportId, decision_id: a.decision_id || null,
        action_title: actionTitle, action_description: a.action_description ? _interpolate(a.action_description, ctx) : null,
        owner_team_member_id: a.owner_team_member_id || null, priority: a.priority || 'medium', due_date: a.due_date || null,
        notes: a.notes ? _interpolate(a.notes, ctx) : null,
        created_by: opts.userId, updated_by: opts.userId,
    }).select().single();
    if (error) return { status: 'failed', error: `Failed to create executive action: ${error.message}` };
    return { status: 'completed', output: { executive_action_id: data.id, report_id: reportId } };
}

// Never mutates a source record — writes only an automation event (recorded
// by the run's own event-writing pass, see _writeRunEvent below).
async function _actionAddNoteEvent(a, ctx, opts) {
    const notes = _interpolate(a.notes || '', ctx);
    if (opts.dryRun) return { status: 'passed', output: { would_record_note: notes } };
    return { status: 'completed', output: { recorded_note: notes } };
}

// Records a flag (automation event) and, only if explicitly configured,
// also raises a notification via the same code path as create_notification
// — never a second notification-creation implementation.
async function _actionFlagForReview(a, ctx, opts) {
    const notes = a.notes ? _interpolate(a.notes, ctx) : null;
    if (!a.notify) {
        if (opts.dryRun) return { status: 'passed', output: { would_flag: true, would_notify: false } };
        return { status: 'completed', output: { flagged: true, notified: false, notes } };
    }
    const notifyResult = await _actionCreateNotification(a.notification, ctx, opts);
    return {
        status: notifyResult.status === 'failed' ? 'warning' : notifyResult.status,
        output: Object.assign({ flagged: true, notified: notifyResult.status !== 'failed', notes }, notifyResult.output || {}),
        error: notifyResult.error || null,
    };
}

async function _executeAction(a, ctx, opts) {
    switch (a.type) {
        case 'create_notification': return _actionCreateNotification(a, ctx, opts);
        case 'create_reminder': return _actionCreateReminder(a, ctx, opts);
        case 'create_executive_action': return _actionCreateExecutiveAction(a, ctx, opts);
        case 'add_note_event': return _actionAddNoteEvent(a, ctx, opts);
        case 'flag_for_review': return _actionFlagForReview(a, ctx, opts);
        default: return { status: 'failed', error: `"${a.type}" is not a supported automation action.` };
    }
}

// ── Idempotency ───────────────────────────────────────────────────────────────
// Dry-runs never consume idempotency (spec, verbatim). A completed live run
// with the same key blocks a duplicate live execution for the same trigger
// occurrence — never a duplicate notification/reminder/action.

function _renderIdempotencyKey(rule, cid, triggerType, sourceType, sourceId) {
    const tpl = rule.idempotency_key_template;
    const parts = { company_id: cid, rule_id: rule.id, trigger_type: triggerType, source_type: sourceType || 'none', source_id: sourceId || 'none' };
    if (tpl) return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in parts ? String(parts[k]) : `{${k}}`));
    return `${parts.company_id}:${parts.rule_id}:${parts.trigger_type}:${parts.source_type}:${parts.source_id}`;
}

async function _findCompletedRunByKey(cid, key) {
    if (!key) return null;
    const { data } = await supabase.from('practice_automation_runs')
        .select('id, completed_at').eq('company_id', cid).eq('idempotency_key', key).eq('dry_run', false)
        .in('run_status', ['completed', 'completed_with_warnings']).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data || null;
}

// ── Run / Step / Event persistence helpers ────────────────────────────────────

async function _insertStep(cid, runId, order, type, name, status, input, output, errorMessage) {
    await supabase.from('practice_automation_run_steps').insert({
        company_id: cid, run_id: runId, step_order: order, step_type: type, step_name: name,
        step_status: status, input: input || {}, output: output || {}, error_message: errorMessage || null,
    });
}

async function _writeRunEvent(cid, ruleId, runId, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_automation_events').insert({
        company_id: cid, rule_id: ruleId || null, run_id: runId || null, event_type: eventType,
        old_status: oldStatus || null, new_status: newStatus || null, actor_user_id: userId || null,
        notes: notes || null, metadata: meta || {},
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTOMATION ENGINE — evaluateAutomationRule()
// No AI. No dynamic code execution. No eval. No arbitrary JavaScript.
// ═══════════════════════════════════════════════════════════════════════════

async function evaluateAutomationRule(cid, rule, triggerContext, opts) {
    const dryRun = !!opts.dryRun;
    const userId = opts.userId || null;
    const triggerSourceType = opts.triggerSourceType || null;
    const triggerSourceId = opts.triggerSourceId || null;

    const ctx = {
        source: (triggerContext && triggerContext.source) || {},
        rule: { id: rule.id, rule_key: rule.rule_key, rule_name: rule.rule_name, safety_level: rule.safety_level },
        context: (triggerContext && triggerContext.context) || {},
        company: { id: cid },
        user: { id: userId },
    };

    const { data: run, error: runInsertError } = await supabase.from('practice_automation_runs').insert({
        company_id: cid, rule_id: rule.id, run_status: dryRun ? 'dry_run' : 'running',
        trigger_type: rule.trigger_type, trigger_source_type: triggerSourceType, trigger_source_id: triggerSourceId,
        dry_run: dryRun, input_snapshot: { trigger_context: triggerContext || {} }, created_by: userId,
    }).select().single();
    if (runInsertError) throw new Error(`Failed to create automation run: ${runInsertError.message}`);

    await _writeRunEvent(cid, rule.id, run.id, 'run_started', null, run.run_status, userId, null, { dry_run: dryRun });

    let order = 0;
    const warnings = [];
    const errors = [];
    const actionResults = [];
    let finalStatus;
    let stopSummary = null;

    try {
        // Safety check: a live run requires the rule to be active; a dry
        // run (test) is always allowed regardless of status, so a draft
        // rule can be validated before ever being turned on.
        order++;
        if (!dryRun && rule.rule_status !== 'active') {
            await _insertStep(cid, run.id, order, 'safety_check', 'Rule must be active for a live run', 'failed', { rule_status: rule.rule_status }, {}, `Rule is "${rule.rule_status}", not "active".`);
            finalStatus = 'failed';
            stopSummary = `Rule must be active to run live. Current status: "${rule.rule_status}".`;
            errors.push(stopSummary);
            throw new _StopRun();
        }
        await _insertStep(cid, run.id, order, 'safety_check', 'Rule status check', 'passed', { rule_status: rule.rule_status }, {});

        // Defense in depth: re-validate actions at run time even though
        // activation already required this.
        order++;
        const actionValidation = validateActions(rule.actions || []);
        if (!actionValidation.valid) {
            await _insertStep(cid, run.id, order, 'safety_check', 'Action validity check', 'failed', { actions: rule.actions }, { errors: actionValidation.errors });
            finalStatus = 'failed';
            stopSummary = 'Rule has invalid/unsupported actions.';
            errors.push(...actionValidation.errors);
            throw new _StopRun();
        }
        await _insertStep(cid, run.id, order, 'safety_check', 'Action validity check', 'passed', {}, {});

        // Idempotency (skip entirely for dry runs, per spec).
        let idempotencyKey = null;
        order++;
        if (!dryRun) {
            idempotencyKey = _renderIdempotencyKey(rule, cid, rule.trigger_type, triggerSourceType, triggerSourceId);
            const existing = await _findCompletedRunByKey(cid, idempotencyKey);
            if (existing) {
                await _insertStep(cid, run.id, order, 'idempotency_check', 'Idempotency check', 'skipped', { idempotency_key: idempotencyKey }, { duplicate_of_run_id: existing.id });
                finalStatus = 'skipped';
                await supabase.from('practice_automation_runs').update({
                    run_status: 'skipped', completed_at: new Date().toISOString(), idempotency_key: idempotencyKey,
                    result_summary: `Skipped — already completed as run #${existing.id}.`,
                }).eq('id', run.id).eq('company_id', cid);
                await _writeRunEvent(cid, rule.id, run.id, 'run_completed', run.run_status, 'skipped', userId, 'Idempotent duplicate skipped.', { duplicate_of_run_id: existing.id });
                return { run: Object.assign({}, run, { run_status: 'skipped' }), steps: null, warnings: [], errors: [], skipped: true, duplicate_of_run_id: existing.id };
            }
            await _insertStep(cid, run.id, order, 'idempotency_check', 'Idempotency check', 'passed', { idempotency_key: idempotencyKey }, {});
        } else {
            await _insertStep(cid, run.id, order, 'idempotency_check', 'Idempotency check', 'skipped', {}, { note: 'Dry runs do not consume idempotency.' });
        }

        // Conditions — AND semantics, one step per condition for full
        // inspectability. Sequential for...of (not forEach) so every insert
        // is properly awaited and step_order stays deterministic.
        const conditionEval = evaluateConditions(rule.conditions || [], ctx);
        for (const r of conditionEval.results) {
            order++;
            await _insertStep(cid, run.id, order, 'condition', `${r.field} ${r.operator} ${JSON.stringify(r.value)}`, r.passed ? 'passed' : 'failed', { field: r.field, operator: r.operator, value: r.value }, { actual: r.actual });
        }

        if (!conditionEval.passed) {
            order++;
            await _insertStep(cid, run.id, order, 'output', 'Conditions not met', 'skipped', {}, { conditions: conditionEval.results });
            finalStatus = 'skipped';
            stopSummary = 'Conditions not met — no actions were run.';
            throw new _StopRun();
        }

        // Actions — executed (or simulated, if dryRun) in declared order.
        for (const a of (rule.actions || [])) {
            order++;
            const actionOpts = { cid, ruleId: rule.id, runId: run.id, dryRun, userId };
            let result;
            try {
                result = await _executeAction(a, ctx, actionOpts);
            } catch (e) {
                result = { status: 'failed', error: e.message };
            }
            actionResults.push(Object.assign({ type: a.type }, result));
            const stepStatus = result.status === 'failed' ? 'failed' : (result.status === 'warning' ? 'warning' : (dryRun ? 'passed' : 'completed'));
            await _insertStep(cid, run.id, order, 'action', a.type, stepStatus, _pickActionInput(a), result.output || {}, result.error || null);
            if (result.status === 'failed') { errors.push(`${a.type}: ${result.error || 'failed'}`); await _writeRunEvent(cid, rule.id, run.id, 'action_skipped', null, null, userId, result.error || null, { action_type: a.type }); }
            else if (result.status === 'warning') { warnings.push(`${a.type}: ${JSON.stringify(result.output)}`); await _writeRunEvent(cid, rule.id, run.id, 'action_executed', null, null, userId, null, { action_type: a.type, warning: true }); }
            else { await _writeRunEvent(cid, rule.id, run.id, 'action_executed', null, null, userId, null, { action_type: a.type, dry_run: dryRun }); }
        }

        order++;
        await _insertStep(cid, run.id, order, 'output', 'Run summary', 'completed', {}, { actions_run: actionResults.length, warnings: warnings.length, errors: errors.length });

        if (dryRun) {
            finalStatus = errors.length ? 'failed' : 'dry_run';
        } else if (errors.length && actionResults.every(r => r.status === 'failed')) {
            finalStatus = 'failed';
        } else if (errors.length || warnings.length) {
            finalStatus = 'completed_with_warnings';
        } else {
            finalStatus = 'completed';
        }

        const now = new Date().toISOString();
        const idempotencyToStore = (!dryRun && ['completed', 'completed_with_warnings'].includes(finalStatus)) ? _renderIdempotencyKey(rule, cid, rule.trigger_type, triggerSourceType, triggerSourceId) : null;

        await supabase.from('practice_automation_runs').update({
            run_status: finalStatus, completed_at: now, warnings, errors,
            output_snapshot: { actions: actionResults }, idempotency_key: idempotencyToStore,
            result_summary: `${actionResults.length} action(s), ${warnings.length} warning(s), ${errors.length} error(s).`,
        }).eq('id', run.id).eq('company_id', cid);

        if (!dryRun && ['completed', 'completed_with_warnings'].includes(finalStatus)) {
            await supabase.from('practice_automation_rules').update({ last_run_at: now }).eq('id', rule.id).eq('company_id', cid);
        }

        await _writeRunEvent(cid, rule.id, run.id, dryRun ? 'dry_run_completed' : (finalStatus === 'failed' ? 'run_failed' : 'run_completed'), run.run_status, finalStatus, userId, null, { warnings: warnings.length, errors: errors.length });

        return { run: Object.assign({}, run, { run_status: finalStatus }), warnings, errors, action_results: actionResults };
    } catch (e) {
        if (!(e instanceof _StopRun)) { errors.push(e.message); finalStatus = 'failed'; stopSummary = e.message; }
        const now = new Date().toISOString();
        await supabase.from('practice_automation_runs').update({
            run_status: finalStatus || 'failed', completed_at: now, warnings, errors,
            result_summary: stopSummary || errors[0] || 'Run stopped.',
        }).eq('id', run.id).eq('company_id', cid);
        await _writeRunEvent(cid, rule.id, run.id, dryRun ? 'dry_run_completed' : 'run_failed', run.run_status, finalStatus || 'failed', userId, errors[0] || null, {});
        return { run: Object.assign({}, run, { run_status: finalStatus || 'failed' }), warnings, errors, action_results: actionResults };
    }
}

// Sentinel used to unwind the try block early without treating a deliberate
// stop (safety/idempotency/conditions) as an unexpected error.
class _StopRun extends Error {}

function _pickActionInput(a) {
    const { type, ...rest } = a;
    return { type, config: rest };
}

// ── CRUD Helpers ──────────────────────────────────────────────────────────────

async function _requireManager(req, res) {
    return teamAccess.requireManager(req, res, supabase, 'Only owners, partners, admins, and practice managers can manage automation.');
}

function _pick(obj, keys) {
    const out = {};
    keys.forEach(k => { if (k in obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function _verifyRule(id, cid) {
    const { data } = await supabase.from('practice_automation_rules').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    return data || null;
}

async function _writeRuleEvent(cid, ruleId, eventType, oldStatus, newStatus, userId, notes, meta) {
    await supabase.from('practice_automation_events').insert({
        company_id: cid, rule_id: ruleId, run_id: null, event_type: eventType,
        old_status: oldStatus || null, new_status: newStatus || null, actor_user_id: userId || null,
        notes: notes || null, metadata: meta || {},
    });
}

// ── Routes: Summary (dashboard integration) ────────────────────────────────────

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const [{ count: activeRules }, { count: awaitingApproval }, { data: failedRuns }, { data: warningRuns }] = await Promise.all([
            supabase.from('practice_automation_rules').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('rule_status', 'active'),
            supabase.from('practice_automation_rules').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('requires_approval', true).is('approved_at', null).not('rule_status', 'in', '("archived","cancelled")'),
            supabase.from('practice_automation_runs').select('id').eq('company_id', cid).eq('run_status', 'failed').eq('dry_run', false).order('created_at', { ascending: false }).limit(20),
            supabase.from('practice_automation_runs').select('id').eq('company_id', cid).eq('run_status', 'completed_with_warnings').order('created_at', { ascending: false }).limit(20),
        ]);
        return res.json({
            active_rules: activeRules || 0,
            rules_awaiting_approval: awaitingApproval || 0,
            failed_runs: (failedRuns || []).length,
            runs_with_warnings: (warningRuns || []).length,
        });
    } catch (err) {
        console.error('GET /api/practice/automation/summary', err);
        return res.status(500).json({ error: 'Failed to load automation summary.' });
    }
});

// ── Routes: Catalogue ─────────────────────────────────────────────────────────

router.get('/catalogue', (req, res) => {
    res.json({
        triggers: TRIGGER_TYPES,
        rule_categories: RULE_CATEGORIES,
        safety_levels: SAFETY_LEVELS,
        actions: SUPPORTED_ACTIONS,
        forbidden_actions: EXPLICITLY_FORBIDDEN_ACTIONS,
        condition_operators: CONDITION_OPERATORS,
        condition_field_roots: ALLOWED_FIELD_ROOTS,
    });
});

// ── Routes: Rules CRUD ────────────────────────────────────────────────────────

router.get('/rules', async (req, res) => {
    const cid = req.companyId;
    const { rule_status, rule_category, trigger_type, page = 1, limit = 50 } = req.query;
    try {
        if (rule_status && !RULE_STATUSES.includes(rule_status)) return res.status(400).json({ error: `Invalid rule_status. Allowed: ${RULE_STATUSES.join(', ')}` });
        if (rule_category && !RULE_CATEGORIES.includes(rule_category)) return res.status(400).json({ error: `Invalid rule_category. Allowed: ${RULE_CATEGORIES.join(', ')}` });

        let q = supabase.from('practice_automation_rules').select('*', { count: 'exact' }).eq('company_id', cid);
        if (rule_status) q = q.eq('rule_status', rule_status);
        if (rule_category) q = q.eq('rule_category', rule_category);
        if (trigger_type) q = q.eq('trigger_type', trigger_type);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        q = q.order('created_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ rules: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/automation/rules', err);
        return res.status(500).json({ error: 'Failed to load automation rules.' });
    }
});

router.post('/rules', async (req, res) => {
    const cid = req.companyId;
    const { rule_name, rule_key, trigger_type, rule_category, description, conditions, actions, safety_level, requires_approval, idempotency_key_template } = req.body || {};

    if (!rule_name || !String(rule_name).trim()) return res.status(400).json({ error: 'rule_name is required.' });
    if (!rule_key || !String(rule_key).trim()) return res.status(400).json({ error: 'rule_key is required.' });
    if (!TRIGGER_TYPES.includes(trigger_type)) return res.status(400).json({ error: `trigger_type must be one of: ${TRIGGER_TYPES.join(', ')}` });
    if (!RULE_CATEGORIES.includes(rule_category)) return res.status(400).json({ error: `rule_category must be one of: ${RULE_CATEGORIES.join(', ')}` });
    if (safety_level && !SAFETY_LEVELS.includes(safety_level)) return res.status(400).json({ error: `safety_level must be one of: ${SAFETY_LEVELS.join(', ')}` });

    const conditionCheck = validateConditions(conditions || []);
    if (!conditionCheck.valid) return res.status(400).json({ error: 'Invalid conditions.', details: conditionCheck.errors });
    const actionCheck = validateActions(actions || []);
    if (!actionCheck.valid) return res.status(400).json({ error: 'Invalid actions.', details: actionCheck.errors });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const resolvedSafety = safety_level || 'low';
        const { data: rule, error } = await supabase.from('practice_automation_rules').insert({
            company_id: cid, rule_name: String(rule_name).trim(), rule_key: String(rule_key).trim(),
            rule_status: 'draft', trigger_type, rule_category, description: description || null,
            conditions: conditions || [], actions: actions || [],
            safety_level: resolvedSafety,
            requires_approval: requires_approval === true || HIGH_RISK_SAFETY_LEVELS.includes(resolvedSafety),
            idempotency_key_template: idempotency_key_template || null,
            created_by: req.user?.userId || null, updated_by: req.user?.userId || null,
        }).select().single();
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: `A rule with key "${rule_key}" already exists for this company.` });
            throw error;
        }

        await _writeRuleEvent(cid, rule.id, 'rule_created', null, 'draft', req.user?.userId, null, {});
        await auditFromReq(req, 'automation_rule_created', 'practice_automation_rule', rule.id, {});

        return res.status(201).json({ rule });
    } catch (err) {
        console.error('POST /api/practice/automation/rules', err);
        return res.status(500).json({ error: 'Failed to create automation rule.' });
    }
});

router.get('/rules/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        return res.json({ rule });
    } catch (err) {
        console.error('GET /api/practice/automation/rules/:id', err);
        return res.status(500).json({ error: 'Failed to load automation rule.' });
    }
});

router.put('/rules/:id', async (req, res) => {
    const cid = req.companyId;
    const EDITABLE_ALWAYS = ['rule_name', 'description', 'next_review_date', 'settings'];
    const EDITABLE_CONFIG = ['conditions', 'actions', 'safety_level', 'requires_approval', 'idempotency_key_template'];
    const body = req.body || {};

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });

        const patch = _pick(body, EDITABLE_ALWAYS);
        const configPatch = _pick(body, EDITABLE_CONFIG);
        if (Object.keys(configPatch).length) {
            if (!EDITABLE_RULE_STATUSES.includes(rule.rule_status)) {
                return res.status(422).json({ error: `Conditions/actions/safety_level can only be changed while the rule is draft, paused, or disabled. Current: "${rule.rule_status}".` });
            }
            if ('conditions' in configPatch) {
                const check = validateConditions(configPatch.conditions);
                if (!check.valid) return res.status(400).json({ error: 'Invalid conditions.', details: check.errors });
            }
            if ('actions' in configPatch) {
                const check = validateActions(configPatch.actions);
                if (!check.valid) return res.status(400).json({ error: 'Invalid actions.', details: check.errors });
            }
            if ('safety_level' in configPatch && !SAFETY_LEVELS.includes(configPatch.safety_level)) {
                return res.status(400).json({ error: `safety_level must be one of: ${SAFETY_LEVELS.join(', ')}` });
            }
            Object.assign(patch, configPatch);
        }

        if (!Object.keys(patch).length) return res.status(400).json({ error: 'No editable fields provided.' });

        const { data: updated, error } = await supabase.from('practice_automation_rules').update({ ...patch, updated_by: req.user?.userId }).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeRuleEvent(cid, rule.id, 'rule_updated', null, null, req.user?.userId, null, { fields: Object.keys(patch) });
        await auditFromReq(req, 'automation_rule_updated', 'practice_automation_rule', rule.id, { fields: Object.keys(patch) });

        return res.json({ rule: updated });
    } catch (err) {
        console.error('PUT /api/practice/automation/rules/:id', err);
        return res.status(500).json({ error: 'Failed to update automation rule.' });
    }
});

router.delete('/rules/:id', async (req, res) => {
    const cid = req.companyId;
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason is required to cancel an automation rule.' });

    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        if (TERMINAL_RULE_STATUSES.includes(rule.rule_status)) return res.status(422).json({ error: `Rule is already ${rule.rule_status}.` });

        const { data: updated, error } = await supabase.from('practice_automation_rules').update({ rule_status: 'cancelled', cancellation_reason: String(reason).trim(), updated_by: req.user?.userId }).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeRuleEvent(cid, rule.id, 'rule_cancelled', rule.rule_status, 'cancelled', req.user?.userId, String(reason).trim(), {});
        await auditFromReq(req, 'automation_rule_cancelled', 'practice_automation_rule', rule.id, {});

        return res.json({ rule: updated });
    } catch (err) {
        console.error('DELETE /api/practice/automation/rules/:id', err);
        return res.status(500).json({ error: 'Failed to cancel automation rule.' });
    }
});

// ── Routes: Rule workflow (approve/activate/pause/disable/archive) ─────────────

router.put('/rules/:id/approve', async (req, res) => {
    const cid = req.companyId;
    const { approval_notes } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        if (TERMINAL_RULE_STATUSES.includes(rule.rule_status)) return res.status(422).json({ error: `Cannot approve a rule that is already ${rule.rule_status}.` });

        const now = new Date().toISOString();
        const { data: updated, error } = await supabase.from('practice_automation_rules').update({
            approved_by: req.user?.userId || null, approved_at: now, approval_notes: approval_notes || null, updated_by: req.user?.userId,
        }).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeRuleEvent(cid, rule.id, 'rule_approved', null, null, req.user?.userId, approval_notes || null, {});
        await auditFromReq(req, 'automation_rule_approved', 'practice_automation_rule', rule.id, {});

        return res.json({ rule: updated });
    } catch (err) {
        console.error('PUT /api/practice/automation/rules/:id/approve', err);
        return res.status(500).json({ error: 'Failed to approve automation rule.' });
    }
});

router.put('/rules/:id/activate', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        if (!['draft', 'paused', 'disabled'].includes(rule.rule_status)) return res.status(422).json({ error: `Rule must be draft, paused, or disabled to activate. Current: "${rule.rule_status}".` });

        const conditionCheck = validateConditions(rule.conditions || []);
        if (!conditionCheck.valid) return res.status(422).json({ error: 'Rule has invalid conditions and cannot be activated.', details: conditionCheck.errors });
        const actionCheck = validateActions(rule.actions || []);
        if (!actionCheck.valid) return res.status(422).json({ error: 'Rule has unsupported/invalid actions and cannot be activated.', details: actionCheck.errors });

        if (rule.requires_approval && !rule.approved_at) {
            return res.status(422).json({ error: 'This rule requires approval before it can be activated.' });
        }

        const { data: updated, error } = await supabase.from('practice_automation_rules').update({ rule_status: 'active', updated_by: req.user?.userId }).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeRuleEvent(cid, rule.id, 'rule_activated', rule.rule_status, 'active', req.user?.userId, null, {});
        await auditFromReq(req, 'automation_rule_activated', 'practice_automation_rule', rule.id, {});

        return res.json({ rule: updated });
    } catch (err) {
        console.error('PUT /api/practice/automation/rules/:id/activate', err);
        return res.status(500).json({ error: 'Failed to activate automation rule.' });
    }
});

router.put('/rules/:id/pause', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        if (rule.rule_status !== 'active') return res.status(422).json({ error: `Rule must be active to pause. Current: "${rule.rule_status}".` });

        const { data: updated, error } = await supabase.from('practice_automation_rules').update({ rule_status: 'paused', updated_by: req.user?.userId }).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeRuleEvent(cid, rule.id, 'rule_paused', 'active', 'paused', req.user?.userId, null, {});
        await auditFromReq(req, 'automation_rule_paused', 'practice_automation_rule', rule.id, {});

        return res.json({ rule: updated });
    } catch (err) {
        console.error('PUT /api/practice/automation/rules/:id/pause', err);
        return res.status(500).json({ error: 'Failed to pause automation rule.' });
    }
});

router.put('/rules/:id/disable', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        if (TERMINAL_RULE_STATUSES.includes(rule.rule_status)) return res.status(422).json({ error: `Rule is already ${rule.rule_status}.` });

        const { data: updated, error } = await supabase.from('practice_automation_rules').update({ rule_status: 'disabled', updated_by: req.user?.userId }).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeRuleEvent(cid, rule.id, 'rule_disabled', rule.rule_status, 'disabled', req.user?.userId, null, {});
        await auditFromReq(req, 'automation_rule_disabled', 'practice_automation_rule', rule.id, {});

        return res.json({ rule: updated });
    } catch (err) {
        console.error('PUT /api/practice/automation/rules/:id/disable', err);
        return res.status(500).json({ error: 'Failed to disable automation rule.' });
    }
});

router.put('/rules/:id/archive', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        if (!['paused', 'disabled'].includes(rule.rule_status)) return res.status(422).json({ error: `Rule must be paused or disabled to archive. Current: "${rule.rule_status}".` });

        const { data: updated, error } = await supabase.from('practice_automation_rules').update({ rule_status: 'archived', updated_by: req.user?.userId }).eq('id', rule.id).eq('company_id', cid).select().single();
        if (error) throw error;

        await _writeRuleEvent(cid, rule.id, 'rule_archived', rule.rule_status, 'archived', req.user?.userId, null, {});
        await auditFromReq(req, 'automation_rule_archived', 'practice_automation_rule', rule.id, {});

        return res.json({ rule: updated });
    } catch (err) {
        console.error('PUT /api/practice/automation/rules/:id/archive', err);
        return res.status(500).json({ error: 'Failed to archive automation rule.' });
    }
});

// ── Routes: Execution (test / run) ──────────────────────────────────────────

router.post('/rules/:id/test', async (req, res) => {
    const cid = req.companyId;
    const { trigger_context, trigger_source_type, trigger_source_id } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });

        const result = await evaluateAutomationRule(cid, rule, trigger_context || {}, {
            dryRun: true, userId: req.user?.userId, triggerSourceType: trigger_source_type, triggerSourceId: trigger_source_id,
        });
        return res.json(result);
    } catch (err) {
        console.error('POST /api/practice/automation/rules/:id/test', err);
        return res.status(500).json({ error: 'Failed to test-run automation rule.' });
    }
});

router.post('/rules/:id/run', async (req, res) => {
    const cid = req.companyId;
    const { trigger_context, trigger_source_type, trigger_source_id } = req.body || {};
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        if (rule.rule_status !== 'active') return res.status(422).json({ error: `Rule must be active to run live. Current: "${rule.rule_status}".` });
        if (rule.requires_approval && !rule.approved_at) return res.status(422).json({ error: 'This rule requires approval before it can run live.' });

        const result = await evaluateAutomationRule(cid, rule, trigger_context || {}, {
            dryRun: false, userId: req.user?.userId, triggerSourceType: trigger_source_type, triggerSourceId: trigger_source_id,
        });
        return res.json(result);
    } catch (err) {
        console.error('POST /api/practice/automation/rules/:id/run', err);
        return res.status(500).json({ error: 'Failed to run automation rule.' });
    }
});

// ── Routes: Runs ──────────────────────────────────────────────────────────────

router.get('/runs', async (req, res) => {
    const cid = req.companyId;
    const { rule_id, run_status, trigger_type, page = 1, limit = 50 } = req.query;
    try {
        if (run_status && !RUN_STATUSES.includes(run_status)) return res.status(400).json({ error: `Invalid run_status. Allowed: ${RUN_STATUSES.join(', ')}` });

        let q = supabase.from('practice_automation_runs').select('*', { count: 'exact' }).eq('company_id', cid);
        if (rule_id) q = q.eq('rule_id', parseInt(rule_id, 10));
        if (run_status) q = q.eq('run_status', run_status);
        if (trigger_type) q = q.eq('trigger_type', trigger_type);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        q = q.order('created_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ runs: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/automation/runs', err);
        return res.status(500).json({ error: 'Failed to load automation runs.' });
    }
});

router.get('/runs/:id', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data, error } = await supabase.from('practice_automation_runs').select('*').eq('id', req.params.id).eq('company_id', cid).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Automation run not found.' });
        return res.json({ run: data });
    } catch (err) {
        console.error('GET /api/practice/automation/runs/:id', err);
        return res.status(500).json({ error: 'Failed to load automation run.' });
    }
});

router.get('/runs/:id/steps', async (req, res) => {
    const cid = req.companyId;
    try {
        const { data: run } = await supabase.from('practice_automation_runs').select('id').eq('id', req.params.id).eq('company_id', cid).maybeSingle();
        if (!run) return res.status(404).json({ error: 'Automation run not found.' });
        const { data, error } = await supabase.from('practice_automation_run_steps').select('*').eq('run_id', run.id).eq('company_id', cid).order('step_order');
        if (error) throw error;
        return res.json({ steps: data || [] });
    } catch (err) {
        console.error('GET /api/practice/automation/runs/:id/steps', err);
        return res.status(500).json({ error: 'Failed to load run steps.' });
    }
});

// ── Routes: Events ────────────────────────────────────────────────────────────

router.get('/events', async (req, res) => {
    const cid = req.companyId;
    const { rule_id, run_id, event_type, page = 1, limit = 50 } = req.query;
    try {
        let q = supabase.from('practice_automation_events').select('*', { count: 'exact' }).eq('company_id', cid);
        if (rule_id) q = q.eq('rule_id', parseInt(rule_id, 10));
        if (run_id) q = q.eq('run_id', parseInt(run_id, 10));
        if (event_type) q = q.eq('event_type', event_type);

        const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        q = q.order('created_at', { ascending: false }).range((p - 1) * l, (p - 1) * l + l - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return res.json({ events: data || [], total: count || 0, page: p, limit: l });
    } catch (err) {
        console.error('GET /api/practice/automation/events', err);
        return res.status(500).json({ error: 'Failed to load automation events.' });
    }
});

router.get('/rules/:id/events', async (req, res) => {
    const cid = req.companyId;
    try {
        const rule = await _verifyRule(req.params.id, cid);
        if (!rule) return res.status(404).json({ error: 'Automation rule not found.' });
        const { data, error } = await supabase.from('practice_automation_events').select('*').eq('rule_id', rule.id).eq('company_id', cid).order('created_at', { ascending: false });
        if (error) throw error;
        return res.json({ events: data || [] });
    } catch (err) {
        console.error('GET /api/practice/automation/rules/:id/events', err);
        return res.status(500).json({ error: 'Failed to load rule events.' });
    }
});

// ── Seed defaults ─────────────────────────────────────────────────────────────
// Four SAFE draft example rules, never auto-activated, matching the same
// idempotent "insert if missing by key" seeding pattern used by
// alert-rules.js / skills-matrix.js.

const SEED_RULES = [
    {
        rule_key: 'seed_executive_report_published_notify_partners',
        rule_name: 'Executive report published — notify responsible partners',
        trigger_type: 'executive_report_published', rule_category: 'executive',
        description: 'When an executive report is published, notify the practice owner/partners that a new board pack is available.',
        conditions: [{ field: 'source.report_status', operator: 'equals', value: 'published' }],
        actions: [{ type: 'create_notification', category: 'system', severity: 'medium', title: 'Executive report published: {{source.report_title}}', message: 'A new executive report is ready for review.', sourceType: 'practice_executive_report', assignment: { role: 'partner' } }],
        safety_level: 'low',
    },
    {
        rule_key: 'seed_pricing_review_approved_confirm_implementation',
        rule_name: 'Pricing review approved — confirm implementation plan',
        trigger_type: 'pricing_review_approved', rule_category: 'pricing',
        description: 'When a pricing review is approved, create an executive action to confirm the implementation plan with the client.',
        conditions: [{ field: 'source.pricing_status', operator: 'equals', value: 'approved' }],
        actions: [{ type: 'create_executive_action', action_title: 'Confirm implementation plan for approved pricing review', report_id_field: 'context.report_id', priority: 'medium' }],
        safety_level: 'medium', requires_approval: true,
    },
    {
        rule_key: 'seed_secretarial_integrity_critical_notify_manager',
        rule_name: 'Secretarial integrity critical finding — notify manager',
        trigger_type: 'secretarial_integrity_critical', rule_category: 'secretarial',
        description: 'When a critical secretarial integrity finding is recorded, notify the responsible manager immediately.',
        conditions: [{ field: 'source.severity', operator: 'equals', value: 'critical' }],
        actions: [{ type: 'create_notification', category: 'compliance', severity: 'critical', title: 'Critical secretarial integrity finding', message: '{{source.finding_title}}', sourceType: 'practice_secretarial_integrity_finding', assignment: { role: 'partner' } }],
        safety_level: 'high', requires_approval: true,
    },
    {
        rule_key: 'seed_onboarding_completed_notify_partner',
        rule_name: 'Client onboarding completed — notify assigned partner',
        trigger_type: 'onboarding_completed', rule_category: 'onboarding',
        description: 'When a client onboarding workspace is marked completed, notify the assigned partner so they can plan the first engagement cycle.',
        conditions: [{ field: 'source.onboarding_status', operator: 'equals', value: 'completed' }],
        actions: [{ type: 'create_notification', category: 'client', severity: 'info', title: 'Client onboarding completed', message: 'Onboarding for {{source.client_name}} is complete.', sourceType: 'practice_onboarding_profile', assignment: { role: 'partner' } }],
        safety_level: 'low',
    },
];

router.post('/seed-defaults', async (req, res) => {
    const cid = req.companyId;
    try {
        const manager = await _requireManager(req, res);
        if (!manager) return;

        const { data: existing } = await supabase.from('practice_automation_rules').select('rule_key').eq('company_id', cid);
        const existingKeys = new Set((existing || []).map(r => r.rule_key));
        const toInsert = SEED_RULES.filter(r => !existingKeys.has(r.rule_key)).map(r => ({
            company_id: cid, rule_name: r.rule_name, rule_key: r.rule_key, rule_status: 'draft',
            trigger_type: r.trigger_type, rule_category: r.rule_category, description: r.description,
            conditions: r.conditions, actions: r.actions, safety_level: r.safety_level,
            requires_approval: r.requires_approval === true || HIGH_RISK_SAFETY_LEVELS.includes(r.safety_level),
            created_by: req.user?.userId || null, updated_by: req.user?.userId || null,
        }));

        if (!toInsert.length) return res.json({ inserted: 0, message: 'All seed rules already exist for this company.' });

        const { data: inserted, error } = await supabase.from('practice_automation_rules').insert(toInsert).select('id, rule_key, rule_name');
        if (error) throw error;

        for (const r of inserted || []) {
            await _writeRuleEvent(cid, r.id, 'rule_created', null, 'draft', req.user?.userId, 'Seeded default rule.', { seeded: true });
        }
        await auditFromReq(req, 'automation_rules_seeded', 'practice_automation_rule', null, { inserted_count: (inserted || []).length });

        return res.status(201).json({ inserted: (inserted || []).length, rules: inserted || [] });
    } catch (err) {
        console.error('POST /api/practice/automation/seed-defaults', err);
        return res.status(500).json({ error: 'Failed to seed default automation rules.' });
    }
});

module.exports = router;
module.exports.evaluateAutomationRule = evaluateAutomationRule;
module.exports.validateConditions = validateConditions;
module.exports.validateActions = validateActions;
