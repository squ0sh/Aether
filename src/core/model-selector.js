function selectModel(hardware, models) {
  if (!Array.isArray(models) || models.length === 0) throw new Error("No model candidates are available");
  const memoryGB = hardware?.memory?.totalGB || 0;
  const verifiedAcceleration = hardware?.verifiedAcceleration || [];
  const cpuOnly = !verifiedAcceleration.some((item) => item !== "cpu");
  const ranked = models.map((model) => {
    let score = 100 + (model.priority || 0);
    if (model.sizeBytes > memoryGB * 1024 ** 3 * 0.25) score -= 50;
    if (cpuOnly && model.parametersBillions > 1) score -= 30;
    return { ...model, score };
  }).sort((a, b) => b.score - a.score);
  const selected = ranked[0];
  return {
    selected,
    profile: cpuOnly ? "cpu-first" : "accelerated",
    reasons: [
      `${memoryGB || "Unknown"} GB host memory`,
      cpuOnly ? "CPU-first inference path (no accelerator has been verified)" : `Verified acceleration: ${verifiedAcceleration.filter((item) => item !== "cpu").join(", ")}`,
      `${Math.round(selected.sizeBytes / 1024 ** 2)} MiB quantized model keeps the first-run footprint small`
    ],
    candidates: ranked.map(({ id, name, score }) => ({ id, name, score }))
  };
}

export { selectModel };
