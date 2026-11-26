'use strict';

const fs = require('fs');
const path = require('path');
const {
  DIRECTOR_ROLES, normalizeDirectorRole, defaultDirectorRole,
  resolveDefaultDirectorRole, invalidRoleMessage,
} = require('../modules/practice/lib/director-roles');

describe('director roles', () => {
  test('includes director and member alongside the old roles', () => {
    expect(DIRECTOR_ROLES).toEqual(['director', 'executive', 'non_executive', 'alternate', 'member']);
  });

  test.each([
    ['Director', 'director'], ['DIRECTOR', 'director'], [' director ', 'director'],
    ['member', 'member'], ['Member', 'member'], ['CC Member', 'member'],
    ['executive', 'executive'], ['Executive Director', 'executive'],
    ['Non-Executive', 'non_executive'], ['non executive director', 'non_executive'], ['nonexecutive', 'non_executive'],
    ['Alternate', 'alternate'], ['alternate director', 'alternate'],
  ])('normalises %j → %s', (input, expected) => {
    expect(normalizeDirectorRole(input)).toBe(expected);
  });

  test('no role → undefined; unknown role → null', () => {
    expect(normalizeDirectorRole(undefined)).toBeUndefined();
    expect(normalizeDirectorRole(null)).toBeUndefined();
    expect(normalizeDirectorRole('  ')).toBeUndefined();
    expect(normalizeDirectorRole('chairman')).toBeNull();
    expect(normalizeDirectorRole('secretary')).toBeNull();
  });

  test('default: member for a CC, director otherwise; profile type wins over client type', () => {
    expect(defaultDirectorRole('cc', 'company')).toBe('member');
    expect(defaultDirectorRole(null, 'cc')).toBe('member');
    expect(defaultDirectorRole('pty_ltd', 'cc')).toBe('director');
    expect(defaultDirectorRole('pty_ltd', 'company')).toBe('director');
    expect(defaultDirectorRole(null, null)).toBe('director');
    expect(defaultDirectorRole('npc', undefined)).toBe('director');
  });

  test('resolveDefaultDirectorRole reads profile + client without creating a profile', async () => {
    const calls = [];
    const fake = (rows) => ({
      from(table) {
        const q = {
          select() { return q; }, eq() { return q; },
          insert() { calls.push(['insert', table]); return q; },
          maybeSingle: async () => ({ data: rows[table] || null }),
        };
        return q;
      },
    });
    expect(await resolveDefaultDirectorRole(fake({ practice_clients: { client_type: 'cc' } }), 1, 2)).toBe('member');
    expect(await resolveDefaultDirectorRole(fake({ practice_secretarial_profiles: { company_type: 'pty_ltd' }, practice_clients: { client_type: 'cc' } }), 1, 2)).toBe('director');
    expect(await resolveDefaultDirectorRole(fake({}), 1, 2)).toBe('director');
    expect(calls).toEqual([]);
  });

  test('error message lists the valid roles', () => {
    expect(invalidRoleMessage('chairman')).toMatch(/director, executive, non_executive, alternate, member/);
  });

  test('migration CHECK constraint matches DIRECTOR_ROLES', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'config', 'migrations', '191_director_roles_director_member.sql'), 'utf8');
    const m = /CHECK \(role IN \(([^)]*)\)\)/.exec(sql);
    expect(m).toBeTruthy();
    const roles = m[1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(roles.sort()).toEqual([...DIRECTOR_ROLES].sort());
  });

  test('routes no longer hardcode the old role list or default to executive', () => {
    const dir = path.join(__dirname, '..', 'modules', 'practice');
    for (const f of ['secretarial.js', 'secretarial-workflows.js']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).not.toMatch(/role \|\| 'executive'/);
      expect(src).toMatch(/director-roles/);
    }
  });
});
