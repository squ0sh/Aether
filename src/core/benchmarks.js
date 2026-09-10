import { randomUUID } from "crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { join } from "path";

const benchmarksRoot = join(process.env.AETHER_DATA_DIR || join(process.cwd(), "data"), "benchmarks");
const idPattern = /^[0-9a-f-]{36}$/i;

async function recordBenchmark(input, root = benchmarksRoot) {
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    providerId: input.providerId,
    modelId: input.modelId,
    status: input.status === "success" ? "success" : "error",
    measuredAt: input.measuredAt || now,
    acceleration: input.acceleration || null,
    contextSize: Number(input.contextSize) || null,
    loadDurationMs: Number(input.loadDurationMs) || null,
    inferenceDurationMs: Number(input.inferenceDurationMs) || null,
    generatedTokens: Number(input.generatedTokens) || null,
    tokensPerSecond: Number.isFinite(Number(input.tokensPerSecond)) ? Number(Number(input.tokensPerSecond).toFixed(2)) : null,
    residentMemoryMB: Number.isFinite(Number(input.residentMemoryMB)) ? Number(Number(input.residentMemoryMB).toFixed(1)) : null,
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

async function listBenchmarks({ limit = 200, root = benchmarksRoot } = {}) {
  let files;
  try { files = await readdir(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const file of files.filter((name) => name.endsWith(".json") && idPattern.test(name.slice(0, -5)))) {
    try { records.push(JSON.parse(await readFile(join(root, file), "utf8"))); }
    catch { /* Ignore a damaged individual measurement. */ }
  }
  return records.sort((a, b) => b.measuredAt.localeCompare(a.measuredAt)).slice(0, Math.min(Math.max(1, Number(limit) || 200), 500));
}

function summarizeBenchmarks(records) {
  const latest = new Map();
  for (const record of records) {
    const key = `${record.providerId}:${record.modelId}`;
    if (!latest.has(key)) latest.set(key, record);
  }
  return [...latest.values()].map((record) => ({
    providerId: record.providerId,
    modelId: record.modelId,
    status: record.status,
    measuredAt: record.measuredAt,
    acceleration: record.acceleration,
    contextSize: record.contextSize,
    loadDurationMs: record.loadDurationMs,
    inferenceDurationMs: record.inferenceDurationMs,
    generatedTokens: record.generatedTokens,
    tokensPerSecond: record.tokensPerSecond,
    residentMemoryMB: record.residentMemoryMB,
    errorCategory: record.errorCategory
  }));
}

export { benchmarksRoot, listBenchmarks, recordBenchmark, summarizeBenchmarks };
