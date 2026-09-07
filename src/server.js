import http from "http";
import { getCapabilities } from "./core/capabilities.js";
import { detectHardware } from "./core/hardware.js";
import { ProviderManager } from "./core/providers.js";

const PORT = Number(process.env.AETHER_PORT || 8080);
const providerManager = new ProviderManager();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, {
        name: "Aether",
        version: "0.2.0",
        status: "online",
        mode: "local",
        backend: null
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

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, {
      error: "Aether internal error",
      message: error.message
    });
  }
});

server.listen(PORT, function () {
  console.log("");
  console.log("================================");
  console.log("          AETHER ZERO");
  console.log("================================");
  console.log("Status:  ONLINE");
  console.log("API:     http://localhost:" + PORT);
  console.log("Backend: runtime verification enabled");
  console.log("================================");
  console.log("");
});
