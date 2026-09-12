// Portable Field records: no filesystem, model, network, clock, or UUID dependency.
// Callers supply identity and time; returned records are detached and deeply frozen.
const KINDS = ["question", "observation", "hypothesis", "inference", "assumption", "analogy", "evidence", "abstraction"];
const RELATIONS = ["supports", "contradicts", "questions", "responds_to", "analogous_to", "transforms", "constrains", "contains", "precedes"];
const SOURCES = ["human", "model", "tool", "memory", "system"];
const STATUSES = ["open", "supported", "weakened", "contradicted", "unresolved"];
const BASE = ["schemaVersion", "id", "fieldId", "createdAt", "extensions"];

export class FieldValidationError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = "FieldValidationError";
    this.code = "INVALID_FIELD";
    this.path = path;
  }
}

function requireThat(condition, path, reason) {
  if (!condition) throw new FieldValidationError(path, reason);
}

function jsonValue(value, path = "$", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    requireThat(Number.isFinite(value), path, "must be a finite JSON number");
    return;
  }
  requireThat(typeof value === "object", path, "must be a JSON value");
  requireThat(!ancestors.has(value), path, "cyclic objects are not JSON");
  const array = Array.isArray(value);
  requireThat(array || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, path, "must be a plain JSON object");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array) requireThat(keys.length === value.length + 1, path, "arrays must be dense and have no extra properties");
  for (const key of keys) {
    if (array && key === "length") continue;
    requireThat(typeof key === "string", path, "symbol keys are not JSON");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireThat(descriptor.enumerable && "value" in descriptor, `${path}.${key}`, "accessors and hidden properties are not JSON");
    if (array) requireThat(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, path, "invalid array index");
    jsonValue(descriptor.value, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function detached(value) {
  jsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Shared JSON boundary for higher-level Field commands; never invoke accessors
// or silently strip non-JSON input while capturing a pending operation.
export function validateFieldJson(value) { return freeze(detached(value)); }

function object(value, path) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), path, "must be an object");
}

function fields(value, names, path) {
  object(value, path);
  for (const name of names) requireThat(Object.hasOwn(value, name), `${path}.${name}`, "is required");
  for (const name of Object.keys(value)) requireThat(names.includes(name), `${path}.${name}`, "unknown core field; use a namespaced extension");
}

function text(value, path, empty = false) {
  requireThat(typeof value === "string" && (empty || value.trim().length > 0), path, "must be a string" + (empty ? "" : " with content"));
}

function ids(value, path) {
  requireThat(Array.isArray(value), path, "must be an array");
  value.forEach((id, index) => text(id, `${path}[${index}]`));
  requireThat(new Set(value).size === value.length, path, "duplicate values");
}

function nullableId(value, path) { if (value !== null) text(value, path); }
function choice(value, values, path) { requireThat(values.includes(value), path, "unsupported value"); }

function extensions(value, path) {
  object(value, path);
  for (const key of Object.keys(value)) requireThat(/^[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+$/.test(key), `${path}.${key}`, "extension keys must be namespaced, e.g. example:label");
}

function base(value, path) {
  requireThat(value.schemaVersion === 1, `${path}.schemaVersion`, "unsupported schema version");
  text(value.id, `${path}.id`);
  text(value.fieldId, `${path}.fieldId`);
  text(value.createdAt, `${path}.createdAt`);
  const date = new Date(value.createdAt);
  requireThat(Number.isFinite(date.getTime()) && date.toISOString() === value.createdAt, `${path}.createdAt`, "must be a canonical UTC ISO timestamp");
  extensions(value.extensions, `${path}.extensions`);
}

function confidence(value, path) {
  fields(value, ["value", "basis"], path);
  requireThat(value.value === null || (typeof value.value === "number" && value.value >= 0 && value.value <= 1), `${path}.value`, "must be null or a number between 0 and 1");
  text(value.basis, `${path}.basis`);
  if (value.value !== null) requireThat(value.basis.trim().toLowerCase() !== "unknown", `${path}.basis`, "a numeric confidence needs a stated basis");
}

function provenance(value, path) {
  fields(value, ["sourceType", "sourceId", "providerId", "modelId", "executionId", "conversationId", "messageId", "references", "method"], path);
  choice(value.sourceType, SOURCES, `${path}.sourceType`);
  text(value.sourceId, `${path}.sourceId`);
  text(value.method, `${path}.method`);
  for (const key of ["providerId", "modelId", "executionId", "conversationId", "messageId"]) nullableId(value[key], `${path}.${key}`);
  if (value.sourceType === "model") {
    text(value.providerId, `${path}.providerId`);
    text(value.modelId, `${path}.modelId`);
  }
  requireThat(Array.isArray(value.references), `${path}.references`, "must be an array");
  value.references.forEach((reference, index) => {
    const location = `${path}.references[${index}]`;
    fields(reference, ["uri", "locator"], location);
    text(reference.uri, `${location}.uri`);
    nullableId(reference.locator, `${location}.locator`);
  });
  if (value.sourceType === "memory") requireThat(value.references.length > 0, `${path}.references`, "memory-derived records must retain an origin reference");
}

function node(value, path) {
  fields(value, [...BASE, "kind", "content", "context", "status", "confidence", "provenance", "derivedFrom", "revises", "primitives"], path);
  base(value, path);
  choice(value.kind, KINDS, `${path}.kind`);
  fields(value.content, ["format", "text"], `${path}.content`);
  requireThat(value.content.format === "text/plain", `${path}.content.format`, "unsupported content format");
  text(value.content.text, `${path}.content.text`);
  text(value.context, `${path}.context`, true);
  choice(value.status, STATUSES, `${path}.status`);
  confidence(value.confidence, `${path}.confidence`);
  provenance(value.provenance, `${path}.provenance`);
  ids(value.derivedFrom, `${path}.derivedFrom`);
  ids(value.primitives, `${path}.primitives`);
  nullableId(value.revises, `${path}.revises`);
  requireThat(value.revises !== value.id && !value.derivedFrom.includes(value.id), path, "cannot derive from or revise itself");
}

function edge(value, path) {
  fields(value, [...BASE, "from", "to", "relation", "context", "confidence", "provenance", "revises"], path);
  base(value, path);
  text(value.from, `${path}.from`);
  text(value.to, `${path}.to`);
  choice(value.relation, RELATIONS, `${path}.relation`);
  text(value.context, `${path}.context`, true);
  confidence(value.confidence, `${path}.confidence`);
  provenance(value.provenance, `${path}.provenance`);
  nullableId(value.revises, `${path}.revises`);
  requireThat(value.revises !== value.id, path, "cannot revise itself");
}

function state(value, path) {
  fields(value, [...BASE, "parentStateIds", "nodeIds", "edgeIds", "provenance"], path);
  base(value, path);
  for (const key of ["parentStateIds", "nodeIds", "edgeIds"]) ids(value[key], `${path}.${key}`);
  provenance(value.provenance, `${path}.provenance`);
  requireThat(!value.parentStateIds.includes(value.id), path, "cannot be its own parent");
}

function validated(input, validator) {
  const copy = detached(input);
  validator(copy, "$");
  return freeze(copy);
}

export const validateNode = (input) => validated(input, node);
export const validateEdge = (input) => validated(input, edge);
export const validateState = (input) => validated(input, state);
export const validateProvenance = (input) => validated(input, provenance);

export function createProvenance(input) {
  return validateProvenance({ providerId: null, modelId: null, executionId: null, conversationId: null, messageId: null, references: [], ...detached(input) });
}

const defaults = () => ({ schemaVersion: 1, extensions: {} });
export function createNode(input) {
  return validateNode({ ...defaults(), context: "", status: "open", confidence: { value: null, basis: "unknown" }, derivedFrom: [], revises: null, primitives: [], ...detached(input) });
}
export function createEdge(input) {
  return validateEdge({ ...defaults(), context: "", confidence: { value: null, basis: "unknown" }, revises: null, ...detached(input) });
}
export function createState(input) {
  return validateState({ ...defaults(), parentStateIds: [], nodeIds: [], edgeIds: [], ...detached(input) });
}

// A complete in-memory history, not a store or a commit API. Validate before
// accepting imported/proposed history. Input order does not imply ancestry.
export function validateFieldSnapshot(input) {
  const copy = detached(input);
  fields(copy, ["schemaVersion", "id", "nodes", "edges", "states", "extensions"], "$");
  requireThat(copy.schemaVersion === 1, "$.schemaVersion", "unsupported schema version");
  text(copy.id, "$.id");
  extensions(copy.extensions, "$.extensions");
  const records = new Map();
  for (const [group, validator] of [["nodes", node], ["edges", edge], ["states", state]]) {
    requireThat(Array.isArray(copy[group]), `$.${group}`, "must be an array");
    copy[group].forEach((record, index) => {
      const path = `$.${group}[${index}]`;
      validator(record, path);
      requireThat(record.fieldId === copy.id, `${path}.fieldId`, "belongs to another Field");
      requireThat(!records.has(record.id), `${path}.id`, "record IDs must be unique across all types");
      records.set(record.id, { record, group });
    });
  }
  const get = (id, group, path) => {
    requireThat(records.get(id)?.group === group, path, `missing or wrong-type ${group} reference: ${id}`);
    return records.get(id).record;
  };
  const roots = copy.states.filter((item) => item.parentStateIds.length === 0);
  requireThat(roots.length === 1, "$.states", "must contain exactly one initial state");
  requireThat(roots[0].nodeIds.length === 0 && roots[0].edgeIds.length === 0, "$.states", "initial state must be empty");
  const pending = new Map(copy.states.map((item) => [item.id, item]));
  const histories = new Map();
  const used = new Set();
  while (pending.size) {
    let progressed = false;
    for (const [id, item] of pending) {
      const path = `state(${id})`;
      item.parentStateIds.forEach((parent) => get(parent, "states", path));
      if (item.parentStateIds.some((parent) => !histories.has(parent))) continue;
      const ancestors = new Set(item.parentStateIds.flatMap((parent) => [...histories.get(parent)]));
      for (const nodeId of item.nodeIds) get(nodeId, "nodes", path);
      for (const edgeId of item.edgeIds) {
        const relation = get(edgeId, "edges", path);
        requireThat(item.nodeIds.includes(relation.from) && item.nodeIds.includes(relation.to), path, "edge endpoints must be members of this state");
      }
      for (const member of [...item.nodeIds, ...item.edgeIds]) {
        const { record, group } = records.get(member);
        if (!ancestors.has(member)) {
          const references = [...(record.derivedFrom || []), ...(record.revises === null ? [] : [record.revises])];
          for (const reference of references) {
            get(reference, group, path);
            requireThat(ancestors.has(reference), path, "revision and derivation targets must be in parent history");
          }
        }
        used.add(member);
      }
      histories.set(id, new Set([...ancestors, ...item.nodeIds, ...item.edgeIds]));
      pending.delete(id);
      progressed = true;
    }
    requireThat(progressed, "$.states", "state ancestry contains a cycle");
  }
  for (const item of [...copy.nodes, ...copy.edges]) requireThat(used.has(item.id), "$.states", `record is not a member of any state: ${item.id}`);
  return freeze(copy);
}
