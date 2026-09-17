// Durable, per-mission persistence. Deliberately plain files (no DB dependency):
// data/missions.json is the index, data/missions/<id>.jsonl is that mission's op log.
// Mirrors the append-only style already used for logs/events.jsonl.
import fs from 'node:fs';
import path from 'node:path';

const MISSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export function createStore({ dir }) {
  const missionsDir = path.join(dir, 'missions');
  const indexFile = path.join(dir, 'missions.json');
  fs.mkdirSync(missionsDir, { recursive: true });

  function readIndex() {
    if (!fs.existsSync(indexFile)) return [];
    try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return []; }
  }
  function writeIndex(list) {
    fs.writeFileSync(indexFile, JSON.stringify(list, null, 2));
  }
  function opsFile(missionId) {
    if (!MISSION_ID_RE.test(missionId)) throw new Error(`invalid mission id: ${missionId}`);
    return path.join(missionsDir, `${missionId}.jsonl`);
  }

  function startMission(missionId, label, startedAt) {
    const file = opsFile(missionId); // validates the id before touching the index
    const list = readIndex();
    for (const m of list) {
      if (m.status === 'running') { m.status = 'completed'; m.endedAt = startedAt; }
    }
    list.push({ id: missionId, label, startedAt, endedAt: null, status: 'running' });
    writeIndex(list);
    fs.writeFileSync(file, '');
  }

  function appendOp(missionId, op) {
    fs.appendFileSync(opsFile(missionId), JSON.stringify(op) + '\n');
  }

  function listMissions() {
    return readIndex();
  }

  function loadMissionOps(missionId) {
    const file = opsFile(missionId);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  return { startMission, appendOp, listMissions, loadMissionOps };
}
