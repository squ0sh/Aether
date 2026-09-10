import { randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { join } from "path";

const executionsRoot = join(process.env.AETHER_DATA_DIR || join(process.cwd(), "data"), "executions");
const idPattern = /^[0-9a-f-]{36}$/i;

async function recordExecution(input, root = executionsRoot) {
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    decisionId: input.decisionId || null,
    conversationId: input.conversationId || null,
    providerId: input.providerId || null,
    modelId: input.modelId || null,
    task: input.task || "chat",
    outcome: input.outcome === "success" ? "success" : "error",
    startedAt: input.startedAt || now,
    completedAt: input.completedAt || now,
    durationMs: Math.max(0, Number(input.durationMs) || 0),
    inputCharacters: Math.max(0, Number(input.inputCharacters) || 0),
    outputCharacters: Math.max(0, Number(input.outputCharacters) || 0),
    errorCategory: input.errorCategory || null
  };
  const path = join(root, `${record.id}.json`);
  const incoming = `${path}.incoming-${process.pid}`;
  await mkdir(root, { recursive: true });
  try {
    await writeFile(incoming, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(incoming, path);
  } finally { await rm(incoming, { force: true }); }
  return record;
}

async function listExecutions({ limit = 50, root = executionsRoot } = {}) {
  let files;
  try { files = await readdir(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const file of files.filter((name) => name.endsWith(".json") && idPattern.test(name.slice(0, -5)))) {
    try { records.push(JSON.parse(await readFile(join(root, file), "utf8"))); }
    catch { /* Ignore an incomplete individual measurement. */ }
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Math.min(Math.max(1, Number(limit) || 50), 200));
}

function summarizeExecutions(records) {
  const strategies = new Map();
  for (const record of records) {
    const key = `${record.providerId || "unknown"}:${record.modelId || "unknown"}`;
    const current = strategies.get(key) || {
      providerId: record.providerId,
      modelId: record.modelId,
      attempts: 0,
      successes: 0,
      totalDurationMs: 0,
      lastUsedAt: null
    };
    current.attempts += 1;
    if (record.outcome === "success") current.successes += 1;
    current.totalDurationMs += record.durationMs || 0;
    if (!current.lastUsedAt || record.startedAt > current.lastUsedAt) current.lastUsedAt = record.startedAt;
    strategies.set(key, current);
  }
  return [...strategies.values()].map((strategy) => ({
    providerId: strategy.providerId,
    modelId: strategy.modelId,
    attempts: strategy.attempts,
    successes: strategy.successes,
    successRate: strategy.attempts ? Number((strategy.successes / strategy.attempts).toFixed(3)) : null,
    averageDurationMs: strategy.attempts ? Math.round(strategy.totalDurationMs / strategy.attempts) : null,
    lastUsedAt: strategy.lastUsedAt
  }));
}

export { executionsRoot, listExecutions, recordExecution, summarizeExecutions };
