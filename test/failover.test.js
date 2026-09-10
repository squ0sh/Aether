import assert from "node:assert/strict";
import test from "node:test";
import { activateFailover, failoverRoutes, mayFailOver } from "../src/core/failover.js";

function decision() {
  const preferred = { providerId: "llama-cpp", modelId: "qwen", score: 100, ready: true };
  return {
    status: "ready",
    selected: preferred,
    candidates: [
      preferred,
      { providerId: "llama-cpp", modelId: "smol", score: 95, ready: true },
      { providerId: "ollama", modelId: "qwen", score: 90, ready: false },
      { providerId: "other", modelId: "qwen", score: 80, ready: true }
    ],
    reasons: [],
    requiredActions: []
  };
}

test("failover chooses at most one alternate and prefers another runtime", () => {
  const routes = failoverRoutes(decision());
  assert.deepEqual(routes.map(({ providerId, modelId }) => [providerId, modelId]), [
    ["llama-cpp", "qwen"],
    ["ollama", "qwen"]
  ]);
});

test("activating a fallback preserves the failure and makes preparation actionable", () => {
  const plan = decision();
  const alternate = failoverRoutes(plan)[1];
  activateFailover(plan, alternate, new Error("preferred runtime stopped"));
  assert.equal(plan.selected.providerId, "ollama");
  assert.equal(plan.status, "actionable");
  assert.deepEqual(plan.requiredActions, ["load-model"]);
  assert.equal(plan.failover.reason, "preferred runtime stopped");
  assert.match(plan.reasons[0], /failed before producing an answer/i);
});

test("failover is forbidden after streaming output starts", () => {
  assert.equal(mayFailOver({ outputStarted: false, remainingRoutes: 1 }), true);
  assert.equal(mayFailOver({ outputStarted: true, remainingRoutes: 1 }), false);
  assert.equal(mayFailOver({ outputStarted: false, remainingRoutes: 0 }), false);
});

test("an exact manual route has no silent alternative", () => {
  const plan = decision();
  plan.candidates = [plan.selected];
  assert.deepEqual(failoverRoutes(plan), [plan.selected]);
});
