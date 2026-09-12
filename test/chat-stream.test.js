import test from "node:test";
import assert from "node:assert/strict";
import { consumeChatStream, interruptedAnswer } from "../public/chat-stream.js";

const event = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const body = (text) => new ReadableStream({ start(controller) {
  // Byte-sized chunks also split UTF-8 characters and event boundaries.
  for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
  controller.close();
} });

test("chat stream requires explicit completion and handles split UTF-8", async () => {
  const received = [];
  await consumeChatStream(body(event({ type: "delta", delta: "blue 🔵" }) + event({ type: "done" })), (item) => received.push(item));
  assert.equal(received[0].delta, "blue 🔵");
  assert.equal(received.at(-1).type, "done");
});

test("EOF and truncated terminal events do not imply successful inference", async () => {
  for (const ending of ["", 'data: {"type":"done"}', 'data: {"type":']) {
    let text = "";
    await assert.rejects(consumeChatStream(body(event({ type: "delta", delta: "partial" }) + ending), (item) => { text += item.delta || ""; }), /before completion/);
    assert.equal(text, "partial");
  }
});

test("save failure retains completed answer and structured failure metadata", async () => {
  let text = "";
  const source = event({ type: "delta", delta: "complete answer" }) + event({ type: "error", code: "AETHER_PERSISTENCE_UNCERTAIN", inferenceCompleted: true, error: "Check before retrying." });
  await assert.rejects(consumeChatStream(body(source), (item) => { text += item.delta || ""; }), (error) => {
    assert.equal(error.inferenceCompleted, true);
    assert.equal(error.code, "AETHER_PERSISTENCE_UNCERTAIN");
    const displayed = interruptedAnswer(text, error);
    assert.ok(displayed.startsWith("complete answer"));
    assert.match(displayed, /Saving could not be confirmed/);
    return true;
  });
});

test("transport failure and cancellation preserve partial text with a warning", () => {
  assert.match(interruptedAnswer("partial", new Error("connection lost")), /^partial\n\n\[Response incomplete/);
  assert.match(interruptedAnswer("partial", { name: "AbortError" }), /^partial\n\n\[Response stopped/);
});

test("stream errors and CRLF events are handled without false success", async () => {
  await consumeChatStream(body(event({ type: "done" }).replaceAll("\n", "\r\n")), () => {});
  await assert.rejects(consumeChatStream(body(event({ type: "error", error: "model failed" })), () => {}), /model failed/);
});
