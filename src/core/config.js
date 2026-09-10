import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

const configPath = join(process.env.AETHER_DATA_DIR || join(process.cwd(), "data"), "config.json");
const defaults = { version: 1, selectedModel: null, autoRestore: false };

async function loadConfig(path = configPath) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return { ...defaults, ...parsed, version: 1 };
  } catch (error) {
    if (error.code === "ENOENT") return { ...defaults };
    throw new Error(`Could not read Aether configuration: ${error.message}`);
  }
}

async function saveConfig(config, path = configPath) {
  const next = { ...defaults, ...config, version: 1 };
  const incoming = `${path}.incoming-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(incoming, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(incoming, path);
  } finally { await rm(incoming, { force: true }); }
  return next;
}

export { configPath, loadConfig, saveConfig };
