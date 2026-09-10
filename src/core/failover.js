function sameRoute(left, right) {
  return left?.providerId === right?.providerId && left?.modelId === right?.modelId;
}

function failoverRoutes(decision, maxAlternates = 1) {
  if (!decision?.selected) return [];
  const alternatives = (decision.candidates || []).filter((candidate) => !sameRoute(candidate, decision.selected));
  const differentRuntime = alternatives.filter((candidate) => candidate.providerId !== decision.selected.providerId);
  const sameRuntime = alternatives.filter((candidate) => candidate.providerId === decision.selected.providerId);
  return [decision.selected, ...differentRuntime, ...sameRuntime].slice(0, 1 + Math.max(0, maxAlternates));
}

function activateFailover(decision, candidate, failure) {
  const previous = decision.selected;
  decision.selected = { ...candidate };
  decision.status = candidate.ready ? "ready" : "actionable";
  decision.requiredActions = candidate.ready ? [] : ["load-model"];
  decision.failover = {
    attempted: true,
    from: { providerId: previous.providerId, modelId: previous.modelId },
    to: { providerId: candidate.providerId, modelId: candidate.modelId },
    reason: failure?.message || "The preferred route became unavailable"
  };
  decision.reasons.push(`The preferred ${previous.providerId} route failed before producing an answer, so Aether switched to ${candidate.providerId}.`);
  return decision;
}

function mayFailOver({ outputStarted = false, remainingRoutes = 0 } = {}) {
  return !outputStarted && remainingRoutes > 0;
}

export { activateFailover, failoverRoutes, mayFailOver, sameRoute };
