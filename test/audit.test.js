import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAudit } from '../audit.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-audit-'));
}

describe('createAudit', () => {
  test('records an entry and reads it back with a timestamp attached', () => {
    const audit = createAudit({ dir: tmpDir() });
    audit.record({ user: 'alice', action: 'login', result: 'ok' });
    const entries = audit.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].user, 'alice');
    assert.equal(entries[0].action, 'login');
    assert.equal(typeof entries[0].at, 'number');
  });

  test('list returns entries in the order they were recorded', () => {
    const audit = createAudit({ dir: tmpDir() });
    audit.record({ user: 'alice', action: 'login', result: 'ok' });
    audit.record({ user: 'alice', action: 'approve', target: 'appr-1', result: 'ok' });
    const entries = audit.list();
    assert.deepEqual(entries.map(e => e.action), ['login', 'approve']);
  });

  test('list caps to the requested limit, keeping the most recent entries', () => {
    const audit = createAudit({ dir: tmpDir() });
    for (let i = 0; i < 5; i++) audit.record({ user: 'alice', action: `event-${i}` });
    const entries = audit.list(2);
    assert.deepEqual(entries.map(e => e.action), ['event-3', 'event-4']);
  });

  test('an empty audit log reads back as an empty list', () => {
    const audit = createAudit({ dir: tmpDir() });
    assert.deepEqual(audit.list(), []);
  });

  test('entries persist across separate createAudit instances pointed at the same dir', () => {
    const dir = tmpDir();
    const a = createAudit({ dir });
    a.record({ user: 'alice', action: 'login' });
    const b = createAudit({ dir });
    assert.equal(b.list().length, 1);
  });
});
