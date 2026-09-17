import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pick, textOf, usageOf, KNOWN_EVENTS, createNormalizer } from '../normalizer.js';

describe('pick', () => {
  test('returns the first defined, non-null, non-empty value across paths', () => {
    assert.equal(pick({ a: '', b: 'x' }, 'a', 'b'), 'x');
    assert.equal(pick({ a: null, b: undefined, c: 0 }, 'a', 'b', 'c'), 0);
  });

  test('resolves dotted paths', () => {
    assert.equal(pick({ data: { phase: 'start' } }, 'data.phase'), 'start');
  });

  test('returns undefined when nothing matches', () => {
    assert.equal(pick({ a: 1 }, 'x.y', 'z'), undefined);
  });

  test('short-circuits a missing intermediate key instead of throwing', () => {
    assert.equal(pick({}, 'a.b.c'), undefined);
  });
});

describe('textOf', () => {
  test('returns a plain string message as-is', () => {
    assert.equal(textOf('hello'), 'hello');
  });

  test('reads .content when it is a string', () => {
    assert.equal(textOf({ content: 'hi' }), 'hi');
  });

  test('joins text blocks when .content is an array', () => {
    assert.equal(
      textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
      'a b'
    );
  });

  test('returns empty string for null/undefined', () => {
    assert.equal(textOf(null), '');
    assert.equal(textOf(undefined), '');
  });
});

describe('KNOWN_EVENTS', () => {
  test('lists every event name the switch in normalize() actually handles', () => {
    for (const name of ['sessions.snapshot', 'session.tool', 'chat', 'exec.approval.resolved']) {
      assert.ok(KNOWN_EVENTS.has(name), `expected KNOWN_EVENTS to include ${name}`);
    }
    assert.ok(!KNOWN_EVENTS.has('something.unknown'));
  });
});

describe('createNormalizer', () => {
  const agents = ['main', 'sysadmin'];

  test('unknown events normalize to no ops', () => {
    const normalize = createNormalizer({ agents });
    assert.deepEqual(normalize('something.unknown', {}), []);
  });

  test('a user message from the orchestrator starts a new mission', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('session.message', {
      sessionKey: 'agent:main:1',
      message: { role: 'user', content: 'check disk usage' },
    });
    assert.equal(ops[0].op, 'mission');
    assert.equal(ops[0].label, 'check disk usage');
    assert.deepEqual(ops[1], { op: 'upsert', node: { id: 'agent:main', kind: 'agent', status: 'thinking' } });
    assert.equal(ops[2].op, 'pulse');
    assert.equal(ops[3].op, 'log');
  });

  test('registers a brand-new agentId even when it is not in the configured agents list', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('sessions.changed', {
      sessions: [{ key: 'agent:newcomer:1', agentId: 'newcomer', hasActiveRun: true }],
    });
    const agentOp = ops.find(o => o.op === 'upsert' && o.node.id === 'agent:newcomer');
    assert.ok(agentOp, 'expected an upsert for the never-before-seen agent');
  });

  test('sessions.snapshot registers agents without emitting delegation pulses', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('sessions.snapshot', {
      sessions: [{ key: 'agent:sysadmin:1', agentId: 'sysadmin', spawnedBy: 'agent:main:1', hasActiveRun: true }],
    });
    assert.ok(ops.some(o => o.op === 'upsert' && o.node.id === 'agent:sysadmin'));
    assert.ok(!ops.some(o => o.op === 'pulse'));
    assert.ok(ops.some(o => o.op === 'subscribe' && o.key === 'agent:sysadmin:1'));
  });

  test('a tool start event creates an executing tool node under its agent', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('session.tool', {
      sessionKey: 'agent:main:1',
      phase: 'start',
      name: 'exec',
      args: { command: 'df -h' },
      toolCallId: 'call-1',
    });
    const toolOp = ops.find(o => o.op === 'upsert' && o.node.kind === 'tool');
    assert.equal(toolOp.node.id, 'tool:call-1');
    assert.equal(toolOp.node.parent, 'agent:main');
    assert.equal(toolOp.node.status, 'executing');
    assert.equal(toolOp.node.label, 'df -h');
    assert.equal(toolOp.node.sessionKey, 'agent:main:1');
    assert.equal(toolOp.node.callId, 'call-1');
    assert.deepEqual(toolOp.node.args, { command: 'df -h' });
  });

  test('a tool end event marks the tool done and the agent thinking again, keeping sessionKey/callId', () => {
    const normalize = createNormalizer({ agents });
    normalize('session.tool', {
      sessionKey: 'agent:main:1', phase: 'start', name: 'exec', args: { command: 'df -h' }, toolCallId: 'call-1',
    });
    const ops = normalize('session.tool', {
      sessionKey: 'agent:main:1', phase: 'end', toolCallId: 'call-1', result: 'ok',
    });
    const toolOp = ops.find(o => o.op === 'upsert' && o.node.kind === 'tool');
    const agentOp = ops.find(o => o.op === 'upsert' && o.node.kind === 'agent');
    assert.equal(toolOp.node.status, 'done');
    assert.equal(agentOp.node.status, 'thinking');
    assert.equal(toolOp.node.sessionKey, 'agent:main:1');
    assert.equal(toolOp.node.callId, 'call-1');
  });

  test('a failed tool event marks the tool and pulse as errors', () => {
    const normalize = createNormalizer({ agents });
    normalize('session.tool', {
      sessionKey: 'agent:main:1', phase: 'start', name: 'exec', args: { command: 'rm -rf /tmp/x' }, toolCallId: 'call-2',
    });
    const ops = normalize('session.tool', {
      sessionKey: 'agent:main:1', phase: 'error', toolCallId: 'call-2', error: 'permission denied',
    });
    const toolOp = ops.find(o => o.op === 'upsert' && o.node.kind === 'tool');
    const pulseOp = ops.find(o => o.op === 'pulse');
    assert.equal(toolOp.node.status, 'error');
    assert.equal(pulseOp.tone, 'error');
  });

  test('an unresolved approval request creates a waiting approval node', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('exec.approval.requested', {
      id: 'appr-1', sessionKey: 'agent:main:1', command: 'rm -rf /var/log/old',
    });
    const approvalOp = ops.find(o => o.op === 'upsert' && o.node.kind === 'approval');
    assert.equal(approvalOp.node.status, 'waiting');
    assert.equal(approvalOp.node.label, 'rm -rf /var/log/old');
  });

  test('a resolved approval marks the node done when approved', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('exec.approval.resolved', {
      id: 'appr-1', sessionKey: 'agent:main:1', decision: 'allow-once',
    });
    const approvalOp = ops.find(o => o.op === 'upsert' && o.node.kind === 'approval');
    assert.equal(approvalOp.node.status, 'done');
  });

  test('an agent-end event with usage attaches tokensIn/tokensOut to the agent node', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('agent', {
      sessionKey: 'agent:main:1', phase: 'end',
      usage: { inputTokens: 120, outputTokens: 340 },
    });
    const agentOp = ops.find(o => o.op === 'upsert' && o.node.kind === 'agent');
    assert.equal(agentOp.node.tokensIn, 120);
    assert.equal(agentOp.node.tokensOut, 340);
  });

  test('an agent-end event with no usage field omits the token counts', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('agent', { sessionKey: 'agent:main:1', phase: 'end' });
    const agentOp = ops.find(o => o.op === 'upsert' && o.node.kind === 'agent');
    assert.equal('tokensIn' in agentOp.node, false);
    assert.equal('tokensOut' in agentOp.node, false);
  });

  test('a chat error event marks the agent as errored', () => {
    const normalize = createNormalizer({ agents });
    const ops = normalize('chat', { sessionKey: 'agent:main:1', state: 'error', errorMessage: 'boom' });
    assert.equal(ops[0].node.status, 'error');
    assert.equal(ops[0].node.detail, 'boom');
  });
});
