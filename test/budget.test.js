import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, budgetStatus } from '../budget.js';

describe('estimateCost', () => {
  const pricing = {
    default: { inputPer1k: 0, outputPer1k: 0 },
    'gpt-fast': { inputPer1k: 1, outputPer1k: 2 },
  };

  test('uses the model rate when present in the pricing table', () => {
    const node = { model: 'gpt-fast', tokensIn: 2000, tokensOut: 1000 };
    assert.equal(estimateCost(node, pricing), 4); // 2*$1 + 1*$2
  });

  test('falls back to "default" for an unknown model', () => {
    const node = { model: 'some-other-model', tokensIn: 5000, tokensOut: 5000 };
    assert.equal(estimateCost(node, pricing), 0);
  });

  test('treats missing token counts as zero', () => {
    const node = { model: 'gpt-fast' };
    assert.equal(estimateCost(node, pricing), 0);
  });

  test('falls back to a zero-rate default when the pricing table has none at all', () => {
    assert.equal(estimateCost({ model: 'x', tokensIn: 1000, tokensOut: 1000 }, {}), 0);
  });
});

describe('budgetStatus', () => {
  test('reports "ok" with no limit set (0 or missing means unlimited)', () => {
    assert.equal(budgetStatus({ used: 999999, limit: 0 }), 'ok');
    assert.equal(budgetStatus({ used: 999999, limit: undefined }), 'ok');
  });

  test('reports "ok" below 80% of the limit', () => {
    assert.equal(budgetStatus({ used: 79, limit: 100 }), 'ok');
  });

  test('reports "warning" from 80% up to (not including) 100%', () => {
    assert.equal(budgetStatus({ used: 80, limit: 100 }), 'warning');
    assert.equal(budgetStatus({ used: 99, limit: 100 }), 'warning');
  });

  test('reports "exceeded" at or above 100%', () => {
    assert.equal(budgetStatus({ used: 100, limit: 100 }), 'exceeded');
    assert.equal(budgetStatus({ used: 150, limit: 100 }), 'exceeded');
  });
});
