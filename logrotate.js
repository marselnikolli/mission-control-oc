// Rotates a single-file append log once it crosses maxBytes, keeping exactly one
// previous generation (file -> file.1, old file.1 is discarded). Good enough for a
// low-volume operator log; not a general logrotate replacement.
import fs from 'node:fs';

export function appendWithRotation(file, line, { maxBytes = 10 * 1024 * 1024 } = {}) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* file doesn't exist yet */ }
  if (size > maxBytes) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, line);
}
