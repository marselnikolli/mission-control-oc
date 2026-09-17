// Server-side graph state. Browsers get a snapshot on connect, then the same ops live.
const MAX_LEAVES_PER_AGENT = 6;
const ACTIVE_STATUSES = new Set(['thinking', 'executing', 'waiting']);

// True once a node has held an active status longer than thresholdMs — used to flag a stuck
// agent/tool/approval in the UI. Never flags idle/done/error, or a node with no statusSince yet.
export function isOverdue(node, now = Date.now(), thresholdMs = 5 * 60 * 1000) {
  if (!node || !node.statusSince || !ACTIVE_STATUSES.has(node.status)) return false;
  return now - node.statusSince > thresholdMs;
}

export function createGraph({ agents }) {
  const nodes = new Map();
  let mission = { label: 'No active mission', startedAt: null };
  const log = [];

  function seed() {
    nodes.clear();
    nodes.set('mission', { id: 'mission', kind: 'mission', label: mission.label, status: mission.startedAt ? 'thinking' : 'idle' });
    agents.forEach((a, i) => nodes.set(`agent:${a}`, {
      id: `agent:${a}`, kind: 'agent', label: a, status: 'idle',
      parent: i === 0 ? 'mission' : `agent:${agents[0]}`,
    }));
  }
  seed();

  function prune(parentId) {
    const leaves = [...nodes.values()].filter(n => n.parent === parentId && (n.kind === 'tool' || n.kind === 'approval'));
    const removable = leaves.filter(n => n.status !== 'waiting' && n.status !== 'executing');
    const removed = [];
    while (leaves.length - removed.length > MAX_LEAVES_PER_AGENT && removable.length) {
      const n = removable.shift();
      nodes.delete(n.id);
      removed.push({ op: 'remove', id: n.id });
    }
    return removed;
  }

  // Applies ops and returns the list that should be broadcast (may include generated removals).
  function apply(ops) {
    const out = [];
    for (const o of ops) {
      if (o.op === 'mission') {
        mission = { label: o.label, startedAt: Date.now() };
        for (const [id, n] of nodes) {
          if (n.kind === 'tool' || n.kind === 'approval') nodes.delete(id);
          else if (n.kind === 'agent') { n.status = 'idle'; n.detail = ''; }
        }
        Object.assign(nodes.get('mission'), { label: o.label, status: 'thinking' });
        out.push({ ...o, startedAt: mission.startedAt });
      } else if (o.op === 'upsert') {
        const { idleHint, ...incoming } = o.node;
        const prev = nodes.get(incoming.id);
        if (!prev && incoming.kind === 'agent' && !incoming.label) incoming.label = incoming.id.replace('agent:', '');
        const next = { ...(prev || { status: 'idle' }), ...incoming };
        // Token counts accumulate across runs (a lifetime-per-agent total) rather than the
        // last upsert simply overwriting the last one -- budgets need a running total to mean anything.
        if (incoming.tokensIn != null) next.tokensIn = (prev?.tokensIn || 0) + incoming.tokensIn;
        if (incoming.tokensOut != null) next.tokensOut = (prev?.tokensOut || 0) + incoming.tokensOut;
        if (idleHint && (next.status === 'thinking' || next.status === 'executing')) next.status = 'idle';
        if (!prev || prev.status !== next.status) next.statusSince = Date.now();
        nodes.set(next.id, next);
        out.push({ op: 'upsert', node: next });
        if (!prev && next.parent && (next.kind === 'tool' || next.kind === 'approval')) out.push(...prune(next.parent));
      } else if (o.op === 'log') {
        const entry = { ...o, at: Date.now() };
        log.push(entry); if (log.length > 200) log.shift();
        out.push(entry);
      } else if (o.op === 'pulse' || o.op === 'remove') {
        if (o.op === 'remove') nodes.delete(o.id);
        out.push(o);
      }
    }
    return out;
  }

  const snapshot = () => ({ nodes: [...nodes.values()], log: log.slice(-60), mission });
  return { apply, snapshot, get: id => nodes.get(id) };
}
