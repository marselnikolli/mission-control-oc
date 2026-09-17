import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../log.js';

function fakeStream() {
  const lines = [];
  return { write: s => lines.push(s), lines };
}

describe('createLogger', () => {
  test('info() writes a JSON line with level, message, and a timestamp', () => {
    const out = fakeStream();
    const log = createLogger({ stream: out, errStream: out });
    log.info('server started');
    assert.equal(out.lines.length, 1);
    const entry = JSON.parse(out.lines[0]);
    assert.equal(entry.level, 'info');
    assert.equal(entry.msg, 'server started');
    assert.equal(typeof entry.at, 'string');
  });

  test('warn() and error() include any extra fields passed', () => {
    const out = fakeStream();
    const log = createLogger({ stream: out, errStream: out });
    log.warn('subscribe failed', { key: 'agent:main:1' });
    log.error('gateway rejected', { code: 4000 });
    const [w, e] = out.lines.map(JSON.parse);
    assert.equal(w.level, 'warn');
    assert.equal(w.key, 'agent:main:1');
    assert.equal(e.level, 'error');
    assert.equal(e.code, 4000);
  });

  test('info goes to the normal stream, warn/error go to the error stream', () => {
    const normal = fakeStream(), err = fakeStream();
    const log = createLogger({ stream: normal, errStream: err });
    log.info('a');
    log.warn('b');
    log.error('c');
    assert.equal(normal.lines.length, 1);
    assert.equal(err.lines.length, 2);
  });
});
