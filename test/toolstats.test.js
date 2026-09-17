import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../store.js';
import { computeToolStats } from '../toolstats.js';

function tmpStore() {
  return createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-toolstats-')) });
}

function startOp(callId, tool, agentNode, at) {
  return { op: 'upsert', node: { id: `tool:${callId}`, parent: agentNode, kind: 'tool', tool, callId, status: 'executing' }, _recordedAt: at };
}
function endOp(callId, agentNode, status, at) {
  return { op: 'upsert', node: { id: `tool:${callId}`, parent: agentNode, kind: 'tool', callId, status }, _recordedAt: at };
}

describe('computeToolStats', () => {
  test('counts calls, successes, and failures per tool name', () => {
    const store = tmpStore();
    store.startMission('m1', 'first', 1000);
    store.appendOp('m1', startOp('c1', 'exec', 'agent:sysadmin', 1000));
    store.appendOp('m1', endOp('c1', 'agent:sysadmin', 'done', 1200));
    store.appendOp('m1', startOp('c2', 'exec', 'agent:sysadmin', 1300));
    store.appendOp('m1', endOp('c2', 'agent:sysadmin', 'error', 1400));

    const stats = computeToolStats(store);
    const exec = stats.find(s => s.name === 'exec');
    assert.equal(exec.calls, 2);
    assert.equal(exec.success, 1);
    assert.equal(exec.failure, 1);
  });

  test('tracks which agents used a tool', () => {
    const store = tmpStore();
    store.startMission('m1', 'first', 1000);
    store.appendOp('m1', startOp('c1', 'exec', 'agent:sysadmin', 1000));
    store.appendOp('m1', endOp('c1', 'agent:sysadmin', 'done', 1100));
    store.appendOp('m1', startOp('c2', 'exec', 'agent:security', 1200));
    store.appendOp('m1', endOp('c2', 'agent:security', 'done', 1300));

    const stats = computeToolStats(store);
    const exec = stats.find(s => s.name === 'exec');
    assert.deepEqual(exec.agents.sort(), ['security', 'sysadmin']);
  });

  test('computes average duration in ms from matched start/end timestamps', () => {
    const store = tmpStore();
    store.startMission('m1', 'first', 1000);
    store.appendOp('m1', startOp('c1', 'exec', 'agent:sysadmin', 1000));
    store.appendOp('m1', endOp('c1', 'agent:sysadmin', 'done', 1500));
    store.appendOp('m1', startOp('c2', 'exec', 'agent:sysadmin', 2000));
    store.appendOp('m1', endOp('c2', 'agent:sysadmin', 'done', 2300));

    const stats = computeToolStats(store);
    const exec = stats.find(s => s.name === 'exec');
    assert.equal(exec.avgDurationMs, 400); // (500 + 300) / 2
  });

  test('a tool call still in flight (no end op) is not counted at all', () => {
    const store = tmpStore();
    store.startMission('m1', 'first', 1000);
    store.appendOp('m1', startOp('c1', 'exec', 'agent:sysadmin', 1000));

    const stats = computeToolStats(store);
    assert.deepEqual(stats, []);
  });

  test('aggregates across multiple missions', () => {
    const store = tmpStore();
    store.startMission('m1', 'first', 1000);
    store.appendOp('m1', startOp('c1', 'exec', 'agent:sysadmin', 1000));
    store.appendOp('m1', endOp('c1', 'agent:sysadmin', 'done', 1100));
    store.startMission('m2', 'second', 2000);
    store.appendOp('m2', startOp('c2', 'exec', 'agent:sysadmin', 2000));
    store.appendOp('m2', endOp('c2', 'agent:sysadmin', 'done', 2100));

    const stats = computeToolStats(store);
    assert.equal(stats.find(s => s.name === 'exec').calls, 2);
  });

  test('sorts results by call count, most-used first', () => {
    const store = tmpStore();
    store.startMission('m1', 'first', 1000);
    store.appendOp('m1', startOp('c1', 'rare-tool', 'agent:sysadmin', 1000));
    store.appendOp('m1', endOp('c1', 'agent:sysadmin', 'done', 1100));
    store.appendOp('m1', startOp('c2', 'common-tool', 'agent:sysadmin', 1200));
    store.appendOp('m1', endOp('c2', 'agent:sysadmin', 'done', 1300));
    store.appendOp('m1', startOp('c3', 'common-tool', 'agent:sysadmin', 1400));
    store.appendOp('m1', endOp('c3', 'agent:sysadmin', 'done', 1500));

    const stats = computeToolStats(store);
    assert.equal(stats[0].name, 'common-tool');
  });

  test('an empty store produces an empty catalog', () => {
    const store = tmpStore();
    assert.deepEqual(computeToolStats(store), []);
  });
});
