# Field editing operations

Implemented in `src/core/field-operations.js` in the v0.13.1 development tree.
These pure functions need no model, filesystem, clock, or generated IDs. They
construct validated, detached, deeply frozen snapshots; they do not save them or
change live chat. Callers supply identity, time, and attribution explicitly.

## API

- `createField({id, initialStateId, createdAt, provenance, extensions?})` creates
  a Field with one empty initial state.
- `readFieldState(snapshot, stateId)` resolves that state's membership as
  `{state, nodes, edges}`. Parent IDs remain on `state`; this is not a flattened
  ancestry query or an automatic latest-revision filter.
- `applyFieldChange(snapshot, {parentStateId, stateId, createdAt, provenance,
  actions, extensions?})` returns a complete proposed snapshot with one successor.
- `integrateFieldStates(snapshot, {parentStateIds, stateId, createdAt, provenance,
  actions, extensions?})` explicitly combines at least two distinct existing
  states into one successor, optionally adding the same actions described below.

Each action contains `type` and `record`. Supported types are `add-node`,
`add-edge`, `revise-node`, and `revise-edge`. Revisions also require `targetId`.
The record must supply an unused `id`; additions supply the required node or edge
fields. Revision records are patches: omitted fields retain the target's values,
including confidence and status. Content and other nested values are replaced as
whole values, not recursively merged. Every new record gets the command's time
and provenance, unless the record supplies its own provenance. The original
author's contribution is never rewritten or attributed to the new author.

`schemaVersion`, `fieldId`, `createdAt`, and `revises` are controlled by the layer,
not accepted in action records. Extensions follow the namespaced JSON contract.
Malformed JSON, unknown fields, invalid records, and invalid ancestry reject the
whole proposal without changing either input. Command errors use
`INVALID_FIELD_CHANGE`; record/JSON validation errors use `INVALID_FIELD`.

## Example

Run equivalent code from the project root in a Node ES module:

```js
import { createProvenance } from './src/core/field.js';
import { createField, applyFieldChange, readFieldState } from './src/core/field-operations.js';

const provenance = createProvenance({
  sourceType: 'human', sourceId: 'owner', method: 'explicit question'
});
const field = createField({
  id: 'inquiry-1', initialStateId: 'root',
  createdAt: '2026-09-11T00:00:00.000Z', provenance
});
const proposal = applyFieldChange(field, {
  parentStateId: 'root', stateId: 'question-state',
  createdAt: '2026-09-11T00:01:00.000Z', provenance,
  actions: [{ type: 'add-node', record: {
    id: 'question-1', kind: 'question',
    content: { format: 'text/plain', text: 'What evidence would distinguish these explanations?' }
  } }]
});
console.log(readFieldState(proposal, 'question-state').nodes);
// Optional explicit persistence: await store.save(proposal, { requestId: 'add-question-1' });
```

## History and persistence boundaries

The selected parent may be historical, allowing separate branches. The full
snapshot retains other branches, but the new state's membership inherits only
the selected parent's members plus the additions. Revisions add records alongside
their originals; they do not hide earlier versions, retarget edges, or declare a
winner. Changing an edge requires an explicit edge revision.

Revision and derivation targets must exist in the selected parent's history, not
an unrelated sibling or the same batch. New edges can reference nodes added in
the same batch, regardless of action order. An empty action list creates an
explicit checkpoint. Membership filtering remains future work.

## Explicit branch integration

Integration takes the union of the selected parents' memberships. Shared IDs
appear once, in first-seen order following the caller's parent order; this order
does not express priority or credibility. Distinct revisions remain distinct.
All selected parent IDs become ancestry links on the new state. Historical and
overlapping parents are allowed; there is no implicit selection of current heads.
Unselected states and their records remain in the snapshot but are not added to
the integrated membership unless shared with a selected parent.

```js
// Given a snapshot with existing left-state and right-state branches:
const proposal = integrateFieldStates(snapshot, {
  parentStateIds: ['left-state', 'right-state'], stateId: 'integrated-state',
  createdAt: '2026-09-11T00:02:00.000Z', provenance,
  actions: []
});
```

Import `integrateFieldStates` from `src/core/field-operations.js`. Integration
provenance records who requested the combination, not endorsement of every claim.
Actions may derive a new inference from either selected parent's history, revise
an earlier contribution, or add cross-branch relationships. They cannot use an
unselected branch's private ancestry or same-batch revision/derivation targets.
New edges still require their endpoints in the resulting membership. No claims
are automatically reconciled, rescored, hidden, or rewritten. A subsequent
`applyFieldChange` can continue from the integrated state.

Save the returned proposal through [LocalFieldStore](FIELD-STORAGE.md). This is
not an incremental durable transaction: it still validates and saves a complete
history. Keep the exact proposal and request ID for uncertain-save retries.
Rebuilding against a newer snapshot is a new decision, not a transparent retry.
A stale proposal that would discard saved history is rejected; there is no
automatic merge or rebase. Explicit privacy deletion and live conversation
integration remain separate work.

`npm run test:field` exercises these operations, attribution, immutable views,
invalid batches, ancestry boundaries, and persistence/retry interoperability.
