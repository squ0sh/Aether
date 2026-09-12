import { createAetherApp } from "./app.js";

const PORT = Number(process.env.AETHER_PORT || 8080);
const HOST = process.env.AETHER_HOST || "127.0.0.1";
const { server, restoreSelection, operations, providerManager } = createAetherApp();

server.listen(PORT, HOST, async function () {
  const address = server.address();
  console.log(`Aether online: http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`);
  if (!["127.0.0.1", "::1", "localhost"].includes(HOST)) console.warn("Warning: remote binding is enabled without authentication. Use only behind trusted access controls.");
  try {
    const model = await restoreSelection();
    if (model) console.log("Restored model: " + model.name);
  } catch (error) {
    console.error("Model restore skipped: " + error.message);
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  operations.close();
  const closed = new Promise((resolve) => server.close(resolve));
  // User-requested process shutdown has a bounded grace period; ordinary API
  // stop requests never interrupt an admitted operation.
  const deadline = setTimeout(() => process.exit(1), 15000);
  let graceTimer;
  try {
    await Promise.race([
      operations.whenIdle(),
      new Promise((resolve) => { graceTimer = setTimeout(resolve, 5000); })
    ]);
    clearTimeout(graceTimer);
    await providerManager.stopAll();
    await closed;
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    console.error("Aether shutdown failed: " + error.message);
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
