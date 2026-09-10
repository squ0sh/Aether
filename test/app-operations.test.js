import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Import storage only after redirecting it away from the user's conversations.
const root = await mkdtemp(join(tmpdir(), "aether-operation-http-test-"));
const previousDataDir = process.env.AETHER_DATA_DIR;
process.env.AETHER_DATA_DIR = root;
const { createAetherApp } = await import("../src/app.js");
const { saveConfig } = await import("../src/core/config.js");
after(async () => {
  if (previousDataDir === undefined) delete process.env.AETHER_DATA_DIR;
  else process.env.AETHER_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(context) {
  const started = deferred();
  const finish = deferred();
  const calls = [];
  const provider = {
    id: "llama-cpp", name: "Mock runtime", loaded: "small", fail: false,
    async status() { return { id: this.id, name: this.name, verified: true, healthy: true, running: true }; },
    async modelStatus(id = "small") { return { id, providerId: this.id, name: id, installed: true, loaded: this.loaded === id, sizeBytes: 1000 }; },
    async modelCatalogStatus() { return await Promise.all([this.modelStatus("small"), this.modelStatus("alternate")]); },
    recommendedModel() { return { id: "small" }; },
    async loadModel(id) { calls.push(`load:${id}`); this.loaded = id; return await this.status(); },
    async loadRecommendedModel() { return await this.loadModel("small"); },
    async stop() { calls.push("stop"); return await this.status(); },
    async start() { calls.push("start"); return await this.status(); },
    async provision() { calls.push("provision-runtime"); return await this.status(); },
    async provisionModel() { calls.push("provision-model"); return await this.modelStatus(); },
    async chat(message, history, options) {
      calls.push(`chat:${options.modelId}`);
      started.resolve();
      await finish.promise;
      if (this.fail) throw new Error("mock inference failed");
      return { provider: this.id, model: options.modelId, message: "complete answer" };
    },
    async *chatStream(message, history, options) {
      calls.push(`stream:${options.modelId}`);
      yield "first ";
      started.resolve();
      await finish.promise;
      if (this.fail) throw new Error("mock streaming failed");
      yield "last";
    },
    async benchmarkModel(id) {
      calls.push(`benchmark:${id}`);
      started.resolve();
      await finish.promise;
      return { providerId: this.id, modelId: id, status: "success", tokensPerSecond: 1 };
    }
  };
  const providerManager = {
    getProviders: () => [{ id: provider.id, name: provider.name }],
    getProvider: (id) => id === provider.id ? provider : null,
    detectAll: async () => [await provider.status()],
    stopAll: async () => provider.stop()
  };
  const app = createAetherApp({ providerManager });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(async () => {
    finish.resolve();
    app.operations.close();
    await app.operations.whenIdle();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, body, method = body === undefined ? "GET" : "POST", options = {}) => fetch(url + path, {
    method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), ...options
  });
  return { ...app, provider, calls, started, finish, request };
}

const chatInput = { message: "hello", providerId: "llama-cpp", modelId: "small" };

async function assertBusy(response, kind) {
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "AETHER_BUSY");
  assert.equal(body.operations.active.kind, kind);
  assert.match(body.message, /not started/);
}

test("streaming owns the runtime and conversation until the complete answer is committed", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  const streaming = f.request("/api/chat/stream", chatInput);
  await f.started.promise;
  const response = await streaming;
  const before = await (await f.request("/api/conversations")).json();
  const current = before.conversations.find((item) => item.messageCount === 1);
  assert.ok(current);
  const blockedPaths = [
    "/api/chat", "/api/chat/stream", "/api/benchmarks/run",
    "/api/models/recommended/load", "/api/models/alternate/load",
    "/api/models/recommended/provision", "/api/models/alternate/provision",
    "/api/providers/llama-cpp/models/alternate/load", "/api/providers/llama-cpp/models/alternate/provision",
    "/api/providers/llama-cpp/start", "/api/providers/llama-cpp/stop", "/api/providers/llama-cpp/provision"
  ];
  for (const path of blockedPaths) await assertBusy(await f.request(path, { ...chatInput, permission: true }), "chat");
  await assertBusy(await f.request(`/api/conversations/${current.id}`, undefined, "DELETE"), "chat");
  assert.deepEqual(f.calls, ["stream:small"]);
  assert.deepEqual(await (await f.request("/api/conversations")).json(), before, "busy requests must not add or delete messages");
  assert.equal((await (await f.request("/api/status")).json()).operations.state, "busy");
  assert.equal((await f.request("/api/models")).status, 200);
  assert.equal((await f.request("/api/decisions/preview", chatInput)).status, 200);
  f.finish.resolve();
  assert.match(await response.text(), /"type":"done"/);
  await f.operations.whenIdle();
  const saved = await (await f.request(`/api/conversations/${current.id}`)).json();
  assert.deepEqual(saved.conversation.messages.map((item) => item.content), ["hello", "first last"]);
  assert.equal((await f.request("/api/models/alternate/load", {})).status, 200);
  assert.equal(f.operations.status().state, "idle");
});

test("JSON inference failure releases ownership for the next operation", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  f.provider.fail = true;
  const chatting = f.request("/api/chat", chatInput);
  await f.started.promise;
  await assertBusy(await f.request("/api/providers/llama-cpp/stop", {}), "chat");
  f.finish.resolve();
  const response = await chatting;
  assert.equal(response.status, 500);
  assert.match((await response.json()).message, /mock inference failed/);
  assert.equal((await f.request("/api/providers/llama-cpp/stop", {})).status, 200);
});

test("automatic failover stays under one lease and appends the user only once", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  f.provider.loaded = "fallback-primary";
  f.provider.modelCatalogStatus = async () => [await f.provider.modelStatus("fallback-primary"), await f.provider.modelStatus("fallback-alternate")];
  f.provider.chat = async (message, history, { modelId }) => {
    f.calls.push(`chat:${modelId}`);
    if (modelId === "fallback-primary") throw new Error("primary unavailable");
    f.started.resolve();
    await f.finish.promise;
    return { provider: f.provider.id, model: modelId, message: "alternate answer" };
  };
  const chatting = f.request("/api/chat", { message: "one user turn" });
  await f.started.promise;
  await assertBusy(await f.request("/api/providers/llama-cpp/stop", {}), "chat");
  f.finish.resolve();
  const result = await (await chatting).json();
  assert.equal(result.status, "ok");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.decision.failover.to.modelId, "fallback-alternate");
  const saved = await (await f.request(`/api/conversations/${result.conversationId}`)).json();
  assert.deepEqual(saved.conversation.messages.map((item) => item.content), ["one user turn", "alternate answer"]);
  assert.deepEqual(f.calls, ["chat:fallback-primary", "load:fallback-alternate", "chat:fallback-alternate"]);
  assert.equal(f.operations.status().state, "idle");
});

test("stream failure releases ownership without mixing an alternate answer", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  f.provider.fail = true;
  const chatting = f.request("/api/chat/stream", { message: "hello" });
  await f.started.promise;
  f.finish.resolve();
  const text = await (await chatting).text();
  assert.match(text, /"type":"error"/);
  assert.doesNotMatch(text, /"type":"fallback"|"type":"done"/);
  assert.equal((await f.request("/api/providers/llama-cpp/stop", {})).status, 200);
});

test("benchmark work and restoration own the runtime; permission errors do not leak ownership", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  assert.equal((await f.request("/api/benchmarks/run", {})).status, 403);
  assert.equal(f.operations.status().state, "idle");
  const benchmarking = f.request("/api/benchmarks/run", { permission: true, modelIds: ["small"] });
  await f.started.promise;
  await assertBusy(await f.request("/api/chat", chatInput), "benchmark");
  const originalLoad = f.provider.loadModel.bind(f.provider);
  f.provider.loadModel = async (id) => {
    assert.equal(f.operations.status().active.kind, "benchmark", "restoration must remain protected");
    return await originalLoad(id);
  };
  f.finish.resolve();
  assert.equal((await benchmarking).status, 200);
  assert.deepEqual(f.calls, ["benchmark:small", "load:small"]);
  assert.equal(f.operations.status().state, "idle");
});

test("startup restore owns the same lease before its first asynchronous read", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  await saveConfig({ selectedModel: "small", autoRestore: true });
  f.provider.loadModel = async () => { f.started.resolve(); await f.finish.promise; };
  const restoring = f.restoreSelection();
  assert.equal(f.operations.status().active.kind, "restore");
  await f.started.promise;
  await assertBusy(await f.request("/api/chat", chatInput), "restore");
  f.finish.resolve();
  await restoring;
  assert.equal(f.operations.status().state, "idle");
  await saveConfig({ autoRestore: false, selectedModel: null });
});

test("invalid input, missing routes, and provider errors do not retain ownership", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  for (const [path, input, expected] of [["/api/chat", {}, 400], ["/api/chat", "{", 500], ["/api/missing", {}, 404]]) {
    assert.equal((await f.request(path, input)).status, expected);
    assert.equal(f.operations.status().state, "idle");
  }
  f.provider.loadModel = async () => { throw new Error("load failed"); };
  assert.equal((await f.request("/api/models/alternate/load", {})).status, 500);
  assert.equal(f.operations.status().state, "idle");
  await saveConfig({ selectedModel: "small", autoRestore: true });
  await assert.rejects(f.restoreSelection(), /load failed/);
  assert.equal(f.operations.status().state, "idle");
  await saveConfig({ selectedModel: null, autoRestore: false });
});

test("stopping state rejects new mutations but remains observable", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  f.operations.close();
  const response = await f.request("/api/chat", chatInput);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "AETHER_STOPPING");
  assert.equal((await (await f.request("/api/status")).json()).operations.state, "stopping");
  assert.deepEqual(f.calls, []);
});

test("closing a browser stream does not release ownership while inference still runs", { timeout: 10000 }, async (context) => {
  const f = await fixture(context);
  const controller = new AbortController();
  const chatting = f.request("/api/chat/stream", chatInput, "POST", { signal: controller.signal });
  await f.started.promise;
  const response = await chatting;
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read());
  await assertBusy(await f.request("/api/models/alternate/load", {}), "chat");
  f.finish.resolve();
  await f.operations.whenIdle();
  assert.equal((await f.request("/api/models/alternate/load", {})).status, 200);
});
