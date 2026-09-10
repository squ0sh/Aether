import { randomUUID } from "crypto";

function buildCapabilityProfile({ hardware, providers = [], models = [], executionSummary = [], benchmarkSummary = [], acceleration = null, now = new Date().toISOString() }) {
  const verifiedAcceleration = hardware?.verifiedAcceleration || [];
  const potentialAcceleration = hardware?.acceleration || ["cpu"];
  const nodes = [];
  const edges = [];

  nodes.push({
    id: "host:local",
    kind: "host",
    name: hardware?.cpu?.model || "Local computer",
    status: "available",
    attributes: {
      platform: hardware?.platform || "unknown",
      architecture: hardware?.architecture || "unknown",
      cpuCores: hardware?.cpu?.cores || 0,
      totalMemoryGB: hardware?.memory?.totalGB || 0,
      freeMemoryGB: hardware?.memory?.freeGB || 0
    },
    capabilities: ["compute.cpu", "storage.local", ...verifiedAcceleration.filter((item) => item !== "cpu").map((item) => `compute.${item}`)]
  });

  for (const provider of providers) {
    const providerId = `provider:${provider.id}`;
    nodes.push({
      id: providerId,
      kind: "runtime",
      name: provider.name,
      status: provider.healthy ? "ready" : provider.verified ? "available" : provider.detected ? "detected" : "unavailable",
      attributes: {
        source: provider.source || null,
        verified: Boolean(provider.verified),
        running: Boolean(provider.running),
        healthy: Boolean(provider.healthy),
        version: provider.version || null
      },
      capabilities: provider.verified ? ["inference.text-generation", "inference.streaming"] : []
    });
    edges.push({ from: "host:local", to: providerId, relation: "hosts" });
  }

  for (const model of models) {
    const modelProviderId = model.providerId || providers[0]?.id || null;
    const modelId = `model:${modelProviderId || "unknown"}:${model.id}`;
    const benchmark = benchmarkSummary.find((item) => item.providerId === modelProviderId && item.modelId === model.id) || null;
    nodes.push({
      id: modelId,
      kind: "model",
      name: model.name,
      status: model.loaded ? "ready" : model.installed ? "available" : "discoverable",
      attributes: {
        modelId: model.id,
        providerId: modelProviderId,
        installed: Boolean(model.installed),
        loaded: Boolean(model.loaded),
        parametersBillions: model.parametersBillions || null,
        sizeBytes: model.sizeBytes || null,
        license: model.license || null,
        priority: model.priority || 0,
        benchmark
      },
      capabilities: ["language.chat", "language.instruction-following"]
    });
    if (modelProviderId) edges.push({ from: `provider:${modelProviderId}`, to: modelId, relation: "executes" });
  }

  return {
    schemaVersion: 1,
    generatedAt: now,
    hostId: "local",
    nodes,
    edges,
    environment: {
      privacyBoundary: "local-device",
      potentialAcceleration,
      verifiedAcceleration: verifiedAcceleration.length ? verifiedAcceleration : ["cpu"],
      acceleration
    },
    experience: { strategies: executionSummary, benchmarks: benchmarkSummary },
    summary: {
      hosts: 1,
      runtimes: providers.length,
      models: models.length,
      installedModels: models.filter((model) => model.installed).length,
      readyModels: models.filter((model) => model.loaded).length,
      readyForChat: providers.some((provider) => provider.healthy) && models.some((model) => model.loaded)
    }
  };
}

function normalizeRequest(request = {}) {
  const privacy = ["local-only", "private-network", "cloud-allowed"].includes(request.privacy) ? request.privacy : "local-only";
  const priority = ["speed", "balanced", "quality"].includes(request.priority) ? request.priority : "balanced";
  const modelId = typeof request.modelId === "string" && request.modelId.trim() ? request.modelId.trim() : null;
  const providerId = typeof request.providerId === "string" && request.providerId.trim() ? request.providerId.trim() : null;
  return { task: request.task === "chat" ? "chat" : "chat", modality: "text", privacy, priority, providerId, modelId };
}

function planExecution(profile, request = {}, id = randomUUID()) {
  const constraints = normalizeRequest(request);
  const runtimes = profile.nodes.filter((node) => node.kind === "runtime");
  const models = profile.nodes.filter((node) => node.kind === "model");
  const availableModels = models.filter((node) => ["ready", "available"].includes(node.status));
  const experience = profile.experience?.strategies || [];
  const candidates = [];

  for (const model of availableModels) {
    const modelKey = model.attributes.modelId;
    if (constraints.modelId && constraints.modelId !== modelKey) continue;
    const executionEdge = profile.edges.find((edge) => edge.relation === "executes" && edge.to === model.id);
    const runtime = runtimes.find((node) => node.id === executionEdge?.from && ["ready", "available"].includes(node.status));
    if (!runtime) continue;
    const runtimeKey = runtime.id.slice("provider:".length);
    if (constraints.providerId && constraints.providerId !== runtimeKey) continue;
    const measured = experience.find((item) => item.providerId === runtimeKey && item.modelId === modelKey);
    const benchmark = model.attributes.benchmark;
    const speedScore = benchmark?.status === "success" && benchmark.tokensPerSecond ? Math.min(50, Math.round(benchmark.tokensPerSecond)) : 0;
    const qualityScore = Math.min(30, Math.max(0, Number(model.attributes.priority || 0) * 3));
    const breakdown = {
      readiness: model.status === "ready" && runtime.status === "ready" ? 30 : 20,
      privacy: constraints.privacy === "local-only" ? 20 : 10,
      stability: benchmark?.status === "success" ? 15 : benchmark?.status === "error" ? -20 : 0,
      preference: constraints.priority === "speed" ? speedScore : constraints.priority === "quality" ? qualityScore : Math.round((speedScore + qualityScore) / 2),
      override: constraints.modelId || constraints.providerId ? 100 : 0
    };
    if (measured?.attempts) {
      breakdown.stability += Math.round((measured.successRate || 0) * 20 - 10);
    }
    const score = Object.values(breakdown).reduce((total, value) => total + value, 0);
    candidates.push({
      providerId: runtimeKey,
      modelId: modelKey,
      score,
      scoreBreakdown: breakdown,
      measured: measured || null,
      benchmark: benchmark || null,
      ready: model.status === "ready" && runtime.status === "ready"
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));
  const selected = candidates[0] || null;
  const reasons = [];
  const requiredActions = [];
  if (constraints.privacy === "local-only") reasons.push("The request is restricted to this device.");
  const selectedRuntime = selected ? runtimes.find((node) => node.id === `provider:${selected.providerId}`) : null;
  if (selectedRuntime?.status === "ready") reasons.push(`${selectedRuntime.name} is verified, running, and healthy.`);
  else if (selectedRuntime) reasons.push(`${selectedRuntime.name} is verified and can start this execution path.`);
  else requiredActions.push(runtimes.some((node) => node.status === "available") ? "start-runtime" : "install-runtime");
  if (selected) {
    const model = models.find((node) => node.attributes.providerId === selected.providerId && node.attributes.modelId === selected.modelId);
    if (selected.ready) reasons.push(`${model?.name || selected.modelId} is already loaded and ready.`);
    else {
      reasons.push(`${model?.name || selected.modelId} is installed and can be loaded automatically.`);
      requiredActions.push("load-model");
    }
    if (constraints.modelId || constraints.providerId) reasons.push("The user manually selected this runtime and model.");
    else if (constraints.priority === "speed") reasons.push("Speed is prioritized, so measured generation rate has the strongest preference weight.");
    else if (constraints.priority === "quality") reasons.push("Quality is prioritized, so the stronger instruction-following model receives the largest preference weight.");
    else reasons.push("Balanced mode weighs both measured speed and expected answer quality.");
    if (selected.benchmark?.status === "success") reasons.push(`${model?.name || selected.modelId} measured ${selected.benchmark.tokensPerSecond} tokens/second in its latest local benchmark.`);
    else reasons.push("This model has not completed a successful local benchmark yet.");
    if (selected.measured?.attempts) reasons.push(`This strategy has succeeded ${selected.measured.successes} of ${selected.measured.attempts} measured attempts on this machine.`);
    else reasons.push("No previous measurements exist yet; Aether will record this run as a baseline.");
  } else requiredActions.push(models.some((node) => node.status === "available") ? "load-model" : "install-model");

  return {
    id,
    createdAt: new Date().toISOString(),
    status: selected ? selected.ready ? "ready" : "actionable" : "blocked",
    request: constraints,
    selected,
    candidates,
    reasons,
    requiredActions: [...new Set(requiredActions)]
  };
}

export { buildCapabilityProfile, normalizeRequest, planExecution };
