import assert from "node:assert/strict";
import test from "node:test";
import { OperationGate, operationForRequest } from "../src/core/operations.js";

test("operation ownership is exclusive, observable, and released idempotently", async () => {
  const gate = new OperationGate();
  assert.equal(gate.status().state, "idle");
  const release = gate.acquire("chat");
  assert.equal(gate.status().active.kind, "chat");
  gate.status().active.kind = "tampered";
  assert.equal(gate.status().active.kind, "chat");
  assert.throws(() => gate.acquire("runtime-change"), { code: "AETHER_BUSY", statusCode: 409 });
  let idle = false;
  const waiting = gate.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  release();
  await waiting;
  const nextRelease = gate.acquire("benchmark");
  release();
  assert.equal(gate.status().active.kind, "benchmark", "an old release must not unlock a new owner");
  nextRelease();
  assert.equal(gate.status().state, "idle");
});

test("shutdown rejects new ownership while allowing current work to drain", async () => {
  const gate = new OperationGate();
  const release = gate.acquire("chat");
  gate.close();
  assert.equal(gate.status().state, "stopping");
  assert.equal(gate.status().active.kind, "chat");
  assert.throws(() => gate.acquire("chat"), { code: "AETHER_STOPPING", statusCode: 503 });
  release();
  await gate.whenIdle();
  assert.equal(gate.status().active, null);
  assert.throws(() => gate.acquire("chat"), { code: "AETHER_STOPPING" });
});

test("API writes are exclusive by default; status and decision previews stay readable", () => {
  for (const path of ["/api/chat", "/api/chat/stream", "/api/models/small/load", "/api/providers/llama-cpp/stop", "/api/benchmarks/run", "/api/future-mutation"]) {
    assert.ok(operationForRequest("POST", path));
  }
  assert.ok(operationForRequest("DELETE", "/api/conversations/id"));
  assert.equal(operationForRequest("POST", "/api/decisions/preview"), null);
  assert.equal(operationForRequest("GET", "/api/models"), null);
  assert.equal(operationForRequest("GET", "/api/status"), null);
  assert.equal(operationForRequest("GET", "/"), null);
});
