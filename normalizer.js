// Translates raw OpenClaw Gateway frames into a small graph-op vocabulary:
//   { op: 'mission', label }
//   { op: 'upsert', node: { id, parent, kind, label, status, detail, model } }
//   { op: 'pulse', from, to, tone }           tone: delegate | exec | result | approval | error
//   { op: 'log', agent, text, tone }
//   { op: 'subscribe', key }                   side effect for the server, never sent to browsers
//
// Payload shapes differ between OpenClaw versions, so every field is read defensively.
// When something doesn't show up on the map, look at logs/events.jsonl and adjust the pick() paths.

// Every event name normalize() actually handles below -- kept as one literal set so
// server.js can flag anything else as Gateway protocol drift without duplicating this list.
export const KNOWN_EVENTS = new Set([
  'sessions.snapshot', 'sessions.changed', 'agent', 'session.tool', 'session.message', 'chat',
  'session.approval', 'exec.approval.requested', 'exec.approval.resolved',
  'plugin.approval.requested', 'plugin.approval.resolved',
]);

export function pick(obj, ...paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of p.split('.')) { if (v == null) break; v = v[k]; }
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const short = (s, n = 90) => {
  if (s == null) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

export function textOf(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  const c = msg.content ?? msg.text ?? msg.message;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && (b.type === 'text' || typeof b.text === 'string')).map(b => b.text).join(' ');
  return '';
}

// Extracts token usage from wherever a Gateway version happens to put it. Returns null when
// nothing usable is found, so callers can skip attaching tokensIn/tokensOut entirely.
export function usageOf(p) {
  const u = pick(p, 'usage', 'data.usage', 'result.usage', 'message.usage');
  if (!u || typeof u !== 'object') return null;
  const inTok = pick(u, 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens');
  const outTok = pick(u, 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens');
  if (inTok == null && outTok == null) return null;
  return { tokensIn: Number(inTok) || 0, tokensOut: Number(outTok) || 0 };
}

export function createNormalizer({ agents }) {
  const orchestrator = agents[0];
  const sessionAgent = new Map();   // sessionKey -> agentId
  const sessionParent = new Map();  // sessionKey -> parent sessionKey
  const toolNames = new Map();      // toolCallId -> label

  const agentFromKey = (key) => {
    if (!key) return orchestrator;
    if (sessionAgent.has(key)) return sessionAgent.get(key);
    const m = /^agent:([^:]+):/.exec(key);
    return m ? m[1] : orchestrator;
  };
  const nodeFor = (agentId) => `agent:${agentId}`;
  const defaultParent = (agentId) => (agentId === orchestrator ? 'mission' : nodeFor(orchestrator));
  const parentNodeForSession = (key) => {
    const pk = sessionParent.get(key);
    if (!pk) return defaultParent(agentFromKey(key));
    const pa = agentFromKey(pk);
    return pa === agentFromKey(key) ? defaultParent(pa) : nodeFor(pa);
  };

  function sessionRows(p) {
    if (!p) return [];
    if (Array.isArray(p.sessions)) return p.sessions;
    if (p.list && Array.isArray(p.list.sessions)) return p.list.sessions;
    if (p.session) return [p.session];
    if (p.key && (p.agentId || p.hasActiveRun !== undefined)) return [p];
    return [];
  }

  function onSessions(p, isSnapshot) {
    const ops = [];
    for (const row of sessionRows(p)) {
      const key = row.key || row.sessionKey;
      if (!key) continue;
      const agentId = row.agentId || agentFromKey(key);
      sessionAgent.set(key, agentId);
      const parentKey = row.spawnedBy || row.parentSessionKey || row.controlOwnerSessionKey;
      const hadParent = sessionParent.get(key);
      if (parentKey && parentKey !== key) sessionParent.set(key, parentKey);

      const id = nodeFor(agentId);
      const parent = parentNodeForSession(key);
      const node = { id, kind: 'agent', parent };
      if (row.model) node.model = row.model;
      if (row.hasActiveRun === true) node.status = 'thinking';
      else if (row.hasActiveRun === false) node.idleHint = true;
      ops.push({ op: 'upsert', node });

      if (!isSnapshot && parentKey && !hadParent && row.hasActiveRun) {
        ops.push({ op: 'pulse', from: parent, to: id, tone: 'delegate' });
        ops.push({ op: 'log', agent: agentId, text: `Picked up work from ${parent.replace('agent:', '')}`, tone: 'delegate' });
      }
      ops.push({ op: 'subscribe', key });
    }
    return ops;
  }

  function onAgent(p) {
    const key = pick(p, 'sessionKey', 'session.key', 'data.sessionKey');
    const agentId = pick(p, 'agentId') || agentFromKey(key);
    const phase = String(pick(p, 'data.phase', 'phase', 'state', 'status', 'stream') || '').toLowerCase();
    const id = nodeFor(agentId);
    if (/start|accept|stream|running/.test(phase)) return [{ op: 'upsert', node: { id, kind: 'agent', status: 'thinking' } }];
    if (/error|fail|abort/.test(phase)) {
      const err = short(pick(p, 'data.error', 'error', 'errorMessage'));
      return [
        { op: 'upsert', node: { id, kind: 'agent', status: 'error', detail: err || 'Run failed' } },
        { op: 'log', agent: agentId, text: `Run failed${err ? ': ' + err : ''}`, tone: 'error' },
      ];
    }
    if (/end|final|done|complete/.test(phase)) {
      const usage = usageOf(p);
      const node = { id, kind: 'agent', status: 'done', detail: '' };
      if (usage) Object.assign(node, usage);
      const ops = [{ op: 'upsert', node }];
      const parent = parentNodeForSession(key);
      if (parent !== 'mission') ops.push({ op: 'pulse', from: id, to: parent, tone: 'result' });
      ops.push({ op: 'log', agent: agentId, text: 'Finished its run', tone: 'result' });
      return ops;
    }
    return [];
  }

  function toolLabel(name, args) {
    if (args && typeof args === 'object') {
      const cmd = args.command || args.cmd || args.script;
      if (cmd) return short(Array.isArray(cmd) ? cmd.join(' ') : cmd, 60);
      const target = args.path || args.url || args.query || args.file;
      if (target) return `${name} ${short(target, 44)}`;
    }
    return name || 'tool';
  }

  function onTool(p) {
    const key = pick(p, 'sessionKey', 'session.key');
    const agentId = agentFromKey(key);
    const agentNode = nodeFor(agentId);
    const name = pick(p, 'name', 'toolName', 'tool', 'data.name', 'toolCall.name');
    const args = pick(p, 'args', 'input', 'arguments', 'data.args', 'toolCall.args');
    const callId = pick(p, 'toolCallId', 'callId', 'id', 'data.toolCallId', 'toolCall.id') || `${name}:${Date.now()}`;
    const phase = String(pick(p, 'phase', 'state', 'status', 'data.phase', 'type') || '').toLowerCase();
    const id = `tool:${callId}`;

    if (!toolNames.has(callId) || args) toolNames.set(callId, toolLabel(name, args));
    const label = toolNames.get(callId);

    if (/start|call|running|begin/.test(phase) || (!phase && args)) {
      return [
        { op: 'upsert', node: { id, parent: agentNode, kind: 'tool', label, tool: name, status: 'executing', sessionKey: key, callId, args } },
        { op: 'upsert', node: { id: agentNode, kind: 'agent', status: 'executing', detail: label } },
        { op: 'pulse', from: agentNode, to: id, tone: 'exec' },
        { op: 'log', agent: agentId, text: `Running ${label}`, tone: 'exec' },
      ];
    }
    if (/end|result|done|complete|finish|error|fail/.test(phase)) {
      const failed = /error|fail/.test(phase) || pick(p, 'isError', 'error', 'result.isError') === true;
      const summary = short(pick(p, 'result.summary', 'summary', 'resultPreview', 'result'), 120);
      toolNames.delete(callId);
      return [
        { op: 'upsert', node: { id, parent: agentNode, kind: 'tool', label, status: failed ? 'error' : 'done', detail: summary, sessionKey: key, callId } },
        { op: 'upsert', node: { id: agentNode, kind: 'agent', status: 'thinking', detail: '' } },
        { op: 'pulse', from: id, to: agentNode, tone: failed ? 'error' : 'result' },
        { op: 'log', agent: agentId, text: `${failed ? 'Failed' : 'Finished'} ${label}`, tone: failed ? 'error' : 'result' },
      ];
    }
    return [];
  }

  function onMessage(p) {
    const key = pick(p, 'sessionKey', 'session.key', 'key');
    const agentId = agentFromKey(key);
    const msg = p.message || p.entry || p;
    const role = pick(msg, 'role', 'author.role');
    const text = short(textOf(msg), 140);
    const isSub = sessionParent.has(key);
    if (role === 'user' && agentId === orchestrator && !isSub && text) {
      return [
        { op: 'mission', label: text },
        { op: 'upsert', node: { id: nodeFor(agentId), kind: 'agent', status: 'thinking' } },
        { op: 'pulse', from: 'mission', to: nodeFor(agentId), tone: 'delegate' },
        { op: 'log', agent: agentId, text: `New mission: ${text}`, tone: 'delegate' },
      ];
    }
    if (role === 'assistant' && isSub && text) {
      const parent = parentNodeForSession(key);
      return [
        { op: 'pulse', from: nodeFor(agentId), to: parent, tone: 'result' },
        { op: 'log', agent: agentId, text: `Reported: ${text}`, tone: 'result' },
      ];
    }
    return [];
  }

  function onApproval(event, p) {
    const req = p.request || p.approval || p;
    const approvalId = pick(p, 'id', 'approvalId', 'request.id', 'approval.id');
    if (!approvalId) return [];
    const key = pick(p, 'sessionKey', 'request.sessionKey', 'approval.sessionKey');
    const agentId = pick(p, 'agentId', 'request.agentId') || agentFromKey(key);
    const agentNode = nodeFor(agentId);
    const state = String(pick(p, 'state', 'status', 'approval.state') || '').toLowerCase();
    const resolved = event.endsWith('.resolved') || /resolved|approved|denied|rejected|expired|allow|deny/.test(state);
    const id = `approval:${approvalId}`;
    const command = short(pick(req, 'command', 'commandText', 'summary', 'title', 'description') || 'Approval requested', 80);

    if (!resolved) {
      return [
        { op: 'upsert', node: { id, parent: agentNode, kind: 'approval', label: command, approvalId, status: 'waiting' } },
        { op: 'upsert', node: { id: agentNode, kind: 'agent', status: 'waiting', detail: 'Waiting for your approval' } },
        { op: 'pulse', from: agentNode, to: id, tone: 'approval' },
        { op: 'log', agent: agentId, text: `Needs approval: ${command}`, tone: 'approval' },
      ];
    }
    const decision = String(pick(p, 'decision', 'resolution', 'result', 'approval.decision') || state).toLowerCase();
    const ok = /approve|allow|accept|yes/.test(decision);
    return [
      { op: 'upsert', node: { id, kind: 'approval', status: ok ? 'done' : 'error', detail: ok ? 'Approved' : 'Rejected' } },
      { op: 'upsert', node: { id: agentNode, kind: 'agent', status: 'thinking', detail: '' } },
      { op: 'pulse', from: id, to: agentNode, tone: ok ? 'result' : 'error' },
      { op: 'log', agent: agentId, text: `${ok ? 'Approved' : 'Rejected'}: ${command}`, tone: ok ? 'result' : 'error' },
    ];
  }

  function onChat(p) {
    if (pick(p, 'state') !== 'error') return [];
    const agentId = agentFromKey(pick(p, 'sessionKey'));
    const err = short(pick(p, 'errorMessage', 'errorKind'), 100);
    return [
      { op: 'upsert', node: { id: nodeFor(agentId), kind: 'agent', status: 'error', detail: err } },
      { op: 'log', agent: agentId, text: `Error: ${err}`, tone: 'error' },
    ];
  }

  return function normalize(event, payload) {
    const p = payload || {};
    switch (event) {
      case 'sessions.snapshot': return onSessions(p, true);
      case 'sessions.changed': return onSessions(p, false);
      case 'agent': return onAgent(p);
      case 'session.tool': return onTool(p);
      case 'session.message': return onMessage(p);
      case 'chat': return onChat(p);
      case 'session.approval':
      case 'exec.approval.requested':
      case 'exec.approval.resolved':
      case 'plugin.approval.requested':
      case 'plugin.approval.resolved':
        return onApproval(event, p);
      default: return [];
    }
  };
}
