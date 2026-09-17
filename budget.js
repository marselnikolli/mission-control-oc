// Pure helpers for the budget banner: cost estimation from Phase 4's pricing.json, and a
// three-state read on how close a usage number is to its limit.
export function estimateCost(node, pricing = {}) {
  const rate = pricing[node.model] || pricing.default || { inputPer1k: 0, outputPer1k: 0 };
  const tokensIn = node.tokensIn || 0;
  const tokensOut = node.tokensOut || 0;
  return (tokensIn / 1000) * (rate.inputPer1k || 0) + (tokensOut / 1000) * (rate.outputPer1k || 0);
}

export function budgetStatus({ used, limit }) {
  if (!limit) return 'ok';
  const ratio = used / limit;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= 0.8) return 'warning';
  return 'ok';
}
