import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker } from '../circuitbreaker.js';

describe('createCircuitBreaker', () => {
  test('stays closed below the failure threshold', () => {
    const b = createCircuitBreaker({ maxFailures: 3, windowMs: 60000 });
    b.recordFailure(1000);
    b.recordFailure(1100);
    assert.equal(b.isOpen(1200), false);
  });

  test('opens once failures reach the threshold within the window', () => {
    const b = createCircuitBreaker({ maxFailures: 3, windowMs: 60000 });
    b.recordFailure(1000);
    b.recordFailure(1100);
    b.recordFailure(1200);
    assert.equal(b.isOpen(1300), true);
  });

  test('failures outside the window expire and no longer count', () => {
    const b = createCircuitBreaker({ maxFailures: 3, windowMs: 1000 });
    b.recordFailure(1000);
    b.recordFailure(1100);
    b.recordFailure(1200);
    assert.equal(b.isOpen(3000), false); // all three are now >1000ms old
  });

  test('a success clears accumulated failures', () => {
    const b = createCircuitBreaker({ maxFailures: 3, windowMs: 60000 });
    b.recordFailure(1000);
    b.recordFailure(1100);
    b.recordSuccess();
    b.recordFailure(1200);
    assert.equal(b.isOpen(1300), false);
  });
});
