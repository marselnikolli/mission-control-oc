import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendWithRotation } from '../logrotate.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rotate-')), 'events.jsonl');
}

describe('appendWithRotation', () => {
  test('appends to a fresh file', () => {
    const file = tmpFile();
    appendWithRotation(file, 'line1\n');
    appendWithRotation(file, 'line2\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'line1\nline2\n');
  });

  test('rotates the old file out once it crosses maxBytes', () => {
    const file = tmpFile();
    appendWithRotation(file, 'x'.repeat(50) + '\n', { maxBytes: 10 });
    appendWithRotation(file, 'new-line\n', { maxBytes: 10 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'new-line\n');
    assert.ok(fs.readFileSync(`${file}.1`, 'utf8').startsWith('x'.repeat(50)));
  });

  test('a second rotation discards the previous .1 generation', () => {
    const file = tmpFile();
    appendWithRotation(file, 'x'.repeat(50) + '\n', { maxBytes: 10 });
    appendWithRotation(file, 'y'.repeat(50) + '\n', { maxBytes: 10 });
    appendWithRotation(file, 'z\n', { maxBytes: 10 });
    assert.ok(fs.readFileSync(`${file}.1`, 'utf8').startsWith('y'.repeat(50)));
  });
});
