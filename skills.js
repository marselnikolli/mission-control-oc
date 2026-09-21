// Skills catalog. Mission Control keeps a plain-file mirror of the skills the Gateway knows
// about (populated from `skills.changed` frames and from local install/control actions), so
// the Skills panel and the per-agent config form work even against a Gateway that doesn't
// report a catalog yet. RPC calls for install/update/remove are unverified placeholders (same
// caveat as the agent RPCs) -- the local record is kept either way so the UI stays consistent.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SKILLS = [
  { name: 'file-ops', version: '1.0.0', status: 'installed', enabled: true, source: 'builtin', description: 'Read, write, list, and organize files via the filesystem toolset.' },
  { name: 'web-fetch', version: '1.2.0', status: 'installed', enabled: true, source: 'builtin', description: 'Fetch pages and APIs and feed their content back to the model.' },
  { name: 'shell-exec', version: '1.1.0', status: 'installed', enabled: true, source: 'builtin', description: 'Run shell commands and scripts inside the workspace sandbox.' },
  { name: 'memory', version: '0.9.4', status: 'installed', enabled: true, source: 'builtin', description: 'Long-term key/value recall shared across agent sessions.' },
  { name: 'web-search', version: '2.0.1', status: 'available', enabled: false, source: 'registry', description: 'Live web search skill (not installed yet).' },
];

// Accepts the catalog shapes Gateways tend to emit: a bare array, { skills: [] },
// { list: [] }, { catalog: [] }, { data: [] }, or the same arrays wrapped one level deeper
// under list/data/result/payload. Anything else yields no rows.
export function listRows(list) {
  if (Array.isArray(list)) return list;
  if (list && Array.isArray(list.skills)) return list.skills;
  if (list && Array.isArray(list.list)) return list.list;
  if (list && Array.isArray(list.catalog)) return list.catalog;
  if (list && Array.isArray(list.data)) return list.data;
  if (list && typeof list === 'object') {
    for (const wrap of ['list', 'data', 'result', 'payload']) {
      const inner = list[wrap];
      if (inner && Array.isArray(inner.skills)) return inner.skills;
    }
  }
  return [];
}

export function createSkillsStore({ dir, seed = DEFAULT_SKILLS } = {}) {
  const file = path.join(dir, 'skills.json');
  const skills = new Map();

  function load() {
    if (Array.isArray(seed)) for (const s of seed) set(s);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const s of listRows(raw)) set(s);
    } catch { /* first run, empty or corrupt store -- fall back to seed */ }
    save();
  }
  function save() {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify([...skills.values()], null, 2)); } catch {}
  }
  function set(skill) {
    if (!skill || !skill.name) return;
    const prev = skills.get(skill.name) || {};
    skills.set(String(skill.name), {
      name: String(skill.name),
      version: skill.version ?? prev.version ?? '1.0.0',
      status: skill.status ?? prev.status ?? 'installed',
      enabled: skill.enabled ?? (prev.enabled !== undefined ? prev.enabled : true),
      source: skill.source ?? prev.source ?? 'builtin',
      description: skill.description ?? prev.description ?? '',
      ...(skill.updatedAt ? { updatedAt: skill.updatedAt } : {}),
    });
  }

  load();

  return {
    list: () => [...skills.values()],
    get: (name) => skills.get(String(name)) || null,
    // Merge a Gateway catalog frame (skills.changed / skills.snapshot). Returns the current
    // catalog plus whether anything actually changed, so the server can skip rebroadcasting.
    merge(payload) {
      let changed = false;
      for (const s of listRows(payload)) {
        if (!s || !s.name) continue;
        const before = JSON.stringify(skills.get(String(s.name)));
        set(s);
        if (before !== JSON.stringify(skills.get(String(s.name)))) changed = true;
      }
      if (changed) save();
      return { skills: this.list(), changed };
    },
    applyAction(name, action, meta = {}) {
      const key = String(name);
      const cur = skills.get(key) || { name: key, version: '1.0.0', status: 'available', enabled: false, source: 'registry', description: '' };
      if (action === 'remove') {
        const had = skills.delete(key);
        if (had) save();
        return had;
      }
      if (action === 'install') { cur.status = 'installed'; cur.enabled = true; cur.source = meta.source || cur.source || 'registry'; cur.description = meta.description || cur.description || ''; cur.updatedAt = Date.now(); }
      if (action === 'enable') cur.enabled = true;
      if (action === 'disable') cur.enabled = false;
      if (action === 'update') { cur.version = meta.version || cur.version; cur.updatedAt = Date.now(); }
      skills.set(key, cur);
      save();
      return true;
    },
  };
}