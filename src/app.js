import http from "http";
import { join } from "path";
import { getCapabilities } from "./core/capabilities.js";
import { detectHardware } from "./core/hardware.js";
import { ProviderManager } from "./core/providers.js";
import { loadConfig, saveConfig } from "./core/config.js";
import { appendMessage as defaultAppendMessage, createConversation, deleteConversation, getConversation, listConversations } from "./core/conversations.js";
import { selectModel } from "./core/model-selector.js";
import { servePublicAsset } from "./core/static.js";
import { buildCapabilityProfile, planExecution } from "./core/capability-core.js";
import { listExecutions, recordExecution as defaultRecordExecution, summarizeExecutions } from "./core/executions.js";
import { listBenchmarks, recordBenchmark, summarizeBenchmarks } from "./core/benchmarks.js";
import { activateFailover, failoverRoutes, mayFailOver } from "./core/failover.js";
import { buildAccelerationProfile } from "./core/acceleration.js";
import { OperationGate, operationForRequest } from "./core/operations.js";

// Construct without listening, allowing isolated HTTP tests with fake providers.
export function createAetherApp({ providerManager = new ProviderManager(), publicRoot = join(process.cwd(), "public"), persistence = {} } = {}) {
  const { appendMessage = defaultAppendMessage, recordExecution = defaultRecordExecution } = persistence;
  const operations = new OperationGate();

  function persistenceFailure(conversationId, phase) {
    return {
      code: "AETHER_PERSISTENCE_UNCERTAIN", conversationId, phase,
      inferenceCompleted: true, retrySafe: false,
      message: "The model completed its answer, but saving could not be confirmed. Check the conversation before retrying; resubmitting chat runs inference again."
    };
  }

  async function capabilitySnapshot() {
    const providers = providerManager.getProviders().map(({ id }) => providerManager.getProvider(id));
    const [providerStatuses, modelGroups, executions, benchmarks] = await Promise.all([
      providerManager.detectAll(),
      Promise.all(providers.map(async (provider) => typeof provider.modelCatalogStatus === "function" ? await provider.modelCatalogStatus() : [])),
      listExecutions({ limit: 200 }),
      listBenchmarks({ limit: 200 })
    ]);
    const benchmarkSummary = summarizeBenchmarks(benchmarks);
    const hardware = detectHardware();
    const providerReports = await Promise.all(providers.map(async (provider) => typeof provider.accelerationStatus === "function" ? await provider.accelerationStatus() : { providerId: provider.id, runtimeVerified: false, cpuAvailable: false, devices: [] }));
    const acceleration = buildAccelerationProfile({ hardware, providerReports, benchmarks: benchmarkSummary });
    hardware.verifiedAcceleration = acceleration.verified;
    return buildCapabilityProfile({
      hardware,
      providers: providerStatuses,
      models: modelGroups.flat(),
      executionSummary: summarizeExecutions(executions),
      benchmarkSummary,
      acceleration
    });
  }

  async function accelerationSnapshot() {
    const providers = providerManager.getProviders().map(({ id }) => providerManager.getProvider(id));
    const [providerReports, benchmarks] = await Promise.all([
      Promise.all(providers.map(async (provider) => typeof provider.accelerationStatus === "function" ? await provider.accelerationStatus() : { providerId: provider.id, runtimeVerified: false, cpuAvailable: false, devices: [] })),
      listBenchmarks({ limit: 200 })
    ]);
    return buildAccelerationProfile({ hardware: detectHardware(), providerReports, benchmarks: summarizeBenchmarks(benchmarks) });
  }

  async function createChatDecision(input = {}) {
    return planExecution(await capabilitySnapshot(), {
      task: "chat",
      privacy: input.privacy,
      priority: input.priority,
      providerId: input.providerId,
      modelId: input.modelId
    });
  }

  function requireExecutionPath(decision) {
    if (decision.selected && decision.status !== "blocked") return decision;
    const error = new Error(`Aether has no ready local execution path (${decision.requiredActions.join(", ") || "setup required"})`);
    error.statusCode = 409;
    throw error;
  }

  async function prepareExecutionPath(decision) {
    const provider = providerManager.getProvider(decision.selected.providerId);
    if (!provider) throw new Error(`Selected provider is unavailable: ${decision.selected.providerId}`);
    const model = await provider.modelStatus(decision.selected.modelId);
    if (!model.loaded) {
      await provider.loadModel(decision.selected.modelId);
      decision.preparation = { actions: ["load-model"], completed: true };
      decision.reasons.push(`${model.name} was loaded automatically for this request.`);
    } else decision.preparation = { actions: [], completed: true };
    decision.status = "ready";
    decision.selected.ready = true;
    decision.requiredActions = [];
    return provider;
  }

  function validateMessage(message) {
    if (typeof message !== "string" || !message.trim()) {
      const error = new Error("A non-empty message is required");
      error.statusCode = 400;
      throw error;
    }
    return message.trim();
  }

  function errorCategory(error) {
    if (/health|running|loaded|execution path/i.test(error.message)) return "unavailable";
    if (/timeout|timed out/i.test(error.message)) return "timeout";
    return "inference-error";
  }

  function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload, null, 2));
  }

  async function readJson(req) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1024 * 1024) throw new Error("Request body is too large");
    }
    return body ? JSON.parse(body) : {};
  }

  const server = http.createServer(async function (req, res) {
    let release;
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const operation = operationForRequest(req.method, url.pathname);
      if (operation) release = operations.acquire(operation);

      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, {
          name: "Aether",
          version: "0.13.1",
          status: "online",
          mode: "local",
          backend: null,
          operations: operations.status()
        });
      }

      if (req.method === "GET" && url.pathname === "/api/capabilities") {
        return sendJson(res, 200, {
          status: "ok",
          capabilities: getCapabilities()
        });
      }

      if (req.method === "GET" && url.pathname === "/api/hardware") {
        return sendJson(res, 200, {
          status: "ok",
          hardware: detectHardware()
        });
      }

      if (req.method === "GET" && url.pathname === "/api/acceleration") {
        return sendJson(res, 200, await accelerationSnapshot());
      }

      if (req.method === "GET" && url.pathname === "/api/capability-profile") {
        return sendJson(res, 200, { status: "ok", profile: await capabilitySnapshot() });
      }

      if (req.method === "POST" && url.pathname === "/api/decisions/preview") {
        return sendJson(res, 200, { status: "ok", decision: await createChatDecision(await readJson(req)) });
      }

      if (req.method === "GET" && url.pathname === "/api/executions") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
        const executions = await listExecutions({ limit });
        return sendJson(res, 200, { status: "ok", executions, strategies: summarizeExecutions(executions) });
      }

      if (req.method === "GET" && url.pathname === "/api/benchmarks") {
        const benchmarks = await listBenchmarks({ limit: 200 });
        return sendJson(res, 200, { status: "ok", benchmarks, profiles: summarizeBenchmarks(benchmarks) });
      }

      if (req.method === "POST" && url.pathname === "/api/benchmarks/run") {
        const input = await readJson(req);
        if (input.permission !== true) {
          const error = new Error("Explicit permission is required to run local performance benchmarks");
          error.statusCode = 403;
          throw error;
        }
        const results = [];
        const restorations = [];
        const requestedProviders = Array.isArray(input.providerIds) ? new Set(input.providerIds) : null;
        const requestedModels = Array.isArray(input.modelIds) ? new Set(input.modelIds) : null;
        for (const descriptor of providerManager.getProviders()) {
          if (requestedProviders && !requestedProviders.has(descriptor.id)) continue;
          const provider = providerManager.getProvider(descriptor.id);
          if (typeof provider.modelCatalogStatus !== "function" || typeof provider.benchmarkModel !== "function") continue;
          const initialModels = await provider.modelCatalogStatus();
          restorations.push({ provider, models: initialModels, loadedId: initialModels.find((model) => model.loaded)?.id || null });
          for (const model of initialModels) {
            if (!model.installed || (requestedModels && !requestedModels.has(model.id))) continue;
            try {
              results.push(await recordBenchmark(await provider.benchmarkModel(model.id)));
            } catch (error) {
              results.push(await recordBenchmark({ providerId: provider.id, modelId: model.id, status: "error", errorCategory: errorCategory(error) }));
            }
          }
        }
        const selectedModel = (await loadConfig()).selectedModel;
        for (const restoration of restorations) {
          const restoreId = restoration.loadedId || (restoration.provider.id === "llama-cpp" ? selectedModel : null);
          if (restoreId && restoration.models.some((model) => model.id === restoreId && model.installed)) await restoration.provider.loadModel(restoreId);
        }
        return sendJson(res, 200, { status: "ok", benchmarks: results, profiles: summarizeBenchmarks(await listBenchmarks({ limit: 200 })) });
      }

      if (req.method === "GET" && url.pathname === "/api/providers") {
        return sendJson(res, 200, {
          status: "ok",
          providers: providerManager.getProviders()
        });
      }

      if (req.method === "GET" && url.pathname === "/api/providers/detect") {
        return sendJson(res, 200, {
          status: "ok",
          providers: await providerManager.detectAll()
        });
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/status")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const providerId = parts[2];
        const provider = providerManager.getProvider(providerId);

        if (!provider) {
          return sendJson(res, 404, {
            error: "Provider not found",
            provider: providerId
          });
        }

        return sendJson(res, 200, {
          status: "ok",
          provider: await provider.status()
        });
      }

      if (req.method === "POST" && /^\/api\/providers\/[^/]+\/models\/[^/]+\/provision$/.test(url.pathname)) {
        const parts = url.pathname.split("/").filter(Boolean);
        const provider = providerManager.getProvider(parts[2]);
        if (!provider) return sendJson(res, 404, { error: "Provider not found", provider: parts[2] });
        if (typeof provider.provisionModel !== "function") return sendJson(res, 409, { error: "Model provisioning is not supported", provider: parts[2] });
        return sendJson(res, 200, { status: "ok", model: await provider.provisionModel({ ...await readJson(req), modelId: parts[4] }) });
      }

      if (req.method === "POST" && /^\/api\/providers\/[^/]+\/models\/[^/]+\/load$/.test(url.pathname)) {
        const parts = url.pathname.split("/").filter(Boolean);
        const provider = providerManager.getProvider(parts[2]);
        if (!provider) return sendJson(res, 404, { error: "Provider not found", provider: parts[2] });
        const status = await provider.loadModel(parts[4]);
        if (provider.id === "llama-cpp") await saveConfig({ ...await loadConfig(), selectedModel: parts[4], autoRestore: true });
        return sendJson(res, 200, { status: "ok", provider: status, model: await provider.modelStatus(parts[4]) });
      }

      if (req.method === "POST" && /^\/api\/providers\/[^/]+\/provision$/.test(url.pathname)) {
        const parts = url.pathname.split("/").filter(Boolean);
        const providerId = parts[2];
        const provider = providerManager.getProvider(providerId);

        if (!provider) return sendJson(res, 404, { error: "Provider not found", provider: providerId });

        const input = await readJson(req);
        if (typeof provider.provision !== "function") return sendJson(res, 409, { error: "Provider provisioning is not supported", provider: providerId });
        return sendJson(res, 200, { status: "ok", provider: await provider.provision(input) });
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/start")) {
        const providerId = url.pathname.split("/").filter(Boolean)[2];
        const provider = providerManager.getProvider(providerId);
        if (!provider) return sendJson(res, 404, { error: "Provider not found", provider: providerId });
        return sendJson(res, 200, { status: "ok", provider: await provider.start() });
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/stop")) {
        const providerId = url.pathname.split("/").filter(Boolean)[2];
        const provider = providerManager.getProvider(providerId);
        if (!provider) return sendJson(res, 404, { error: "Provider not found", provider: providerId });
        return sendJson(res, 200, { status: "ok", provider: await provider.stop() });
      }

      if (req.method === "GET" && url.pathname === "/api/models/recommended") {
        const provider = providerManager.getProvider("llama-cpp");
        const model = await provider.modelStatus();
        return sendJson(res, 200, { status: "ok", model, recommendation: selectModel(detectHardware(), await provider.modelCatalogStatus()) });
      }

      if (req.method === "POST" && url.pathname === "/api/models/recommended/provision") {
        const provider = providerManager.getProvider("llama-cpp");
        return sendJson(res, 200, { status: "ok", model: await provider.provisionModel(await readJson(req)) });
      }

      if (req.method === "POST" && url.pathname === "/api/models/recommended/load") {
        const provider = providerManager.getProvider("llama-cpp");
        const status = await provider.loadRecommendedModel();
        await saveConfig({ ...await loadConfig(), selectedModel: provider.recommendedModel().id, autoRestore: true });
        return sendJson(res, 200, { status: "ok", provider: status, model: await provider.modelStatus() });
      }

      if (req.method === "GET" && url.pathname === "/api/models") {
        const providers = providerManager.getProviders().map(({ id }) => providerManager.getProvider(id));
        const models = (await Promise.all(providers.map(async (provider) => typeof provider.modelCatalogStatus === "function" ? await provider.modelCatalogStatus() : []))).flat();
        const llamaModels = models.filter((model) => model.providerId === "llama-cpp");
        return sendJson(res, 200, { status: "ok", models, recommendation: selectModel(detectHardware(), llamaModels) });
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/models/") && url.pathname.endsWith("/provision")) {
        const modelId = url.pathname.split("/").filter(Boolean)[2];
        const provider = providerManager.getProvider("llama-cpp");
        return sendJson(res, 200, { status: "ok", model: await provider.provisionModel({ ...await readJson(req), modelId }) });
      }

      if (req.method === "POST" && url.pathname.startsWith("/api/models/") && url.pathname.endsWith("/load")) {
        const modelId = url.pathname.split("/").filter(Boolean)[2];
        const provider = providerManager.getProvider("llama-cpp");
        const status = await provider.loadModel(modelId);
        await saveConfig({ ...await loadConfig(), selectedModel: modelId, autoRestore: true });
        return sendJson(res, 200, { status: "ok", provider: status, model: await provider.modelStatus(modelId) });
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const input = await readJson(req);
        const message = validateMessage(input.message);
        const decision = requireExecutionPath(await createChatDecision(input));
        const conversation = input.conversationId ? await getConversation(input.conversationId) : await createConversation();
        const history = conversation.messages.map(({ role, content }) => ({ role, content }));
        await appendMessage(conversation.id, "user", message);
        const routes = failoverRoutes(decision);
        const attempts = [];
        let previousError = null;
        for (let index = 0; index < routes.length; index += 1) {
          if (index > 0) activateFailover(decision, routes[index], previousError);
          const startedAt = new Date().toISOString();
          const started = Date.now();
          let completedResponse = null;
          let phase = "assistant-message";
          try {
            const provider = await prepareExecutionPath(decision);
            const response = await provider.chat(message, history, { modelId: decision.selected.modelId });
            completedResponse = response;
            await appendMessage(conversation.id, "assistant", response.message);
            phase = "execution-record";
            const execution = await recordExecution({ decisionId: decision.id, conversationId: conversation.id, providerId: response.provider, modelId: response.model, task: "chat", outcome: "success", startedAt, durationMs: Date.now() - started, inputCharacters: message.length, outputCharacters: response.message.length });
            attempts.push(execution);
            return sendJson(res, 200, { status: "ok", conversationId: conversation.id, decision, execution, attempts, response });
          } catch (error) {
            // Storage failure is not evidence that this model failed inference.
            // Never invoke an alternate or write a misleading error measurement.
            if (completedResponse) return sendJson(res, 500, {
              error: "Aether persistence error", ...persistenceFailure(conversation.id, phase),
              response: completedResponse, decision, attempts
            });
            previousError = error;
            attempts.push(await recordExecution({ decisionId: decision.id, conversationId: conversation.id, providerId: decision.selected.providerId, modelId: decision.selected.modelId, task: "chat", outcome: "error", startedAt, durationMs: Date.now() - started, inputCharacters: message.length, errorCategory: errorCategory(error) }));
            if (!mayFailOver({ remainingRoutes: routes.length - index - 1 })) throw error;
          }
        }
        throw previousError || new Error("No local execution route completed the request");
      }

      if (req.method === "POST" && url.pathname === "/api/chat/stream") {
        const input = await readJson(req);
        const message = validateMessage(input.message);
        const conversationId = input.conversationId;
        const decision = requireExecutionPath(await createChatDecision(input));
        const conversation = conversationId ? await getConversation(conversationId) : await createConversation();
        const history = conversation.messages.map(({ role, content }) => ({ role, content }));
        await appendMessage(conversation.id, "user", message);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        });
        let complete = "";
        const routes = failoverRoutes(decision);
        const attempts = [];
        let previousError = null;
        res.write(`data: ${JSON.stringify({ type: "conversation", conversationId: conversation.id })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "decision", decision })}\n\n`);
        for (let index = 0; index < routes.length; index += 1) {
          if (index > 0) {
            activateFailover(decision, routes[index], previousError);
            res.write(`data: ${JSON.stringify({ type: "fallback", decision, from: decision.failover.from, to: decision.failover.to })}\n\n`);
          }
          const startedAt = new Date().toISOString();
          const started = Date.now();
          let inferenceCompleted = false;
          let phase = "assistant-message";
          try {
            const provider = await prepareExecutionPath(decision);
            for await (const delta of provider.chatStream(message, history, { modelId: decision.selected.modelId })) {
              complete += delta;
              res.write(`data: ${JSON.stringify({ type: "delta", delta })}\n\n`);
            }
            inferenceCompleted = true;
            if (complete) await appendMessage(conversation.id, "assistant", complete);
            phase = "execution-record";
            const execution = await recordExecution({ decisionId: decision.id, conversationId: conversation.id, providerId: decision.selected.providerId, modelId: decision.selected.modelId, task: "chat", outcome: "success", startedAt, durationMs: Date.now() - started, inputCharacters: message.length, outputCharacters: complete.length });
            attempts.push(execution);
            res.write(`data: ${JSON.stringify({ type: "done", execution, attempts, decision })}\n\n`);
            return res.end();
          } catch (error) {
            if (inferenceCompleted) {
              const failure = persistenceFailure(conversation.id, phase);
              res.write(`data: ${JSON.stringify({ type: "error", error: failure.message, ...failure })}\n\n`);
              return res.end();
            }
            previousError = error;
            attempts.push(await recordExecution({ decisionId: decision.id, conversationId: conversation.id, providerId: decision.selected.providerId, modelId: decision.selected.modelId, task: "chat", outcome: "error", startedAt, durationMs: Date.now() - started, inputCharacters: message.length, outputCharacters: complete.length, errorCategory: errorCategory(error) }));
            if (!mayFailOver({ outputStarted: complete.length > 0, remainingRoutes: routes.length - index - 1 })) {
              res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
              return res.end();
            }
          }
        }
        res.write(`data: ${JSON.stringify({ type: "error", error: previousError?.message || "No local execution route completed the request" })}\n\n`);
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/api/conversations") {
        return sendJson(res, 200, { status: "ok", conversations: await listConversations() });
      }

      if (url.pathname.startsWith("/api/conversations/")) {
        const conversationId = url.pathname.split("/").filter(Boolean)[2];
        if (req.method === "GET") return sendJson(res, 200, { status: "ok", conversation: await getConversation(conversationId) });
        if (req.method === "DELETE") {
          await deleteConversation(conversationId);
          return sendJson(res, 200, { status: "ok", deleted: conversationId });
        }
      }

      if (req.method === "GET" && !url.pathname.startsWith("/api/") && await servePublicAsset(res, url.pathname, publicRoot)) return;

      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      // A disconnected browser does not prove that inference has stopped. Keep
      // ownership until the handler exits, including its persistence work.
      if (res.destroyed) return;
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
        return res.end();
      }
      if (error.code === "AETHER_BUSY" || error.code === "AETHER_STOPPING") {
        req.resume();
        return sendJson(res, error.statusCode, { error: "Aether unavailable", code: error.code, message: error.message, operations: error.operation });
      }
      return sendJson(res, error.statusCode || 500, {
        error: "Aether internal error",
        message: error.message
      });
    } finally {
      release?.();
    }
  });

  async function restoreSelection() {
    const release = operations.acquire("restore");
    try {
      const config = await loadConfig();
      const provider = providerManager.getProvider("llama-cpp");
      if (config.autoRestore && config.selectedModel) {
        const model = await provider.modelStatus(config.selectedModel);
        if (!model.installed) return;
        await provider.loadModel(config.selectedModel);
        return model;
      }
    } finally {
      release();
    }
  }

  return { server, restoreSelection, operations, providerManager };
}
