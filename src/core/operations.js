// One lease covers planning, runtime changes, inference, and persistence. Status
// reads remain available; competing writes are rejected, never silently queued.
class OperationGate {
  #active = null;
  #closed = false;
  #idle = Promise.resolve();

  status() {
    return {
      state: this.#closed ? "stopping" : this.#active ? "busy" : "idle",
      active: this.#active ? { ...this.#active } : null,
      concurrency: 1,
      queued: 0
    };
  }

  acquire(kind) {
    if (this.#closed || this.#active) {
      const error = new Error(this.#closed
        ? "Aether is shutting down. This request was not started."
        : "Aether is busy with another operation. Please try again when it finishes; this request was not started.");
      error.statusCode = this.#closed ? 503 : 409;
      error.code = this.#closed ? "AETHER_STOPPING" : "AETHER_BUSY";
      error.operation = this.status();
      throw error;
    }
    const lease = { kind, startedAt: new Date().toISOString() };
    this.#active = lease;
    let resolveIdle;
    this.#idle = new Promise((resolve) => { resolveIdle = resolve; });
    return () => {
      if (this.#active !== lease) return;
      this.#active = null;
      resolveIdle();
    };
  }

  close() { this.#closed = true; }
  whenIdle() { return this.#idle; }
}

function operationForRequest(method, pathname) {
  if (!pathname.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(method)) return null;
  if (method === "POST" && pathname === "/api/decisions/preview") return null;
  if (pathname === "/api/chat" || pathname === "/api/chat/stream") return "chat";
  if (pathname === "/api/benchmarks/run") return "benchmark";
  if (pathname.startsWith("/api/conversations/")) return "conversation-change";
  return "runtime-change";
}

export { OperationGate, operationForRequest };
