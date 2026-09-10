# Aether: foundation before expansion

Updated 2026-09-10, after reviewing the build history and “Explain Aether Differences.”

## The direction

Aether should answer: “What can this system safely do for this task, under the
user's constraints?” Its center should be deterministic coordination: structured
state, policy, resource admission, execution, and observations. Models are
replaceable capabilities, not the authority that defines permissions.

The most useful interpretation of recursive expansion is reusable composition:
verified capabilities can form a tested workflow, and a verified workflow can
later be used as a capability. This does not require self-modifying code, endless
exploration, or training a new model. A goal, a budget, and a success check must
bound each attempt. Larger ideas remain design directions, not shipped features.

## What the current code demonstrates

- A browser chat workspace with local persisted conversations.
- llama.cpp and Ollama adapters, verification, model preparation, and inference.
- A small capability graph and deterministic route ranking.
- Local execution records, fixed-prompt performance benchmarks, and one-step
  failover before streaming answer output begins.
- v0.13.1: exclusive admission for chat and state-changing operations within one
  Aether process, plus stable Ollama request model identity during status polling.

Important limits: generation speed is not answer quality. The current Quality
preference uses catalog priority, not measured task accuracy. A successful process
or inference call does not prove that the answer is correct. Historical benchmark
results are observations, not a guarantee about the current runtime or workload.
The graph describes one host; there is no Tendril protocol, general tool runner,
cognitive interpreter, capability composer, or cross-machine scheduler yet.

## Small checkpoints, in order

### 1. Reliable local admission — started in v0.13.1

The lease spans planning, model preparation, inference/fallback, and persistence.
Conflicting writes fail clearly without storing another prompt; they are not
silently queued. Reads remain available. This intentionally limits the host to
one operation even if two runtimes might otherwise run in parallel.

Acceptance evidence: hold a mock stream open; attempted chat, model replacement,
stop, benchmark, provision, and deletion must not interfere. Verify release after
success, failure, startup restoration, and eventual completion after disconnection.
Observe two resident Ollama models without changing the requested inference route.

### 2. Memory admission and real cancellation

Collect usable-memory pressure with platform-appropriate semantics. On Linux,
reclaimable cache makes “free memory” alone an inadequate budget. Include model,
runtime, context/cache overhead, and a configurable safety reserve. Label estimates
and missing measurements honestly; recheck while holding admission immediately
before a new load. Do not unload a working route solely on a stale preview.

Propagate disconnect/Stop through runtime calls and await confirmed completion
before releasing resources. Introduce a bounded queue only with explicit lifecycle
states, cancellation while waiting, fresh planning on admission, and no hidden
prompt persistence for rejected work.

Acceptance evidence: mocked low-memory readings block unsafe loads; sufficient
memory permits them; changing pressure invalidates an old preview; canceled work
does not load later. Do not intentionally exhaust the user's machine to test it.

### 3. Trustworthy observations and failure boundaries

Attach observations to runtime version, model checksum, hardware/backend,
context settings, and workload class. Record sample count and age, and invalidate
or downweight mismatched/stale observations. Keep speed, memory, reliability,
and evaluated answer quality as separate signals. A model's self-reported
confidence is not a calibrated quality score.

Separate provider failures from saving/logging failures: the current JSON chat
catch boundary can classify persistence errors as inference failures and retry
after producing an answer. Fix that before adding retries for general tools.
Validate stream completion explicitly and retain the actual executed decision
in the interface separately from a newly calculated preview.

Acceptance evidence: changing a runtime/configuration does not reuse incompatible
measurements as proof; a failed execution-record write never re-runs a successful
answer; a truncated stream is not recorded as completed success.

### 4. One non-model capability and one fixed composition

Define a small contract for inputs, outputs, permissions, time/resource budget,
cancellation, and success verification. Start with a read-only capability and a
fixed, user-authorized workflow. Register a composition only when its components,
constraints, version, and success criteria are explicit.

Acceptance evidence: the deterministic core refuses an out-of-scope input, stops
on a failed step, and completes its permitted steps without requiring an LLM to
manage its policy. An optional cognitive layer may propose a structured plan;
it cannot grant itself permission or weaken a privacy constraint.

### 5. One paired private peer, then broader composition

Before peer discovery, define the trust boundary: authentication, encrypted
transport, pairing and revocation, narrow capability advertisements, and explicit
permission to send each class of data. A local-only request must remain local,
including when its preferred route fails. A proxy name alone provides no privacy.
Even prompt-free performance metadata can identify hardware or usage patterns;
sharing must be minimized and opt-in, not assumed harmless.

The current HTTP service has no authentication and does not explicitly restrict
its listening address. Do not expose it to an untrusted network as a Tendril.
Loopback-by-default binding and a network threat model must precede intentional
peer access. No networking/security change is bundled into v0.13.1.

Acceptance evidence: an unpaired/revoked node cannot invoke capabilities or read
private state; a disappearing peer produces a clear bounded failure or a permitted
local fallback. Only then consider goal-driven composition search, strict step
and cost budgets, and reuse of verified workflows.

## Working agreement

Keep changes independently testable. Preserve working models and private data.
Do not install runtimes, download models, share observations, expose peers, or
expand tool permissions merely because a planner suggests them. Demonstrate the
same narrow task on different machines before making broad adaptability claims.
The interface can keep evolving, but no interface or adviser should be required
for the core's policy and execution rules to work.
