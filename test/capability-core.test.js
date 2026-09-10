import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCapabilityProfile, planExecution } from "../src/core/capability-core.js";
import { listExecutions, recordExecution, summarizeExecutions } from "../src/core/executions.js";
import { listBenchmarks, recordBenchmark, summarizeBenchmarks } from "../src/core/benchmarks.js";

const hardware = {
  platform: "linux",
  architecture: "x64",
  cpu: { model: "Test CPU", cores: 4 },
  memory: { totalGB: 16, freeGB: 8 },
  acceleration: ["vulkan", "cpu"],
  verifiedAcceleration: []
};
const provider = { id: "llama-cpp", name: "llama.cpp", detected: true, verified: true, running: true, healthy: true, source: "portable", version: "test" };
const model = { id: "small", name: "Small model", installed: true, loaded: true, sizeBytes: 1000, parametersBillions: 0.5, license: "test" };

test("capability profile connects the local host, runtime, and model", () => {
  const profile = buildCapabilityProfile({ hardware, providers: [provider], models: [model], now: "2026-01-01T00:00:00.000Z" });
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.summary.readyForChat, true);
  assert.deepEqual(profile.environment.verifiedAcceleration, ["cpu"]);
  assert.ok(profile.edges.some((edge) => edge.from === "host:local" && edge.to === "provider:llama-cpp"));
  assert.ok(profile.edges.some((edge) => edge.from === "provider:llama-cpp" && edge.to === "model:llama-cpp:small"));
});

test("execution planner respects local privacy and explains an empirical choice", () => {
  const profile = buildCapabilityProfile({
    hardware,
    providers: [provider],
    models: [model],
    executionSummary: [{ providerId: "llama-cpp", modelId: "small", attempts: 4, successes: 4, successRate: 1, averageDurationMs: 900 }]
  });
  const decision = planExecution(profile, { privacy: "local-only", priority: "quality" }, "decision-test");
  assert.equal(decision.status, "ready");
  assert.equal(decision.selected.providerId, "llama-cpp");
  assert.equal(decision.selected.modelId, "small");
  assert.match(decision.reasons.join(" "), /this device/i);
  assert.match(decision.reasons.join(" "), /4 of 4 measured attempts/i);
});

test("execution planner marks an installed model as an actionable automatic route", () => {
  const profile = buildCapabilityProfile({ hardware, providers: [{ ...provider, running: false, healthy: false }], models: [{ ...model, loaded: false }] });
  const decision = planExecution(profile);
  assert.equal(decision.status, "actionable");
  assert.equal(decision.selected.modelId, "small");
  assert.deepEqual(decision.requiredActions.sort(), ["load-model"]);
});

test("execution planner reports setup actions instead of inventing an unavailable route", () => {
  const profile = buildCapabilityProfile({ hardware, providers: [{ ...provider, running: false, healthy: false }], models: [{ ...model, installed: false, loaded: false }] });
  const decision = planExecution(profile);
  assert.equal(decision.status, "blocked");
  assert.equal(decision.selected, null);
  assert.deepEqual(decision.requiredActions.sort(), ["install-model", "start-runtime"]);
});

test("benchmarks make speed and quality priorities choose different models", () => {
  const fast = { ...model, id: "fast", name: "Fast", priority: 0, loaded: false };
  const strong = { ...model, id: "strong", name: "Strong", priority: 10 };
  const benchmarkSummary = [
    { providerId: "llama-cpp", modelId: "fast", status: "success", tokensPerSecond: 20 },
    { providerId: "llama-cpp", modelId: "strong", status: "success", tokensPerSecond: 5 }
  ];
  const profile = buildCapabilityProfile({ hardware, providers: [provider], models: [fast, strong], benchmarkSummary });
  assert.equal(planExecution(profile, { priority: "speed" }).selected.modelId, "fast");
  assert.equal(planExecution(profile, { priority: "quality" }).selected.modelId, "strong");
  assert.equal(planExecution(profile, { modelId: "fast", priority: "quality" }).selected.modelId, "fast");
});

test("execution planner distinguishes the same model across two runtimes", () => {
  const ollama = { ...provider, id: "ollama", name: "Ollama" };
  const routes = [
    { ...model, providerId: "llama-cpp" },
    { ...model, providerId: "ollama", loaded: false }
  ];
  const benchmarkSummary = [
    { providerId: "llama-cpp", modelId: "small", status: "success", tokensPerSecond: 10 },
    { providerId: "ollama", modelId: "small", status: "success", tokensPerSecond: 30 }
  ];
  const profile = buildCapabilityProfile({ hardware, providers: [provider, ollama], models: routes, benchmarkSummary });
  assert.equal(new Set(profile.nodes.filter((node) => node.kind === "model").map((node) => node.id)).size, 2);
  assert.equal(planExecution(profile, { priority: "speed" }).selected.providerId, "ollama");
  assert.equal(planExecution(profile, { providerId: "llama-cpp", modelId: "small" }).selected.providerId, "llama-cpp");
});

test("measured failures steer automatic routing toward a reliable alternate", () => {
  const ollama = { ...provider, id: "ollama", name: "Ollama", running: false, healthy: false };
  const routes = [
    { ...model, providerId: "llama-cpp" },
    { ...model, providerId: "ollama", loaded: false }
  ];
  const executionSummary = [
    { providerId: "llama-cpp", modelId: "small", attempts: 1, successes: 0, successRate: 0 },
    { providerId: "ollama", modelId: "small", attempts: 1, successes: 1, successRate: 1 }
  ];
  const profile = buildCapabilityProfile({ hardware, providers: [provider, ollama], models: routes, executionSummary });
  assert.equal(planExecution(profile).selected.providerId, "ollama");
});

test("execution records persist measurements without prompt or response content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aether-execution-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await recordExecution({ providerId: "llama-cpp", modelId: "small", outcome: "success", durationMs: 1200, inputCharacters: 10, outputCharacters: 20 }, root);
  await recordExecution({ providerId: "llama-cpp", modelId: "small", outcome: "error", durationMs: 800, inputCharacters: 4, errorCategory: "timeout" }, root);
  const records = await listExecutions({ root });
  assert.equal(records.length, 2);
  assert.equal("message" in records[0], false);
  assert.equal("response" in records[0], false);
  const [summary] = summarizeExecutions(records);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.successes, 1);
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.averageDurationMs, 1000);
});

test("benchmark records preserve only operational measurements", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aether-benchmark-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await recordBenchmark({ providerId: "llama-cpp", modelId: "small", status: "success", acceleration: "cpu", contextSize: 2048, loadDurationMs: 500, inferenceDurationMs: 1000, generatedTokens: 12, tokensPerSecond: 12.345, residentMemoryMB: 412.26 }, root);
  const records = await listBenchmarks({ root });
  assert.equal(records.length, 1);
  assert.equal(records[0].tokensPerSecond, 12.35);
  assert.equal(records[0].residentMemoryMB, 412.3);
  assert.equal("prompt" in records[0], false);
  assert.equal("response" in records[0], false);
  const [summary] = summarizeBenchmarks(records);
  assert.equal(summary.acceleration, "cpu");
  assert.equal(summary.contextSize, 2048);
});
