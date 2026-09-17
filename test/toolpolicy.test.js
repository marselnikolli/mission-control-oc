import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolPolicy } from '../toolpolicy.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-toolpolicy-'));
}

describe('createToolPolicy', () => {
  test('defaults an unset agent/tool pair to "ask"', () => {
    const policy = createToolPolicy({ dir: tmpDir() });
    assert.equal(policy.get('sysadmin', 'exec'), 'ask');
  });

  test('set() then get() round-trips the policy', () => {
    const policy = createToolPolicy({ dir: tmpDir() });
    policy.set('sysadmin', 'exec', 'allow');
    assert.equal(policy.get('sysadmin', 'exec'), 'allow');
  });

  test('rejects an invalid policy value', () => {
    const policy = createToolPolicy({ dir: tmpDir() });
    assert.throws(() => policy.set('sysadmin', 'exec', 'sometimes'), /allow\/ask\/deny/);
  });

  test('policies are scoped per agent+tool pair independently', () => {
    const policy = createToolPolicy({ dir: tmpDir() });
    policy.set('sysadmin', 'exec', 'allow');
    assert.equal(policy.get('security', 'exec'), 'ask');
    assert.equal(policy.get('sysadmin', 'openssl'), 'ask');
  });

  test('list() returns every stored policy', () => {
    const policy = createToolPolicy({ dir: tmpDir() });
    policy.set('sysadmin', 'exec', 'allow');
    policy.set('security', 'openssl', 'deny');
    assert.deepEqual(policy.list(), { 'sysadmin:exec': 'allow', 'security:openssl': 'deny' });
  });

  test('persists across separate instances pointed at the same dir', () => {
    const dir = tmpDir();
    const a = createToolPolicy({ dir });
    a.set('sysadmin', 'exec', 'deny');
    const b = createToolPolicy({ dir });
    assert.equal(b.get('sysadmin', 'exec'), 'deny');
  });
});
