// Skills catalog. Mission Control keeps a plain-file mirror of the skills the Gateway knows
// about (populated from `skills.changed` frames and from local install/control actions), so
// the Skills panel and the per-agent config form work even against a Gateway that doesn't
// report a catalog yet. RPC calls for install/update/remove are unverified placeholders (same
// caveat as the agent RPCs) -- the local record is kept either way so the UI stays consistent.
//
// The seed catalog is the org chart's own skill set, transcribed in org.js: one department per
// agent on the roster, and every skill that department installs. A Gateway frame merges on top of
// it, so a live Gateway still wins; the chart is what the panel shows before one connects.
import fs from 'node:fs';
import path from 'node:path';
import { ORG_SKILLS } from './org.js';

export const DEFAULT_SKILLS = ORG_SKILLS;

// Fields the org chart carries that a Gateway may not report. They describe where a skill came from
// (department, its SKILL.md, the authorities it checks against) rather than its install state, so
// they survive a merge only from the org seed and are otherwise left alone.
const ORG_FIELDS = ['department', 'departmentTitle', 'trigger', 'url', 'sources'];

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
    const next = {
      name: String(skill.name),
      version: skill.version ?? prev.version ?? '1.0.0',
      status: skill.status ?? prev.status ?? 'installed',
      enabled: skill.enabled ?? (prev.enabled !== undefined ? prev.enabled : true),
      source: skill.source ?? prev.source ?? 'headcount',
      description: skill.description ?? prev.description ?? '',
      ...(skill.updatedAt ? { updatedAt: skill.updatedAt } : {}),
    };
    for (const f of ORG_FIELDS) {
      const v = skill[f] ?? prev[f];
      if (v !== undefined) next[f] = v;
    }
    skills.set(String(skill.name), next);
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