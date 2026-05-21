/**
 * ============================================================================
 * SEAN AI — Coaching Routes
 * ============================================================================
 * Company-scoped coaching case store and pattern engine.
 *
 * Routes prefix (mounted at): /api/sean/coaching
 *
 *   GET  /cases          — List coaching cases for the company
 *   POST /cases          — Manually create a coaching case
 *   POST /chat           — Submit coaching text → get rule-based suggestion
 *   POST /feedback       — Record feedback on a coaching response
 *   GET  /patterns       — Get pattern dashboard stats
 *
 * PRIVACY / TENANT SAFETY:
 *   - Every query filters by req.companyId — company A cannot see company B cases
 *   - No sensitive case text is written to the audit log — only metadata
 *   - Signal labels are for coaching context only, never presented as diagnoses
 *
 * AUDIT LOGGING:
 *   - coaching_case_created
 *   - coaching_chat_submitted
 *   - coaching_response_suggested
 *   - coaching_feedback_saved
 *   - coaching_pattern_built
 * ============================================================================
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { supabase }                  = require('../config/database');
const { authenticateToken }         = require('../middleware/auth');
const CoachingEngine                = require('./coaching-engine');

// Belt-and-suspenders auth — /api/sean is already gated by authenticateToken
// in server.js, but this ensures the coaching sub-router is safe if ever
// mounted independently.
router.use(authenticateToken);

// ─── Helper: company ID from request ─────────────────────────────────────────
function getCompanyId(req) {
    const id = req.companyId || req.user?.companyId;
    return id ? parseInt(id, 10) : null;
}

// ─── Helper: write coaching audit log (fire-and-forget, never fatal) ─────────
function auditLog(params) {
    const {
        companyId, userId, action, caseId = null,
        confidence = null, metadata = {}
    } = params;

    supabase.from('sean_coaching_audit_log').insert({
        company_id: companyId || null,
        user_id:    userId    || null,
        action,
        case_id:    caseId    || null,
        confidence: confidence != null ? parseFloat(confidence) : null,
        metadata,
        created_at: new Date().toISOString()
    }).then(({ error }) => {
        if (error) console.error('[coaching-routes] audit log write failed:', error.message);
    });
}

// ─── GET /api/sean/coaching/cases ─────────────────────────────────────────────
// List coaching cases for the authenticated company.
// Optional filters: pattern_group, learned_from_user, emotional_state, limit
router.get('/cases', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    try {
        const { pattern_group, learned_from_user, emotional_state, limit = 50 } = req.query;

        let query = supabase
            .from('sean_coaching_cases')
            .select('*')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(Math.min(parseInt(limit) || 50, 200));

        if (pattern_group)      query = query.eq('pattern_group', pattern_group);
        if (emotional_state)    query = query.eq('emotional_state', emotional_state);
        if (learned_from_user !== undefined) {
            query = query.eq('learned_from_user', learned_from_user === 'true');
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({
            ok: true,
            count: (data || []).length,
            cases: (data || []).map(c => ({
                id:                c.id,
                triggerPhrase:     c.trigger_phrase,
                context:           c.context,
                personalitySignals: c.personality_signals,
                emotionalState:    c.emotional_state,
                responseUsed:      c.response_used,
                outcome:           c.outcome,
                patternGroup:      c.pattern_group,
                confidence:        c.confidence,
                learnedFromUser:   c.learned_from_user,
                createdBy:         c.created_by,
                createdAt:         c.created_at
            }))
        });
    } catch (err) {
        console.error('[coaching-routes] GET /cases error:', err.message);
        res.status(500).json({ error: 'Failed to retrieve coaching cases' });
    }
});

// ─── POST /api/sean/coaching/cases ────────────────────────────────────────────
// Manually create a coaching case (reviewer/admin entry).
// learned_from_user defaults to false for manual entries.
router.post('/cases', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    try {
        const {
            trigger_phrase,
            context,
            personality_signals,
            emotional_state,
            response_used,
            outcome,
            pattern_group,
            confidence,
            learned_from_user = false
        } = req.body;

        const userId = req.user?.email || req.user?.id || null;

        const { data, error } = await supabase
            .from('sean_coaching_cases')
            .insert({
                company_id:         companyId,
                trigger_phrase:     trigger_phrase || null,
                context:            context        || null,
                personality_signals: personality_signals || {},
                emotional_state:    emotional_state || null,
                response_used:      response_used  || null,
                outcome:            outcome        || null,
                pattern_group:      pattern_group  || null,
                confidence:         confidence != null ? parseFloat(confidence) : null,
                learned_from_user:  Boolean(learned_from_user),
                created_by:         userId,
                created_at:         new Date().toISOString(),
                updated_at:         new Date().toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        auditLog({
            companyId, userId,
            action:   'coaching_case_created',
            caseId:   data.id,
            metadata: {
                pattern_group: data.pattern_group,
                emotional_state: data.emotional_state,
                learned_from_user: data.learned_from_user
            }
        });

        res.status(201).json({ ok: true, case: { id: data.id, createdAt: data.created_at } });
    } catch (err) {
        console.error('[coaching-routes] POST /cases error:', err.message);
        res.status(500).json({ error: 'Failed to create coaching case' });
    }
});

// ─── POST /api/sean/coaching/chat ─────────────────────────────────────────────
// Submit coaching input text → rule-based pattern match → suggested response.
//
// Flow:
//   1. identifyPersonalitySignals(inputText)
//   2. findSimilarCases(inputText, companyId)
//   3. If top case confidence >= 0.65 → buildPattern → suggestResponse
//   4. Else → return "Ek leer nog hieroor..." uncertainty response
//   5. Always audit the submission + the suggestion (separately)
router.post('/chat', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
    }

    const userId = req.user?.email || req.user?.id || null;
    const inputText = message.trim();

    try {
        // Step 1: Identify personality/emotional signals
        const signalResult = CoachingEngine.identifyPersonalitySignals(inputText);

        // Step 2: Find similar cases (scored against this input)
        const scoredCases = await CoachingEngine.findSimilarCases(
            inputText, companyId, supabase, signalResult
        );

        // Audit: chat submitted
        auditLog({
            companyId, userId,
            action:   'coaching_chat_submitted',
            metadata: {
                input_length:  inputText.length,
                signal_count:  signalResult.signalCount,
                dominant_signal: signalResult.dominant,
                cases_found:   scoredCases.length
            }
        });

        // Step 3: Check top confidence
        const topCase       = scoredCases[0] || null;
        const topConfidence = topCase ? topCase.confidence : 0;

        let pattern  = null;
        let response = null;
        let source   = 'uncertain';

        if (topConfidence >= CoachingEngine.CONFIDENCE_THRESHOLD && scoredCases.length >= 1) {
            // Build pattern from top-matching cases (cap at 10 for pattern building)
            const patternCases = scoredCases.slice(0, 10);
            pattern = CoachingEngine.buildPattern(patternCases);

            // Audit: pattern built
            auditLog({
                companyId, userId,
                action:     'coaching_pattern_built',
                confidence: pattern.avgConfidence,
                metadata: {
                    pattern_group:   pattern.patternGroup,
                    emotional_state: pattern.emotionalState,
                    case_count:      pattern.caseCount
                }
            });

            const suggestion = CoachingEngine.suggestResponse(pattern, signalResult.dominant, topConfidence);
            response = suggestion.response;
            source   = suggestion.source;
        } else {
            // No strong match — return uncertainty prompt
            const suggestion = CoachingEngine.suggestResponse(null, signalResult.dominant, topConfidence);
            response = suggestion.response;
            source   = suggestion.source;
        }

        // Audit: response suggested
        auditLog({
            companyId, userId,
            action:     'coaching_response_suggested',
            confidence: topConfidence,
            metadata: {
                source,
                pattern_group:   pattern?.patternGroup || null,
                dominant_signal: signalResult.dominant,
                top_confidence:  topConfidence
            }
        });

        res.json({
            ok: true,
            response,
            confidence:     topConfidence,
            source,
            signals:        signalResult.signals,
            dominantSignal: signalResult.dominant,
            patternGroup:   pattern?.patternGroup || null,
            matchedCases:   scoredCases.length,
            isUncertain:    source === 'uncertain'
        });
    } catch (err) {
        console.error('[coaching-routes] POST /chat error:', err.message);
        res.status(500).json({ error: 'Coaching chat processing failed' });
    }
});

// ─── POST /api/sean/coaching/feedback ─────────────────────────────────────────
// Record user feedback on a coaching response.
//
// If outcome === 'positive': record the response as a new learned case
//   (learned_from_user = true) so it improves future suggestions.
// If outcome === 'negative': record what would have worked better.
// In both cases, always audit.
router.post('/feedback', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    try {
        const {
            original_message,
            response_given,
            outcome,              // 'positive' or 'negative'
            better_response,      // what would have worked better (for negative)
            pattern_group,
            emotional_state,
            dominant_signal,
            confidence
        } = req.body;

        if (!original_message || !outcome) {
            return res.status(400).json({ error: 'original_message and outcome are required' });
        }

        const userId = req.user?.email || req.user?.id || null;

        // Determine what to store as the response
        const effectiveResponse = outcome === 'positive'
            ? (response_given || null)
            : (better_response || null);

        // Detect signals from the original message for the new learned case
        const signalResult = CoachingEngine.identifyPersonalitySignals(original_message);

        // Save as a new learned case
        const { data: newCase, error } = await supabase
            .from('sean_coaching_cases')
            .insert({
                company_id:          companyId,
                trigger_phrase:      original_message,
                context:             null,
                personality_signals: signalResult,
                emotional_state:     emotional_state || signalResult.dominant || null,
                response_used:       effectiveResponse,
                outcome:             outcome,
                pattern_group:       pattern_group || signalResult.dominant || null,
                confidence:          confidence != null ? parseFloat(confidence) : null,
                learned_from_user:   true,
                created_by:          userId,
                created_at:          new Date().toISOString(),
                updated_at:          new Date().toISOString()
            })
            .select('id')
            .single();

        if (error) throw error;

        auditLog({
            companyId, userId,
            action:   'coaching_feedback_saved',
            caseId:   newCase.id,
            confidence: confidence || null,
            metadata: {
                outcome,
                dominant_signal: signalResult.dominant,
                pattern_group:   pattern_group || signalResult.dominant || null,
                had_better_response: Boolean(better_response)
            }
        });

        res.json({ ok: true, learned: true, caseId: newCase.id });
    } catch (err) {
        console.error('[coaching-routes] POST /feedback error:', err.message);
        res.status(500).json({ error: 'Failed to save coaching feedback' });
    }
});

// ─── GET /api/sean/coaching/patterns ──────────────────────────────────────────
// Return pattern dashboard stats for the authenticated company:
//   - total cases
//   - total learned-from-user cases
//   - pattern group breakdown (count + avg confidence)
//   - recent cases (5 most recent)
router.get('/patterns', async (req, res) => {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    try {
        // Fetch all cases for this company (for aggregation)
        const { data: cases, error } = await supabase
            .from('sean_coaching_cases')
            .select('id, pattern_group, confidence, emotional_state, learned_from_user, created_at, trigger_phrase, outcome')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const allCases = cases || [];
        const total            = allCases.length;
        const learnedFromUser  = allCases.filter(c => c.learned_from_user).length;

        // Group by pattern_group
        const groupMap = {};
        for (const c of allCases) {
            const key = c.pattern_group || 'unclassified';
            if (!groupMap[key]) groupMap[key] = { count: 0, confidenceSum: 0, confCount: 0 };
            groupMap[key].count++;
            if (c.confidence != null) {
                groupMap[key].confidenceSum += parseFloat(c.confidence);
                groupMap[key].confCount++;
            }
        }

        const patternGroups = Object.entries(groupMap).map(([group, stats]) => ({
            group,
            caseCount:     stats.count,
            avgConfidence: stats.confCount > 0
                ? parseFloat((stats.confidenceSum / stats.confCount).toFixed(4))
                : null
        })).sort((a, b) => b.caseCount - a.caseCount);

        // Recent cases (last 5, summary only — no sensitive trigger text)
        const recentCases = allCases.slice(0, 5).map(c => ({
            id:              c.id,
            patternGroup:    c.pattern_group,
            emotionalState:  c.emotional_state,
            outcome:         c.outcome,
            learnedFromUser: c.learned_from_user,
            confidence:      c.confidence,
            createdAt:       c.created_at
        }));

        res.json({
            ok: true,
            stats: {
                total,
                learnedFromUser,
                manualEntries: total - learnedFromUser,
                patternGroups,
                recentCases
            }
        });
    } catch (err) {
        console.error('[coaching-routes] GET /patterns error:', err.message);
        res.status(500).json({ error: 'Failed to retrieve coaching patterns' });
    }
});

// =============================================================================
// COACHING CLIENT CONTEXT ROUTES
// =============================================================================
// These routes proxy to the Coaching App backend to provide client context for
// the Sean coaching chat. All routes require:
//   1. Ecosystem authenticateToken (already applied above via router.use)
//   2. has_coaching_access flag on the ecosystem user (requireCoachingAccess)
//   3. COACHING_APP_URL + COACHING_APP_TOKEN env vars on the ecosystem server
//
// The Coaching App uses its own JWT system. The ecosystem backend authenticates
// with the Coaching App using a pre-configured service token (COACHING_APP_TOKEN).
// No Coaching App code is modified.
//
// DEPLOYMENT SETUP REQUIRED:
//   COACHING_APP_URL=https://<coaching-app-hostname>
//   COACHING_APP_TOKEN=<valid Coaching App JWT for the coach service account>
// =============================================================================

const COACHING_APP_URL   = process.env.COACHING_APP_URL   || null;
const COACHING_APP_TOKEN = process.env.COACHING_APP_TOKEN || null;

// Verify the requesting ecosystem user has coaching access.
// Access is granted if either:
//   (a) req.user.isSuperAdmin === true  — embedded in the JWT by /api/auth/login
//   (b) users.has_coaching_access = true in the DB  — for non-admin granted users
async function requireCoachingAccess(req, res, next) {
    // (a) Super admin bypass — isSuperAdmin is set in the JWT at login time
    if (req.user?.isSuperAdmin === true) {
        return next();
    }

    // (b) DB column check for non-super-admin users
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
        console.warn('[coaching-routes] requireCoachingAccess: no userId in token — role:', req.user?.role || 'unknown');
        return res.status(403).json({ error: 'Coaching access denied', code: 'NO_USER' });
    }
    try {
        const { data, error } = await supabase
            .from('users')
            .select('has_coaching_access')
            .eq('id', userId)
            .maybeSingle();

        if (error || !data || !data.has_coaching_access) {
            const reason = error    ? 'db_error:' + error.message
                         : !data   ? 'user_not_found'
                         :           'access_false';
            console.warn('[coaching-routes] coaching access denied — userId:', userId, 'reason:', reason);
            return res.status(403).json({
                error: 'Coaching access not authorised for this account',
                code: 'NO_COACHING_ACCESS'
            });
        }
        next();
    } catch (err) {
        console.error('[coaching-routes] has_coaching_access check failed:', err.message);
        return res.status(500).json({ error: 'Failed to verify coaching access' });
    }
}

// Proxy a request to the Coaching App backend using the configured service token.
// Throws with err.code === 'NOT_CONFIGURED' if env vars are missing.
async function coachingAppFetch(path, opts = {}) {
    if (!COACHING_APP_URL || !COACHING_APP_TOKEN) {
        const err = new Error(
            'Coaching App integration not configured (COACHING_APP_URL / COACHING_APP_TOKEN missing)'
        );
        err.code = 'NOT_CONFIGURED';
        throw err;
    }

    const url      = COACHING_APP_URL.replace(/\/$/, '') + path;
    const response = await fetch(url, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + COACHING_APP_TOKEN,
            ...(opts.headers || {})
        }
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const e = new Error(body.error || `Coaching App responded ${response.status}`);
        e.status = response.status;
        e.code   = 'COACHING_APP_ERROR';
        throw e;
    }
    return body;
}

// =============================================================================
// COACHING APP DATA HELPERS
// =============================================================================
// Non-fatal helpers — each returns null/[] on any error so a missing data
// source never blocks the rest of the context load.

const QB_CONTEXT_KEYS = [
    'general', 'session.checkin', 'session.reflection',
    'pgf.present', 'pgf.gap', 'pgf.future',
    'four_quadrants.goals', 'four_quadrants.fears', 'four_quadrants.dream_summary'
];

// Fetch the latest BASIS submission linked to a coaching client.
async function fetchClientBasisData(clientId) {
    try {
        const list    = await coachingAppFetch('/api/basis');
        const matches = (Array.isArray(list) ? list : [])
            .filter(s => s.linked_client_id === clientId);
        if (matches.length === 0) return null;
        const pick = matches.find(s => s.status === 'reviewed' || s.status === 'submitted')
            || matches[0];
        if (!pick || !pick.has_results) return null;
        return await coachingAppFetch(`/api/basis/${pick.id}`);
    } catch { return null; }
}

// Fetch the latest SPIL profile linked to a coaching client.
async function fetchClientSpilData(clientId) {
    try {
        const list    = await coachingAppFetch('/api/spil');
        const matches = (Array.isArray(list) ? list : [])
            .filter(p => p.linked_client_id === clientId);
        if (matches.length === 0) return null;
        const pick = matches.find(p => p.has_results) || matches[0];
        if (!pick) return null;
        return await coachingAppFetch(`/api/spil/${pick.id}`);
    } catch { return null; }
}

// Fetch answered questionnaire items across all known context keys.
async function fetchClientQuestionnaireData(clientId) {
    const answers = [];
    await Promise.all(QB_CONTEXT_KEYS.map(key =>
        coachingAppFetch(`/api/coaching/question-builder/client/${clientId}/context/${key}`)
            .then(rows => {
                (Array.isArray(rows) ? rows : []).forEach(q => {
                    const ansVal = q.answer_text
                        || (q.answer_number != null ? String(q.answer_number) : null)
                        || (q.answer_json ? JSON.stringify(q.answer_json) : null);
                    if (ansVal) {
                        answers.push({
                            question:   q.question_text,
                            answer:     ansVal,
                            section:    key,
                            category:   q.category    || null,
                            type:       q.question_type,
                            answeredAt: q.answered_at || null
                        });
                    }
                });
            })
            .catch(() => {})
    ));
    return answers;
}

// Normalize a raw basis_submissions row into a safe, structured object.
function normalizeBasis(raw) {
    if (!raw || !raw.basis_results) return null;
    const results = typeof raw.basis_results === 'string'
        ? JSON.parse(raw.basis_results) : raw.basis_results;
    const reportEditable = raw.report_editable
        ? (typeof raw.report_editable === 'string'
            ? JSON.parse(raw.report_editable) : raw.report_editable)
        : null;
    return { sections: results, status: raw.status || null, submittedAt: raw.submitted_at || null, reportSummary: reportEditable };
}

// Normalize a raw spil_profiles row into a safe, structured object.
function normalizeSpil(raw) {
    if (!raw || !raw.scores) return null;
    return {
        code:    raw.spil_code || null,
        scores:  typeof raw.scores  === 'string' ? JSON.parse(raw.scores)  : raw.scores,
        ranking: typeof raw.ranking === 'string' ? JSON.parse(raw.ranking) : raw.ranking
    };
}

// ─── GET /api/sean/coaching/clients/search ────────────────────────────────────
// Search coaching clients by name (min 2 chars). Returns up to 10 matches.
// MUST be declared before /clients/:clientId/* to prevent Express matching
// "search" as a clientId param.
router.get('/clients/search', requireCoachingAccess, async (req, res) => {
    const companyId = getCompanyId(req);
    const userId    = req.user?.email || req.user?.id || null;
    const q         = ((req.query.q || '')).trim().toLowerCase();

    if (!q || q.length < 2) {
        return res.status(400).json({ error: 'Search term q must be at least 2 characters' });
    }

    try {
        const data    = await coachingAppFetch('/api/clients');
        const matches = (data.clients || [])
            .filter(c => (c.name || '').toLowerCase().includes(q))
            .slice(0, 10)
            .map(c => ({
                id:          c.id,
                name:        c.name,
                status:      c.status,
                currentStep: c.current_step,
                lastSession: c.last_session || c.last_actual_session || null
            }));

        auditLog({ companyId, userId, action: 'coaching_client_search', metadata: { q, resultCount: matches.length } });

        res.json({ ok: true, clients: matches });
    } catch (err) {
        if (err.code === 'NOT_CONFIGURED') {
            return res.status(503).json({ error: err.message, code: err.code });
        }
        console.error('[coaching-routes] GET /clients/search:', err.message);
        res.status(500).json({ error: 'Client search failed' });
    }
});

// ─── GET /api/sean/coaching/clients/:clientId/context ─────────────────────────
// Lightweight client context for AI chat enrichment.
// Returns: name, step, dream, gauges, latest session summary.
router.get('/clients/:clientId/context', requireCoachingAccess, async (req, res) => {
    const companyId = getCompanyId(req);
    const userId    = req.user?.email || req.user?.id || null;
    const clientId  = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

    try {
        const data = await coachingAppFetch(`/api/clients/${clientId}`);
        const c    = data.client;
        if (!c) return res.status(404).json({ error: 'Client not found' });

        const latest = (c.sessions || [])[0] || null;
        const context = {
            id:          c.id,
            name:        c.name,
            status:      c.status,
            dream:       c.dream || null,
            currentStep: c.current_step,
            gauges:      c.gauges || {},
            latestSession: latest ? {
                date:        latest.session_date,
                summary:     latest.summary    || null,
                keyInsights: latest.key_insights || [],
                actionItems: latest.action_items || []
            } : null
        };

        auditLog({ companyId, userId, action: 'coaching_client_context_fetched', metadata: { clientId } });

        res.json({ ok: true, context });
    } catch (err) {
        if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
        if (err.status === 404) return res.status(404).json({ error: 'Client not found' });
        console.error('[coaching-routes] GET /clients/:id/context:', err.message);
        res.status(500).json({ error: 'Failed to load client context' });
    }
});

// ─── GET /api/sean/coaching/clients/:clientId/latest-session ──────────────────
// Most recent session notes for a coaching client.
router.get('/clients/:clientId/latest-session', requireCoachingAccess, async (req, res) => {
    const companyId = getCompanyId(req);
    const userId    = req.user?.email || req.user?.id || null;
    const clientId  = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

    try {
        const data    = await coachingAppFetch(`/api/clients/${clientId}`);
        const c       = data.client;
        if (!c) return res.status(404).json({ error: 'Client not found' });

        const session = (c.sessions || [])[0] || null;

        auditLog({ companyId, userId, action: 'coaching_latest_session_fetched', metadata: { clientId, hasSession: !!session } });

        res.json({
            ok:         true,
            clientName: c.name,
            session:    session ? {
                date:        session.session_date,
                duration:    session.duration_minutes,
                summary:     session.summary,
                keyInsights: session.key_insights || [],
                actionItems: session.action_items || [],
                moodBefore:  session.mood_before,
                moodAfter:   session.mood_after
            } : null
        });
    } catch (err) {
        if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
        if (err.status === 404) return res.status(404).json({ error: 'Client not found' });
        console.error('[coaching-routes] GET /clients/:id/latest-session:', err.message);
        res.status(500).json({ error: 'Failed to load latest session' });
    }
});

// ─── GET /api/sean/coaching/clients/:clientId/full-profile ────────────────────
// Full coaching profile: steps, gauges, last 5 sessions, BASIS, SPIL.
router.get('/clients/:clientId/full-profile', requireCoachingAccess, async (req, res) => {
    const companyId = getCompanyId(req);
    const userId    = req.user?.email || req.user?.id || null;
    const clientId  = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

    try {
        const [clientResp, basisRaw, spilRaw] = await Promise.all([
            coachingAppFetch(`/api/clients/${clientId}`),
            fetchClientBasisData(clientId).catch(() => null),
            fetchClientSpilData(clientId).catch(() => null)
        ]);

        const c = clientResp.client;
        if (!c) return res.status(404).json({ error: 'Client not found' });

        const basis = normalizeBasis(basisRaw);
        const spil  = normalizeSpil(spilRaw);

        auditLog({ companyId, userId, action: 'coaching_full_profile_fetched', metadata: { clientId, hasBasis: !!basis, hasSpil: !!spil } });

        res.json({
            ok: true,
            profile: {
                id:           c.id,
                name:         c.name,
                email:        c.email    || null,
                status:       c.status,
                dream:        c.dream    || null,
                currentStep:  c.current_step,
                gauges:       c.gauges   || {},
                preferredLang: c.preferred_lang,
                lastSession:  c.last_session || null,
                steps: (c.steps || []).map(s => ({
                    id:        s.step_id,
                    name:      s.step_name,
                    order:     s.step_order,
                    completed: s.completed
                })),
                sessions: (c.sessions || []).slice(0, 5).map(s => ({
                    date:        s.session_date,
                    duration:    s.duration_minutes,
                    summary:     s.summary,
                    keyInsights: s.key_insights || [],
                    actionItems: s.action_items || [],
                    moodBefore:  s.mood_before,
                    moodAfter:   s.mood_after
                }))
            },
            basis,
            spil,
            availability: {
                basis:    !!basis,
                spil:     !!spil,
                sessions: (c.sessions || []).length > 0,
                gauges:   Object.keys(c.gauges || {}).length > 0
            }
        });
    } catch (err) {
        if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
        if (err.status === 404) return res.status(404).json({ error: 'Client not found' });
        console.error('[coaching-routes] GET /clients/:id/full-profile:', err.message);
        res.status(500).json({ error: 'Failed to load full profile' });
    }
});

// ─── POST /api/sean/coaching/client-chat ──────────────────────────────────────
// Coaching chat with optional client context injection.
// If coaching_client_id is provided, the client's step, dream, and gauge data
// are injected as a prefix into the pattern engine input. Sean never diagnoses
// — coaching process context only.
router.post('/client-chat', requireCoachingAccess, async (req, res) => {
    const companyId = getCompanyId(req);
    const userId    = req.user?.email || req.user?.id || null;
    const { message, coaching_client_id } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
    }

    const inputText    = message.trim();
    let   clientCtx    = null;

    if (coaching_client_id) {
        try {
            const data = await coachingAppFetch(`/api/clients/${coaching_client_id}`);
            const c    = data.client;
            if (c) {
                const latest = (c.sessions || [])[0] || null;
                clientCtx = {
                    name:        c.name,
                    dream:       c.dream || null,
                    currentStep: c.current_step,
                    gauges:      c.gauges || {},
                    latestSession: latest ? {
                        date:        latest.session_date,
                        summary:     latest.summary || null,
                        keyInsights: latest.key_insights || []
                    } : null
                };
            }
        } catch (fetchErr) {
            if (fetchErr.code === 'NOT_CONFIGURED') {
                return res.status(503).json({ error: fetchErr.message, code: fetchErr.code });
            }
            // Non-fatal — continue without client context on other errors
            console.warn('[coaching-routes] client context fetch skipped:', fetchErr.message);
        }
    }

    try {
        let enrichedInput = inputText;
        if (clientCtx) {
            const gaugeStr  = Object.entries(clientCtx.gauges).map(([k, v]) => `${k}=${v}`).join(', ');
            const parts     = [`Kliënt: ${clientCtx.name}, Stap ${clientCtx.currentStep}`];
            if (clientCtx.dream) parts.push(`Droom: ${clientCtx.dream}`);
            if (clientCtx.latestSession && clientCtx.latestSession.summary) {
                parts.push(`Laaste sessie: ${clientCtx.latestSession.summary}`);
            }
            parts.push(`Meters: ${gaugeStr}`);
            enrichedInput = `[${parts.join(' | ')}]\n${inputText}`;
        }

        const signalResult = CoachingEngine.identifyPersonalitySignals(enrichedInput);
        const scoredCases  = await CoachingEngine.findSimilarCases(enrichedInput, companyId, supabase, signalResult);
        const topCase      = scoredCases[0] || null;
        const topConf      = topCase ? topCase.confidence : 0;

        let response, source, pattern = null;
        if (topConf >= CoachingEngine.CONFIDENCE_THRESHOLD && scoredCases.length >= 1) {
            pattern  = CoachingEngine.buildPattern(scoredCases.slice(0, 10));
            const sg = CoachingEngine.suggestResponse(pattern, signalResult.dominant, topConf);
            response = sg.response;
            source   = sg.source;
        } else {
            const sg = CoachingEngine.suggestResponse(null, signalResult.dominant, topConf);
            response = sg.response;
            source   = sg.source;
        }

        auditLog({
            companyId, userId,
            action:   'coaching_client_chat',
            metadata: {
                has_client_context: !!clientCtx,
                client_id:          coaching_client_id || null,
                source,
                top_confidence:     topConf,
                dominant_signal:    signalResult.dominant
            }
        });

        res.json({
            ok:             true,
            response,
            source,
            confidence:     topConf,
            dominantSignal: signalResult.dominant,
            patternGroup:   pattern?.patternGroup || null,
            clientContext:  clientCtx ? { name: clientCtx.name, currentStep: clientCtx.currentStep } : null
        });

    } catch (err) {
        console.error('[coaching-routes] POST /client-chat:', err.message);
        res.status(500).json({ error: 'Coaching chat failed' });
    }
});

// ─── POST /api/sean/coaching/session-prep/:clientId ───────────────────────────
// Generate a structured session preparation summary: current step, gauge
// highlights, outstanding action items from the last session, BASIS data,
// and questionnaire answers.
router.post('/session-prep/:clientId', requireCoachingAccess, async (req, res) => {
    const companyId = getCompanyId(req);
    const userId    = req.user?.email || req.user?.id || null;
    const clientId  = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

    const STEP_NAMES = {
        1:'Four Quadrant Oefening', 2:'Present-Gap-Future', 3:'Vlugplan',
        4:'Deep Dive', 5:'Assesserings & Ecochart', 6:'Die Dashboard',
        7:'Psigo-Opvoeding', 8:'MLNP (Gesigkaarte)', 9:'Herassessering',
        10:'Herbesoek', 11:'Die Droom-Plek', 12:'Waardes & Oortuigings',
        13:'Sukses-eienskappe', 14:'Nuuskierigheid/Passie/Doel',
        15:'Kreatiwiteit & Vloei'
    };
    const LOWER_IS_BETTER = ['weight', 'negative'];
    const GAUGE_LABELS    = {
        fuel:'Energie/Brandstof', horizon:'Visie/Horison', thrust:'Dryfkrag',
        engine:'Innerlike Motor', compass:'Rigting', positive:'Positiwiteit',
        weight:'Emosionele Las', nav:'Navigasie', negative:'Negatiwiteit'
    };

    try {
        const [clientResp, basisRaw, questionnaireAnswers] = await Promise.all([
            coachingAppFetch(`/api/clients/${clientId}`),
            fetchClientBasisData(clientId).catch(() => null),
            fetchClientQuestionnaireData(clientId).catch(() => [])
        ]);

        const c = clientResp.client;
        if (!c) return res.status(404).json({ error: 'Client not found' });

        const gauges  = c.gauges || {};
        const latest  = (c.sessions || [])[0] || null;

        const gaugeHighlights = Object.entries(gauges).reduce((acc, [key, value]) => {
            const lowerIsBetter = LOWER_IS_BETTER.includes(key);
            const concerning    = lowerIsBetter ? value > 60 : value < 40;
            const strong        = lowerIsBetter ? value < 30 : value > 70;
            if (concerning) acc.concerns.push({ gauge: GAUGE_LABELS[key] || key, value });
            if (strong)     acc.strengths.push({ gauge: GAUGE_LABELS[key] || key, value });
            return acc;
        }, { concerns: [], strengths: [] });

        const basis = normalizeBasis(basisRaw);

        auditLog({ companyId, userId, action: 'coaching_session_prep_generated', metadata: { clientId, hasBasis: !!basis, questionnaireCount: (questionnaireAnswers || []).length } });

        res.json({
            ok:   true,
            prep: {
                clientName:     c.name,
                currentStep:    c.current_step,
                stepName:       STEP_NAMES[c.current_step] || `Stap ${c.current_step}`,
                dream:          c.dream || null,
                gaugeHighlights,
                completedSteps: (c.steps || []).filter(s => s.completed).length,
                totalSteps:     (c.steps || []).length,
                latestSession:  latest ? {
                    date:        latest.session_date,
                    summary:     latest.summary     || null,
                    keyInsights: latest.key_insights || [],
                    actionItems: latest.action_items || []
                } : null
            },
            basis,
            questionnaire: (questionnaireAnswers || []).length > 0 ? questionnaireAnswers : null,
            availability: {
                basis:         !!basis,
                questionnaire: (questionnaireAnswers || []).length > 0,
                sessions:      !!(c.sessions && c.sessions.length > 0),
                gauges:        Object.keys(gauges).length > 0
            }
        });
    } catch (err) {
        if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
        if (err.status === 404) return res.status(404).json({ error: 'Client not found' });
        console.error('[coaching-routes] POST /session-prep:', err.message);
        res.status(500).json({ error: 'Session prep failed' });
    }
});

// ─── GET /api/sean/coaching/clients/:clientId/rich-context ────────────────────
// Full normalized coaching context: client + BASIS + SPIL + questionnaire +
// sessions + gauges, with per-section availability flags.
// Used for client-mode chat enrichment and the coaching availability badge.
router.get('/clients/:clientId/rich-context', requireCoachingAccess, async (req, res) => {
    const companyId = getCompanyId(req);
    const userId    = req.user?.email || req.user?.id || null;
    const clientId  = parseInt(req.params.clientId, 10);
    if (isNaN(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

    try {
        const [clientResp, basisRaw, spilRaw, questionnaireAnswers] = await Promise.all([
            coachingAppFetch(`/api/clients/${clientId}`),
            fetchClientBasisData(clientId).catch(() => null),
            fetchClientSpilData(clientId).catch(() => null),
            fetchClientQuestionnaireData(clientId).catch(() => [])
        ]);

        const c = clientResp.client;
        if (!c) return res.status(404).json({ error: 'Client not found' });

        const basis    = normalizeBasis(basisRaw);
        const spil     = normalizeSpil(spilRaw);
        const qAnswers = questionnaireAnswers || [];
        const latest   = (c.sessions || [])[0] || null;

        const availability = {
            client:        true,
            basis:         !!basis,
            spil:          !!spil,
            questionnaire: qAnswers.length > 0,
            sessions:      (c.sessions || []).length > 0,
            gauges:        Object.keys(c.gauges || {}).length > 0
        };

        auditLog({ companyId, userId, action: 'coaching_client_context_viewed', metadata: { clientId, availability } });

        res.json({
            ok: true,
            context: {
                client: {
                    id:           c.id,
                    name:         c.name,
                    email:        c.email  || null,
                    phone:        c.phone  || null,
                    status:       c.status,
                    dream:        c.dream  || null,
                    currentStep:  c.current_step,
                    preferredLang: c.preferred_lang || 'af'
                },
                basis,
                spil,
                questionnaire: qAnswers.length > 0 ? qAnswers : null,
                sessions: {
                    latest: latest ? {
                        date:        latest.session_date,
                        duration:    latest.duration_minutes,
                        summary:     latest.summary || null,
                        keyInsights: latest.key_insights || [],
                        actionItems: latest.action_items || [],
                        moodBefore:  latest.mood_before,
                        moodAfter:   latest.mood_after
                    } : null,
                    previous: (c.sessions || []).slice(1, 3).map(s => ({
                        date:        s.session_date,
                        summary:     s.summary || null,
                        actionItems: s.action_items || []
                    }))
                },
                gauges: c.gauges || {},
                steps: (c.steps || []).map(s => ({
                    id:        s.step_id,
                    name:      s.step_name,
                    order:     s.step_order,
                    completed: s.completed
                })),
                availability
            }
        });
    } catch (err) {
        if (err.code === 'NOT_CONFIGURED') return res.status(503).json({ error: err.message, code: err.code });
        if (err.status === 404) return res.status(404).json({ error: 'Client not found' });
        console.error('[coaching-routes] GET /clients/:id/rich-context:', err.message);
        res.status(500).json({ error: 'Failed to load client context' });
    }
});

module.exports = router;
