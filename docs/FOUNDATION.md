# Aether: foundation before expansion

Realigned 2026-09-11 after “Define Aether Sovereignty” and the owner's clarification
that existing work should be retained unless deliberately changed or incompatible
with the goals. This document describes direction, not additional shipped features.

Planning reference: [conversation with Cal](https://chatgpt.com/share/6aa388b1-5b60-83e9-90ca-638d4130a56d).

## The direction

Aether is intended to be a persistent, adaptable space in which intelligence can
work. Models supply cognitive effort; the Field preserves the evolving questions,
observations, interpretations, relationships, and history across those efforts.
Switching a model must not mean starting that inquiry over.

Recursive expansion includes branching interpretations, questioning assumptions,
bringing in evidence, and integrating or retaining divergent states. A new state
can become the starting point for further inquiry. Reusable workflows remain a
useful application of this idea, but are not its entire meaning. This external,
model-independent representation is not itself a neural network's latent space.

The existing runtime, provider, hardware, routing, benchmark, conversation, and
interface work stays useful. Extend it rather than replacing it for philosophical
neatness. Revisit an implementation when there is a demonstrated conflict, an
agreed improvement, or a portability need—not simply because the vision grew.

Portability and adaptability remain central: avoid tying the Field to one model,
provider, operating system, database, interface, or hardware class. A small first
implementation is a starting point, not a ceiling on what Aether may represent
or eventually do. Explicit versioned interfaces should allow new capabilities
without weakening data integrity, user permissions, or privacy.

## Design commitments

- The Field holds persistent state; no model owns the truth within it.
- Questions are first-class records, including questions that remain unresolved.
- Observation, inference, assumption, analogy, and evidence remain distinguishable.
- Sources and relationships can be challenged, including human and resident claims.
- Disagreement may persist; integration does not require selecting one winner.
- Ordinary revisions preserve ancestry rather than silently replacing history.
- Human intent sets goals and permissions, not which factual conclusion must win.
  Aether must also leave the human free to reject its conclusions.
- The intended enduring resident supports curiosity and continuity, not authority.
  Its training is later work; the Field must remain readable if it is unavailable.
- Structural primitives are provisional and reducible. Derived patterns and
  operations are separate. Polarity/reference/integration is a lens to examine,
  not a universal law or mandatory three-way classification.
- Similar structure does not establish identical mechanisms. Unknown confidence
  remains unknown, and a model's confidence is not calibrated evidence.
- Privacy-aware deletion is an explicit exception to ordinary history retention.
  Preserving ancestry must not make private content impossible to remove.

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
The development tree now provides immutable JSON records and full-history
validation in `field.js`, plus local snapshot persistence in `field-store.js`.
Restart, retries, writer exclusion, and publication failures are covered by
isolated tests. These modules do not yet integrate live conversations.
The capability graph describes
execution resources; it is not yet a graph of questions and competing claims.

## Next development track: the minimal Field

The first contract is in [FIELD-CONTRACT.md](FIELD-CONTRACT.md). Its status is a
contract with record validation, local snapshot persistence, editing operations,
and explicit multi-parent integration implemented. There are no
new HTTP APIs. The current project remains the
implementation source of truth.

1. Implemented as the first development increment: define and validate small
   node, edge, provenance, and state records. Prove
   unknown confidence, distinct claim types, and immutable revision semantics.
2. Implemented as the second development increment: local persistence behind a
   replaceable storage boundary, with restart, atomic publication, private local
   files, retry receipts, and explicit snapshot export/import. See
   [storage behavior and recovery limits](FIELD-STORAGE.md).
3. Implemented as the third development increment: add attributed questions,
   relationships, and revisions through [editing operations](FIELD-OPERATIONS.md).
   A relationship is a sourced claim, not an automatic truth determination.
4. Implemented as the fourth development increment: explicit branch integration
   unions selected memberships with intact ancestry and disagreement, without
   choosing a winner or changing unselected branches.
5. Lightly connect existing execution/conversation flows. Retain model output as
   attributed output, not verified truth; avoid re-running inference on save errors.
6. Demonstrate continuity across restart and model changes, inspect results with
   the owner and Cal, and revise before resident training or broader automation.

Each increment includes tests; the sixth is an end-to-end review, not the first
testing stage. These are reviewable slices, not a promise to ship exactly six
versions. No custom resident training, large vector service, peer network, or
autonomous swarm is required to prove the first Field.

The acceptance scenario: retain a question and two competing interpretations;
attach evidence to one; create a new state without erasing the other; restart and
switch providers; recover the same inquiry and the origins of every contribution.

## Supporting engineering work retained from the earlier roadmap

These remain valid improvements. Sequence them when they support the Field or
address an actual correctness/resource problem, rather than making every item a
prerequisite for the first Field prototype.

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
