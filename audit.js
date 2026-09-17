// Append-only audit trail: who did what, and the result. Separate from logs/events.jsonl
// (raw Gateway frames) and data/missions/ (mission history) — this is specifically the
// who-approved/denied-what-and-when record for Mission Control's own access control.
import fs from 'node:fs';
import path from 'node:path';

export function createAudit({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'audit.jsonl');

  function record(entry) {
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  }

  function list(limit = 100) {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => JSON.parse(line));
  }

  return { record, list };
}
