# Minimal Aether Field contract

Status: records, validation, editing, explicit branch integration, and local snapshot
persistence implemented in the v0.13.1 development tree. Chat integration remains
planned. No new application release or HTTP behavior
is introduced here. See [local storage](FIELD-STORAGE.md) for its API and limits.
Scope: the smallest representation that can preserve inquiry across model changes.
This contract guides the first implementation; it does not introduce HTTP routes.

## Preserve the foundation, keep the boundaries open

The Field complements the current provider manager, resource capability graph,
execution records, and conversations. It does not replace them or require a new
runtime, resident model, vector database, or network service. The first reference
implementation can use plain JSON and existing local storage conventions. The
data contract must not depend on that storage choice or on Node-specific objects.

Keep validation/state transitions separate from persistence and provider calls.
Core records use JSON values, opaque stable IDs, and UTC timestamp strings.
File paths, process handles, and provider SDK objects are not record identities.
Exported data must be understandable without launching any model. This is a
portability goal, not a claim that all platforms have already been tested.

## Four record types

Every node, edge, and state carries `schemaVersion: 1`, `id`, `fieldId`, `createdAt`, and
`extensions` (an object, empty by default). IDs are unique within a Field and
must never be reused for different content. Timestamps are metadata; explicit
references determine ancestry and order.

### Node: something being considered

- `kind`: initially `question`, `observation`, `hypothesis`, `inference`,
  `assumption`, `analogy`, `evidence`, or `abstraction`.
- `content`: `{ "format": "text/plain", "text": "..." }` initially. Text may
  describe any domain; it is untrusted content, never an executable instruction.
- `context`: a text description of relevant conditions; empty means unspecified,
  not universally applicable.
- `status`: `open`, `supported`, `weakened`, `contradicted`, or `unresolved`.
  It is an attributed assessment, never a global truth label. Default: `open`.
- `confidence`: `{ "value": null, "basis": "unknown" }` by default. A supplied
  value must be finite and between 0 and 1, with a nonempty explanation of its
  basis. A supplied number does not imply statistical calibration.
- `provenance`: who supplied this record and what it was based on (below).
- `derivedFrom`: IDs of prior nodes informing this node; empty for a new input.
- `revises`: the prior node ID if this is a revision, otherwise `null`.
- `primitives`: optional structural tags, empty by default. They are annotations,
  not a required ontology or proof that a structure applies universally.

A question need not acquire an answer to be a valid persistent node. Evidence
identifies material being offered in support of a claim; using that kind does not
certify the material's authenticity or its interpretation. Every initial model
utterance is an observation of what that model produced, not direct observation
of the world. Extracted hypotheses or claims are separate attributed nodes.

### Edge: an attributed relationship

An edge has `from`, `to` (node IDs), `relation`, `context`, `confidence`,
`provenance`, and `revises` (a prior edge ID or `null`). Initial relation labels:
`supports`, `contradicts`, `questions`, `responds_to`, `analogous_to`,
`transforms`, `constrains`, `contains`, and `precedes`.

An edge points from the contributing node toward its target: evidence supports
a hypothesis; an answer candidate responds to a question. The direction of a
stored contradiction or analogy preserves who asserted which relationship; a
reader must not invent a reverse assertion. Opposing edges may coexist.

Edges do not automatically change node status or confidence. Such a change
requires a new attributed node revision. Shared words or structure alone do not
justify adding support or causality. Semantic relationship cycles are allowed;
historical ancestry cycles are not.

### Provenance: embedded on nodes, edges, and states

Use one consistent object:

```json
{
  "sourceType": "model",
  "sourceId": "provider:llama-cpp/model:example",
  "providerId": "llama-cpp",
  "modelId": "example",
  "executionId": null,
  "conversationId": null,
  "messageId": null,
  "references": [],
  "method": "captured model output"
}
```

`sourceType` initially accepts `human`, `model`, `tool`, `memory`, or `system`.
`sourceId` identifies the contributor; provider/model IDs are required for model
sources. Optional linkage IDs are `null` when unavailable, never fabricated.
`references` contains explicit source descriptors (such as a URI and locator),
not fetched content or automatically trusted citations. Reading a stored URI
does not authorize network access. `method` states how the record was obtained.
Memory-derived records preserve origin references rather than laundering a
previous claim into new independent evidence.

### State: an immutable view with parents

A state has `parentStateIds`, `nodeIds`, `edgeIds`, and `provenance`. Its membership
lists identify its complete view, not an ambiguous partial update. The empty
initial state has no parents. A successor has one parent; an explicit integration
may have more. Multiple states may share a parent and remain equally available.

A state is not an answer. Creating a newer state does not invalidate a sibling.
History remains reachable through parent references even when a newer view omits
an older record. A store may maintain a set of head IDs for navigation, but there
is no compulsory single winning head or “most true” branch.

## Implemented record API

`src/core/field.js` exports `createNode`, `createEdge`, `createState`, and
`createProvenance`, plus the matching `validate*` functions and
`validateFieldSnapshot`. Constructors supply documented empty/unknown defaults;
validators require complete records. Callers supply IDs, UTC timestamps, and
source attribution. Provenance is embedded, not a separately identified record.

All successful calls return detached, deeply frozen JSON-compatible values.
Errors are `FieldValidationError` with `code: "INVALID_FIELD"` and a `path`.
No validator writes files, invokes models, fetches references, or decides truth.
Run `npm run test:field` for the isolated tests; `npm test` includes them as well.

A complete in-memory snapshot has `{ schemaVersion, id, nodes, edges, states,
extensions }`. It includes exactly one empty initial state and the complete
retained history; this is not a partial context view. Record IDs are unique across
the three arrays and every node/edge must appear in at least one state. Records
and arrays may be supplied in any order. Repeated IDs are rejected even if content
matches. The local adapter separately records save request IDs for idempotent
retries; they are storage receipts, not duplicate Field records.

Standalone validation checks shape and self-references. Snapshot validation also
checks membership, record types, Field boundaries, parent ancestry, and historical
revision/derivation targets. It can validate explicitly supplied branches and
multi-parent views; the separate editing layer constructs these only from explicit
caller commands, never by automatically selecting branches or winners.
This small in-memory validator is not a large-graph indexing or storage solution.

Timestamps use canonical UTC ISO form, for example `2026-09-11T00:00:00.000Z`.
Initial source descriptors use `{ uri: string, locator: string | null }`; a memory
source must retain at least one such origin reference. Numeric confidence cannot
use `unknown` as its basis. Accessors, sparse arrays, cycles, non-finite numbers,
and non-JSON objects are rejected instead of silently losing data on serialization.

## Revision and validation rules

Ordinary changes create new IDs; existing records are immutable. Revising a node
or edge explicitly links the previous version. Never mutate a confidence score
in place. Do not use timestamps to overwrite competing updates.

A proposed state is accepted only when:

1. Required fields, types, IDs, confidence values, and schema versions are valid.
2. Referenced parents exist in this Field; state ancestry is acyclic.
3. Members exist or are created in this same operation; IDs are not duplicated.
4. Every edge endpoint is present in the state's node membership.
5. Revision/derivation targets exist in parent-state history, are of the correct
   record type, and cannot point to themselves or forward into a cycle.
6. All writes can be published atomically, or none become an accepted state.

Branches and integration cannot silently alter shared records. Integration records
its parents, selected membership, contributor, and method. It does not need to
resolve contradictions or average confidence. Validation checks consistency, not
the factual correctness of a claim.

## Core operations and storage boundary

[The editing layer](FIELD-OPERATIONS.md) now creates Fields, resolves state
membership, and constructs attributed additions/revisions against one explicit
parent. It also explicitly integrates two or more selected states by membership
union, retaining their ancestry and competing revisions. Both return complete
proposals for a separate save, not durable commits. Ancestry query conveniences
remain planned.
The intended boundary is:

- Create a Field with an empty initial state.
- Read a state and resolve its complete membership and parent history.
- Commit additions or revisions against explicit parent IDs, returning a new
  state ID. Two commits from the same parent may form separate branches.
- Integrate explicitly selected parent states without choosing a winner by default.
- Export/import records losslessly, retaining IDs, provenance, and ancestry.

The first persistence adapter now publishes a complete validated snapshot and its
save receipts through one atomic local file replacement. Head IDs are derived from
the saved state graph, not written separately. It detects incomplete/corrupt data,
uses an exclusive per-Field writer lock, and refuses stale snapshots that would
remove or replace retained history. Reusing a request ID with a different snapshot
is a conflict. A higher-level incremental commit API is still future work; the
adapter does not infer how to merge a stale writer's proposal.

The first validator supports only the initial vocabulary above. Extensions use
namespaced keys and survive round-tripping; they cannot override core fields or
grant permissions. Unsupported schema versions/kinds/relations fail explicitly
in active processing, without rewriting stored originals. Versioned migrations
can expand the vocabulary later. A small supported vocabulary is a compatibility
boundary, not a permanent restriction on Aether's capabilities or domains.

## Existing-flow integration, later in this track

Keep current chat responses, streaming events, and conversations working. Connect
contributions by execution and message IDs; do not copy prompt text into the
operational measurement records. Existing history is not bulk-imported without
an explicit migration choice.

After a successful complete reply, an opt-in integration can record attributed
model output in a Field. Do not infer which text is evidence or a question merely
from punctuation. Claims, questions, and relationships can first be supplied
explicitly, then proposed by a model under the same validation rules.

Field persistence failure must not trigger another inference or claim that the
output was saved. Chat now guards completed inference so subsequent conversation
or measurement save failures cannot trigger failover or false model-failure records.
It reports uncertain persistence without automatically retrying the request.
Field integration still needs stable linkage/deduplication to reconcile partial saves;
do not promise a cross-store atomic commit without implementing one. Interrupted
streams must not be imported as completed answers.

Later context selection supplies a bounded, relevant view with source and
uncertainty labels—not the entire Field as a growing prompt. Stored model/tool
text is data, not system instructions. Switching providers must not change IDs,
erase dissent, or bypass permissions. The future enduring resident contributes
through the same attributed interface; no resident is needed to read the Field.

## Privacy and retention

Fields can contain private content. Store locally under the configured data root,
exclude from source control, and do not automatically share or export them.
The logical format is portable; export is still an explicit user action.

Preserve history during normal reasoning. The local adapter now supports explicit
whole-Field deletion at a reviewed revision, with a minimal marker blocking stale
save resurrection; see [deletion scope](FIELD-STORAGE.md#explicit-deletion).
Linked-content deletion is still required before broad integration.
Deleting a conversation must not quietly leave
newly duplicated text in a Field. Explain the scope for linked/derived records
and backups; deliberate erasure can make historical views incomplete. Report
redacted/missing ancestry honestly rather than reconstructing deleted content or
claiming intact replay. Do not implement silent cascading deletion as inference.

## Acceptance tests, not model-quality promises

- Save a question with unknown confidence; reload with that uncertainty intact.
- Keep two incompatible hypotheses and their independently sourced relationships.
- Add evidence and revise one assessment without changing the previous state.
- Branch from one state, integrate explicitly, and retain both parent histories.
- Reject dangling IDs, mismatched Field IDs, invalid confidence, ancestry cycles,
  and attempts to replace an existing ID with different content.
- Recover from an interrupted write without publishing half a state; retries of
  the same commit do not duplicate records.
- Export/import on another supported storage environment without losing origins
  or extension fields. No model process is required for these operations.
- Switch a mock provider and restart: earlier questions and dissent remain visible.
- A Field save failure never repeats successful inference or reports false success.
- Test explicit deletion and linked-content behavior before enabling integration.

Tests accompany each increment. This contract introduces neither automatic truth
scoring nor autonomous exploration. Both would require separately evaluated
methods, visible budgets, and explicit execution permissions.
