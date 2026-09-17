// Tracks reconnect failures in a sliding window so server.js can stop hammering a dead
// Gateway with exponential backoff forever and instead fall back to one slow, steady retry.
export function createCircuitBreaker({ maxFailures = 5, windowMs = 5 * 60 * 1000 } = {}) {
  let failures = [];

  function prune(now) {
    failures = failures.filter(t => now - t <= windowMs);
  }

  function recordFailure(now = Date.now()) {
    failures.push(now);
    prune(now);
  }

  function recordSuccess() {
    failures = [];
  }

  function isOpen(now = Date.now()) {
    prune(now);
    return failures.length >= maxFailures;
  }

  return { recordFailure, recordSuccess, isOpen };
}
