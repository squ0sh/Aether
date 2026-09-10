import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { compatibilityBuildArguments, downloadAndVerify, hashFile, LlamaCppAdapter, needsCompatibilityBuild, portableRuntimeEnvironment } from "../src/adapters/llama-cpp.js";
import { loadConfig, saveConfig } from "../src/core/config.js";
import { appendMessage, createConversation, deleteConversation, getConversation, listConversations } from "../src/core/conversations.js";
import { selectModel } from "../src/core/model-selector.js";

test("conversation history persists, lists, and deletes safely", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aether-conversation-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const created = await createConversation(null, root);
  await appendMessage(created.id, "user", "What is Aether?", root);
  await appendMessage(created.id, "assistant", "A local AI gateway.", root);
  const saved = await getConversation(created.id, root);
  assert.equal(saved.title, "What is Aether?");
  assert.deepEqual(saved.messages.map(({ role }) => role), ["user", "assistant"]);
  const listed = await listConversations(root);
  assert.equal(listed[0].messageCount, 2);
  await deleteConversation(created.id, root);
  await assert.rejects(getConversation(created.id, root), /not found/);
});

test("model selection explains a conservative CPU-first recommendation", () => {
  const small = { id: "small", name: "Small", sizeBytes: 271000000, parametersBillions: 0.36 };
  const large = { id: "large", name: "Large", sizeBytes: 8 * 1024 ** 3, parametersBillions: 8 };
  const result = selectModel({ memory: { totalGB: 8 }, acceleration: ["vulkan", "cpu"] }, [large, small]);
  assert.equal(result.selected.id, "small");
  assert.equal(result.profile, "cpu-first");
  assert.match(result.reasons.join(" "), /no accelerator has been verified/i);
});

test("configuration persists model selection atomically", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aether-config-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "data", "config.json");
  assert.deepEqual(await loadConfig(path), { version: 1, selectedModel: null, autoRestore: false });
  await saveConfig({ selectedModel: "smollm2-360m-instruct-q4-k-m", autoRestore: true }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, selectedModel: "smollm2-360m-instruct-q4-k-m", autoRestore: true });
});

test("model download streams to disk, retries a terminated transfer, and verifies SHA-256", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aether-download-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "model.gguf.incoming");
  const content = Buffer.from("mock gguf content");
  const expected = createHash("sha256").update(content).digest("hex");
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("terminated");
    return new Response(content, { status: 200 });
  };
  const digest = await downloadAndVerify(mockFetch, "https://example.invalid/model.gguf", destination, expected, 2);
  assert.equal(digest, expected);
  assert.equal(calls, 2);
  assert.equal(await readFile(destination, "utf8"), content.toString());
});

test("large-file checksum verification streams from disk", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aether-hash-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "model.gguf");
  const content = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  await writeFile(file, content);
  assert.equal(await hashFile(file), createHash("sha256").update(content).digest("hex"));
});

test("Ivy Bridge-class Linux x64 hosts select the compatibility build", () => {
  const ivyBridge = new Set(["sse4_2", "avx", "f16c"]);
  assert.equal(needsCompatibilityBuild(ivyBridge, "linux", "x64"), true);
  assert.equal(needsCompatibilityBuild(new Set([...ivyBridge, "avx2"]), "linux", "x64"), false);
  assert.equal(needsCompatibilityBuild(ivyBridge, "darwin", "x64"), false);
});

test("compatibility build disables unsupported Ivy Bridge instruction sets", () => {
  const args = compatibilityBuildArguments();
  assert.ok(args.includes("-DGGML_AVX=ON"));
  assert.ok(args.includes("-DGGML_F16C=ON"));
  assert.ok(args.includes("-DGGML_AVX2=OFF"));
  assert.ok(args.includes("-DGGML_FMA=OFF"));
  assert.ok(args.includes("-DGGML_BMI2=OFF"));
});

test("portable environment prepends sibling library directory and preserves existing value", () => {
  const executable = join("", "opt", "aether", "llama-server");
  const env = portableRuntimeEnvironment(executable, { LD_LIBRARY_PATH: "/system/libs", KEEP: "yes" }, "linux");
  assert.equal(env.LD_LIBRARY_PATH, `${dirname(executable)}${delimiter}/system/libs`);
  assert.equal(env.KEEP, "yes");
});

test("macOS portable environment uses DYLD_LIBRARY_PATH without changing LD_LIBRARY_PATH", () => {
  const executable = join("", "opt", "aether", "llama-server");
  const env = portableRuntimeEnvironment(executable, { DYLD_LIBRARY_PATH: "/dyld", LD_LIBRARY_PATH: "/ld" }, "darwin");
  assert.equal(env.DYLD_LIBRARY_PATH, `${dirname(executable)}${delimiter}/dyld`);
  assert.equal(env.LD_LIBRARY_PATH, "/ld");
});

test("portable final-location verification receives its sibling library path", async (context) => {
  if (process.platform !== "linux") return context.skip("Linux loader-path integration test");
  const root = await mkdtemp(join(tmpdir(), "aether-env-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "llama-b-test");
  await mkdir(runtime, { recursive: true });
  const binary = join(runtime, "llama-server");
  await writeFile(binary, "#!/bin/sh\n[ \"$LD_LIBRARY_PATH\" = \"$(dirname \"$0\"):/existing\" ] || exit 23\necho llama-test-version\n");
  await chmod(binary, 0o755);

  const previous = process.env.LD_LIBRARY_PATH;
  process.env.LD_LIBRARY_PATH = "/existing";
  try {
    const status = await new LlamaCppAdapter({ runtimeRoot: root }).status();
    assert.equal(status.verified, true);
    assert.equal(status.version, "llama-test-version");
    assert.equal(status.source, "portable");
  } finally {
    if (previous === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previous;
  }
});

test("verified portable runtime starts, becomes healthy, reports status, and stops", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX mock executable test");
  const root = await mkdtemp(join(tmpdir(), "aether-lifecycle-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "llama-server");
  await writeFile(binary, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("mock llama-server 0.4.0"); process.exit(0); }
const http = require("http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end('{"status":"ok"}');
  }
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.messages[0]?.role !== "system" || !input.messages[0]?.content.includes("conversation as memory")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      return response.end('{"error":{"message":"missing memory system instruction"}}');
    }
    if (input.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\\n\\n');
      response.write('data: {"choices":[{"delta":{"content":"streaming Aether"}}]}\\n\\n');
      return response.end('data: [DONE]\\n\\n');
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end('{"choices":[{"message":{"role":"assistant","content":"Hello from local Aether"}}]}');
  }
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end('{}');
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  await chmod(binary, 0o755);

  const adapter = new LlamaCppAdapter({ runtimeRoot: root, modelsRoot: join(root, "models"), healthTimeout: 5000 });
  const started = await adapter.start({ modelsDirectory: join(root, "models") });
  assert.equal(started.state, "healthy");
  assert.equal(started.running, true);
  assert.equal(started.healthy, true);
  assert.equal(started.server.host, "127.0.0.1");
  assert.ok(started.server.port > 0);

  const stopped = await adapter.stop();
  assert.equal(stopped.state, "verified");
  assert.equal(stopped.running, false);
  assert.equal(stopped.healthy, false);

  const model = adapter.recommendedModel();
  await mkdir(dirname(model.path), { recursive: true });
  await writeFile(model.path, "mock gguf");
  const loaded = await adapter.loadRecommendedModel();
  assert.equal(loaded.healthy, true);
  const chat = await adapter.chat("Say hello");
  assert.equal(chat.message, "Hello from local Aether");
  assert.equal(chat.model, "qwen2.5-0.5b-instruct-q4-k-m");
  const streamed = [];
  for await (const delta of adapter.chatStream("Stream hello")) streamed.push(delta);
  assert.deepEqual(streamed, ["Hello ", "streaming Aether"]);
  const benchmark = await adapter.benchmarkModel(model.id);
  assert.equal(benchmark.status, "success");
  assert.equal(benchmark.acceleration, "cpu");
  assert.equal(benchmark.contextSize, 2048);
  assert.ok(benchmark.tokensPerSecond > 0);
  assert.ok(benchmark.generatedTokens > 0);
  await adapter.stop();
});
