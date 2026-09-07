import os from "os";

function getCapabilities() {
  return {
    platform: process.platform,
    architecture: process.arch,
    cpu: {
      model: os.cpus()[0]?.model || "Unknown",
      cores: os.cpus().length
    },
    memory: {
      totalGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      freeGB: Number((os.freemem() / 1024 ** 3).toFixed(2))
    },
    node: process.version
  };
}

export { getCapabilities };
