import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-'));
}

describe('createStore', () => {
  test('starting a mission adds it to the mission list as running', () => {
    const store = createStore({ dir: tmpDir() });
    store.startMission('m1', 'check disk usage', 1000);
    const missions = store.listMissions();
    assert.equal(missions.length, 1);
    assert.deepEqual(missions[0], { id: 'm1', label: 'check disk usage', startedAt: 1000, endedAt: null, status: 'running' });
  });

  test('starting a second mission marks the previous one completed', () => {
    const store = createStore({ dir: tmpDir() });
    store.startMission('m1', 'first', 1000);
    store.startMission('m2', 'second', 2000);
    const missions = store.listMissions();
    const first = missions.find(m => m.id === 'm1');
    const second = missions.find(m => m.id === 'm2');
    assert.equal(first.status, 'completed');
    assert.equal(first.endedAt, 2000);
    assert.equal(second.status, 'running');
  });

  test('appended ops for a mission can be read back in order', () => {
    const store = createStore({ dir: tmpDir() });
    store.startMission('m1', 'first', 1000);
    store.appendOp('m1', { op: 'upsert', node: { id: 'agent:main', status: 'thinking' } });
    store.appendOp('m1', { op: 'log', agent: 'main', text: 'hello' });
    const ops = store.loadMissionOps('m1');
    assert.equal(ops.length, 2);
    assert.equal(ops[0].op, 'upsert');
    assert.equal(ops[1].text, 'hello');
  });

  test('a mission with no ops yet reads back as an empty list', () => {
    const store = createStore({ dir: tmpDir() });
    store.startMission('m1', 'first', 1000);
    assert.deepEqual(store.loadMissionOps('m1'), []);
  });

  test('history persists across separate store instances pointed at the same dir', () => {
    const dir = tmpDir();
    const a = createStore({ dir });
    a.startMission('m1', 'first', 1000);
    a.appendOp('m1', { op: 'log', agent: 'main', text: 'hello' });

    const b = createStore({ dir });
    assert.equal(b.listMissions().length, 1);
    assert.equal(b.loadMissionOps('m1')[0].text, 'hello');
  });

  test('an unknown mission id reads back as an empty list rather than throwing', () => {
    const store = createStore({ dir: tmpDir() });
    assert.deepEqual(store.loadMissionOps('does-not-exist'), []);
  });

  test('mission ids are sanitized so they cannot escape the store directory', () => {
    const store = createStore({ dir: tmpDir() });
    assert.throws(() => store.startMission('../../etc/passwd', 'x', 1), /invalid mission id/i);
  });
});
