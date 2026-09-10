import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OllamaAdapter, ollamaTag } from "../src/adapters/ollama.js";

test("Ollama verifies, imports an existing GGUF, loads, chats, streams, and benchmarks", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX mock executable test");
  const root = await mkdtemp(join(tmpdir(), "aether-ollama-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "ollama");
  const modelsRoot = join(root, "aether-models");
  const ollamaModelsRoot = join(root, "ollama-models");
  const modelId = "qwen2.5-0.5b-instruct-q4-k-m";
  const tag = ollamaTag(modelId);
  await mkdir(modelsRoot, { recursive: true });
  await writeFile(join(modelsRoot, "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"), "mock gguf");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");
if (process.argv.includes("--version")) { console.log("ollama version mock-1.0"); process.exit(0); }
const manifest = path.join(process.env.OLLAMA_MODELS, "manifests", "registry.ollama.ai", "library", ${JSON.stringify(`aether-${modelId}`)}, "latest");
if (process.argv[2] === "create") {
  const file = process.argv[process.argv.indexOf("--file") + 1];
  const source = fs.readFileSync(file, "utf8").match(/^FROM (.+)$/m)?.[1];
  if (!source || !fs.existsSync(source)) process.exit(3);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, "{}");
  process.exit(0);
}
if (process.argv[2] !== "serve") process.exit(2);
let loaded = false;
const port = Number(process.env.OLLAMA_HOST.split(":").pop());
const server = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const installed = fs.existsSync(manifest);
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/api/version") return response.end('{"version":"mock-1.0"}');
  if (request.url === "/api/tags") return response.end(JSON.stringify({ models: installed ? [{ name: ${JSON.stringify(tag)} }] : [] }));
  if (request.url === "/api/ps") return response.end(JSON.stringify({ models: loaded ? [{ name: ${JSON.stringify(tag)}, size: 419430400, size_vram: 0 }] : [] }));
  if (request.url === "/api/generate") { loaded = true; return response.end('{"done":true}'); }
  if (request.url === "/api/chat") {
    loaded = true;
    const input = JSON.parse(body);
    if (!input.messages[0]?.content.includes("conversation as memory")) { response.statusCode = 400; return response.end('{"error":"missing memory instruction"}'); }
    if (input.stream) {
      response.write('{"message":{"content":"Hello "},"done":false}\\n');
      return response.end('{"message":{"content":"from Ollama"},"done":true}\\n');
    }
    return response.end('{"message":{"content":"Hello from Ollama"},"eval_count":12,"eval_duration":500000000}');
  }
  response.statusCode = 404;
  response.end('{}');
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  await chmod(executable, 0o755);

  const adapter = new OllamaAdapter({ executablePath: executable, modelsRoot, ollamaModelsRoot, externalPort: null, healthTimeout: 5000 });
  const verified = await adapter.status();
  assert.equal(verified.verified, true);
  assert.equal(verified.running, false);
  const imported = await adapter.provisionModel({ permission: true, modelId });
  assert.equal(imported.installed, true);
  await adapter.loadModel(modelId);
  assert.equal((await adapter.modelStatus(modelId)).loaded, true);
  const acceleration = await adapter.accelerationStatus();
  assert.equal(acceleration.cpuAvailable, true);
  assert.deepEqual(acceleration.devices, []);
  assert.match(acceleration.output, /CPU-only/i);
  assert.equal((await adapter.chat("Say hello")).message, "Hello from Ollama");
  const chunks = [];
  for await (const chunk of adapter.chatStream("Stream hello")) chunks.push(chunk);
  assert.deepEqual(chunks, ["Hello ", "from Ollama"]);
  const benchmark = await adapter.benchmarkModel(modelId);
  assert.equal(benchmark.providerId, "ollama");
  assert.equal(benchmark.tokensPerSecond, 24);
  assert.equal(benchmark.acceleration, "cpu");
  assert.equal(Math.round(benchmark.residentMemoryMB), 400);
  assert.equal((await adapter.stop()).running, false);
});

test("Ollama model import requires explicit permission", async () => {
  const adapter = new OllamaAdapter({ externalPort: null });
  await assert.rejects(adapter.provisionModel({ modelId: "qwen2.5-0.5b-instruct-q4-k-m" }), /Explicit permission/);
});

function residentModelsFixture() {
  const modelIds = ["qwen2.5-0.5b-instruct-q4-k-m", "smollm2-360m-instruct-q4-k-m"];
  const requests = [];
  const hooks = {};
  const adapter = new OllamaAdapter({
    executablePath: join(tmpdir(), "aether-no-executable-for-injected-fetch", "ollama"),
    fetch: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/version") {
        await hooks.health?.();
        return Response.json({ version: "mock" });
      }
      if (["/api/tags", "/api/ps"].includes(pathname)) {
        return Response.json({ models: modelIds.map((id) => ({ name: ollamaTag(id), size: 419430400, size_vram: 0 })) });
      }
      if (pathname === "/api/generate") return Response.json({ done: true });
      if (pathname === "/api/chat") {
        const input = JSON.parse(options.body);
        requests.push(input);
        await hooks.chat?.();
        if (input.stream) return new Response(`${JSON.stringify({ message: { content: input.model }, done: true })}\n`);
        return Response.json({ message: { content: input.model }, eval_count: 12, eval_duration: 500000000 });
      }
      throw new Error(`Unexpected mock request: ${pathname}`);
    }
  });
  return { adapter, modelIds, requests, hooks };
}

test("Ollama status polling preserves model selection and default chat captures that selection", async () => {
  const { adapter, modelIds: [selected, other], requests, hooks } = residentModelsFixture();
  const resident = await adapter.modelCatalogStatus();
  assert.ok(resident.every((model) => model.loaded));
  assert.equal(adapter.loadedModel, null, "observing resident models must not select one");

  await adapter.loadModel(selected);
  await adapter.modelStatus(other);
  await adapter.modelCatalogStatus();
  assert.equal(adapter.loadedModel, selected, "polling must preserve the explicitly loaded model");

  // Simulate a selection change during the first asynchronous startup check.
  hooks.health = async () => { adapter.loadedModel = other; };
  const result = await adapter.chat("hello");
  assert.equal(requests[0].model, ollamaTag(selected));
  assert.equal(result.model, selected, "response attribution must match the dispatched model");
});

test("Ollama explicit chat and streaming routes work with unset or different selected models", async () => {
  const { adapter, modelIds: [requested, other], requests, hooks } = residentModelsFixture();
  for (const selection of [null, other]) {
    adapter.loadedModel = selection;
    hooks.chat = async () => { await adapter.modelCatalogStatus(); };
    const response = await adapter.chat("hello", [], { modelId: requested });
    assert.equal(response.model, requested);
    assert.equal(response.message, ollamaTag(requested));
    const chunks = [];
    for await (const chunk of adapter.chatStream("hello", [], { modelId: requested })) chunks.push(chunk);
    assert.deepEqual(chunks, [ollamaTag(requested)]);
    assert.equal(adapter.loadedModel, selection);
  }
  assert.deepEqual(requests.map((request) => request.model), Array(4).fill(ollamaTag(requested)));
  assert.deepEqual(requests.map((request) => request.stream), [false, true, false, true]);
});

test("Ollama benchmark requests retain their explicit model identity", async () => {
  const { adapter, modelIds: [requested, other], requests } = residentModelsFixture();
  const loadModel = adapter.loadModel.bind(adapter);
  adapter.loadModel = async (id) => {
    await loadModel(id);
    adapter.loadedModel = other;
  };
  const benchmark = await adapter.benchmarkModel(requested);
  assert.equal(requests[0].model, ollamaTag(requested));
  assert.equal(benchmark.modelId, requested);
  assert.equal(benchmark.tokensPerSecond, 24);
});
