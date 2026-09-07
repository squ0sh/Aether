import os from "os";

function detectHardware() {
  const platform = process.platform;
  const architecture = process.arch;

  const cpuInfo = os.cpus();
  const totalMemoryGB = Number(
    (os.totalmem() / 1024 ** 3).toFixed(2)
  );

  const hardware = {
    platform,
    architecture,

    cpu: {
      model: cpuInfo[0]?.model || "Unknown",
      cores: cpuInfo.length
    },

    memory: {
      totalGB: totalMemoryGB
    },

    acceleration: []
  };

  /*
   * These are POSSIBLE acceleration paths based on
   * the operating system/architecture.
   *
   * We will verify actual availability later.
   */

  if (platform === "darwin") {
    hardware.acceleration.push("metal");
  }

  if (platform === "win32") {
    hardware.acceleration.push("directml");
    hardware.acceleration.push("vulkan");
  }

  if (platform === "linux") {
    hardware.acceleration.push("vulkan");
  }

  /*
   * WebGPU is handled separately because it belongs
   * to the browser environment rather than Node itself.
   */

  hardware.acceleration.push("cpu");

  return hardware;
}

export { detectHardware };

