import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("CLI starts and shuts down cleanly without an installed runtime", { timeout: 10000 }, async (context) => {
  if (process.platform === "win32") return context.skip("POSIX shutdown signal test");
  const root = await mkdtemp(join(tmpdir(), "aether-cli-test-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], {
    cwd: root,
    // Use an empty working directory and search path: do not discover or start
    // the user's installed models/runtimes during this entry-point smoke test.
    env: { ...process.env, AETHER_PORT: "0", AETHER_DATA_DIR: join(root, "data"), PATH: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const ready = new Promise((resolve) => child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("Aether online:")) resolve();
  }));
  await Promise.race([ready, exited.then(() => { throw new Error(`CLI exited before readiness: ${errors}`); })]);
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0, errors);
  assert.equal(signal, null);
  assert.equal(errors, "");
});
