import os from "os";
import { existsSync, readdirSync } from "fs";

function directoryHas(path, predicate) {
  try { return existsSync(path) && readdirSync(path).some(predicate); }
  catch { return false; }
}

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
  if (platform === "linux") {
    const renderNode = directoryHas("/dev/dri", (name) => name.startsWith("renderD"));
    const vulkanDriver = directoryHas("/usr/share/vulkan/icd.d", (name) => name.endsWith(".json"));
    if (renderNode && vulkanDriver) hardware.acceleration.push("vulkan");
    hardware.graphicsDeviceAccess = { renderNode, vulkanDriver };
  }
  hardware.acceleration.push("cpu");

  return hardware;
}

export { detectHardware };
