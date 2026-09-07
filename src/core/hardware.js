import os from "os";

function detectHardware() {
  const platform = process.platform;
  const architecture = process.arch;
  const cpuInfo = os.cpus();

  const hardware = {
    platform,
    architecture,
    cpu: {
      model: cpuInfo[0]?.model || "Unknown",
      cores: cpuInfo.length
    },
    memory: {
      totalGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      freeGB: Number((os.freemem() / 1024 ** 3).toFixed(2))
    },
    acceleration: []
  };

  // Potential acceleration paths. These are not yet verified runtime checks.
  if (platform === "darwin") hardware.acceleration.push("metal");
  if (platform === "win32") hardware.acceleration.push("directml", "vulkan");
  if (platform === "linux") hardware.acceleration.push("vulkan");
  hardware.acceleration.push("cpu");

  return hardware;
}

export { detectHardware };
