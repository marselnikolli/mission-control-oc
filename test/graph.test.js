import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, isOverdue } from '../graph.js';

describe('dynamic agent discovery (no restart needed)', () => {
  test('an agent id never listed in MC_AGENTS still gets a node once the Gateway reports it', () => {
    const graph = createGraph({ agents: ['main'] });
    // Mirrors what normalizer.js's onSessions() upserts for a brand-new agentId it has never
    // seen before -- no `agents` config change and no restart involved.
    graph.apply([{ op: 'upsert', node: { id: 'agent:newcomer', kind: 'agent', parent: 'agent:main', model: 'some-model' } }]);
    const node = graph.get('agent:newcomer');
    assert.ok(node);
    assert.equal(node.label, 'newcomer'); // derived from the id, same as any seeded agent
    assert.equal(node.parent, 'agent:main');
  });
});

describe('createGraph seeding', () => {
  test('seeds a mission node and one agent node per configured agent', () => {
    const graph = createGraph({ agents: ['main', 'sysadmin'] });
    const snap = graph.snapshot();
    const ids = snap.nodes.map(n => n.id);
    assert.ok(ids.includes('mission'));
    assert.ok(ids.includes('agent:main'));
    assert.ok(ids.includes('agent:sysadmin'));
    assert.equal(graph.get('agent:sysadmin').parent, 'agent:main');
  });
});

describe('graph.apply mission op', () => {
  test('starting a mission clears tool/approval nodes and marks the mission thinking', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'tool:1', parent: 'agent:main', kind: 'tool', status: 'done' } }]);
    const out = graph.apply([{ op: 'mission', label: 'do the thing' }]);
    assert.equal(graph.get('tool:1'), undefined);
    assert.equal(graph.get('mission').status, 'thinking');
    assert.equal(graph.get('mission').label, 'do the thing');
    const missionOp = out.find(o => o.op === 'mission');
    assert.ok(typeof missionOp.startedAt === 'number');
  });
});

describe('graph.apply upsert op', () => {
  test('derives a label for a brand-new agent node from its id', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'agent:devops', kind: 'agent', parent: 'agent:main' } }]);
    assert.equal(graph.get('agent:devops').label, 'devops');
  });

  test('merges into the existing node instead of replacing it', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', status: 'thinking', detail: 'x' } }]);
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', status: 'done' } }]);
    assert.equal(graph.get('agent:main').detail, 'x');
    assert.equal(graph.get('agent:main').status, 'done');
  });

  test('idleHint downgrades a thinking/executing agent back to idle', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', status: 'thinking' } }]);
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', idleHint: true } }]);
    assert.equal(graph.get('agent:main').status, 'idle');
  });
});

describe('graph.apply token accumulation', () => {
  test('sums tokensIn/tokensOut across runs instead of overwriting them', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', tokensIn: 100, tokensOut: 50 } }]);
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', tokensIn: 30, tokensOut: 10 } }]);
    assert.equal(graph.get('agent:main').tokensIn, 130);
    assert.equal(graph.get('agent:main').tokensOut, 60);
  });

  test('a node with no token fields yet just starts from whatever this upsert reports', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', tokensIn: 5, tokensOut: 2 } }]);
    assert.equal(graph.get('agent:main').tokensIn, 5);
    assert.equal(graph.get('agent:main').tokensOut, 2);
  });

  test('an upsert with no token fields leaves the accumulated totals alone', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', tokensIn: 5, tokensOut: 2 } }]);
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', detail: 'thinking still' } }]);
    assert.equal(graph.get('agent:main').tokensIn, 5);
    assert.equal(graph.get('agent:main').tokensOut, 2);
  });
});

describe('graph.apply pruning', () => {
  test('keeps at most 6 finished tool/approval leaves per parent, oldest first', () => {
    const graph = createGraph({ agents: ['main'] });
    let removed = [];
    for (let i = 0; i < 8; i++) {
      const out = graph.apply([{ op: 'upsert', node: { id: `tool:${i}`, parent: 'agent:main', kind: 'tool', status: 'done' } }]);
      removed = removed.concat(out.filter(o => o.op === 'remove'));
    }
    const remaining = graph.snapshot().nodes.filter(n => n.parent === 'agent:main' && n.kind === 'tool');
    assert.equal(remaining.length, 6);
    assert.deepEqual(removed.map(r => r.id), ['tool:0', 'tool:1']);
  });

  test('never removes a leaf that is still waiting or executing', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'tool:pending', parent: 'agent:main', kind: 'tool', status: 'executing' } }]);
    for (let i = 0; i < 7; i++) {
      graph.apply([{ op: 'upsert', node: { id: `tool:${i}`, parent: 'agent:main', kind: 'tool', status: 'done' } }]);
    }
    assert.ok(graph.get('tool:pending'));
  });
});

describe('graph.apply log and pulse ops', () => {
  test('log entries are timestamped, kept, and capped at 200', () => {
    const graph = createGraph({ agents: ['main'] });
    for (let i = 0; i < 205; i++) graph.apply([{ op: 'log', agent: 'main', text: `line ${i}`, tone: 'result' }]);
    const snap = graph.snapshot();
    assert.equal(snap.log.length, 60);
    assert.equal(snap.log.at(-1).text, 'line 204');
  });

  test('pulse ops pass through unchanged', () => {
    const graph = createGraph({ agents: ['main'] });
    const out = graph.apply([{ op: 'pulse', from: 'a', to: 'b', tone: 'exec' }]);
    assert.deepEqual(out, [{ op: 'pulse', from: 'a', to: 'b', tone: 'exec' }]);
  });
});

describe('graph.apply statusSince tracking', () => {
  test('stamps statusSince the first time a node gets a status', () => {
    const graph = createGraph({ agents: ['main'] });
    const before = Date.now();
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', status: 'thinking' } }]);
    assert.ok(graph.get('agent:main').statusSince >= before);
  });

  test('refreshes statusSince only when the status actually changes', () => {
    const graph = createGraph({ agents: ['main'] });
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', status: 'thinking' } }]);
    const first = graph.get('agent:main').statusSince;
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', detail: 'still thinking' } }]);
    assert.equal(graph.get('agent:main').statusSince, first);
    graph.apply([{ op: 'upsert', node: { id: 'agent:main', kind: 'agent', status: 'done' } }]);
    assert.ok(graph.get('agent:main').statusSince >= first);
  });
});

describe('isOverdue', () => {
  test('flags an active node whose status has outlasted the threshold', () => {
    const node = { status: 'executing', statusSince: Date.now() - 10_000 };
    assert.equal(isOverdue(node, Date.now(), 5_000), true);
  });

  test('does not flag a node still within the threshold', () => {
    const node = { status: 'executing', statusSince: Date.now() - 1_000 };
    assert.equal(isOverdue(node, Date.now(), 5_000), false);
  });

  test('never flags idle, done, or error statuses regardless of age', () => {
    const old = Date.now() - 10_000;
    for (const status of ['idle', 'done', 'error']) {
      assert.equal(isOverdue({ status, statusSince: old }, Date.now(), 5_000), false);
    }
  });

  test('returns false for a missing node or one with no statusSince yet', () => {
    assert.equal(isOverdue(null, Date.now(), 5_000), false);
    assert.equal(isOverdue({ status: 'executing' }, Date.now(), 5_000), false);
  });
});
