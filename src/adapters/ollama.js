import { constants } from "fs";
import { access, mkdtemp, rm, writeFile } from "fs/promises";
import { execFile, spawn } from "child_process";
import { createServer } from "net";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { Readable } from "stream";
import { MODEL_CATALOG, SYSTEM_MESSAGE } from "./llama-cpp.js";

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function runFile(file, args, options = {}) {
  return new Promise((resolve) => execFile(file, args, options, (error, stdout, stderr) => resolve({ error, stdout: stdout || "", stderr: stderr || "" })));
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function ollamaTag(modelId) { return `aether-${modelId}:latest`; }

class OllamaAdapter {
  constructor(options = {}) {
    this.name = "Ollama";
    this.id = "ollama";
    this.type = "local";
    this.fetch = options.fetch || globalThis.fetch;
    this.platform = options.platform || process.platform;
    this.modelsRoot = options.modelsRoot || join(process.cwd(), "models");
    this.ollamaModelsRoot = options.ollamaModelsRoot || process.env.OLLAMA_MODELS || join(homedir(), ".ollama", "models");
    this.healthTimeout = options.healthTimeout || 15000;
    this.executablePath = options.executablePath || null;
    this.externalPort = options.externalPort === undefined ? 11434 : options.externalPort;
    this.process = null;
    this.port = null;
    this.ownsProcess = false;
    this.loadedModel = null;
    this.processOutput = "";
  }

  async #executable() {
    if (this.executablePath) {
      try { await access(this.executablePath, this.platform === "win32" ? constants.F_OK : constants.X_OK); return this.executablePath; }
      catch { return null; }
    }
    const name = this.platform === "win32" ? "ollama.exe" : "ollama";
    for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
      const path = join(directory, name);
      try { await access(path, this.platform === "win32" ? constants.F_OK : constants.X_OK); return path; }
      catch { /* Continue searching. */ }
    }
    return null;
  }

  async #probe(path) {
    if (!path) return { ok: false, version: null, error: "Ollama executable was not found" };
    const result = await runFile(path, ["--version"], { timeout: 5000, windowsHide: true });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const versionLine = output.split("\n").map((line) => line.trim()).find((line) => /^ollama version\b/i.test(line) || /client version is\b/i.test(line));
    const version = versionLine?.replace(/^Warning:\s*client version is\s*/i, "") || output || "unknown";
    return result.error ? { ok: false, version: null, error: output || result.error.message } : { ok: true, version, error: null, output };
  }

  async #healthyAt(port) {
    try {
      const response = await this.fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    } catch { return false; }
  }

  async #endpoint() {
    if (this.port && await this.#healthyAt(this.port)) return this.port;
    if (this.externalPort && await this.#healthyAt(this.externalPort)) return this.externalPort;
    return null;
  }

  modelDefinition(id) {
    const model = MODEL_CATALOG.find((item) => item.id === id);
    if (!model) { const error = new Error("Model not found"); error.statusCode = 404; throw error; }
    return { ...model, providerId: this.id, tag: ollamaTag(model.id), sourcePath: join(this.modelsRoot, model.filename) };
  }

  async #installedFromManifest(tag) {
    const [name, version = "latest"] = tag.split(":");
    try { await access(join(this.ollamaModelsRoot, "manifests", "registry.ollama.ai", "library", name, version), constants.R_OK); return true; }
    catch { return false; }
  }

  async #remoteModels(port) {
    try {
      const response = await this.fetch(`http://127.0.0.1:${port}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return [];
      return (await response.json()).models || [];
    } catch { return []; }
  }

  async #runningModels(port) {
    try {
      const response = await this.fetch(`http://127.0.0.1:${port}/api/ps`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return [];
      return (await response.json()).models || [];
    } catch { return []; }
  }

  async status() {
    const executable = await this.#executable();
    const probe = await this.#probe(executable);
    const port = probe.ok ? await this.#endpoint() : null;
    const running = Boolean(port);
    return {
      name: this.name,
      id: this.id,
      type: this.type,
      state: running ? "healthy" : probe.ok ? "verified" : executable ? "detected" : "not_found",
      detected: Boolean(executable),
      executable: Boolean(executable),
      available: probe.ok,
      verified: probe.ok,
      running,
      healthy: running,
      source: executable ? "system" : null,
      path: executable,
      version: probe.version,
      server: running ? { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, managed: this.ownsProcess } : null,
      verification: { method: "--version", ok: probe.ok, output: probe.output || probe.version, error: probe.error },
      provisioning: { supported: false, permissionRequired: true, note: "Aether uses an existing Ollama installation and can import local GGUF models after explicit permission." }
    };
  }

  async modelStatus(id) {
    const model = this.modelDefinition(id);
    const port = await this.#endpoint();
    const remote = port ? await this.#remoteModels(port) : [];
    const installed = remote.some((item) => item.name === model.tag || item.model === model.tag) || await this.#installedFromManifest(model.tag);
    const running = port ? await this.#runningModels(port) : [];
    const loaded = running.some((item) => item.name === model.tag || item.model === model.tag);
    return { ...model, path: null, installed, selected: loaded, loaded };
  }

  async modelCatalogStatus() { return await Promise.all(MODEL_CATALOG.map((model) => this.modelStatus(model.id))); }

  async accelerationStatus() {
    const status = await this.status();
    const port = await this.#endpoint();
    const running = port ? await this.#runningModels(port) : [];
    const accelerated = running.filter((model) => Number(model.size_vram || 0) > 0);
    return {
      providerId: this.id,
      runtimeVerified: status.verified,
      cpuAvailable: status.verified,
      devices: accelerated.length ? [{ backend: "gpu", description: "Ollama reported model data resident in graphics memory" }] : [],
      method: "/api/ps size_vram",
      output: accelerated.length ? `${accelerated.length} loaded model(s) using graphics memory` : running.length ? "Loaded models report CPU-only residency" : "No loaded model is available for acceleration observation",
      error: null
    };
  }

  async start() {
    const current = await this.#endpoint();
    if (current) { this.port = current; return await this.status(); }
    const executable = await this.#executable();
    const probe = await this.#probe(executable);
    if (!probe.ok) throw new Error(`Cannot start Ollama: ${probe.error}`);
    this.port = await reserveLocalPort();
    this.ownsProcess = true;
    this.processOutput = "";
    this.process = spawn(executable, ["serve"], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${this.port}`, OLLAMA_MODELS: this.ollamaModelsRoot },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const remember = (chunk) => { this.processOutput = `${this.processOutput}${chunk}`.slice(-16 * 1024); };
    this.process.stdout.on("data", remember);
    this.process.stderr.on("data", remember);
    const deadline = Date.now() + this.healthTimeout;
    while (Date.now() < deadline) {
      if (this.process.exitCode !== null) throw new Error(`Ollama exited before becoming healthy${this.processOutput.trim() ? `: ${this.processOutput.trim()}` : ""}`);
      if (await this.#healthyAt(this.port)) return await this.status();
      await delay(200);
    }
    await this.stop();
    throw new Error(`Ollama did not become healthy within ${this.healthTimeout}ms`);
  }

  async stop() {
    const child = this.process;
    if (child && child.exitCode === null && this.ownsProcess) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) await delay(50);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    this.process = null;
    this.port = null;
    this.ownsProcess = false;
    this.loadedModel = null;
    return await this.status();
  }

  async provisionModel({ permission = false, modelId } = {}) {
    if (!permission) { const error = new Error("Explicit permission is required to import a GGUF model into Ollama"); error.statusCode = 403; throw error; }
    const model = this.modelDefinition(modelId);
    await access(model.sourcePath, constants.R_OK);
    await this.start();
    const executable = await this.#executable();
    const staging = await mkdtemp(join(tmpdir(), "aether-ollama-model-"));
    const modelfile = join(staging, "Modelfile");
    try {
      await writeFile(modelfile, `FROM ${model.sourcePath}\nPARAMETER num_ctx 2048\n`);
      const result = await runFile(executable, ["create", model.tag, "--file", modelfile], {
        env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${this.port}`, OLLAMA_MODELS: this.ollamaModelsRoot },
        timeout: 10 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024
      });
      if (result.error) throw new Error(`Ollama model import failed: ${result.stderr || result.error.message}`);
      return await this.modelStatus(modelId);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async loadModel(modelId) {
    const model = await this.modelStatus(modelId);
    if (!model.installed) throw new Error(`${model.name} is not imported into Ollama`);
    await this.start();
    const response = await this.fetch(`http://127.0.0.1:${this.port}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: model.tag, prompt: "", stream: false, keep_alive: "10m" })
    });
    if (!response.ok) throw new Error(`Ollama could not load ${model.name} (${response.status})`);
    this.loadedModel = modelId;
    return await this.status();
  }

  async #chatResponse(message, history, options = {}) {
    const modelId = options.modelId ?? this.loadedModel;
    if (!modelId) throw new Error("No Ollama model is loaded");
    const model = this.modelDefinition(modelId);
    await this.start();
    return await this.fetch(`http://127.0.0.1:${this.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.tag, messages: [SYSTEM_MESSAGE, ...history, { role: "user", content: message.trim() }], stream: Boolean(options.stream), keep_alive: "10m", options: { num_predict: options.maxTokens || 96, temperature: options.temperature ?? 0.2 } })
    });
  }

  async chat(message, history = [], options = {}) {
    if (typeof message !== "string" || !message.trim()) throw new Error("A non-empty message is required");
    const modelId = options.modelId ?? this.loadedModel;
    const response = await this.#chatResponse(message, history, { modelId });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `Ollama inference failed (${response.status})`);
    if (typeof payload?.message?.content !== "string") throw new Error("Ollama returned an invalid chat response");
    return { provider: this.id, model: modelId, message: payload.message.content };
  }

  async *chatStream(message, history = [], options = {}) {
    if (typeof message !== "string" || !message.trim()) throw new Error("A non-empty message is required");
    const modelId = options.modelId ?? this.loadedModel;
    const response = await this.#chatResponse(message, history, { modelId, stream: true });
    if (!response.ok || !response.body) throw new Error(`Ollama streaming inference failed (${response.status})`);
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of Readable.fromWeb(response.body)) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines.filter(Boolean)) {
        const payload = JSON.parse(line);
        const delta = payload?.message?.content;
        if (typeof delta === "string" && delta) yield delta;
        if (payload.done) return;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      const payload = JSON.parse(buffered);
      const delta = payload?.message?.content;
      if (typeof delta === "string" && delta) yield delta;
    }
  }

  async benchmarkModel(modelId) {
    const loadStarted = Date.now();
    await this.loadModel(modelId);
    const loadDurationMs = Date.now() - loadStarted;
    const inferenceStarted = Date.now();
    const response = await this.#chatResponse("Write one short sentence about reliable local artificial intelligence.", [], { modelId, maxTokens: 48, temperature: 0 });
    const payload = await response.json();
    const inferenceDurationMs = Date.now() - inferenceStarted;
    if (!response.ok || typeof payload?.message?.content !== "string") throw new Error(payload?.error || "Ollama benchmark returned no text");
    const generatedTokens = Number(payload.eval_count) || Math.max(1, Math.round(payload.message.content.trim().split(/\s+/).length * 1.3));
    const tokensPerSecond = Number(payload.eval_duration) > 0 ? generatedTokens / (Number(payload.eval_duration) / 1e9) : generatedTokens / Math.max(inferenceDurationMs / 1000, 0.001);
    const running = await this.#runningModels(this.port);
    const active = running.find((item) => item.name === this.modelDefinition(modelId).tag || item.model === this.modelDefinition(modelId).tag);
    const residentMemoryMB = active?.size ? Number(active.size) / 1024 ** 2 : null;
    const sizeVram = Number(active?.size_vram || 0);
    return { providerId: this.id, modelId, status: "success", acceleration: sizeVram > 0 ? "gpu" : "cpu", contextSize: 2048, loadDurationMs, inferenceDurationMs, generatedTokens, tokensPerSecond, residentMemoryMB };
  }
}

export { OllamaAdapter, ollamaTag };
