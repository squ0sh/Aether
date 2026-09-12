// Consume Aether's SSE protocol; transport EOF is not successful completion.
export async function consumeChatStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const payload = JSON.parse(data);
        if (payload.type === "error") {
          const error = new Error(payload.error || "The local model stopped unexpectedly");
          error.code = payload.code;
          error.inferenceCompleted = payload.inferenceCompleted === true;
          throw error;
        }
        onEvent(payload);
        if (payload.type === "done") completed = true;
      }
      if (completed) return;
      if (done) throw new Error("The stream ended before completion was confirmed. Check the conversation before retrying.");
    }
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the original result. */ }
    reader.releaseLock();
  }
}

export function interruptedAnswer(text, error) {
  const notice = error.name === "AbortError" ? "Response stopped."
    : error.code === "AETHER_PERSISTENCE_UNCERTAIN" ? `Saving could not be confirmed. ${error.message}`
      : `Response incomplete. ${error.message}`;
  return text ? `${text}\n\n[${notice}]` : notice;
}
