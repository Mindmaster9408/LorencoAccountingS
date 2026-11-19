'use strict';

/** Login identity normalization — mixed-case emails ("Leo@…") must never strand a user again. */
const { normalizeLogin, loginOrFilter, pgQuote } = require('../shared/utils/loginIdentity');

describe('loginIdentity', () => {
  test('normalizeLogin trims and lower-cases; empty → null', () => {
    expect(normalizeLogin('  Leo@Example.COM ')).toBe('leo@example.com');
    expect(normalizeLogin('')).toBeNull();
    expect(normalizeLogin('   ')).toBeNull();
    expect(normalizeLogin(null)).toBeNull();
    expect(normalizeLogin(undefined)).toBeNull();
  });

  test('loginOrFilter matches the typed value and its lower-case form on username and email', () => {
    expect(loginOrFilter(' Leo@Example.com ')).toBe(
      'username.eq."Leo@Example.com",username.eq."leo@example.com",email.eq."Leo@Example.com",email.eq."leo@example.com"');
  });

  test('already lower-case input produces no duplicate conditions', () => {
    expect(loginOrFilter('leo@example.com', ['email'])).toBe('email.eq."leo@example.com"');
  });

  test('a typed comma cannot add an extra filter condition', () => {
    const f = loginOrFilter('nobody,id.eq.1', ['email']);
    expect(f).toBe('email.eq."nobody,id.eq.1"');
  });

  test('quotes and backslashes are escaped', () => {
    expect(pgQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});
