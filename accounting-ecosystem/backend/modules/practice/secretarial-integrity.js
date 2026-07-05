'use strict';

// Codebox 69 — Secretarial Register Integrity Audit + Statutory Data Quality Review
// "Is this entity actually ready?" before "Can we submit?"
//
// NOT data correction. NOT automatic repair. NOT CIPC validation. NOT legal
// advice. This module only detects, classifies, and reports issues across
// the Secretarial suite (Registers, Workflows, Governance, Beneficial
// Ownership, Evidence, Statutory Calendar, Entity Lifecycle) — it never
// writes to any table outside its own three (runs/findings/events).
// Managers decide how to resolve findings.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticateToken, requireCompany } = require('../../middleware/auth');
const secretarialCalendar = require('./secretarial-calendar');
const beneficialOwnership = require('./beneficial-ownership');
const secretarialEvidence = require('./secretarial-evidence');
const teamAccess = require('./lib/team-access');

const router = express.Router();
router.use(authenticateToken);
router.use(requireCompany);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Constants ─────────────────────────────────────────────────────────────────

const RUN_TYPES = ['manual', 'scheduled', 'pre_filing', 'pre_review', 'full_scan'];
const FINDING_CATEGORIES = ['register', 'director', 'shareholder', 'beneficial_owner', 'governance', 'evidence', 'calendar', 'lifecycle', 'annual_return', 'general'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const FINDING_STATUSES = ['open', 'acknowledged', 'resolved', 'accepted_risk', 'ignored'];

const SEVERITY_WEIGHTS = { critical: 15, high: 7, medium: 3, low: 1, info: 0 };
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

// Deterministic, developer-chosen subsets — not from the spec's literal text,
// documented as Architect Freedom in docs/new-app/69_secretarial_integrity.md.
// A statutory change of these types normally needs a supporting board/
// shareholder decision — used only to flag a MISSING governance record, never
// to block or auto-create one.
const GOVERNANCE_REQUIRED_CHANGE_TYPES = ['director_appointment', 'director_resignation', 'share_transfer', 'share_issue', 'share_cancellation', 'company_status_change'];
// A statutory change of these types normally needs supporting evidence — used
// only to flag a MISSING evidence checklist, never to generate one.
const EVIDENCE_EXPECTED_CHANGE_TYPES = ['director_appointment', 'director_resignation', 'share_transfer', 'company_secretary_change', 'auditor_change', 'company_status_change'];
// Director/shareholder registers are only meaningfully "empty" for entity
// types that actually have directors/shareholders in the CIPC sense.
const DIRECTOR_SHAREHOLDER_SCOPED_TYPES = ['pty_ltd', 'cc'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function today() { return new Date().toISOString().split('T')[0]; }

async function _myTeamMember(cid, user) {
    return teamAccess.getMyTeamMember(supabase, cid, user);
}
function _isManager(member) { return teamAccess.isManager(member); }

async function _requireManager(req, res) {
    return teamAccess.requireManager(req, res, supabase, 'Only owners, partners, admins, and practice managers can run or review the Secretarial Integrity Audit.');
}

async function _writeEvent(cid, clientId, sourceType, sourceId, eventType, oldStatus, newStatus, actorUserId, notes, meta) {
    await supabase.from('practice_secretarial_integrity_events').insert({
        company_id: cid, client_id: clientId || null, source_type: sourceType, source_id: sourceId,
        event_type: eventType, old_status: oldStatus || null, new_status: newStatus || null,
        actor_user_id: actorUserId || null, notes: notes || null, metadata: meta || {},
    });
}

async function _fetchSafe(label, queryPromise) {
    try {
        const { data, error } = await queryPromise;
        if (error) { console.error(`[secretarial-integrity] fetch "${label}" error:`, error.message); return []; }
        return data || [];
    } catch (e) { console.error(`[secretarial-integrity] fetch "${label}" threw:`, e.message); return []; }
}

// "One validation failing must NEVER stop the entire audit" — every
// validation group runs through this wrapper.
async function _safeCheck(label, fn) {
    try { return (await fn()) || []; }
    catch (e) { console.error(`[secretarial-integrity] validation "${label}" failed:`, e.message); return []; }
}

function _groupBy(rows, key) {
    const map = {};
    (rows || []).forEach(r => { const k = r[key]; if (k == null) return; if (!map[k]) map[k] = []; map[k].push(r); });
    return map;
}

function _finding(clientId, category, code, severity, title, description, recommendedAction, sourceModule, sourceRecordId) {
    return {
        client_id: clientId || null, finding_category: category, finding_code: code, severity,
        title, description, recommended_action: recommendedAction || null,
        source_module: sourceModule || null, source_record_id: sourceRecordId || null,
    };
}

function _summarizeByCategory(findings) {
    const out = {};
    (findings || []).forEach(f => {
        if (!out[f.finding_category]) out[f.finding_category] = { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        out[f.finding_category].total++;
        out[f.finding_category][f.severity] = (out[f.finding_category][f.severity] || 0) + 1;
    });
    return out;
}

// ── Validations ───────────────────────────────────────────────────────────────
// Each function takes only the bulk data it needs and returns an array of
// findings. Independently wrapped by _safeCheck() in runIntegrityAudit().

function _checkRegistersAndPeople(clients, secProfilesByClient, directorsByClient, shareholdersByClient, fyeByClient) {
    const out = [];
    for (const client of clients) {
        const profile = (secProfilesByClient[client.id] || [])[0];
        if (!profile) continue; // not yet onboarded into Secretarial — out of this module's scope

        const companyType = profile.company_type;

        if (!profile.registered_address || !String(profile.registered_address).trim()) {
            out.push(_finding(client.id, 'register', 'no_registered_office', 'medium',
                'No registered office recorded', `${client.name} has no registered_address on its Secretarial Corporate Profile.`,
                'Capture the registered office address on the Secretarial Corporate Profile.', 'secretarial', profile.id));
        }
        if (companyType !== 'sole_proprietor' && (!client.registration_number || !String(client.registration_number).trim())) {
            out.push(_finding(client.id, 'register', 'missing_registration_number', 'high',
                'Missing CIPC registration number', `${client.name} has no registration_number recorded.`,
                'Capture the CIPC (or equivalent) registration number on the client record.', 'clients', client.id));
        }
        const fyeRows = fyeByClient[client.id] || [];
        if (!fyeRows.some(r => r.financial_year_end)) {
            out.push(_finding(client.id, 'register', 'missing_financial_year_end', 'medium',
                'Missing financial year-end', `${client.name} has no financial_year_end recorded on its Taxpayer Profile.`,
                'Capture the financial year-end on the Taxpayer Profile.', 'taxpayer-profiles', null));
        }

        if (!DIRECTOR_SHAREHOLDER_SCOPED_TYPES.includes(companyType)) continue;

        const activeDirectors = (directorsByClient[client.id] || []).filter(d => d.status === 'active');
        if (!activeDirectors.length) {
            out.push(_finding(client.id, 'director', 'no_active_directors', 'high',
                'No active directors', `${client.name} (${companyType}) has zero active directors on record.`,
                'Add at least one active director via the Director Register.', 'secretarial', null));
        } else {
            const seen = new Map();
            activeDirectors.forEach(d => {
                const key = (d.director_name || '').trim().toLowerCase();
                if (!key) return;
                if (seen.has(key)) {
                    out.push(_finding(client.id, 'director', 'duplicate_director_records', 'medium',
                        'Duplicate active director records', `${client.name} has more than one active director record named "${d.director_name}".`,
                        'Review and merge or resign the duplicate director record.', 'secretarial', d.id));
                } else seen.set(key, d.id);
            });
        }

        const activeShareholders = (shareholdersByClient[client.id] || []).filter(s => s.status === 'active');
        if (!activeShareholders.length) {
            out.push(_finding(client.id, 'shareholder', 'no_shareholders', 'medium',
                'No active shareholders', `${client.name} (${companyType}) has zero active shareholders on record.`,
                'Add the shareholder register via the Shareholder Register.', 'secretarial', null));
        } else {
            const sumPct = activeShareholders.reduce((s, r) => s + (Number(r.percentage) || 0), 0);
            if (sumPct > 100) {
                out.push(_finding(client.id, 'shareholder', 'shareholder_percentage_exceeds_100', 'critical',
                    'Shareholder percentages exceed 100%', `${client.name}'s active shareholders sum to ${sumPct}%, which exceeds 100%.`,
                    'Review the Shareholder Register and correct the percentage allocations.', 'secretarial', null));
            } else if (sumPct > 0 && sumPct < 100) {
                out.push(_finding(client.id, 'shareholder', 'shareholder_percentage_below_expected', 'low',
                    'Shareholder percentages below 100%', `${client.name}'s active shareholders sum to only ${sumPct}%.`,
                    'Confirm whether the remaining shareholding is unallocated or simply unrecorded.', 'secretarial', null));
            }
            const seenSh = new Map();
            activeShareholders.forEach(s => {
                const key = (s.shareholder_name || '').trim().toLowerCase();
                if (!key) return;
                if (seenSh.has(key)) {
                    out.push(_finding(client.id, 'shareholder', 'duplicate_shareholder_records', 'medium',
                        'Duplicate active shareholder records', `${client.name} has more than one active shareholder record named "${s.shareholder_name}".`,
                        'Review and merge or transfer the duplicate shareholder record.', 'secretarial', s.id));
                } else seenSh.set(key, s.id);
            });
        }
    }
    return out;
}

function _checkAnnualReturns(clients, secProfilesByClient, returnsByClient) {
    const out = [];
    const currentYear = new Date().getFullYear();
    const t = today();
    for (const client of clients) {
        if (!(secProfilesByClient[client.id] || [])[0]) continue;
        const returns = returnsByClient[client.id] || [];
        if (!returns.some(r => r.return_year === currentYear || r.return_year === currentYear - 1)) {
            out.push(_finding(client.id, 'annual_return', 'missing_annual_return', 'medium',
                'No recent annual return on record', `${client.name} has no annual return recorded for ${currentYear - 1} or ${currentYear}.`,
                'Create the annual return record via Secretarial and confirm its filing status.', 'secretarial', null));
        }
        returns.forEach(r => {
            const overdue = r.status === 'overdue' || (r.status === 'pending' && r.due_date && r.due_date < t);
            if (overdue) {
                out.push(_finding(client.id, 'annual_return', 'annual_return_overdue', 'high',
                    'Annual return overdue', `${client.name}'s ${r.return_year} annual return (due ${r.due_date || 'unknown'}) is overdue.`,
                    'Submit the annual return and update its status, or record an exemption.', 'secretarial', r.id));
            }
        });
    }
    return out;
}

function _checkBeneficialOwnership(clients, ownersByClient, chainsByClient, readinessByClient, computeReadinessFromItems) {
    const out = [];
    for (const client of clients) {
        const owners = ownersByClient[client.id] || [];
        const chains = chainsByClient[client.id] || [];
        const readinessItems = readinessByClient[client.id] || [];
        if (!owners.length && !chains.length && !readinessItems.length) continue; // BO not yet tracked — out of scope

        const readiness = computeReadinessFromItems(readinessItems);
        if (readiness.status === 'blocked') {
            out.push(_finding(client.id, 'beneficial_owner', 'bo_readiness_blocked', 'high',
                'Beneficial Ownership readiness blocked', `${client.name}'s BO readiness has a blocked required item.`,
                'Resolve the blocked BO readiness item via Beneficial Ownership.', 'beneficial-ownership', null));
        } else if (readiness.status === 'incomplete') {
            out.push(_finding(client.id, 'beneficial_owner', 'beneficial_ownership_incomplete', 'medium',
                'Beneficial Ownership incomplete', `${client.name}'s BO readiness score is ${readiness.score}% (incomplete).`,
                'Complete the outstanding BO readiness items.', 'beneficial-ownership', null));
        }

        const ownerIds = new Set(owners.map(o => o.id));
        const chainIds = new Set(chains.map(c => c.id));
        readinessItems.forEach(item => {
            if (item.beneficial_owner_id && !ownerIds.has(item.beneficial_owner_id)) {
                out.push(_finding(client.id, 'beneficial_owner', 'orphan_bo_records', 'low',
                    'Orphaned BO readiness item', `BO readiness item "${item.item_name || item.id}" references a beneficial owner that no longer exists.`,
                    'Review and remove or relink the orphaned readiness item.', 'beneficial-ownership', item.id));
            }
            if (item.ownership_chain_id && !chainIds.has(item.ownership_chain_id)) {
                out.push(_finding(client.id, 'beneficial_owner', 'orphan_bo_records', 'low',
                    'Orphaned BO readiness item', `BO readiness item "${item.item_name || item.id}" references an ownership chain that no longer exists.`,
                    'Review and remove or relink the orphaned readiness item.', 'beneficial-ownership', item.id));
            }
        });
        chains.forEach(c => {
            if (c.ultimate_owner_id && !ownerIds.has(c.ultimate_owner_id)) {
                out.push(_finding(client.id, 'beneficial_owner', 'broken_foreign_reference', 'medium',
                    'Broken ownership chain reference', `Ownership chain "${c.chain_name || c.id}" references an ultimate owner that no longer exists.`,
                    'Review and correct the ownership chain\'s ultimate owner link.', 'beneficial-ownership', c.id));
            }
        });
    }
    return out;
}

function _checkLifecycle(clients, secProfilesByClient, lifecycleProfilesByClient, lifecycleTransitionsByClient, terminalStatuses) {
    const out = [];
    for (const client of clients) {
        const lifecycle = (lifecycleProfilesByClient[client.id] || [])[0];
        if (!lifecycle) continue; // not yet tracked in Entity Lifecycle — out of scope
        const secProfile = (secProfilesByClient[client.id] || [])[0];
        const transitions = lifecycleTransitionsByClient[client.id] || [];
        const activeTransitions = transitions.filter(t => !['completed', 'rejected', 'cancelled'].includes(t.transition_status));

        if (lifecycle.current_lifecycle_status === 'unknown') {
            out.push(_finding(client.id, 'lifecycle', 'unknown_lifecycle_state', 'low',
                'Lifecycle status unknown', `${client.name}'s Entity Lifecycle status has never been set.`,
                'Record the entity\'s actual lifecycle status via Entity Lifecycle.', 'entity-lifecycle', lifecycle.id));
        }
        if (terminalStatuses.includes(lifecycle.current_lifecycle_status) && activeTransitions.length) {
            out.push(_finding(client.id, 'lifecycle', 'lifecycle_terminal_with_active_workflow', 'high',
                'Terminal lifecycle status with an active transition', `${client.name} is "${lifecycle.current_lifecycle_status}" but has ${activeTransitions.length} active lifecycle transition(s) in progress.`,
                'Review the active transition(s) — a terminal entity should not normally have further transitions in flight.', 'entity-lifecycle', lifecycle.id));
        }
        if (lifecycle.current_lifecycle_status === 'dormant' && activeTransitions.some(t => t.transition_type === 'commence_trading')) {
            out.push(_finding(client.id, 'lifecycle', 'dormant_company_active_trading_workflow', 'medium',
                'Dormant entity has an active trading transition', `${client.name} is "dormant" but has an active commence_trading transition in progress.`,
                'Confirm whether the entity is actually resuming trading and update its lifecycle status accordingly.', 'entity-lifecycle', lifecycle.id));
        }
        if (secProfile) {
            if (['deregistered', 'in_liquidation'].includes(secProfile.company_status) && lifecycle.trading_status === 'trading') {
                out.push(_finding(client.id, 'register', 'inactive_company_marked_trading', 'high',
                    'Inactive company marked as trading', `${client.name}'s Secretarial company_status is "${secProfile.company_status}" but its Entity Lifecycle trading_status is "trading".`,
                    'Reconcile the company\'s trading status with its actual statutory status.', 'entity-lifecycle', lifecycle.id));
            }
            const secDeregistered = secProfile.company_status === 'deregistered';
            const lifecycleDeregistered = ['deregistered', 'deregistration_pending'].includes(lifecycle.current_lifecycle_status);
            if (secDeregistered !== lifecycleDeregistered) {
                out.push(_finding(client.id, 'lifecycle', 'lifecycle_status_inconsistent', 'medium',
                    'Secretarial and Lifecycle status disagree', `${client.name}: Secretarial company_status is "${secProfile.company_status}" while Entity Lifecycle status is "${lifecycle.current_lifecycle_status}" — these appear inconsistent.`,
                    'Review both statuses and reconcile — they intentionally track different models but should not directly contradict each other.', 'entity-lifecycle', lifecycle.id));
            }
        }

        transitions.forEach(t => {
            if (t.implemented_at && !t.approved_at) {
                out.push(_finding(client.id, 'lifecycle', 'implementation_without_approval', 'critical',
                    'Transition implemented without approval', `Transition #${t.id} (${t.transition_type}) for ${client.name} was implemented without a recorded approval.`,
                    'Investigate how this transition bypassed the approval step.', 'entity-lifecycle', t.id));
            }
            if (t.transition_status === 'completed' && !t.implemented_at) {
                out.push(_finding(client.id, 'lifecycle', 'transition_without_implementation', 'critical',
                    'Transition completed without implementation', `Transition #${t.id} (${t.transition_type}) for ${client.name} is marked completed but has no implemented_at timestamp.`,
                    'Investigate how this transition was completed without an implementation step.', 'entity-lifecycle', t.id));
            }
            if (t.lifecycle_profile_id !== lifecycle.id) {
                out.push(_finding(client.id, 'lifecycle', 'broken_foreign_reference', 'medium',
                    'Transition references the wrong lifecycle profile', `Transition #${t.id} for ${client.name} references lifecycle_profile_id ${t.lifecycle_profile_id}, which does not match this client's profile (#${lifecycle.id}).`,
                    'Investigate this data inconsistency.', 'entity-lifecycle', t.id));
            }
        });
    }
    return out;
}

function _checkGovernance(changeCases, resolutions, meetings, decisions) {
    const out = [];
    const changeCaseIds = new Set(changeCases.map(c => c.id));
    const resolutionIds = new Set(resolutions.map(r => r.id));
    const meetingIds = new Set(meetings.map(m => m.id));
    const caseIdsWithResolution = new Set(resolutions.filter(r => r.change_case_id).map(r => r.change_case_id));
    const caseIdsWithMeeting = new Set(meetings.filter(m => m.change_case_id).map(m => m.change_case_id));

    changeCases.forEach(c => {
        if (!['implemented', 'completed'].includes(c.case_status)) return;
        if (!GOVERNANCE_REQUIRED_CHANGE_TYPES.includes(c.change_type)) return;
        if (caseIdsWithResolution.has(c.id) || caseIdsWithMeeting.has(c.id)) return;
        out.push(_finding(c.client_id, 'governance', 'governance_missing_for_implemented_change', 'medium',
            'Governance record missing for implemented change', `Change case #${c.id} (${c.change_type}) is ${c.case_status} but has no linked resolution or meeting.`,
            'Link or create a supporting resolution/meeting via Secretarial Governance.', 'secretarial-workflows', c.id));
    });

    resolutions.forEach(r => {
        if (r.change_case_id && !changeCaseIds.has(r.change_case_id)) {
            out.push(_finding(r.client_id, 'governance', 'orphan_governance_records', 'low',
                'Orphaned resolution record', `Resolution #${r.id} references a statutory change case that no longer exists.`,
                'Review and correct or remove the resolution\'s change case link.', 'secretarial-governance', r.id));
        }
    });
    meetings.forEach(m => {
        if (m.change_case_id && !changeCaseIds.has(m.change_case_id)) {
            out.push(_finding(m.client_id, 'governance', 'orphan_governance_records', 'low',
                'Orphaned meeting record', `Meeting #${m.id} references a statutory change case that no longer exists.`,
                'Review and correct or remove the meeting\'s change case link.', 'secretarial-governance', m.id));
        }
    });
    decisions.forEach(d => {
        if (d.meeting_id && !meetingIds.has(d.meeting_id)) {
            out.push(_finding(d.client_id, 'governance', 'orphan_governance_records', 'low',
                'Orphaned decision record', `Decision #${d.id} references a meeting that no longer exists.`,
                'Review and correct or remove the decision\'s meeting link.', 'secretarial-governance', d.id));
        }
        if (d.resolution_id && !resolutionIds.has(d.resolution_id)) {
            out.push(_finding(d.client_id, 'governance', 'orphan_governance_records', 'low',
                'Orphaned decision record', `Decision #${d.id} references a resolution that no longer exists.`,
                'Review and correct or remove the decision\'s resolution link.', 'secretarial-governance', d.id));
        }
        if (d.change_case_id && !changeCaseIds.has(d.change_case_id)) {
            out.push(_finding(d.client_id, 'governance', 'orphan_governance_records', 'low',
                'Orphaned decision record', `Decision #${d.id} references a statutory change case that no longer exists.`,
                'Review and correct or remove the decision\'s change case link.', 'secretarial-governance', d.id));
        }
    });
    return out;
}

function _checkEvidenceMissing(changeCases, evidenceChecklists) {
    const out = [];
    const checklistedCaseIds = new Set(evidenceChecklists.filter(c => c.source_type === 'change_case' && c.source_id).map(c => c.source_id));
    changeCases.forEach(c => {
        if (!['implemented', 'completed', 'approved', 'ready_for_review'].includes(c.case_status)) return;
        if (!EVIDENCE_EXPECTED_CHANGE_TYPES.includes(c.change_type)) return;
        if (checklistedCaseIds.has(c.id)) return;
        out.push(_finding(c.client_id, 'evidence', 'evidence_checklist_missing', 'low',
            'Evidence checklist missing', `Change case #${c.id} (${c.change_type}, ${c.case_status}) has no linked evidence checklist.`,
            'Generate an evidence checklist for this change via Secretarial Evidence.', 'secretarial-evidence', c.id));
    });
    return out;
}

function _checkEvidenceReadiness(evidenceReadinessResults) {
    const out = [];
    evidenceReadinessResults.forEach(({ checklist, readiness }) => {
        if (!readiness) return;
        if (readiness.status === 'blocked') {
            out.push(_finding(checklist.client_id, 'evidence', 'evidence_required_but_incomplete', 'high',
                'Evidence checklist blocked', `Evidence checklist #${checklist.id} ("${checklist.title || checklist.source_type}") has a blocked required item.`,
                'Resolve the blocked evidence item via Secretarial Evidence.', 'secretarial-evidence', checklist.id));
        } else if (readiness.status === 'incomplete') {
            out.push(_finding(checklist.client_id, 'evidence', 'evidence_required_but_incomplete', 'medium',
                'Evidence required but incomplete', `Evidence checklist #${checklist.id} ("${checklist.title || checklist.source_type}") is incomplete (score ${readiness.score}%).`,
                'Complete the outstanding required evidence items.', 'secretarial-evidence', checklist.id));
        } else if (readiness.status === 'partial') {
            out.push(_finding(checklist.client_id, 'evidence', 'evidence_required_but_incomplete', 'low',
                'Evidence partially complete', `Evidence checklist #${checklist.id} ("${checklist.title || checklist.source_type}") is only partially complete (score ${readiness.score}%).`,
                'Continue collecting the outstanding evidence items.', 'secretarial-evidence', checklist.id));
        }
    });
    return out;
}

function _checkCalendar(calendarItems) {
    const out = [];
    calendarItems.forEach(item => {
        if (item.category === 'blocked') {
            out.push(_finding(item.client_id, 'calendar', 'blocked_statutory_obligations', 'high',
                'Statutory obligation blocked and overdue', `"${item.period_label}" (due ${item.due_date}) is overdue and blocked by an unresolved dependency.`,
                'Resolve the dependency or record a manager override via Statutory Calendar.', 'secretarial-calendar', item.id));
        } else if (item.category === 'waiting') {
            out.push(_finding(item.client_id, 'calendar', 'calendar_dependency_unresolved', 'medium',
                'Statutory obligation waiting on an unresolved dependency', `"${item.period_label}" (due ${item.due_date}) has an unresolved dependency.`,
                'Resolve the dependency ahead of the due date via Statutory Calendar.', 'secretarial-calendar', item.id));
        }
    });
    return out;
}

function _checkBrokenReferences(calendarItems, statutoryObligationIds, statutoryDependencies, evidenceChecklistIds) {
    const out = [];
    calendarItems.forEach(item => {
        if (item.obligation_id && !statutoryObligationIds.has(item.obligation_id)) {
            out.push(_finding(item.client_id, 'calendar', 'broken_foreign_reference', 'medium',
                'Broken schedule reference', `Schedule item #${item.id} ("${item.period_label}") references an obligation that no longer exists.`,
                'Review and correct or remove the orphaned schedule item.', 'secretarial-calendar', item.id));
        }
    });
    const scheduleIds = new Set(calendarItems.map(i => i.id));
    statutoryDependencies.forEach(d => {
        if (d.depends_on_schedule_id && !scheduleIds.has(d.depends_on_schedule_id)) {
            out.push(_finding(d.client_id, 'calendar', 'broken_foreign_reference', 'medium',
                'Broken dependency reference', `Dependency #${d.id} references a schedule item that no longer exists.`,
                'Review and correct or remove the orphaned dependency.', 'secretarial-calendar', d.id));
        }
        if (d.depends_on_checklist_id && !evidenceChecklistIds.has(d.depends_on_checklist_id)) {
            out.push(_finding(d.client_id, 'calendar', 'broken_foreign_reference', 'medium',
                'Broken dependency reference', `Dependency #${d.id} references an evidence checklist that no longer exists.`,
                'Review and correct or remove the orphaned dependency.', 'secretarial-calendar', d.id));
        }
    });
    return out;
}

function _checkOrphanEvidence(evidenceChecklists, evidenceTemplateIds) {
    const out = [];
    evidenceChecklists.forEach(c => {
        if (c.template_id && !evidenceTemplateIds.has(c.template_id)) {
            out.push(_finding(c.client_id, 'evidence', 'orphan_evidence_records', 'low',
                'Orphaned evidence checklist template link', `Evidence checklist #${c.id} ("${c.title}") references a template that no longer exists.`,
                'Review and correct or remove the orphaned template link.', 'secretarial-evidence', c.id));
        }
    });
    return out;
}

// ── Audit Engine — runIntegrityAudit() ───────────────────────────────────────

async function runIntegrityAudit(cid, actorUserId, runType) {
    const resolvedRunType = RUN_TYPES.includes(runType) ? runType : 'manual';

    const { data: run, error: runError } = await supabase.from('practice_secretarial_integrity_runs')
        .insert({ company_id: cid, run_type: resolvedRunType, created_by: actorUserId }).select().single();
    if (runError) throw new Error(runError.message);
    await _writeEvent(cid, null, 'run', run.id, 'run_started', null, null, actorUserId, null, { run_type: resolvedRunType });

    let TERMINAL_STATUSES;
    try { TERMINAL_STATUSES = require('./entity-lifecycle').TERMINAL_STATUSES || ['deregistered', 'liquidated', 'closed']; }
    catch (e) { TERMINAL_STATUSES = ['deregistered', 'liquidated', 'closed']; }

    const [
        clients, secProfiles, directors, shareholders, annualReturns, taxpayerProfiles,
        lifecycleProfiles, lifecycleTransitions, changeCases, resolutions, meetings, decisions,
        boOwners, boChains, boReadinessItems, evidenceChecklists, evidenceTemplates, statutoryObligations, statutoryDependencies,
    ] = await Promise.all([
        _fetchSafe('clients', supabase.from('practice_clients').select('id, name, registration_number').eq('company_id', cid).eq('is_active', true)),
        _fetchSafe('secretarial_profiles', supabase.from('practice_secretarial_profiles').select('id, client_id, company_type, registered_address, company_status').eq('company_id', cid)),
        _fetchSafe('directors', supabase.from('practice_company_directors').select('id, client_id, director_name, status').eq('company_id', cid)),
        _fetchSafe('shareholders', supabase.from('practice_company_shareholders').select('id, client_id, shareholder_name, percentage, status').eq('company_id', cid)),
        _fetchSafe('annual_returns', supabase.from('practice_annual_returns').select('id, client_id, return_year, due_date, status').eq('company_id', cid)),
        _fetchSafe('taxpayer_profiles', supabase.from('practice_taxpayer_profiles').select('id, client_id, financial_year_end').eq('company_id', cid)),
        _fetchSafe('lifecycle_profiles', supabase.from('practice_entity_lifecycle_profiles').select('id, client_id, current_lifecycle_status, trading_status').eq('company_id', cid)),
        _fetchSafe('lifecycle_transitions', supabase.from('practice_entity_lifecycle_transitions').select('id, client_id, lifecycle_profile_id, transition_type, transition_status, approved_at, implemented_at').eq('company_id', cid)),
        _fetchSafe('change_cases', supabase.from('practice_secretarial_change_cases').select('id, client_id, change_type, case_status').eq('company_id', cid)),
        _fetchSafe('resolutions', supabase.from('practice_secretarial_resolutions').select('id, client_id, change_case_id').eq('company_id', cid)),
        _fetchSafe('meetings', supabase.from('practice_secretarial_meetings').select('id, client_id, change_case_id').eq('company_id', cid)),
        _fetchSafe('decisions', supabase.from('practice_secretarial_decisions').select('id, client_id, meeting_id, resolution_id, change_case_id').eq('company_id', cid)),
        _fetchSafe('bo_owners', supabase.from('practice_beneficial_owners').select('id, client_id, status').eq('company_id', cid)),
        _fetchSafe('bo_chains', supabase.from('practice_ownership_chains').select('id, client_id, chain_name, ultimate_owner_id').eq('company_id', cid)),
        _fetchSafe('bo_readiness_items', supabase.from('practice_bo_readiness_items').select('id, client_id, item_name, beneficial_owner_id, ownership_chain_id, status, required').eq('company_id', cid)),
        _fetchSafe('evidence_checklists', supabase.from('practice_secretarial_evidence_checklists').select('id, client_id, title, source_type, source_id, template_id').eq('company_id', cid)),
        _fetchSafe('evidence_templates', supabase.from('practice_secretarial_evidence_templates').select('id').eq('company_id', cid)),
        _fetchSafe('statutory_obligations', supabase.from('practice_statutory_obligations').select('id').eq('company_id', cid)),
        _fetchSafe('statutory_dependencies', supabase.from('practice_statutory_dependencies').select('id, client_id, schedule_id, depends_on_schedule_id, depends_on_checklist_id').eq('company_id', cid)),
    ]);

    const calendar = await (async () => {
        try { return await secretarialCalendar.buildStatutoryCalendar(cid, null); }
        catch (e) { console.error('[secretarial-integrity] buildStatutoryCalendar failed:', e.message); return { items: [] }; }
    })();

    const nonBoChecklists = evidenceChecklists.filter(c => c.source_type !== 'bo_verification');
    const evidenceReadinessResults = await Promise.all(nonBoChecklists.map(async checklist => {
        try { return { checklist, readiness: await secretarialEvidence.getChecklistReadiness(cid, checklist) }; }
        catch (e) { return { checklist, readiness: null }; }
    }));

    const secProfilesByClient = _groupBy(secProfiles, 'client_id');
    const directorsByClient = _groupBy(directors, 'client_id');
    const shareholdersByClient = _groupBy(shareholders, 'client_id');
    const returnsByClient = _groupBy(annualReturns, 'client_id');
    const fyeByClient = _groupBy(taxpayerProfiles, 'client_id');
    const lifecycleProfilesByClient = _groupBy(lifecycleProfiles, 'client_id');
    const lifecycleTransitionsByClient = _groupBy(lifecycleTransitions, 'client_id');
    const boOwnersByClient = _groupBy(boOwners, 'client_id');
    const boChainsByClient = _groupBy(boChains, 'client_id');
    const boReadinessByClient = _groupBy(boReadinessItems, 'client_id');

    const statutoryObligationIds = new Set(statutoryObligations.map(o => o.id));
    const evidenceTemplateIds = new Set(evidenceTemplates.map(t => t.id));
    const evidenceChecklistIds = new Set(evidenceChecklists.map(c => c.id));

    const findings = [];
    findings.push(...await _safeCheck('registers_and_people', () => _checkRegistersAndPeople(clients, secProfilesByClient, directorsByClient, shareholdersByClient, fyeByClient)));
    findings.push(...await _safeCheck('annual_returns', () => _checkAnnualReturns(clients, secProfilesByClient, returnsByClient)));
    findings.push(...await _safeCheck('beneficial_ownership', () => _checkBeneficialOwnership(clients, boOwnersByClient, boChainsByClient, boReadinessByClient, beneficialOwnership.computeReadinessFromItems)));
    findings.push(...await _safeCheck('lifecycle', () => _checkLifecycle(clients, secProfilesByClient, lifecycleProfilesByClient, lifecycleTransitionsByClient, TERMINAL_STATUSES)));
    findings.push(...await _safeCheck('governance', () => _checkGovernance(changeCases, resolutions, meetings, decisions)));
    findings.push(...await _safeCheck('evidence_missing', () => _checkEvidenceMissing(changeCases, evidenceChecklists)));
    findings.push(...await _safeCheck('evidence_readiness', () => _checkEvidenceReadiness(evidenceReadinessResults)));
    findings.push(...await _safeCheck('calendar', () => _checkCalendar(calendar.items || [])));
    findings.push(...await _safeCheck('broken_references', () => _checkBrokenReferences(calendar.items || [], statutoryObligationIds, statutoryDependencies, evidenceChecklistIds)));
    findings.push(...await _safeCheck('orphan_evidence', () => _checkOrphanEvidence(evidenceChecklists, evidenceTemplateIds)));

    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    findings.forEach(f => { counts[f.severity] = (counts[f.severity] || 0) + 1; });
    const overallScore = Math.max(0, 100 - (counts.critical * SEVERITY_WEIGHTS.critical + counts.high * SEVERITY_WEIGHTS.high + counts.medium * SEVERITY_WEIGHTS.medium + counts.low * SEVERITY_WEIGHTS.low));
    const passed = counts.critical === 0 && counts.high === 0;

    let insertedFindings = [];
    if (findings.length) {
        const rows = findings.map(f => ({
            company_id: cid, run_id: run.id, client_id: f.client_id, finding_category: f.finding_category,
            finding_code: f.finding_code, severity: f.severity, title: f.title, description: f.description,
            recommended_action: f.recommended_action, source_module: f.source_module, source_record_id: f.source_record_id,
        }));
        const { data, error } = await supabase.from('practice_secretarial_integrity_findings').insert(rows).select();
        if (error) throw new Error(error.message);
        insertedFindings = data || [];
        const eventRows = insertedFindings.map(f => ({
            company_id: cid, client_id: f.client_id, source_type: 'finding', source_id: f.id,
            event_type: 'finding_created', new_status: 'open', actor_user_id: actorUserId,
            metadata: { finding_code: f.finding_code, severity: f.severity },
        }));
        await supabase.from('practice_secretarial_integrity_events').insert(eventRows);
    }

    const { data: updatedRun, error: updateError } = await supabase.from('practice_secretarial_integrity_runs')
        .update({
            scan_completed_at: new Date().toISOString(), overall_score: overallScore,
            critical_count: counts.critical, high_count: counts.high, medium_count: counts.medium, low_count: counts.low,
            passed,
        })
        .eq('id', run.id).eq('company_id', cid).select().single();
    if (updateError) throw new Error(updateError.message);

    await _writeEvent(cid, null, 'run', run.id, 'run_completed', null, null, actorUserId, null, { overall_score: overallScore, findings_count: insertedFindings.length, ...counts });

    return {
        run: updatedRun,
        findings: insertedFindings,
        module_summary: _summarizeByCategory(insertedFindings),
        severity_counts: counts,
        overall_score: overallScore,
        passed,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req, res) => {
    const cid = req.companyId;
    try {
        const [latestRunRes, openFindingsRes] = await Promise.all([
            supabase.from('practice_secretarial_integrity_runs').select('*').eq('company_id', cid).order('scan_started_at', { ascending: false }).limit(1).maybeSingle(),
            supabase.from('practice_secretarial_integrity_findings').select('severity').eq('company_id', cid).eq('status', 'open'),
        ]);
        const openCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        (openFindingsRes.data || []).forEach(f => { if (f.severity in openCounts) openCounts[f.severity]++; });
        res.json({
            latest_run: latestRunRes.data || null,
            open_findings_total: (openFindingsRes.data || []).length,
            open_findings_by_severity: openCounts,
        });
    } catch (err) {
        console.error('Secretarial-integrity /summary error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// RUNS
// ═══════════════════════════════════════════════════════════════════════════

router.post('/run', async (req, res) => {
    const cid = req.companyId;
    const member = await _requireManager(req, res);
    if (!member) return;
    try {
        const result = await runIntegrityAudit(cid, req.user.userId, req.body.run_type);
        res.status(201).json(result);
    } catch (err) {
        console.error('Secretarial-integrity POST /run error:', err.message);
        res.status(500).json({ error: 'Failed to run the integrity audit.' });
    }
});

router.get('/runs', async (req, res) => {
    const cid = req.companyId;
    const { limit = 50 } = req.query;
    try {
        const { data, error } = await supabase.from('practice_secretarial_integrity_runs').select('*')
            .eq('company_id', cid).order('scan_started_at', { ascending: false }).limit(Math.min(200, parseInt(limit) || 50));
        if (error) return res.status(500).json({ error: error.message });
        res.json({ runs: data || [] });
    } catch (err) {
        console.error('Secretarial-integrity GET runs error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/runs/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid run ID' });
    try {
        const [runRes, findingsRes] = await Promise.all([
            supabase.from('practice_secretarial_integrity_runs').select('*').eq('id', id).eq('company_id', cid).maybeSingle(),
            supabase.from('practice_secretarial_integrity_findings').select('*').eq('run_id', id).eq('company_id', cid),
        ]);
        if (runRes.error) return res.status(500).json({ error: runRes.error.message });
        if (!runRes.data) return res.status(404).json({ error: 'Run not found' });
        const findings = (findingsRes.data || []).sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
        res.json({ run: runRes.data, findings, module_summary: _summarizeByCategory(findings) });
    } catch (err) {
        console.error('Secretarial-integrity GET run error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// FINDINGS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/findings', async (req, res) => {
    const cid = req.companyId;
    const { client_id, finding_category, severity, status, run_id, limit = 200 } = req.query;
    try {
        let q = supabase.from('practice_secretarial_integrity_findings').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 200));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        if (finding_category) q = q.eq('finding_category', finding_category);
        if (severity) q = q.eq('severity', severity);
        if (status) q = q.eq('status', status);
        if (run_id) q = q.eq('run_id', parseInt(run_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });

        const clientIds = [...new Set((data || []).map(f => f.client_id).filter(Boolean))];
        let nameById = {};
        if (clientIds.length) {
            const { data: clientRows } = await supabase.from('practice_clients').select('id, name').in('id', clientIds).eq('company_id', cid);
            (clientRows || []).forEach(c => { nameById[c.id] = c.name; });
        }
        const findings = (data || []).sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
            .map(f => ({ ...f, client_name: f.client_id ? (nameById[f.client_id] || null) : null }));
        res.json({ findings });
    } catch (err) {
        console.error('Secretarial-integrity GET findings error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/findings/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid finding ID' });
    try {
        const { data, error } = await supabase.from('practice_secretarial_integrity_findings').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Finding not found' });
        res.json({ finding: data });
    } catch (err) {
        console.error('Secretarial-integrity GET finding error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/findings/:id', async (req, res) => {
    const cid = req.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid finding ID' });
    const member = await _requireManager(req, res);
    if (!member) return;
    const existing = await supabase.from('practice_secretarial_integrity_findings').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
    if (!existing.data) return res.status(404).json({ error: 'Finding not found' });
    try {
        const { data, error } = await supabase.from('practice_secretarial_integrity_findings')
            .update({ notes: req.body.notes ?? existing.data.notes, updated_at: new Date().toISOString() })
            .eq('id', id).eq('company_id', cid).select().single();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ finding: data });
    } catch (err) {
        console.error('Secretarial-integrity PUT finding error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Finding review actions ───────────────────────────────────────────────────
// Each is a distinct, explicit manager action — never inferred. No silent
// resolution: every transition writes an append-only event.

const FINDING_ACTIONS = {
    acknowledge: { to: 'acknowledged', from: ['open'], event: 'finding_acknowledged', requireNotes: false },
    resolve: { to: 'resolved', from: ['open', 'acknowledged'], event: 'finding_resolved', requireNotes: false },
    'accept-risk': { to: 'accepted_risk', from: ['open', 'acknowledged'], event: 'finding_accepted', requireNotes: true },
    reopen: { to: 'open', from: ['acknowledged', 'resolved', 'accepted_risk'], event: 'finding_reopened', requireNotes: false },
};

Object.keys(FINDING_ACTIONS).forEach(path => {
    const config = FINDING_ACTIONS[path];
    router.put(`/findings/:id/${path}`, async (req, res) => {
        const cid = req.companyId;
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid finding ID' });
        const member = await _requireManager(req, res);
        if (!member) return;

        const existing = await supabase.from('practice_secretarial_integrity_findings').select('*').eq('id', id).eq('company_id', cid).maybeSingle();
        if (!existing.data) return res.status(404).json({ error: 'Finding not found' });
        if (!config.from.includes(existing.data.status)) {
            return res.status(400).json({ error: `Cannot ${path} a finding that is already ${existing.data.status}.` });
        }
        if (config.requireNotes && !req.body.notes) {
            return res.status(400).json({ error: `notes is required to ${path} a finding — record the reason risk is being accepted.` });
        }

        try {
            const update = { status: config.to, reviewed_by: req.user.userId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            if (req.body.notes) update.notes = req.body.notes;
            const { data, error } = await supabase.from('practice_secretarial_integrity_findings').update(update).eq('id', id).eq('company_id', cid).select().single();
            if (error) return res.status(500).json({ error: error.message });

            await _writeEvent(cid, existing.data.client_id, 'finding', id, config.event, existing.data.status, config.to, req.user.userId, req.body.notes || null, {});
            res.json({ finding: data });
        } catch (err) {
            console.error(`Secretarial-integrity PUT /findings/:id/${path} error:`, err.message);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/events', async (req, res) => {
    const cid = req.companyId;
    const { client_id, limit = 100 } = req.query;
    try {
        let q = supabase.from('practice_secretarial_integrity_events').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(Math.min(500, parseInt(limit) || 100));
        if (client_id) q = q.eq('client_id', parseInt(client_id));
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        res.json({ events: data || [] });
    } catch (err) {
        console.error('Secretarial-integrity GET events error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

// Reusable for other modules (Management Dashboard, Entity Lifecycle warnings,
// Planning Board) — see docs/new-app/69_secretarial_integrity.md
module.exports.runIntegrityAudit = runIntegrityAudit;
