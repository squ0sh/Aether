import { access } from "fs/promises";
import { constants } from "fs";
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
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async #findExecutable() {
    const candidates = [];

    // Aether portable runtime locations.
    for (const name of this.executableNames) {
      candidates.push(join(process.cwd(), "runtimes", "llama.cpp", name));
      candidates.push(join(process.cwd(), "runtimes", name));
    }

    // System PATH locations.
    for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
      for (const name of this.executableNames) {
        candidates.push(join(directory, name));
      }
    }

    for (const candidate of candidates) {
      if (await this.#isExecutable(candidate)) return candidate;
    }

    return null;
  }

  async detect() {
    const executable = await this.#findExecutable();

    return {
      detected: Boolean(executable),
      available: Boolean(executable),
      running: false,
      executable
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
