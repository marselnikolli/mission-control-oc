// Derives a tool catalog + usage analytics purely from Phase 1's per-mission op history —
// there's no separate tool_calls table; every tool upsert already lives in store.js's
// per-mission .jsonl files, keyed by callId (start carries `tool`+`args`, end carries the
// final status). This scans that history rather than tracking a second copy of it.
export function computeToolStats(store) {
  const stats = new Map(); // toolName -> { agents: Set, calls, success, failure, totalDurationMs, durationSamples }

  function entryFor(name) {
    if (!stats.has(name)) stats.set(name, { agents: new Set(), calls: 0, success: 0, failure: 0, totalDurationMs: 0, durationSamples: 0 });
    return stats.get(name);
  }

  for (const mission of store.listMissions()) {
    const starts = new Map(); // callId -> { name, agentId, at }
    for (const op of store.loadMissionOps(mission.id)) {
      if (op.op !== 'upsert' || op.node.kind !== 'tool' || !op.node.callId) continue;
      const agentId = op.node.parent ? op.node.parent.replace(/^agent:/, '') : null;
      if (op.node.status === 'executing' && op.node.tool) {
        starts.set(op.node.callId, { name: op.node.tool, agentId, at: op._recordedAt });
        continue;
      }
      if (op.node.status !== 'done' && op.node.status !== 'error') continue;
      const started = starts.get(op.node.callId);
      if (!started) continue; // no matching start in this mission's history — nothing to attribute
      starts.delete(op.node.callId);

      const entry = entryFor(started.name);
      entry.calls += 1;
      if (op.node.status === 'done') entry.success += 1; else entry.failure += 1;
      const agent = started.agentId || agentId;
      if (agent) entry.agents.add(agent);
      if (started.at != null && op._recordedAt != null) {
        entry.totalDurationMs += op._recordedAt - started.at;
        entry.durationSamples += 1;
      }
    }
  }

  return [...stats.entries()]
    .map(([name, e]) => ({
      name,
      agents: [...e.agents],
      calls: e.calls,
      success: e.success,
      failure: e.failure,
      avgDurationMs: e.durationSamples ? Math.round(e.totalDurationMs / e.durationSamples) : null,
    }))
    .sort((a, b) => b.calls - a.calls);
}
