import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhooks } from '../webhook.js';

describe('parseWebhooks', () => {
  test('parses event:url pairs into a map of event -> url list', () => {
    const map = parseWebhooks('mission.start:https://a,agent.error:https://b');
    assert.deepEqual(map.get('mission.start'), ['https://a']);
    assert.deepEqual(map.get('agent.error'), ['https://b']);
  });

  test('supports more than one URL for the same event', () => {
    const map = parseWebhooks('mission.start:https://a,mission.start:https://b');
    assert.deepEqual(map.get('mission.start'), ['https://a', 'https://b']);
  });

  test('returns an empty map for empty/undefined input', () => {
    assert.equal(parseWebhooks('').size, 0);
    assert.equal(parseWebhooks(undefined).size, 0);
  });

  test('a URL itself may contain a colon (e.g. https://) without breaking the split', () => {
    const map = parseWebhooks('approval.waiting:https://hooks.example.com:8443/x');
    assert.deepEqual(map.get('approval.waiting'), ['https://hooks.example.com:8443/x']);
  });

  test('ignores stray whitespace and empty entries', () => {
    const map = parseWebhooks(' mission.start:https://a , , ');
    assert.deepEqual(map.get('mission.start'), ['https://a']);
    assert.equal(map.size, 1);
  });
});
