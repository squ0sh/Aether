import { LlamaCppAdapter } from "../adapters/llama-cpp.js";
import { OllamaAdapter } from "../adapters/ollama.js";

class ProviderManager {
  constructor(options = {}) {
    this.providers = options.providers || [new LlamaCppAdapter(), new OllamaAdapter()];
  }

  getProviders() {
    return this.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type
    }));
  }

  getProvider(id) {
    return this.providers.find((provider) => provider.id === id) || null;
  }

  async detectAll() {
    const results = [];

    for (const provider of this.providers) {
      try {
        results.push(await provider.status());
      } catch (error) {
        results.push({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          state: "error",
          detected: false,
          executable: false,
          available: false,
          verified: false,
          running: false,
          healthy: false,
          error: error.message
        });
      }
    }

    return results;
  }

  async stopAll() {
    await Promise.all(this.providers.map(async (provider) => {
      try { await provider.stop(); } catch { /* Best-effort shutdown. */ }
    }));
  }
}

export { ProviderManager };
