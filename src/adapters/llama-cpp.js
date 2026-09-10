import { constants, createReadStream, createWriteStream } from "fs";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { pipeline } from "stream/promises";
import { Readable, Transform } from "stream";
import { createServer } from "net";
import { availableParallelism, tmpdir } from "os";
import { basename, delimiter, dirname, join } from "path";
import { detectLlamaBenchmarkAcceleration, parseLlamaDevices } from "../core/acceleration.js";

const GITHUB_API = "https://api.github.com/repos/ggerganov/llama.cpp/releases";
const RECOMMENDED_MODEL = {
  id: "qwen2.5-0.5b-instruct-q4-k-m",
  name: "Qwen2.5 0.5B Instruct Q4_K_M",
  filename: "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
  repository: "bartowski/Qwen2.5-0.5B-Instruct-GGUF",
  url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true",
  sha256: "6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653",
  sizeBytes: 398000000,
  license: "Apache-2.0",
  parametersBillions: 0.5,
  priority: 10
};
const FALLBACK_MODEL = {
  id: "smollm2-360m-instruct-q4-k-m",
  name: "SmolLM2 360M Instruct Q4_K_M",
  filename: "SmolLM2-360M-Instruct-Q4_K_M.gguf",
  repository: "unsloth/SmolLM2-360M-Instruct-GGUF",
  url: "https://huggingface.co/unsloth/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf?download=true",
  sha256: "16c7f1667fea34bacad196a57b548effcb37614db4ab5677a20c8c7b823b9e63",
  sizeBytes: 271000000,
  license: "Apache-2.0",
  parametersBillions: 0.36,
  priority: 0
};
const MODEL_CATALOG = [RECOMMENDED_MODEL, FALLBACK_MODEL];
const SYSTEM_MESSAGE = {
  role: "system",
  content: "You are Aether, a local assistant. Use the messages in this conversation as memory. When the user asks you to remember something, acknowledge it briefly; do not claim that conversation memory requires internet or external access. Answer directly and concisely."
};

function needsCompatibilityBuild(cpuFlags, platform = process.platform, architecture = process.arch) {
  return platform === "linux" && architecture === "x64" && !cpuFlags.has("avx2");
}

function compatibilityBuildArguments() {
  return [
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DGGML_NATIVE=OFF",
    "-DGGML_SSE42=ON",
    "-DGGML_AVX=ON",
    "-DGGML_F16C=ON",
    "-DGGML_AVX2=OFF",
    "-DGGML_FMA=OFF",
    "-DGGML_BMI2=OFF",
    "-DGGML_AVX_VNNI=OFF",
    "-DGGML_AVX512=OFF"
  ];
}

function portableRuntimeEnvironment(executable, environment = process.env, platform = process.platform) {
  const env = { ...environment };
  const runtimeDirectory = dirname(executable);
  const variable = platform === "darwin" ? "DYLD_LIBRARY_PATH" : platform === "linux" ? "LD_LIBRARY_PATH" : null;
  if (variable) env[variable] = env[variable] ? `${runtimeDirectory}${delimiter}${env[variable]}` : runtimeDirectory;
  return env;
}

function runFile(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function downloadAndVerify(fetchImplementation, url, destination, expectedSha256, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(destination, { force: true });
    try {
      const response = await fetchImplementation(url, { headers: { "User-Agent": "Aether/0.5.1" } });
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      if (!response.body) throw new Error("download returned an empty response body");
      const hash = createHash("sha256");
      const hasher = new Transform({
        transform(chunk, encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(destination, { flags: "wx" }));
      const digest = hash.digest("hex");
      if (digest !== expectedSha256) throw new Error(`checksum mismatch (expected ${expectedSha256}, received ${digest})`);
      return digest;
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
      if (attempt < attempts) await delay(500 * attempt);
    }
  }
  throw new Error(`download failed after ${attempts} attempts: ${lastError?.message || "unknown transfer error"}`);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadWithCurl(url, destination, expectedSha256) {
  // curl's retry and resume support is more resilient to interrupted Hugging Face
  // Xet transfers than restarting a large fetch from byte zero.
  const result = await runFile("curl", [
    "--location", "--fail", "--silent", "--show-error",
    "--retry", "8", "--retry-delay", "2", "--retry-all-errors",
    "--continue-at", "-", "--output", destination, url
  ], { timeout: 60 * 60 * 1000, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error(`resumable curl download failed: ${result.stderr || result.error.message}`);
  const digest = await hashFile(destination);
  if (digest !== expectedSha256) throw new Error(`checksum mismatch (expected ${expectedSha256}, received ${digest})`);
  return digest;
}

class LlamaCppAdapter {
  constructor(options = {}) {
    this.name = "llama.cpp";
    this.id = "llama-cpp";
    this.type = "local";
    this.runtimeRoot = options.runtimeRoot || join(process.cwd(), "runtimes", "llama.cpp");
    this.modelsRoot = options.modelsRoot || join(process.cwd(), "models");
    this.fetch = options.fetch || globalThis.fetch;
    this.platform = options.platform || process.platform;
    this.architecture = options.architecture || process.arch;
    this.healthTimeout = options.healthTimeout || 15000;
    this.process = null;
    this.port = null;
    this.processOutput = "";
    this.loadedModel = null;
    this.executableNames = this.platform === "win32" ? ["llama-server.exe", "server.exe"] : ["llama-server", "server"];
  }

  async #isExecutable(path) {
    try {
      await access(path, this.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch { return false; }
  }

  async #findBelow(root) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
    for (const name of this.executableNames) {
      const match = entries.find((entry) => entry.isFile() && entry.name === name);
      if (match && await this.#isExecutable(join(root, match.name))) return join(root, match.name);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = await this.#findBelow(join(root, entry.name));
      if (match) return match;
    }
    return null;
  }

  async #findExecutable() {
    const portable = await this.#findBelow(this.runtimeRoot);
    if (portable) return { path: portable, source: "portable" };
    for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
      for (const name of this.executableNames) {
        const path = join(directory, name);
        if (await this.#isExecutable(path)) return { path, source: "system" };
      }
    }
    return null;
  }

  async #probeVersion(executable, source) {
    const options = { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 };
    // Official portable builds keep their shared libraries beside llama-server.
    // System installs deliberately retain the host loader environment unchanged.
    if (source === "portable") options.env = portableRuntimeEnvironment(executable, process.env, this.platform);
    const { error, stdout, stderr } = await runFile(executable, ["--version"], options);
    const output = `${stdout}\n${stderr}`.trim();
    const failure = error?.signal === "SIGILL" ? "illegal_instruction" : error ? "execution_failed" : null;
    const processDetail = error ? [error.signal && `signal ${error.signal}`, error.code != null && `code ${error.code}`].filter(Boolean).join(", ") : "";
    return error
      ? { ok: false, failure, version: null, output: output || null, error: error.killed ? "llama.cpp version probe timed out" : `${error.message}${processDetail ? ` (${processDetail})` : ""}${output ? ` | ${output}` : ""}` }
      : { ok: true, version: output.split("\n").map((line) => line.trim()).find(Boolean) || "unknown", output: output || null, error: null };
  }

  async #cpuFlags() {
    if (this.platform !== "linux" || this.architecture !== "x64") return new Set();
    try {
      const cpuInfo = await readFile("/proc/cpuinfo", "utf8");
      const flagsLine = cpuInfo.split("\n").find((line) => /^flags\s*:/i.test(line));
      return new Set((flagsLine?.split(":", 2)[1] || "").trim().split(/\s+/).filter(Boolean));
    } catch { return new Set(); }
  }

  #provisioning() {
    const supported = ["linux", "darwin"].includes(this.platform) && ["x64", "arm64"].includes(this.architecture);
    return {
      supported, permissionRequired: true, platform: this.platform, architecture: this.architecture,
      strategy: supported ? "official-github-release-portable" : null,
      note: supported ? "Aether can install an official portable llama.cpp release after explicit permission." : "Automatic provisioning is not supported on this platform/architecture."
    };
  }

  async detect() {
    const found = await this.#findExecutable();
    if (!found) return {
      state: "not_found", detected: false, executable: false, available: false, verified: false,
      running: false, healthy: false, source: null, path: null, version: null,
      verification: { method: "--version", ok: false, error: "llama.cpp executable was not found" },
      provisioning: this.#provisioning()
    };
    const probe = await this.#probeVersion(found.path, found.source);
    const running = this.process !== null && this.process.exitCode === null;
    const healthy = running ? await this.#checkHealth() : false;
    return {
      state: healthy ? "healthy" : running ? "running" : probe.ok ? "verified" : "detected", detected: true, executable: true,
      available: probe.ok, verified: probe.ok, running, healthy,
      source: found.source, path: found.path, version: probe.version,
      server: running ? { host: "127.0.0.1", port: this.port, url: `http://127.0.0.1:${this.port}` } : null,
      verification: { method: "--version", ok: probe.ok, output: probe.output, error: probe.error },
      provisioning: this.#provisioning()
    };
  }

  #assetScore(name) {
    const value = name.toLowerCase();
    if (!/\.(zip|tar\.gz|tgz)$/.test(value) || /(cuda|cudart|vulkan|sycl|rocm|opencl)/.test(value)) return -1;
    const platformMatch = this.platform === "linux" ? /(ubuntu|linux)/.test(value) : /(macos|darwin)/.test(value);
    const archMatch = this.architecture === "x64" ? /(x64|x86_64|amd64)/.test(value) : /(arm64|aarch64)/.test(value);
    return platformMatch && archMatch ? (value.includes("server") ? 3 : 2) : -1;
  }

  async #releaseAsset() {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "Aether/0.3.4" };
    const latestResponse = await this.fetch(`${GITHUB_API}/latest`, { headers });
    if (!latestResponse.ok) throw new Error(`GitHub release lookup failed (${latestResponse.status})`);
    const latest = await latestResponse.json();
    let releases = [latest];
    if (!(latest.assets || []).some((asset) => this.#assetScore(asset.name) >= 0)) {
      const recentResponse = await this.fetch(`${GITHUB_API}?per_page=20`, { headers });
      if (!recentResponse.ok) throw new Error(`GitHub release fallback lookup failed (${recentResponse.status})`);
      releases = await recentResponse.json();
    }
    for (const release of releases) {
      const assets = [...(release.assets || [])].sort((a, b) => this.#assetScore(b.name) - this.#assetScore(a.name));
      const asset = assets.find((candidate) => this.#assetScore(candidate.name) >= 0);
      if (asset) return asset;
    }
    throw new Error(`No official llama.cpp binary matched ${this.platform}/${this.architecture}`);
  }

  async #latestRelease() {
    const response = await this.fetch(`${GITHUB_API}/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Aether/0.3.5" }
    });
    if (!response.ok) throw new Error(`GitHub source release lookup failed (${response.status})`);
    return await response.json();
  }

  async #extract(archive, target) {
    await mkdir(target, { recursive: true });
    const command = archive.toLowerCase().endsWith(".zip") ? ["unzip", ["-q", archive, "-d", target]] : ["tar", ["-xzf", archive, "-C", target]];
    const result = await runFile(command[0], command[1], { timeout: 120000, maxBuffer: 1024 * 1024 });
    if (result.error) throw new Error(`Could not extract llama.cpp archive: ${result.stderr || result.error.message}`);
  }

  async #promote(stagedRuntime) {
    await mkdir(dirname(this.runtimeRoot), { recursive: true });
    await rm(this.runtimeRoot, { recursive: true, force: true });
    try { await rename(stagedRuntime, this.runtimeRoot); }
    catch (error) {
      if (error.code !== "EXDEV") throw error;
      const incoming = `${this.runtimeRoot}.incoming-${process.pid}`;
      await rm(incoming, { recursive: true, force: true });
      await cp(stagedRuntime, incoming, { recursive: true });
      await rm(stagedRuntime, { recursive: true, force: true });
      await rename(incoming, this.runtimeRoot);
    }
  }

  async #buildCompatibleRuntime(staging) {
    const release = await this.#latestRelease();
    if (!release.tarball_url) throw new Error("Official llama.cpp release did not provide a source archive");
    const response = await this.fetch(release.tarball_url, { headers: { "User-Agent": "Aether/0.3.5" } });
    if (!response.ok) throw new Error(`llama.cpp source download failed (${response.status})`);

    const archive = join(staging, "llama.cpp-source.tar.gz");
    const source = join(staging, "source");
    const build = join(staging, "build");
    const runtime = join(staging, "runtime-compatible");
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await mkdir(source, { recursive: true });
    let result = await runFile("tar", ["-xzf", archive, "--strip-components=1", "-C", source], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw new Error(`Could not extract llama.cpp source: ${result.stderr || result.error.message}`);

    result = await runFile("cmake", ["-S", source, "-B", build, ...compatibilityBuildArguments()], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw new Error(`Compatible llama.cpp configuration failed. Install cmake and a C/C++ build toolchain, then retry. ${result.stderr || result.error.message}`);
    result = await runFile("cmake", ["--build", build, "--config", "Release", "--target", "llama-server", "-j", String(availableParallelism())], { timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw new Error(`Compatible llama.cpp build failed: ${result.stderr || result.error.message}`);

    const builtExecutable = await this.#findBelow(build);
    if (!builtExecutable) throw new Error("Compatible llama.cpp build completed without producing llama-server");
    await mkdir(runtime, { recursive: true });
    await cp(dirname(builtExecutable), runtime, { recursive: true });
    const runtimeExecutable = await this.#findBelow(runtime);
    if (!runtimeExecutable) throw new Error("Could not stage the compatible llama.cpp build");
    if (this.platform !== "win32") await chmod(runtimeExecutable, 0o755);
    return { runtime, executable: runtimeExecutable, release: release.tag_name || null };
  }

  async #checkHealth() {
    if (!this.process || this.process.exitCode !== null || !this.port) return false;
    try {
      const response = await this.fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1000) });
      return response.status === 200;
    } catch { return false; }
  }

  async #residentMemoryMB() {
    if (!this.process || this.process.exitCode !== null) return null;
    try {
      if (this.platform === "linux") {
        const status = await readFile(`/proc/${this.process.pid}/status`, "utf8");
        const kilobytes = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
        return Number.isFinite(kilobytes) ? kilobytes / 1024 : null;
      }
      if (this.platform === "darwin") {
        const result = await runFile("ps", ["-o", "rss=", "-p", String(this.process.pid)], { timeout: 2000 });
        const kilobytes = Number(result.stdout.trim());
        return !result.error && Number.isFinite(kilobytes) ? kilobytes / 1024 : null;
      }
    } catch { /* Memory measurement is optional. */ }
    return null;
  }

  #rememberOutput(chunk) {
    this.processOutput = `${this.processOutput}${chunk}`.slice(-16 * 1024);
  }

  recommendedModel() {
    return { ...RECOMMENDED_MODEL, path: join(this.modelsRoot, RECOMMENDED_MODEL.filename) };
  }

  modelDefinition(id) {
    const model = MODEL_CATALOG.find((candidate) => candidate.id === id);
    if (!model) {
      const error = new Error("Model not found");
      error.statusCode = 404;
      throw error;
    }
    return { ...model, providerId: this.id, path: join(this.modelsRoot, model.filename) };
  }

  async modelStatus(id = RECOMMENDED_MODEL.id) {
    const model = this.modelDefinition(id);
    let installed = false;
    try { await access(model.path, constants.R_OK); installed = true; } catch { /* Not installed. */ }
    return {
      ...model,
      installed,
      selected: this.loadedModel === model.path,
      loaded: this.loadedModel === model.path && this.process !== null && this.process.exitCode === null && await this.#checkHealth()
    };
  }

  async modelCatalogStatus() {
    return await Promise.all(MODEL_CATALOG.map((model) => this.modelStatus(model.id)));
  }

  async accelerationStatus() {
    const found = await this.#findExecutable();
    if (!found) return { providerId: this.id, runtimeVerified: false, cpuAvailable: false, devices: [], method: "--list-devices", error: "llama.cpp executable was not found" };
    const probe = await this.#probeVersion(found.path, found.source);
    if (!probe.ok) return { providerId: this.id, runtimeVerified: false, cpuAvailable: false, devices: [], method: "--list-devices", error: probe.error };
    const env = found.source === "portable" ? portableRuntimeEnvironment(found.path, process.env, this.platform) : process.env;
    const result = await runFile(found.path, ["--list-devices"], { env, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return {
      providerId: this.id,
      runtimeVerified: true,
      cpuAvailable: true,
      devices: result.error ? [] : parseLlamaDevices(output),
      method: "--list-devices",
      output,
      error: result.error ? output || result.error.message : null
    };
  }

  async provisionModel({ permission = false, modelId = RECOMMENDED_MODEL.id } = {}) {
    if (!permission) {
      const error = new Error("Explicit permission is required to download the recommended model");
      error.statusCode = 403;
      throw error;
    }
    const model = this.modelDefinition(modelId);
    await mkdir(this.modelsRoot, { recursive: true });
    const incoming = `${model.path}.incoming-${process.pid}`;
    try {
      try {
        await downloadAndVerify(this.fetch, model.url, incoming, model.sha256);
      } catch (fetchError) {
        if (this.platform === "win32") throw fetchError;
        await downloadWithCurl(model.url, incoming, model.sha256);
      }
      await rename(incoming, model.path);
      return await this.modelStatus();
    } finally { await rm(incoming, { force: true }); }
  }

  async loadModel(modelId = RECOMMENDED_MODEL.id) {
    const model = await this.modelStatus(modelId);
    if (!model.installed) throw new Error("The recommended model is not installed; provision it with explicit permission first");
    if (this.process && this.process.exitCode === null) await this.stop();
    this.loadedModel = model.path;
    try { return await this.start({ modelPath: model.path }); }
    catch (error) { this.loadedModel = null; throw error; }
  }

  async loadRecommendedModel() { return await this.loadModel(RECOMMENDED_MODEL.id); }

  async benchmarkModel(modelId = RECOMMENDED_MODEL.id) {
    const model = await this.modelStatus(modelId);
    if (!model.installed) throw new Error(`${model.name} is not installed`);
    const loadStarted = Date.now();
    await this.loadModel(modelId);
    const loadDurationMs = Date.now() - loadStarted;
    const inferenceStarted = Date.now();
    const response = await this.fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [SYSTEM_MESSAGE, { role: "user", content: "Write one short sentence about reliable local artificial intelligence." }],
        max_tokens: 48,
        temperature: 0
      })
    });
    const payload = await response.json();
    const inferenceDurationMs = Date.now() - inferenceStarted;
    if (!response.ok) throw new Error(payload?.error?.message || `llama.cpp benchmark failed (${response.status})`);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("llama.cpp benchmark returned no text");
    const estimatedTokens = Math.max(1, Math.round(content.trim().split(/\s+/).length * 1.3));
    const generatedTokens = Number(payload?.usage?.completion_tokens || payload?.timings?.predicted_n) || estimatedTokens;
    const measuredRate = Number(payload?.timings?.predicted_per_second);
    const tokensPerSecond = Number.isFinite(measuredRate) && measuredRate > 0 ? measuredRate : generatedTokens / Math.max(inferenceDurationMs / 1000, 0.001);
    const accelerationStatus = await this.accelerationStatus();
    return {
      providerId: this.id,
      modelId,
      status: "success",
      acceleration: detectLlamaBenchmarkAcceleration(this.processOutput, accelerationStatus.devices),
      contextSize: 2048,
      loadDurationMs,
      inferenceDurationMs,
      generatedTokens,
      tokensPerSecond,
      residentMemoryMB: await this.#residentMemoryMB()
    };
  }

  async provision({ permission = false } = {}) {
    if (!permission) {
      const error = new Error("Explicit permission is required to install llama.cpp");
      error.statusCode = 403;
      throw error;
    }
    if (!this.#provisioning().supported) throw new Error(`llama.cpp provisioning is unsupported on ${this.platform}/${this.architecture}`);
    const staging = await mkdtemp(join(tmpdir(), "aether-llama-"));
    try {
      const cpuFlags = await this.#cpuFlags();
      let stagedRuntime;
      let stagedExecutable;

      if (needsCompatibilityBuild(cpuFlags, this.platform, this.architecture)) {
        const compatible = await this.#buildCompatibleRuntime(staging);
        stagedRuntime = compatible.runtime;
        stagedExecutable = compatible.executable;
      } else {
        const asset = await this.#releaseAsset();
        const response = await this.fetch(asset.browser_download_url, { headers: { "User-Agent": "Aether/0.3.5" } });
        if (!response.ok) throw new Error(`llama.cpp download failed (${response.status})`);
        const archive = join(staging, basename(new URL(asset.browser_download_url).pathname));
        await writeFile(archive, Buffer.from(await response.arrayBuffer()));
        stagedRuntime = join(staging, "runtime");
        await this.#extract(archive, stagedRuntime);
        stagedExecutable = await this.#findBelow(stagedRuntime);
        if (!stagedExecutable) throw new Error("Downloaded llama.cpp archive did not contain llama-server");
        if (this.platform !== "win32") await chmod(stagedExecutable, 0o755);
      }

      const stagedProbe = await this.#probeVersion(stagedExecutable, "portable");
      if (!stagedProbe.ok) {
        const hint = stagedProbe.failure === "illegal_instruction" ? " The binary uses CPU instructions unsupported by this host." : "";
        throw new Error(`Downloaded llama.cpp failed verification: ${stagedProbe.error}.${hint}`);
      }
      await this.#promote(stagedRuntime);
      const finalExecutable = await this.#findBelow(this.runtimeRoot);
      if (!finalExecutable) throw new Error("llama.cpp was installed but its executable was not found at the final location");
      if (this.platform !== "win32") await chmod(finalExecutable, 0o755);
      const finalProbe = await this.#probeVersion(finalExecutable, "portable");
      if (!finalProbe.ok) throw new Error(`llama.cpp failed verification from its final location (${finalExecutable}): ${finalProbe.error}`);
      return await this.status();
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async status() { return { name: this.name, id: this.id, type: this.type, ...await this.detect() }; }
  async models() { return []; }
  async start(options = {}) {
    if (this.process && this.process.exitCode === null) return await this.status();
    const found = await this.#findExecutable();
    if (!found) throw new Error("Cannot start llama.cpp because no executable was found");
    const probe = await this.#probeVersion(found.path, found.source);
    if (!probe.ok) throw new Error(`Cannot start an unverified llama.cpp runtime: ${probe.error}`);

    const port = options.port || await reserveLocalPort();
    const modelsDirectory = options.modelsDirectory || this.modelsRoot;
    await mkdir(modelsDirectory, { recursive: true });
    const args = ["--host", "127.0.0.1", "--port", String(port)];
    if (options.modelPath) args.push("--model", options.modelPath, "--ctx-size", "2048");
    else args.push("--models-dir", modelsDirectory);
    const env = found.source === "portable" ? portableRuntimeEnvironment(found.path, process.env, this.platform) : process.env;
    this.processOutput = "";
    this.port = port;
    this.process = spawn(found.path, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.process.stdout.on("data", (chunk) => this.#rememberOutput(chunk));
    this.process.stderr.on("data", (chunk) => this.#rememberOutput(chunk));

    const deadline = Date.now() + this.healthTimeout;
    while (Date.now() < deadline) {
      if (this.process.exitCode !== null) {
        const output = this.processOutput.trim();
        this.process = null;
        this.port = null;
        throw new Error(`llama-server exited before becoming healthy${output ? `: ${output}` : ""}`);
      }
      if (await this.#checkHealth()) return await this.status();
      await delay(200);
    }

    await this.stop();
    throw new Error(`llama-server did not become healthy within ${this.healthTimeout}ms${this.processOutput.trim() ? `: ${this.processOutput.trim()}` : ""}`);
  }

  async stop() {
    const child = this.process;
    if (!child || child.exitCode !== null) {
      this.process = null;
      this.port = null;
      return await this.status();
    }

    child.kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while (child.exitCode === null && Date.now() < deadline) await delay(50);
    if (child.exitCode === null) child.kill("SIGKILL");
    this.process = null;
    this.port = null;
    return await this.status();
  }

  async chat(message, history = []) {
    if (typeof message !== "string" || !message.trim()) throw new Error("A non-empty message is required");
    if (!this.loadedModel || !await this.#checkHealth()) throw new Error("The recommended model is not loaded and healthy");
    const response = await this.fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [SYSTEM_MESSAGE, ...history, { role: "user", content: message.trim() }], max_tokens: 96, temperature: 0.2 })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `llama.cpp inference failed (${response.status})`);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("llama.cpp returned an invalid chat response");
    const model = MODEL_CATALOG.find((candidate) => join(this.modelsRoot, candidate.filename) === this.loadedModel);
    return { provider: this.id, model: model?.id || null, message: content };
  }

  async *chatStream(message, history = []) {
    if (typeof message !== "string" || !message.trim()) throw new Error("A non-empty message is required");
    if (!this.loadedModel || !await this.#checkHealth()) throw new Error("The recommended model is not loaded and healthy");
    const response = await this.fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [SYSTEM_MESSAGE, ...history, { role: "user", content: message.trim() }], max_tokens: 96, temperature: 0.2, stream: true })
    });
    if (!response.ok || !response.body) {
      let payload = null;
      try { payload = await response.json(); } catch { /* Use status fallback. */ }
      throw new Error(payload?.error?.message || `llama.cpp streaming inference failed (${response.status})`);
    }

    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of Readable.fromWeb(response.body)) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        const payload = JSON.parse(data);
        const delta = payload?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      }
    }
  }
}

export { FALLBACK_MODEL, LlamaCppAdapter, MODEL_CATALOG, RECOMMENDED_MODEL, SYSTEM_MESSAGE, compatibilityBuildArguments, downloadAndVerify, downloadWithCurl, hashFile, needsCompatibilityBuild, portableRuntimeEnvironment };
