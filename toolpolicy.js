// Per-agent, per-tool approval policy: allow (auto-approve) / ask (today's default,
// unchanged) / deny (auto-reject). Stored locally in Mission Control, not in OpenClaw itself —
// see the Phase 5 status notes in plan.md for why this doesn't (yet) auto-drive real approval
// decisions; it's an editable record today, wired into the Gateway only via the stubbed
// agent-tool-toggle RPC.
import fs from 'node:fs';
import path from 'node:path';

const POLICIES = new Set(['allow', 'ask', 'deny']);

export function createToolPolicy({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'tool-policy.json');
  const key = (agentId, tool) => `${agentId}:${tool}`;

  function readAll() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return {}; }
  }
  function writeAll(all) {
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  }

  function get(agentId, tool) {
    return readAll()[key(agentId, tool)] || 'ask';
  }
  function set(agentId, tool, policy) {
    if (!POLICIES.has(policy)) throw new Error('policy must be allow/ask/deny');
    const all = readAll();
    all[key(agentId, tool)] = policy;
    writeAll(all);
  }
  function list() {
    return readAll();
  }

  return { get, set, list };
}
