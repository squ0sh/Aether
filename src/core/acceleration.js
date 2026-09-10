function normalizeAcceleration(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("vulkan")) return "vulkan";
  if (text.includes("cuda")) return "cuda";
  if (text.includes("metal")) return "metal";
  if (text.includes("rocm") || text.includes("hip")) return "rocm";
  if (text.includes("sycl")) return "sycl";
  if (text.includes("opencl")) return "opencl";
  if (text === "gpu") return "gpu";
  return null;
}

function parseLlamaDevices(output = "") {
  return String(output).split("\n").map((line) => line.trim()).filter((description) => /^(vulkan|cuda|metal|rocm|hip|sycl|opencl)\d*\s*:/i.test(description)).map((description) => ({ description, backend: normalizeAcceleration(description) }));
}

function detectLlamaBenchmarkAcceleration(output, devices = []) {
  const offloaded = /offload(?:ed|ing)\s+[1-9]\d*(?:\/\d+)?(?:\s+\w+){0,4}\s+layers?\s+to\s+gpu/i.test(String(output || ""));
  return offloaded && devices[0]?.backend ? devices[0].backend : "cpu";
}

function buildAccelerationProfile({ hardware = {}, providerReports = [], benchmarks = [] } = {}) {
  const successful = benchmarks.filter((item) => item.status === "success");
  const proven = [...new Set(successful.map((item) => item.acceleration).filter(Boolean))];
  const accelerated = proven.filter((item) => item !== "cpu");
  const candidates = [...new Set([
    ...(hardware.acceleration || []).filter((item) => item !== "cpu"),
    ...providerReports.flatMap((report) => (report.devices || []).map((device) => device.backend)).filter(Boolean)
  ])];
  const cpuAvailable = providerReports.some((report) => report.cpuAvailable);
  const cpuVerified = proven.includes("cpu");
  const verified = [...new Set([...(cpuVerified ? ["cpu"] : []), ...accelerated])];
  let message;
  if (accelerated.length) message = `Accelerated inference is verified through ${accelerated.join(", ")}.`;
  else if (candidates.length) message = `Graphics support is detectable (${candidates.join(", ")}), but no model benchmark has proven accelerated inference yet.`;
  else if (cpuVerified) message = "No compatible graphics device is exposed to the installed runtimes; measured CPU routing remains active.";
  else message = "No compatible graphics device is exposed to the installed runtimes. A CPU route is available but still needs a benchmark.";
  return {
    status: "ok",
    verified,
    candidates,
    gpuInferenceProven: accelerated.length > 0,
    cpuFallbackVerified: cpuVerified,
    cpuFallbackAvailable: cpuAvailable,
    message,
    providers: providerReports,
    benchmarkEvidence: successful.map(({ providerId, modelId, acceleration, measuredAt }) => ({ providerId, modelId, acceleration, measuredAt }))
  };
}

export { buildAccelerationProfile, detectLlamaBenchmarkAcceleration, normalizeAcceleration, parseLlamaDevices };
