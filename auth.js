// Deliberately simple: one .env-configured user list, in-memory session tokens (lost on
// restart), no OAuth/SSO. Good enough for a handful of operators behind an SSH tunnel; upgrading
// to real SSO is an explicit non-goal for v1.
import crypto from 'node:crypto';

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

export function parseUsers(spec) {
  return (spec || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [username, password, role] = entry.split(':');
      return { username, password, role };
    });
}

export function roleAtLeast(role, min) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 0) && (ROLE_RANK[min] || 0) > 0;
}

export function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // keep the comparison cost roughly constant
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createAuth({ users }) {
  const byUsername = new Map(users.map(u => [u.username, u]));
  const sessions = new Map(); // token -> { username, role, createdAt }

  function login(username, password) {
    const u = byUsername.get(username);
    if (!u || !safeEqual(password, u.password)) return null;
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username: u.username, role: u.role, createdAt: Date.now() });
    return { token, username: u.username, role: u.role };
  }

  function logout(token) {
    if (token) sessions.delete(token);
  }

  function sessionFor(token) {
    if (!token) return null;
    const s = sessions.get(token);
    return s ? { username: s.username, role: s.role } : null;
  }

  return { login, logout, sessionFor };
}
