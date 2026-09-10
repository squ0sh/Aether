# Aether

Aether is a portable, hardware-adaptive local AI gateway. Its goal is to expose one stable local API while adapters handle the differences between local inference runtimes such as llama.cpp, Ollama, vLLM, MLX, WebLLM, and others.

## Current checkpoint: v0.13.1

Aether currently includes:

- Local HTTP API
- Browser workspace at `http://localhost:8080`
- Responsive streaming chat interface
- Server-backed conversation history, search, opening, and deletion
- Friendly local-engine and model setup panel
- Model installation, selection, and loading from the interface
- Live local-runtime readiness state
- Versioned capability graph connecting the host, runtime, and models
- Deterministic, explainable execution decisions
- Privacy-preserving local execution measurements
- "Why Aether chose this" decision view
- Permission-gated local performance benchmarks
- Measured generation speed, model load time, memory, and stability
- Speed, Balanced, and Quality execution priorities
- Automatic model preparation with an optional manual override
- Exclusive operation protection so model changes cannot interrupt an active answer
- `/api/status`
- `/api/capabilities`
- `/api/hardware`
- Provider manager
- llama.cpp provider adapter
- Ollama provider adapter
- Cross-runtime planning, manual routing, and benchmarking
- Permission-gated import of existing Aether GGUF files into Ollama
- One-step failure-aware routing before answer output begins
- Per-attempt execution records and visible fallback explanations
- Runtime-level graphics-device inspection and benchmark-backed acceleration proof
- Clear CPU fallback reporting when graphics acceleration is unavailable
- Portable-runtime discovery under `runtimes/`
- System-runtime discovery through `PATH`
- Runtime executable verification using `llama-server --version`
- Provider state progression that separates discovery from verification
- Permission-gated download of official portable llama.cpp releases
- Fallback scanning of recent official releases when the latest release has no matching build
- Safe cross-filesystem promotion into `runtimes/llama.cpp`
- Final-location verification after promotion
- Portable shared-library resolution on Linux and macOS

### v0.3.4 bug fix

Official portable llama.cpp archives include shared libraries beside `llama-server`.
When Aether executes a portable binary, it now prepends that executable directory to
`LD_LIBRARY_PATH` on Linux or `DYLD_LIBRARY_PATH` on macOS, preserving any existing
value. System-installed runtimes continue to use the host environment unchanged.

### v0.3.5 compatibility fix

Some official Ubuntu x64 builds require AVX2/FMA and crash with `SIGILL` on older
x64 processors such as Intel Ivy Bridge. On Linux x64, Aether now reads the host
CPU flags before provisioning. Hosts without AVX2 use a local source-build fallback
with AVX and F16C enabled and AVX2, FMA, BMI2, AVX-VNNI, and AVX-512 disabled.

The compatibility build is static and uses the official latest llama.cpp source.
It requires `cmake`, a C/C++ compiler, and a build tool. Aether does not install
system packages automatically. On Omarchy/Arch, install prerequisites if needed:

```bash
omarchy pkg add base-devel cmake
```

Provisioning may take several minutes on older hardware while llama.cpp compiles.
Execution failures now include the process signal/exit code, with a specific hint
for illegal-instruction failures.

### v0.4.0 runtime lifecycle

Aether can now launch a verified `llama-server` in router mode, bound only to
`127.0.0.1` on an automatically selected port. It polls llama.cpp's `/health`
endpoint and reports the progression `verified -> running -> healthy`.

The same portable shared-library environment used during verification is reused
for the running process. Aether captures bounded startup diagnostics, terminates
failed health checks, exposes an explicit stop endpoint, and stops child runtimes
when Aether receives `SIGINT` or `SIGTERM`.

### v0.5.0 first local model and inference

Aether recommends SmolLM2 360M Instruct Q4_K_M for the initial low-resource
checkpoint. The GGUF is approximately 271 MB and uses the Apache-2.0 license.

Model download requires explicit permission. Aether downloads into a temporary
file beside the final destination, verifies the pinned SHA-256 checksum, and only
then promotes it into `models/`. A failed or incomplete download is removed.

After provisioning, Aether can restart llama.cpp with the selected model, wait for
it to become healthy, and route a basic message through llama.cpp's
OpenAI-compatible `/v1/chat/completions` endpoint.

### v0.5.1 download reliability fix

Model files are streamed directly to a temporary file instead of being buffered
entirely in Node.js memory. Aether hashes the stream while writing it, retries a
terminated transfer up to three times, removes every partial file, and only
renames a download into place after its pinned SHA-256 matches.

### v0.5.2 resumable download fix

If Node's streaming fetch is repeatedly terminated by Hugging Face's large-file
delivery service, Linux and macOS now fall back to `curl` with redirect handling,
eight retries, and partial-transfer resumption. The completed file is hashed from
disk before promotion, so the fallback cannot bypass integrity verification.

### v0.6.0 streaming and restoration

Aether now exposes an SSE streaming endpoint that forwards incremental text from
llama.cpp while keeping `/api/chat` available for ordinary JSON responses. The
stream uses stable Aether events (`delta`, `done`, or `error`) instead of exposing
the provider's internal response format.

Loading the recommended model persists its selection and enables automatic
restoration. On later Aether starts, `data/config.json` is read and the installed
model is loaded automatically. Configuration writes are atomic, and local state
is excluded from release packages.

### v0.7.0 conversations and model policy

Both chat endpoints now create or continue persistent conversations. Aether stores
role/content history as private, atomic JSON records under `data/conversations/`
and supplies prior turns to llama.cpp for genuine multi-turn context. Conversation
IDs are validated before filesystem access, and history can be listed, opened, or
deleted through the API.

The recommended-model response now includes an explainable selection decision.
Aether ranks candidates against host memory, model size, parameter count, and only
verified acceleration. Merely detecting a possible backend such as Vulkan does not
cause Aether to pretend GPU inference is available.

### v0.7.1 conversation-quality fix

Qwen2.5 0.5B Instruct Q4_K_M is now the preferred CPU-first model. Its pinned
398 MB GGUF provides a stronger instruction-following baseline while remaining
small enough for the Ivy Bridge tower. SmolLM2 360M remains in the catalog as the
lighter fallback and existing installations are preserved.

Every chat request now begins with a system instruction explaining that Aether can
use the current conversation as memory and must not confuse it with internet or
external access. The selected model ID—not only the recommendation—is persisted
and restored.

### v0.8.0 local workspace

Aether now opens as a complete local chat workspace in the browser. The interface
uses Aether's own provider, model, streaming, and conversation APIs rather than a
second browser-only history or an Ollama-specific backend.

The conversation sidebar lists records stored privately under
`data/conversations/`, supports search and deletion, and keeps Aether's server-side
conversation ID throughout a streamed response. The model picker shows which
models are installed or loaded and can provision and load a selected model after
explicit confirmation.

The setup panel translates runtime details into clear engine and model readiness
steps. The layout is responsive and includes keyboard-friendly controls, safe
rendering for model output, request cancellation, and visible recovery messages.

### v0.9.0 Capability Core

Aether now represents the local host, verified runtimes, and available models as a
versioned capability graph. Edges describe which host provides a runtime and which
models that runtime can execute. Potential acceleration remains explicitly
separate from verified acceleration, so detection never becomes a false claim.

Before inference, a deterministic planner evaluates the requested privacy and
priority constraints against ready execution paths. It returns the selected
provider/model, a score breakdown, required setup actions when blocked, and plain
language reasons. Both JSON and streaming chat use this decision rather than
reaching directly for a hard-coded model.

After each attempt Aether records only operational measurements: provider, model,
timing, outcome, and input/output character counts. Prompt and response content is
never copied into execution records. Those measurements become empirical strategy
summaries for later decisions on this particular machine.

### v0.10.0 verified benchmarking and adaptive selection

Aether can now run a short, permission-gated local benchmark for every installed
model. It measures model load time, inference duration, generated tokens, tokens
per second, resident runtime memory where the operating system exposes it, current
context size, stability, and the acceleration path actually used. Benchmark text
is fixed internally and is never saved.

Successful benchmark results become part of the capability profile. Speed mode
weights measured generation rate most heavily, Quality mode favors the stronger
instruction-following model, and Balanced mode combines both. A manual model
selection remains available and is represented explicitly as an override.

The planner can now select an installed model that is not currently loaded. Aether
prepares that route automatically before inference and explains the preparation
in the decision record. It never downloads a missing model without explicit
permission.

### v0.11.0 second verified runtime

Ollama is now a peer execution runtime behind Aether's Capability Core. Aether
verifies an existing system installation, manages a loopback-only `ollama serve`
process when no external instance is available, and keeps externally managed
instances outside Aether's shutdown ownership.

Models are identified by both provider and model ID, so the same GGUF can exist as
distinct llama.cpp and Ollama routes. The planner, manual model picker, chat,
streaming, execution records, and benchmarks all preserve that route identity.
Auto-select can therefore compare measured performance across runtimes instead of
assuming one implementation is always best.

Aether never pulls a cloud model for this integration. After explicit permission,
it asks Ollama to import a GGUF that is already installed in Aether's `models/`
directory. Ollama maintains its own managed model copy, and the interface explains
that disk-space tradeoff before import.

### v0.12.0 failure-aware routing

Auto-select now has one bounded recovery attempt. If its preferred route fails
before producing any answer text, Aether records that failed attempt, prepares one
verified alternate route—preferring another runtime—and continues the same request.
The user message is appended to conversation history only once.

For streaming responses, fallback is allowed only before the first text delta.
Once any answer text has reached the interface, Aether reports a later failure
instead of mixing a second model's answer into the partial response. Exact manual
runtime/model selections never silently fail over. Successful responses include
the attempt records and decisions expose the source, destination, and reason for
an automatic fallback.

### v0.13.0 verified acceleration reporting

Aether now separates three different facts: operating-system graphics potential,
devices exposed by an inference runtime, and acceleration actually observed during
a successful model benchmark. Only the final category is promoted as verified
accelerated inference.

llama.cpp is inspected with `--list-devices` using the same portable-library
environment as normal execution. Ollama reports graphics residency through its
running-model API. The new `/api/acceleration` response combines those reports with
saved benchmark evidence, and the setup interface presents the result in plain
language.

On the current Ivy Bridge tower, Vulkan drivers and a render device are visible at
the operating-system level, but the installed compatibility llama.cpp build
reports no compatible devices and its saved benchmarks use CPU. Aether therefore
shows Vulkan as detectable but unproven and keeps CPU as the verified path instead
of making a false GPU claim.

### v0.13.1 exclusive operation protection

One in-process lease now covers a chat request from planning through model loading,
inference (including its permitted fallback), and conversation persistence. Runtime
start/stop, model load/provision, benchmarks and their restoration, startup model
restoration, and conversation deletion use the same protection.

A competing write returns HTTP `409` with `code: "AETHER_BUSY"` and a friendly
message. It does not start, queue, or save a user message. Try again after the
active operation finishes. Status, model listings, conversation reads, and decision
previews remain available; a preview is not a reservation.

`GET /api/status` now includes `operations.state` (`idle`, `busy`, or `stopping`),
the active operation's kind and start time, and the concurrency limit of one. No
prompt text or conversation identifier is exposed in this operation summary.
New writes during shutdown return `503` with `code: "AETHER_STOPPING"`. Process
shutdown allows up to five seconds for active work to finish before stopping
owned runtimes, with a fifteen-second overall exit deadline.

Ollama status polling is now observational: inspecting resident models does not
change the selected model. Chat, streaming, and benchmarks carry an explicit
model ID into inference, including when the requested model was already resident.

This is conservative admission control, not memory-aware scheduling. It protects
requests handled by one Aether process; it cannot coordinate separate Aether
instances or another application's use of an external Ollama server. Closing a
browser stream does not currently cancel backend inference, so its lease remains
held until the handler finishes. A request queue, cancellation propagation, and
live memory admission are deliberately separate follow-up work.

HTTP tests use mock providers and temporary data to exercise overlapping operations,
failure release, fallback, startup restoration, and browser disconnection. No real
model download or inference is required by these new regression tests.

### Provider states

Aether does not assume that an installed runtime works.

For local runtimes the current flow is:

`not_found -> detected -> verified -> running -> healthy -> preferred`

A runtime is only marked `available: true` after its executable successfully passes verification.

## Run Aether

```bash
npm start
```

By default Aether listens on port `8080`. You can override it:

```bash
AETHER_PORT=9000 npm start
```

Then open `http://localhost:8080` in a browser. If Aether needs a runtime or model,
the setup panel will guide you and ask before downloading anything.

## API endpoints

- `GET /api/status`
- `GET /api/capabilities`
- `GET /api/hardware`
- `GET /api/acceleration`
- `GET /api/capability-profile`
- `POST /api/decisions/preview`
- `GET /api/executions`
- `GET /api/benchmarks`
- `POST /api/benchmarks/run`
- `GET /api/providers`
- `GET /api/providers/detect`
- `GET /api/providers/llama-cpp/status`
- `GET /api/providers/ollama/status`
- `POST /api/providers/llama-cpp/provision`
- `POST /api/providers/llama-cpp/start`
- `POST /api/providers/llama-cpp/stop`
- `GET /api/models/recommended`
- `GET /api/models`
- `POST /api/models/recommended/provision`
- `POST /api/models/recommended/load`
- `POST /api/models/:id/provision`
- `POST /api/models/:id/load`
- `POST /api/providers/:providerId/models/:modelId/provision`
- `POST /api/providers/:providerId/models/:modelId/load`
- `POST /api/chat`
- `POST /api/chat/stream`
- `GET /api/conversations`
- `GET /api/conversations/:id`
- `DELETE /api/conversations/:id`

## Portable llama.cpp discovery

Aether currently checks these locations before searching the system `PATH`:

```text
runtimes/llama.cpp/llama-server
runtimes/llama-server
```

On Windows it also checks the `.exe` equivalents.

If a runtime is found, Aether runs a short `--version` probe with a timeout. The runtime is marked `verified` only if the process exits successfully.

## Permissioned provisioning

Aether can provision a compatible official portable llama.cpp build only after explicit permission:

```bash
curl -X POST http://localhost:8080/api/providers/llama-cpp/provision \
  -H "Content-Type: application/json" \
  -d '{"permission":true}'
```

Without `permission: true`, the endpoint returns HTTP 403 and does not install anything.

The planned flow is:

1. Detect host hardware and operating system.
2. Rank compatible inference runtimes.
3. Recommend the preferred runtime and explain why.
4. Present the exact install action to the user.
5. Require explicit permission before changing the machine.
6. Download/install the runtime.
7. Run the same verification path used for manually installed runtimes.
8. Mark the runtime available only after successful verification.
9. Fall back or repair automatically when verification fails, subject to permission.

This keeps Aether intelligent without silently modifying the host system.

## Start and stop llama.cpp

No model is required at this checkpoint. Current llama.cpp releases support router
mode without a selected model; Aether points the router at its local `models/`
directory.

```bash
curl -X POST http://localhost:8080/api/providers/llama-cpp/start
curl http://localhost:8080/api/providers/llama-cpp/status
curl -X POST http://localhost:8080/api/providers/llama-cpp/stop
```

## First local inference

Check the recommendation:

```bash
curl http://localhost:8080/api/models/recommended
```

Approve the model download:

```bash
curl -X POST http://localhost:8080/api/models/recommended/provision \
  -H "Content-Type: application/json" \
  -d '{"permission":true}'
```

Load it:

```bash
curl -X POST http://localhost:8080/api/models/recommended/load
```

Send Aether its first local message:

```bash
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Say hello in one short sentence."}'
```

Stream a response incrementally:

```bash
curl --no-buffer -X POST http://localhost:8080/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"Explain what Aether is in two sentences."}'
```

The JSON response includes `conversationId`. Pass it into later requests to retain
context:

```bash
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"PASTE_ID_HERE","message":"What did I just ask you?"}'
```

List saved conversations:

```bash
curl http://localhost:8080/api/conversations
```

After a successful model load, stop and restart `npm start`. Aether should print
`Restored model: <your selected model>`, and chat should work without
calling the load endpoint again.

## Next checkpoint

Next is memory-aware admission: distinguish available memory from simply free
memory, estimate runtime and context overhead, and check again before loading.
Follow that with cancellation and trustworthy, configuration-specific measurement
history. See [the staged foundation roadmap](docs/FOUNDATION.md) for the larger
direction, acceptance tests, and explicit limits of the current implementation.
