import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsers, roleAtLeast, parseCookie, createAuth } from '../auth.js';

describe('parseUsers', () => {
  test('parses a comma-separated username:password:role list', () => {
    const users = parseUsers('alice:secret1:admin,bob:secret2:operator');
    assert.deepEqual(users, [
      { username: 'alice', password: 'secret1', role: 'admin' },
      { username: 'bob', password: 'secret2', role: 'operator' },
    ]);
  });

  test('returns an empty list for empty/undefined input', () => {
    assert.deepEqual(parseUsers(''), []);
    assert.deepEqual(parseUsers(undefined), []);
  });

  test('ignores stray whitespace and empty entries', () => {
    assert.deepEqual(parseUsers(' alice:secret1:admin , , '), [{ username: 'alice', password: 'secret1', role: 'admin' }]);
  });
});

describe('roleAtLeast', () => {
  test('orders viewer < operator < admin', () => {
    assert.equal(roleAtLeast('admin', 'operator'), true);
    assert.equal(roleAtLeast('operator', 'admin'), false);
    assert.equal(roleAtLeast('viewer', 'viewer'), true);
    assert.equal(roleAtLeast('operator', 'viewer'), true);
  });

  test('an unknown role never satisfies a real minimum', () => {
    assert.equal(roleAtLeast('bogus', 'viewer'), false);
  });
});

describe('parseCookie', () => {
  test('reads a named cookie out of a Cookie header', () => {
    assert.equal(parseCookie('mc_session=abc123; other=x', 'mc_session'), 'abc123');
  });

  test('returns null when the header is missing or the cookie is absent', () => {
    assert.equal(parseCookie(undefined, 'mc_session'), null);
    assert.equal(parseCookie('other=x', 'mc_session'), null);
  });

  test('decodes URL-encoded cookie values', () => {
    assert.equal(parseCookie('mc_session=a%2Fb', 'mc_session'), 'a/b');
  });
});

describe('createAuth', () => {
  const users = [
    { username: 'alice', password: 'secret1', role: 'admin' },
    { username: 'bob', password: 'secret2', role: 'operator' },
  ];

  test('login succeeds with the right username and password and returns a token + role', () => {
    const auth = createAuth({ users });
    const session = auth.login('alice', 'secret1');
    assert.equal(session.role, 'admin');
    assert.equal(typeof session.token, 'string');
    assert.ok(session.token.length >= 32);
  });

  test('login fails for a wrong password', () => {
    const auth = createAuth({ users });
    assert.equal(auth.login('alice', 'wrong'), null);
  });

  test('login fails for an unknown username', () => {
    const auth = createAuth({ users });
    assert.equal(auth.login('mallory', 'anything'), null);
  });

  test('sessionFor resolves an issued token back to its user and role', () => {
    const auth = createAuth({ users });
    const { token } = auth.login('bob', 'secret2');
    assert.deepEqual(auth.sessionFor(token), { username: 'bob', role: 'operator' });
  });

  test('sessionFor returns null for an unknown or missing token', () => {
    const auth = createAuth({ users });
    assert.equal(auth.sessionFor('not-a-real-token'), null);
    assert.equal(auth.sessionFor(null), null);
  });

  test('logout invalidates the session', () => {
    const auth = createAuth({ users });
    const { token } = auth.login('alice', 'secret1');
    auth.logout(token);
    assert.equal(auth.sessionFor(token), null);
  });

  test('two logins for the same user get different tokens', () => {
    const auth = createAuth({ users });
    const a = auth.login('alice', 'secret1');
    const b = auth.login('alice', 'secret1');
    assert.notEqual(a.token, b.token);
  });
});
