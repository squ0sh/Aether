import { LlamaCppAdapter } from "../adapters/llama-cpp.js";

class ProviderManager {
  constructor() {
    this.providers = [new LlamaCppAdapter()];
  }

  getProviders() {
    return this.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type
    }));
  }

  async detectAll() {
    const results = [];

    for (const provider of this.providers) {
      try {
        const result = await provider.detect();
        results.push({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          ...result
        });
      } catch (error) {
        results.push({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          detected: false,
          available: false,
          running: false,
          error: error.message
        });
      }
    }

    return results;
  }
}

export { ProviderManager };
