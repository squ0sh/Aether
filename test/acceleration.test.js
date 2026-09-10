import assert from "node:assert/strict";
import test from "node:test";
import { buildAccelerationProfile, detectLlamaBenchmarkAcceleration, normalizeAcceleration, parseLlamaDevices } from "../src/core/acceleration.js";

test("llama.cpp device output recognizes supported backends without treating warnings as devices", () => {
  const devices = parseLlamaDevices("Available devices:\n  Vulkan0: Intel Graphics\nwarning: Vulkan unavailable\n  CUDA0: Example GPU");
  assert.deepEqual(devices, [
    { description: "Vulkan0: Intel Graphics", backend: "vulkan" },
    { description: "CUDA0: Example GPU", backend: "cuda" }
  ]);
  assert.deepEqual(parseLlamaDevices("Available devices:\n  (none)"), []);
  assert.equal(normalizeAcceleration("Metal GPU"), "metal");
});

test("llama.cpp promotes a backend only when its load log proves layer offload", () => {
  const devices = [{ backend: "vulkan", description: "Vulkan0: GPU" }];
  assert.equal(detectLlamaBenchmarkAcceleration("offloaded 17/17 layers to GPU", devices), "vulkan");
  assert.equal(detectLlamaBenchmarkAcceleration("offloaded 0/17 layers to GPU", devices), "cpu");
  assert.equal(detectLlamaBenchmarkAcceleration("offloaded 17/17 layers to GPU", []), "cpu");
});

test("detectable graphics support is not promoted without benchmark proof", () => {
  const profile = buildAccelerationProfile({
    hardware: { acceleration: ["vulkan", "cpu"] },
    providerReports: [{ providerId: "llama-cpp", cpuAvailable: true, devices: [{ backend: "vulkan", description: "Vulkan0" }] }],
    benchmarks: [{ providerId: "llama-cpp", modelId: "small", status: "success", acceleration: "cpu" }]
  });
  assert.deepEqual(profile.verified, ["cpu"]);
  assert.equal(profile.gpuInferenceProven, false);
  assert.match(profile.message, /no model benchmark has proven/i);
});

test("an accelerated benchmark promotes only its observed backend", () => {
  const profile = buildAccelerationProfile({
    hardware: { acceleration: ["vulkan", "cpu"] },
    providerReports: [{ providerId: "llama-cpp", cpuAvailable: true, devices: [{ backend: "vulkan", description: "Vulkan0" }] }],
    benchmarks: [{ providerId: "llama-cpp", modelId: "small", status: "success", acceleration: "vulkan", measuredAt: "2026-01-01T00:00:00.000Z" }]
  });
  assert.deepEqual(profile.verified, ["vulkan"]);
  assert.equal(profile.gpuInferenceProven, true);
  assert.equal(profile.benchmarkEvidence[0].acceleration, "vulkan");
});
