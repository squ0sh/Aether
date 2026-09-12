import { consumeChatStream, interruptedAnswer } from "./chat-stream.js";

const $ = (selector) => document.querySelector(selector);

const elements = {
  accelerationStatus: $("#acceleration-status"),
  accelerationSummary: $("#acceleration-summary"),
  chatScroll: $("#chat-scroll"),
  benchmarkAction: $("#benchmark-action"),
  benchmarkResults: $("#benchmark-results"),
  benchmarkSummary: $("#benchmark-summary"),
  closeDecision: $("#close-decision"),
  closeSetup: $("#close-setup"),
  closeSidebar: $("#close-sidebar"),
  composer: $("#composer"),
  decisionButton: $("#decision-button"),
  decisionDialog: $("#decision-dialog"),
  decisionId: $("#decision-id"),
  decisionMetrics: $("#decision-metrics"),
  decisionReasons: $("#decision-reasons"),
  decisionRoute: $("#decision-route"),
  emptyList: $("#empty-list"),
  engineAction: $("#engine-action"),
  engineIcon: $("#engine-icon"),
  engineStatus: $("#engine-status"),
  input: $("#message-input"),
  list: $("#conversation-list"),
  messages: $("#messages"),
  modelAction: $("#model-action"),
  modelIcon: $("#model-icon"),
  modelSelect: $("#model-select"),
  modelStatus: $("#model-status"),
  newChat: $("#new-chat"),
  openSetup: $("#open-setup"),
  prioritySelect: $("#priority-select"),
  refresh: $("#refresh"),
  runtimeDetail: $("#runtime-detail"),
  runtimeTitle: $("#runtime-title"),
  search: $("#conversation-search"),
  send: $("#send-button"),
  setup: $("#setup-dialog"),
  setupDecision: $("#setup-decision"),
  setupMessage: $("#setup-message"),
  sidebarScrim: $("#sidebar-scrim"),
  statusDot: $("#status-dot"),
  stop: $("#stop-button"),
  title: $("#conversation-title"),
  toast: $("#toast"),
  welcome: $("#welcome")
};

const state = {
  acceleration: null,
  conversations: [],
  currentId: null,
  models: [],
  providers: [],
  provider: null,
  recommendation: null,
  decision: null,
  benchmarks: [],
  modelOverride: null,
  priority: ["speed", "balanced", "quality"].includes(localStorage.getItem("aether-priority")) ? localStorage.getItem("aether-priority") : "balanced",
  controller: null,
  busy: false
};

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || result.error || `Request failed (${response.status})`);
  return result;
}

function notify(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { elements.toast.className = "toast"; }, 3600);
}

async function refreshDecision() {
  const override = selectedRoute();
  const result = await api("/api/decisions/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "chat", privacy: "local-only", priority: state.priority, providerId: override?.providerId, modelId: override?.modelId })
  });
  state.decision = result.decision;
  return state.decision;
}

function metric(value, label) {
  const item = document.createElement("div");
  item.className = "metric";
  const strong = document.createElement("strong");
  strong.textContent = value;
  const span = document.createElement("span");
  span.textContent = label;
  item.append(strong, span);
  return item;
}

function renderDecision(decision) {
  elements.decisionRoute.replaceChildren();
  elements.decisionReasons.replaceChildren();
  elements.decisionMetrics.replaceChildren();
  if (decision?.selected) {
    const model = state.models.find((item) => item.id === decision.selected.modelId && item.providerId === decision.selected.providerId);
    const runtime = state.providers.find((item) => item.id === decision.selected.providerId)?.name || decision.selected.providerId;
    const runtimeNode = document.createElement("div");
    runtimeNode.className = "route-node";
    runtimeNode.innerHTML = `<span>Runtime</span><strong>${escapeHtml(runtime)}</strong>`;
    const arrow = document.createElement("div");
    arrow.className = "route-arrow";
    arrow.textContent = "→";
    const modelNode = document.createElement("div");
    modelNode.className = "route-node";
    modelNode.innerHTML = `<span>Model</span><strong>${escapeHtml(model?.name || decision.selected.modelId)}</strong>`;
    elements.decisionRoute.append(runtimeNode, arrow, modelNode);
    const measured = decision.selected.measured;
    const benchmark = decision.selected.benchmark;
    elements.decisionMetrics.append(
      metric(String(decision.selected.score), "Decision score"),
      metric(benchmark?.tokensPerSecond ? `${benchmark.tokensPerSecond}` : "—", "Tokens / second"),
      metric(measured?.attempts ? `${Math.round(measured.successRate * 100)}%` : "New", "Local success")
    );
  } else {
    const blocked = document.createElement("div");
    blocked.className = "decision-blocked";
    blocked.textContent = `No route is ready yet. Required: ${(decision?.requiredActions || []).join(", ") || "local setup"}.`;
    elements.decisionRoute.append(blocked);
    elements.decisionMetrics.append(metric("0", "Ready routes"), metric("Local", "Privacy"), metric("Paused", "Decision"));
  }
  for (const reason of decision?.reasons || []) {
    const item = document.createElement("li");
    item.textContent = reason;
    elements.decisionReasons.append(item);
  }
  elements.decisionId.textContent = decision?.id ? `Decision ${decision.id}` : "No decision record available";
}

async function showDecision() {
  try {
    const decision = await refreshDecision();
    renderDecision(decision);
    if (elements.setup.open) elements.setup.close();
    elements.decisionDialog.showModal();
  } catch (error) { notify(error.message, true); }
}

function closeSidebar() { document.body.classList.remove("sidebar-open"); }
function formatDate(value) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderConversations() {
  const query = elements.search.value.trim().toLowerCase();
  const conversations = state.conversations.filter((item) => item.title.toLowerCase().includes(query));
  elements.list.replaceChildren();
  elements.emptyList.hidden = conversations.length > 0;

  for (const conversation of conversations) {
    const button = document.createElement("button");
    button.className = `conversation-item${conversation.id === state.currentId ? " active" : ""}`;
    button.dataset.id = conversation.id;
    const title = document.createElement("strong");
    title.textContent = conversation.title;
    const details = document.createElement("small");
    details.textContent = `${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"} · ${formatDate(conversation.updatedAt)}`;
    const remove = document.createElement("button");
    remove.className = "delete-chat";
    remove.type = "button";
    remove.title = "Delete conversation";
    remove.setAttribute("aria-label", `Delete ${conversation.title}`);
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteConversation(conversation);
    });
    button.append(title, details, remove);
    button.addEventListener("click", () => openConversation(conversation.id));
    elements.list.append(button);
  }
}

async function loadConversations() {
  const result = await api("/api/conversations");
  state.conversations = result.conversations || [];
  renderConversations();
}

async function openConversation(id) {
  if (state.busy || id === state.currentId) return;
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(id)}`);
    state.currentId = id;
    elements.title.textContent = result.conversation.title;
    elements.messages.replaceChildren();
    elements.welcome.hidden = true;
    for (const message of result.conversation.messages) addMessage(message.role, message.content);
    renderConversations();
    closeSidebar();
    scrollToBottom(false);
  } catch (error) { notify(error.message, true); }
}

async function deleteConversation(conversation) {
  if (!confirm(`Delete “${conversation.title}”? This cannot be undone.`)) return;
  try {
    await api(`/api/conversations/${encodeURIComponent(conversation.id)}`, { method: "DELETE" });
    if (state.currentId === conversation.id) beginNewConversation();
    await loadConversations();
  } catch (error) { notify(error.message, true); }
}

function beginNewConversation() {
  if (state.busy) return;
  state.currentId = null;
  elements.title.textContent = "New conversation";
  elements.messages.replaceChildren();
  elements.welcome.hidden = false;
  renderConversations();
  closeSidebar();
  elements.input.focus();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[character]);
}

function renderText(value) {
  let safe = escapeHtml(value);
  const blocks = [];
  safe = safe.replace(/```(?:[a-z0-9_-]+)?\n?([\s\S]*?)```/gi, (_, code) => {
    blocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `\n@@AETHER_BLOCK_${blocks.length - 1}@@\n`;
  });
  safe = safe.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  safe = safe.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`).join("");
  return safe.replace(/<p>@@AETHER_BLOCK_(\d+)@@<\/p>/g, (_, index) => blocks[Number(index)]);
}

function addMessage(role, content = "") {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "YOU" : "✦";
  const body = document.createElement("div");
  body.className = "message-body";
  const name = document.createElement("div");
  name.className = "message-name";
  name.textContent = role === "user" ? "You" : "Aether";
  const message = document.createElement("div");
  message.className = "message-content";
  message.innerHTML = renderText(content);
  body.append(name, message);
  article.append(avatar, body);
  elements.messages.append(article);
  return message;
}

function scrollToBottom(smooth = true) {
  elements.chatScroll.scrollTo({ top: elements.chatScroll.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function setBusy(busy) {
  state.busy = busy;
  elements.send.hidden = busy;
  elements.stop.hidden = !busy;
  elements.input.disabled = busy;
  elements.modelSelect.disabled = busy;
}

async function sendMessage(message) {
  if (state.busy) return;

  elements.welcome.hidden = true;
  addMessage("user", message);
  const output = addMessage("assistant", "");
  output.classList.add("thinking");
  elements.input.value = "";
  resizeInput();
  setBusy(true);
  scrollToBottom();
  let complete = "";
  state.controller = new AbortController();

  try {
    const override = selectedRoute();
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationId: state.currentId, privacy: "local-only", priority: state.priority, providerId: override?.providerId, modelId: override?.modelId }),
      signal: state.controller.signal
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || result.error || `Request failed (${response.status})`);
    }

    await consumeChatStream(response.body, (payload) => {
        if (payload.type === "conversation") state.currentId = payload.conversationId;
        if (payload.type === "decision") state.decision = payload.decision;
        if (payload.type === "fallback") {
          state.decision = payload.decision;
          notify(`The first local route failed. Aether switched to ${payload.to.providerId}.`);
        }
        if (payload.type === "delta") {
          complete += payload.delta || "";
          output.classList.remove("thinking");
          output.innerHTML = renderText(complete);
          scrollToBottom(false);
        }
    });
    output.classList.remove("thinking");
    if (!complete) output.innerHTML = renderText("The model finished without returning text.");
  } catch (error) {
    output.classList.remove("thinking");
    output.innerHTML = renderText(interruptedAnswer(complete, error));
    if (error.name !== "AbortError") notify(error.message, true);
  } finally {
    state.controller = null;
    setBusy(false);
    elements.input.focus();
    await Promise.all([loadConversations(), refreshStatus()].map((task) => task.catch(() => {})));
    const current = state.conversations.find((item) => item.id === state.currentId);
    if (current) elements.title.textContent = current.title;
  }
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 180)}px`;
}

function modelLabel(model) {
  if (!model) return "No model";
  const runtime = state.providers.find((item) => item.id === model.providerId)?.name || model.providerId;
  const action = model.loaded ? "Ready" : model.installed ? "Installed" : model.providerId === "ollama" ? "Import" : "Download";
  return `${model.name} · ${runtime} · ${action}`;
}

function routeKey(model) { return `${model.providerId}|${model.id}`; }
function selectedRoute() {
  if (!state.modelOverride) return null;
  const [providerId, modelId] = state.modelOverride.split("|");
  return providerId && modelId ? { providerId, modelId } : null;
}

function renderModels() {
  elements.modelSelect.replaceChildren();
  const automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Auto-select";
  automatic.selected = !state.modelOverride;
  elements.modelSelect.append(automatic);
  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = routeKey(model);
    option.textContent = modelLabel(model);
    option.selected = state.modelOverride === option.value;
    elements.modelSelect.append(option);
  }
}

function renderBenchmarks() {
  elements.benchmarkResults.replaceChildren();
  const successful = state.benchmarks.filter((item) => item.status === "success");
  elements.benchmarkSummary.textContent = successful.length
    ? `${successful.length} installed model${successful.length === 1 ? " has" : "s have"} verified measurements.`
    : "No local benchmark results yet.";
  for (const profile of state.benchmarks) {
    const model = state.models.find((item) => item.id === profile.modelId && item.providerId === profile.providerId);
    const row = document.createElement("div");
    row.className = "benchmark-result";
    const name = document.createElement("strong");
    const runtime = state.providers.find((item) => item.id === profile.providerId)?.name || profile.providerId;
    name.textContent = `${model?.name || profile.modelId} · ${runtime}`;
    const speed = document.createElement("span");
    speed.textContent = profile.status === "success" ? `${profile.tokensPerSecond} tok/s` : "Failed";
    if (profile.status !== "success") speed.className = "failed";
    const memory = document.createElement("span");
    memory.textContent = profile.residentMemoryMB ? `${Math.round(profile.residentMemoryMB)} MB` : profile.acceleration || "—";
    row.append(name, speed, memory);
    elements.benchmarkResults.append(row);
  }
}

async function loadBenchmarks() {
  const result = await api("/api/benchmarks");
  state.benchmarks = result.profiles || [];
  renderBenchmarks();
}

async function runBenchmarks() {
  const installed = state.models.filter((model) => model.installed);
  if (!installed.length) { notify("Install a model before measuring performance.", true); return; }
  if (!confirm(`Run a local performance test for ${installed.length} installed model${installed.length === 1 ? "" : "s"}? Aether will use the CPU heavily for a short time.`)) return;
  elements.benchmarkAction.disabled = true;
  elements.benchmarkAction.textContent = "Measuring…";
  elements.setupMessage.textContent = "Aether is loading and testing each installed model. Keep this window open…";
  try {
    const result = await api("/api/benchmarks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission: true })
    });
    state.benchmarks = result.profiles || [];
    renderBenchmarks();
    await refreshStatus();
    await refreshDecision();
    elements.setupMessage.textContent = "Measurements saved. Aether can now compare these models using evidence from this machine.";
    notify("Local performance profile updated.");
  } catch (error) {
    elements.setupMessage.textContent = error.message;
    notify(error.message, true);
  } finally {
    elements.benchmarkAction.disabled = false;
    elements.benchmarkAction.textContent = "Run benchmark";
  }
}

function updateStatusUI() {
  const provider = state.provider;
  const llamaModels = state.models.filter((model) => model.providerId === "llama-cpp");
  const loaded = llamaModels.find((model) => model.loaded);
  const anyLoaded = state.models.find((model) => model.loaded);
  const healthyProvider = state.providers.find((item) => item.healthy);
  const engineReady = Boolean(provider?.verified);
  const healthy = Boolean(provider?.healthy);
  const aetherReady = Boolean(healthyProvider && anyLoaded);
  elements.statusDot.className = `status-dot ${aetherReady ? "good" : provider ? "bad" : ""}`;
  elements.runtimeTitle.textContent = aetherReady ? "Aether is ready" : engineReady ? "Model not running" : "Setup needed";
  elements.runtimeDetail.textContent = aetherReady ? `${anyLoaded.name} · ${healthyProvider.name} · private` : "Open local setup";

  elements.engineIcon.className = `step-icon ${engineReady ? "good" : "bad"}`;
  elements.engineIcon.textContent = engineReady ? "✓" : "1";
  elements.engineStatus.textContent = engineReady ? `${provider.version || "llama.cpp"} · installed` : "The local engine needs to be installed";
  elements.engineAction.textContent = engineReady ? healthy ? "Ready" : "Start" : "Install";
  elements.engineAction.disabled = healthy;

  const installed = llamaModels.filter((model) => model.installed);
  elements.modelIcon.className = `step-icon ${loaded ? "good" : installed.length ? "" : "bad"}`;
  elements.modelIcon.textContent = loaded ? "✓" : "2";
  elements.modelStatus.textContent = loaded ? `${loaded.name} · loaded` : installed.length ? `${installed.length} model${installed.length === 1 ? "" : "s"} installed` : "A small recommended model is needed";
  elements.modelAction.textContent = loaded ? "Ready" : installed.length ? "Load" : "Download";
  elements.modelAction.disabled = Boolean(loaded);

  const acceleration = state.acceleration;
  elements.accelerationSummary.textContent = acceleration?.message || "Acceleration has not been checked yet.";
  elements.accelerationStatus.textContent = acceleration?.gpuInferenceProven ? "GPU verified" : acceleration?.cpuFallbackVerified ? "CPU verified" : acceleration?.cpuFallbackAvailable ? "CPU available" : "Unverified";
  elements.accelerationStatus.className = acceleration?.gpuInferenceProven || acceleration?.cpuFallbackVerified ? "good" : "";
}

async function refreshStatus(showMessage = false) {
  elements.refresh.disabled = true;
  try {
    const [providerResult, providersResult, modelResult, accelerationResult] = await Promise.all([
      api("/api/providers/llama-cpp/status"),
      api("/api/providers/detect"),
      api("/api/models"),
      api("/api/acceleration")
    ]);
    state.provider = providerResult.provider;
    state.providers = providersResult.providers || [];
    state.models = modelResult.models || [];
    state.recommendation = modelResult.recommendation || null;
    state.acceleration = accelerationResult;
    renderModels();
    renderBenchmarks();
    updateStatusUI();
    if (showMessage) notify("Aether status refreshed.");
  } catch (error) {
    elements.runtimeTitle.textContent = "Aether needs attention";
    elements.runtimeDetail.textContent = error.message;
    elements.statusDot.className = "status-dot bad";
    if (showMessage) notify(error.message, true);
  } finally { elements.refresh.disabled = false; }
}

async function runSetupAction(button, message, task) {
  button.disabled = true;
  elements.setupMessage.textContent = message;
  try {
    await task();
    await refreshStatus();
    await refreshDecision().catch(() => {});
    elements.setupMessage.textContent = "Done. Aether is checking that everything is ready.";
  } catch (error) {
    elements.setupMessage.textContent = error.message;
    notify(error.message, true);
  } finally { button.disabled = false; updateStatusUI(); }
}

async function setupEngine() {
  if (state.provider?.verified) {
    return runSetupAction(elements.engineAction, "Starting the local engine…", () => api("/api/providers/llama-cpp/start", { method: "POST" }));
  }
  if (!confirm("Download and install the local llama.cpp engine?")) return;
  return runSetupAction(elements.engineAction, "Installing the local engine. This may take several minutes…", () => api("/api/providers/llama-cpp/provision", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permission: true })
  }));
}

async function setupModel() {
  const llamaModels = state.models.filter((model) => model.providerId === "llama-cpp");
  const installed = llamaModels.find((model) => model.installed);
  if (installed) return loadModel(installed.providerId, installed.id, elements.modelAction);
  if (!confirm("Download Aether’s recommended local model?")) return;
  await runSetupAction(elements.modelAction, "Downloading the recommended model. You can leave this window open…", () => api("/api/models/recommended/provision", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permission: true })
  }));
  const newlyInstalled = state.models.find((model) => model.providerId === "llama-cpp" && model.installed);
  if (newlyInstalled) await loadModel("llama-cpp", state.recommendation?.selected?.id || newlyInstalled.id, elements.modelAction);
}

async function loadModel(providerId, id, button = elements.modelSelect) {
  const model = state.models.find((item) => item.id === id && item.providerId === providerId);
  if (!model) return;
  if (!model.installed) {
    const verb = providerId === "ollama" ? "Import" : "Download";
    const explanation = providerId === "ollama" ? `Import ${model.name} from Aether's existing local GGUF into Ollama? Ollama will create its own managed copy.` : `Download ${model.name}?`;
    if (!confirm(explanation)) { renderModels(); return; }
    await runSetupAction(button, `${verb}ing ${model.name}…`, () => api(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(id)}/provision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permission: true })
    }));
  }
  await runSetupAction(button, `Loading ${model.name} with ${state.providers.find((item) => item.id === providerId)?.name || providerId}…`, () => api(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(id)}/load`, { method: "POST" }));
  notify(`${model.name} is ready with ${state.providers.find((item) => item.id === providerId)?.name || providerId}.`);
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (message) sendMessage(message);
});
elements.input.addEventListener("input", resizeInput);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.stop.addEventListener("click", () => state.controller?.abort());
elements.newChat.addEventListener("click", beginNewConversation);
elements.search.addEventListener("input", renderConversations);
elements.openSetup.addEventListener("click", () => elements.setup.showModal());
elements.closeSetup.addEventListener("click", () => elements.setup.close());
elements.decisionButton.addEventListener("click", showDecision);
elements.setupDecision.addEventListener("click", showDecision);
elements.closeDecision.addEventListener("click", () => elements.decisionDialog.close());
elements.engineAction.addEventListener("click", setupEngine);
elements.modelAction.addEventListener("click", setupModel);
elements.benchmarkAction.addEventListener("click", runBenchmarks);
elements.modelSelect.addEventListener("change", async () => {
  state.modelOverride = elements.modelSelect.value || null;
  const route = selectedRoute();
  if (route) await loadModel(route.providerId, route.modelId);
  await refreshDecision().catch((error) => notify(error.message, true));
  notify(state.modelOverride ? "Manual model override selected." : "Aether will choose the model automatically.");
});
elements.prioritySelect.addEventListener("change", async () => {
  state.priority = elements.prioritySelect.value;
  localStorage.setItem("aether-priority", state.priority);
  await refreshDecision().catch((error) => notify(error.message, true));
  notify(`${elements.prioritySelect.selectedOptions[0].textContent} priority selected.`);
});
elements.refresh.addEventListener("click", () => refreshStatus(true));
$("#open-sidebar").addEventListener("click", () => document.body.classList.add("sidebar-open"));
elements.closeSidebar.addEventListener("click", closeSidebar);
elements.sidebarScrim.addEventListener("click", closeSidebar);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); beginNewConversation(); }
  if (event.key === "Escape") closeSidebar();
});
document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => {
  elements.input.value = button.firstChild.textContent.trim();
  resizeInput();
  elements.input.focus();
}));

async function boot() {
  try {
    elements.prioritySelect.value = state.priority;
    await Promise.all([refreshStatus(), loadConversations(), loadBenchmarks()]);
    await refreshDecision();
    const first = state.conversations[0];
    if (first) await openConversation(first.id);
    if (!state.providers.some((provider) => provider.healthy) || !state.models.some((model) => model.loaded)) elements.setup.showModal();
  } catch (error) { notify(error.message, true); }
}

boot();
