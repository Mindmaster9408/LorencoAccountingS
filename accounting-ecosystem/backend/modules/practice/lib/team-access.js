'use strict';

// Canonical practice team-member / manager-role helper.
//
// Root cause fixed here (2026-07-05 Planning Board access incident):
// every practice_* route module had its own copy-pasted
// MANAGER_ROLES / _myTeamMember / _isManager / _requireManager block that
// looked a user up in practice_team_members by user_id ONLY. When a roster
// row existed (e.g. seeded) with user_id left NULL, the lookup returned
// null and the user was 403'd — including super admins, since no module
// ever checked req.user.isSuperAdmin. All practice_* modules now delegate
// their manager-role gating to this single module instead of duplicating
// the lookup/role logic.

const MANAGER_ROLES = ['owner', 'partner', 'admin', 'manager'];

// Only used when a super admin has no practice_team_members roster row at
// all (see getMyTeamMember below). Never persisted.
const SUPER_ADMIN_BYPASS_ROLE = 'owner';

const TEAM_MEMBER_FIELDS = 'id, display_name, role, user_id, email';

// Resolves the practice_team_members row for the calling user.
// `user` is req.user (the decoded JWT) — needs userId, and optionally
// email / isSuperAdmin for the fallback paths below.
async function getMyTeamMember(supabase, companyId, user) {
    if (!user || !user.userId) return null;

    const { data: byUserId } = await supabase.from('practice_team_members')
        .select(TEAM_MEMBER_FIELDS)
        .eq('company_id', companyId).eq('user_id', user.userId).eq('is_active', true)
        .maybeSingle();
    if (byUserId) return byUserId;

    // Self-healing email fallback: a roster row can exist with a matching
    // login email but no user_id link (e.g. added before the login
    // account existed, or the "Link to Login Account" step was skipped).
    // Only heals when exactly one active, unlinked row matches the email —
    // never touches a row that already has a different user_id, and never
    // guesses across multiple candidates.
    if (user.email) {
        const { data: candidates } = await supabase.from('practice_team_members')
            .select(TEAM_MEMBER_FIELDS)
            .eq('company_id', companyId).eq('is_active', true).is('user_id', null)
            .ilike('email', user.email);
        if (candidates && candidates.length === 1) {
            const { data: healed } = await supabase.from('practice_team_members')
                .update({ user_id: user.userId, updated_at: new Date().toISOString() })
                .eq('id', candidates[0].id).is('user_id', null)
                .select(TEAM_MEMBER_FIELDS).maybeSingle();
            return healed || candidates[0];
        }
    }

    // Super admin bypass (CLAUDE.md Rule F1 — super users get unrestricted
    // access to every app). Only engages when no real roster row was found
    // above; a super admin who IS on the roster always uses their real
    // row/role instead of this synthetic one.
    if (user.isSuperAdmin) {
        return {
            id: null,
            display_name: user.fullName || user.email || 'Super Admin',
            role: SUPER_ADMIN_BYPASS_ROLE,
            user_id: user.userId,
            email: user.email || null,
            _superAdminBypass: true,
        };
    }

    return null;
}

function isManagerRole(role) {
    return !!role && MANAGER_ROLES.includes(role);
}

function isManager(member) {
    return !!member && isManagerRole(member.role);
}

// Full gate: resolves the team member and 403s with `errorMessage` if they
// aren't manager-level. Returns the member (real or bypass) on success, or
// null after already sending the 403 response.
async function requireManager(req, res, supabase, errorMessage) {
    const member = await getMyTeamMember(supabase, req.companyId, req.user);
    if (!isManager(member)) {
        res.status(403).json({
            error: errorMessage || 'Only owners, partners, admins, and practice managers can perform this action.',
        });
        return null;
    }
    return member;
}

module.exports = {
    MANAGER_ROLES,
    getMyTeamMember,
    isManagerRole,
    isManager,
    requireManager,
};
