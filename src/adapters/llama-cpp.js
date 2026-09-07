import { access } from "fs/promises";
import { constants } from "fs";
import { execFile } from "child_process";
import { delimiter, join } from "path";

class LlamaCppAdapter {
  constructor() {
    this.name = "llama.cpp";
    this.id = "llama-cpp";
    this.type = "local";
    this.executableNames = process.platform === "win32"
      ? ["llama-server.exe", "server.exe"]
      : ["llama-server", "server"];
  }

  async #isExecutable(path) {
    try {
      const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
      await access(path, mode);
      return true;
    } catch {
      return false;
    }
  }

  async #findExecutable() {
    const candidates = [];

    // Aether-managed portable runtime locations take priority.
    for (const name of this.executableNames) {
      candidates.push({ path: join(process.cwd(), "runtimes", "llama.cpp", name), source: "portable" });
      candidates.push({ path: join(process.cwd(), "runtimes", name), source: "portable" });
    }

    // Then consider runtimes already installed on the host PATH.
    for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
      for (const name of this.executableNames) {
        candidates.push({ path: join(directory, name), source: "system" });
      }
    }

    for (const candidate of candidates) {
      if (await this.#isExecutable(candidate.path)) return candidate;
    }

    return null;
  }

  async #probeVersion(executable) {
    return await new Promise((resolve) => {
      execFile(
        executable,
        ["--version"],
        {
          timeout: 5000,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        },
        (error, stdout, stderr) => {
          const output = `${stdout || ""}\n${stderr || ""}`.trim();

          if (error) {
            resolve({
              ok: false,
              version: null,
              output: output || null,
              error: error.killed
                ? "llama.cpp version probe timed out"
                : error.message
            });
            return;
          }

          resolve({
            ok: true,
            version: output.split("\n").map((line) => line.trim()).find(Boolean) || "unknown",
            output: output || null,
            error: null
          });
        }
      );
    });
  }

  async detect() {
    const found = await this.#findExecutable();

    if (!found) {
      return {
        state: "not_found",
        detected: false,
        executable: false,
        available: false,
        verified: false,
        running: false,
        healthy: false,
        source: null,
        path: null,
        version: null,
        verification: {
          method: "--version",
          ok: false,
          error: "llama.cpp executable was not found"
        },
        provisioning: {
          supported: false,
          permissionRequired: true,
          note: "Automatic runtime provisioning is planned but not enabled yet."
        }
      };
    }

    const probe = await this.#probeVersion(found.path);
    const verified = probe.ok;

    return {
      state: verified ? "verified" : "detected",
      detected: true,
      executable: true,
      available: verified,
      verified,
      running: false,
      healthy: false,
      source: found.source,
      path: found.path,
      version: probe.version,
      verification: {
        method: "--version",
        ok: probe.ok,
        output: probe.output,
        error: probe.error
      },
      provisioning: {
        supported: false,
        permissionRequired: true,
        note: "Automatic runtime provisioning is planned but not enabled yet."
      }
    };
  }

  async status() {
    const detection = await this.detect();
    return {
      name: this.name,
      id: this.id,
      type: this.type,
      ...detection
    };
  }

  async models() {
    return [];
  }

  async start() {
    throw new Error("llama.cpp process control is not connected yet");
  }

  async stop() {
    throw new Error("llama.cpp process control is not connected yet");
  }

  async chat() {
    throw new Error("llama.cpp chat routing is not connected yet");
  }
}

export { LlamaCppAdapter };
