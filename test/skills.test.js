import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSkillsStore, listRows, DEFAULT_SKILLS } from '../skills.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-skills-')); }

test('listRows accepts the catalog shapes Gateways emit', () => {
  const skill = { name: 'a' };
  assert.deepEqual(listRows([skill]), [skill]);
  assert.deepEqual(listRows({ skills: [skill] }), [skill]);
  assert.deepEqual(listRows({ list: { skills: [skill] } }), [skill]);
  assert.deepEqual(listRows({ catalog: [skill] }), [skill]);
  assert.deepEqual(listRows({ data: { skills: [skill] } }), [skill]);
  assert.deepEqual(listRows({ nope: 1 }), []);
});

test('a fresh store seeds the default catalog and persists it', () => {
  const dir = tmp();
  const store = createSkillsStore({ dir });
  assert.equal(store.list().length, DEFAULT_SKILLS.length);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'skills.json'), 'utf8'));
  assert.equal(onDisk.length, DEFAULT_SKILLS.length);
  // Second instance sees the same records.
  const again = createSkillsStore({ dir });
  assert.equal(again.list().length, DEFAULT_SKILLS.length);
});

test('merge adds new skills and reports changes', () => {
  const store = createSkillsStore({ dir: tmp() });
  const before = store.list().length;
  const { changed, skills } = store.merge({ skills: [{ name: 'brand-new', version: '0.1.0' }] });
  assert.equal(changed, true);
  assert.equal(skills.length, before + 1);
  assert.equal(store.get('brand-new').status, 'installed');
  // A no-op merge marks nothing changed.
  const noop = store.merge([{ name: 'brand-new', version: '0.1.0' }]);
  assert.equal(noop.changed, false);
});

test('applyAction enables, disables, updates, installs, removes', () => {
  const store = createSkillsStore({ dir: tmp(), seed: [] });
  assert.equal(store.get('memorize'), null);
  store.applyAction('memorize', 'install', { source: 'registry' });
  assert.equal(store.get('memorize').status, 'installed');
  assert.equal(store.get('memorize').enabled, true);
  store.applyAction('memorize', 'disable');
  assert.equal(store.get('memorize').enabled, false);
  store.applyAction('memorize', 'enable');
  assert.equal(store.get('memorize').enabled, true);
  store.applyAction('memorize', 'update', { version: '3.0.0' });
  assert.equal(store.get('memorize').version, '3.0.0');
  store.applyAction('memorize', 'remove');
  assert.equal(store.get('memorize'), null);
});