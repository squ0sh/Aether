import { createNode, createEdge, createState, validateFieldJson, validateFieldSnapshot } from "./field.js";

export class FieldChangeError extends Error {
  constructor(message) { super(message); this.name = "FieldChangeError"; this.code = "INVALID_FIELD_CHANGE"; }
}
const requireThat = (condition, message) => { if (!condition) throw new FieldChangeError(message); };

function shape(value, required, optional = []) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object");
  for (const key of required) requireThat(Object.hasOwn(value, key), `${key} is required`);
  for (const key of Object.keys(value)) requireThat([...required, ...optional].includes(key), `Unknown command field: ${key}`);
}

function identity(value, name) { requireThat(typeof value === "string" && value.trim().length > 0, `${name} must be a nonempty string`); }

export function createField(input) {
  const command = validateFieldJson(input);
  shape(command, ["id", "initialStateId", "createdAt", "provenance"], ["extensions"]);
  const initial = createState({ id: command.initialStateId, fieldId: command.id, createdAt: command.createdAt, provenance: command.provenance });
  return validateFieldSnapshot({ schemaVersion: 1, id: command.id, extensions: Object.hasOwn(command, "extensions") ? command.extensions : {}, nodes: [], edges: [], states: [initial] });
}

export function readFieldState(input, stateId) {
  identity(stateId, "stateId");
  const snapshot = validateFieldSnapshot(input);
  const state = snapshot.states.find((item) => item.id === stateId);
  requireThat(state, "State does not exist in this Field");
  const nodes = new Map(snapshot.nodes.map((item) => [item.id, item]));
  const edges = new Map(snapshot.edges.map((item) => [item.id, item]));
  return Object.freeze({ state, nodes: Object.freeze(state.nodeIds.map((id) => nodes.get(id))), edges: Object.freeze(state.edgeIds.map((id) => edges.get(id))) });
}

// Build exactly one successor from an explicit parent. No I/O, generated IDs,
// automatic winner selection, in-place edits, or implicit relationship retargeting.
export function applyFieldChange(input, change) {
  const snapshot = validateFieldSnapshot(input);
  const command = validateFieldJson(change);
  shape(command, ["parentStateId", "stateId", "createdAt", "provenance", "actions"], ["extensions"]);
  identity(command.parentStateId, "parentStateId");
  return buildSuccessor(snapshot, command, [command.parentStateId]);
}

// Explicit union, not truth resolution: retain all selected memberships and
// their ancestry. Shared records appear once; competing revisions stay distinct.
export function integrateFieldStates(input, change) {
  const snapshot = validateFieldSnapshot(input);
  const command = validateFieldJson(change);
  shape(command, ["parentStateIds", "stateId", "createdAt", "provenance", "actions"], ["extensions"]);
  requireThat(Array.isArray(command.parentStateIds) && command.parentStateIds.length >= 2, "Integration requires at least two explicit parent states");
  command.parentStateIds.forEach((id) => identity(id, "parentStateId"));
  requireThat(new Set(command.parentStateIds).size === command.parentStateIds.length, "Integration parents must be distinct");
  return buildSuccessor(snapshot, command, command.parentStateIds);
}

function buildSuccessor(snapshot, command, parentStateIds) {
  identity(command.stateId, "stateId");
  requireThat(Array.isArray(command.actions), "actions must be an array");
  const states = new Map(snapshot.states.map((item) => [item.id, item]));
  const parents = parentStateIds.map((id) => {
    const parent = states.get(id);
    requireThat(parent, "Parent state does not exist in this Field");
    return parent;
  });
  const history = new Set();
  const visited = new Set();
  const pending = [...parents];
  while (pending.length) {
    const state = pending.pop();
    if (visited.has(state.id)) continue;
    visited.add(state.id);
    for (const id of [...state.nodeIds, ...state.edgeIds]) history.add(id);
    pending.push(...state.parentStateIds.map((id) => states.get(id)));
  }
  const previousNodes = new Map(snapshot.nodes.map((item) => [item.id, item]));
  const previousEdges = new Map(snapshot.edges.map((item) => [item.id, item]));
  const nodes = [], edges = [];
  const claimedIds = new Set([...snapshot.nodes, ...snapshot.edges, ...snapshot.states].map((item) => item.id));
  const claimId = (id) => {
    identity(id, "record ID");
    requireThat(!claimedIds.has(id), "A new state or record needs an unused ID");
    claimedIds.add(id);
  };
  claimId(command.stateId);

  for (const action of command.actions) {
    shape(action, ["type", "record"], ["targetId"]);
    requireThat(["add-node", "add-edge", "revise-node", "revise-edge"].includes(action.type), "Unsupported Field action");
    const revision = action.type.startsWith("revise-");
    const isNode = action.type.endsWith("node");
    const keys = isNode
      ? ["kind", "content", "context", "status", "confidence", "provenance", "derivedFrom", "primitives", "extensions"]
      : ["from", "to", "relation", "context", "confidence", "provenance", "extensions"];
    shape(action.record, ["id"], keys);
    claimId(action.record.id);
    let previous = {};
    if (revision) {
      identity(action.targetId, "targetId");
      previous = (isNode ? previousNodes : previousEdges).get(action.targetId);
      requireThat(previous && history.has(action.targetId), "Revision target must have the right type and belong to parent history");
    } else requireThat(!Object.hasOwn(action, "targetId"), "Only revision actions accept targetId");
    const record = {
      ...previous,
      ...action.record,
      fieldId: snapshot.id,
      createdAt: command.createdAt,
      // A revision is a new contribution, not an assertion by the old author.
      provenance: Object.hasOwn(action.record, "provenance") ? action.record.provenance : command.provenance,
      revises: revision ? action.targetId : null
    };
    (isNode ? nodes : edges).push(isNode ? createNode(record) : createEdge(record));
  }
  const successor = createState({
    id: command.stateId, fieldId: snapshot.id, createdAt: command.createdAt,
    provenance: command.provenance, extensions: Object.hasOwn(command, "extensions") ? command.extensions : {},
    parentStateIds,
    nodeIds: [...new Set(parents.flatMap((parent) => parent.nodeIds)), ...nodes.map((item) => item.id)],
    edgeIds: [...new Set(parents.flatMap((parent) => parent.edgeIds)), ...edges.map((item) => item.id)]
  });
  // Validate the whole proposal before returning anything; one invalid action
  // invalidates the batch without changing the original snapshot.
  return validateFieldSnapshot({ ...snapshot, nodes: [...snapshot.nodes, ...nodes], edges: [...snapshot.edges, ...edges], states: [...snapshot.states, successor] });
}
