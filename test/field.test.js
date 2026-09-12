import assert from "node:assert/strict";
import test from "node:test";
import { createNode, createEdge, createState, createProvenance, validateNode, validateEdge, validateState, validateProvenance, validateFieldSnapshot, FieldValidationError } from "../src/core/field.js";

const time = "2026-09-11T00:00:00.000Z";
const source = createProvenance({ sourceType: "human", sourceId: "owner", method: "explicit contribution" });
const common = (id) => ({ id, fieldId: "field-1", createdAt: time, provenance: source });
const node = (id, extra = {}) => createNode({ ...common(id), kind: "hypothesis", content: { format: "text/plain", text: id }, ...extra });
const edge = (id, from, to, extra = {}) => createEdge({ ...common(id), from, to, relation: "contradicts", ...extra });
const state = (id, parents = [], nodes = [], edges = []) => createState({ ...common(id), parentStateIds: parents, nodeIds: nodes, edgeIds: edges });
const snapshot = () => ({ schemaVersion: 1, id: "field-1", extensions: {}, nodes: [node("q", { kind: "question" }), node("a"), node("b")], edges: [edge("ab", "a", "b"), edge("ba", "b", "a")], states: [state("root"), state("s1", ["root"], ["q", "a", "b"], ["ab", "ba"])] });
const mutable = (value) => JSON.parse(JSON.stringify(value));
const invalid = (fn) => assert.throws(fn, (error) => error instanceof FieldValidationError && error.code === "INVALID_FIELD" && typeof error.path === "string");

test("questions retain unknown confidence without inventing an answer", () => {
  const question = node("q", { kind: "question" });
  assert.deepEqual(question.confidence, { value: null, basis: "unknown" });
  assert.equal(question.status, "open");
  assert.deepEqual(validateNode(mutable(question)), question);
});

test("records are detached, deeply frozen, and retain namespaced JSON extensions", () => {
  const extra = { "example:tags": { labels: ["private"] } };
  const record = node("a", { extensions: extra });
  extra["example:tags"].labels.push("changed");
  assert.deepEqual(record.extensions["example:tags"].labels, ["private"]);
  assert.throws(() => { record.confidence.value = 1; }, TypeError);
  assert.throws(() => record.extensions["example:tags"].labels.push("changed"), TypeError);
  assert.deepEqual(validateNode(mutable(record)), record);
});

test("unsupported kinds, core fields, versions, content, and timestamps fail clearly", () => {
  for (const change of [{ kind: "unregistered" }, { schemaVersion: 2 }, { truth: true }, { content: { format: "text/html", text: "hello" } }, { createdAt: "2026-02-30T00:00:00.000Z" }, { createdAt: "yesterday" }, { id: " " }, { extensions: { authority: true } }]) invalid(() => node("a", change));
  const record = mutable(node("a"));
  delete record.context;
  invalid(() => validateNode(record));
});

test("confidence needs a valid value and stated basis, never automatic certainty", () => {
  for (const value of [-0.1, 1.1, NaN, Infinity, "0.5", undefined]) invalid(() => node("a", { confidence: { value, basis: "test" } }));
  for (const basis of ["", "unknown", " UNKNOWN "]) invalid(() => node("a", { confidence: { value: 0.5, basis } }));
  assert.equal(node("a", { confidence: { value: 0, basis: "explicit estimate" } }).confidence.value, 0);
  assert.equal(node("a", { confidence: { value: 1, basis: "uncalibrated model estimate" } }).confidence.value, 1);
});

test("provenance distinguishes sources and requires model and memory origins", () => {
  invalid(() => createProvenance({ sourceType: "model", sourceId: "m", method: "output" }));
  invalid(() => createProvenance({ sourceType: "memory", sourceId: "old", method: "recall" }));
  const model = createProvenance({ sourceType: "model", sourceId: "m", method: "output", providerId: "llama-cpp", modelId: "small" });
  assert.equal(model.executionId, null);
  const memory = createProvenance({ sourceType: "memory", sourceId: "old", method: "recall", references: [{ uri: "urn:aether:node:a", locator: null }] });
  assert.deepEqual(validateProvenance(mutable(memory)), memory);
  invalid(() => createProvenance({ ...model, references: ["invented-format"] }));
});

test("non-JSON input fails without invoking getters or silently losing values", () => {
  let invoked = false;
  const getter = { get value() { invoked = true; return 1; } };
  const cycle = {}; cycle.self = cycle;
  const sparse = Array(2);
  for (const value of [getter, cycle, sparse, new Date(), new Map(), () => {}, 1n, Symbol("x"), { omitted: undefined }]) invalid(() => node("a", { extensions: { "test:value": value } }));
  assert.equal(invoked, false);
});

test("standalone records reject self ancestry and duplicate references", () => {
  invalid(() => node("a", { revises: "a" }));
  invalid(() => node("a", { derivedFrom: ["a"] }));
  invalid(() => node("a", { derivedFrom: ["old", "old"] }));
  invalid(() => edge("e", "a", "b", { revises: "e" }));
  invalid(() => state("s", ["s"]));
  invalid(() => state("s", [], ["a", "a"]));
  assert.deepEqual(validateEdge(mutable(edge("e", "a", "b"))), edge("e", "a", "b"));
  assert.deepEqual(validateState(mutable(state("s"))), state("s"));
});

test("a complete history preserves opposing claims and semantic cycles", () => {
  const result = validateFieldSnapshot(snapshot());
  assert.equal(result.edges.length, 2);
  assert.ok(result.nodes.every((item) => item.status === "open" && item.confidence.value === null));
  assert.deepEqual(validateFieldSnapshot(mutable(result)), result);
  assert.throws(() => result.states.pop(), TypeError);
});

test("revisions, branches, and explicit multi-parent views retain their history", () => {
  const original = snapshot();
  const input = snapshot();
  input.nodes.push(node("a2", { revises: "a", derivedFrom: ["q"], status: "supported", confidence: { value: 0.6, basis: "human assessment" } }));
  input.states.push(state("left", ["s1"], ["q", "a2", "b"]), state("right", ["s1"], ["q", "a", "b"], ["ab", "ba"]), state("merge", ["left", "right"], ["q", "a", "a2", "b"], ["ab", "ba"]));
  input.states.reverse(); // Explicit references, not list or timestamp order.
  const result = validateFieldSnapshot(input);
  assert.equal(result.nodes.find((item) => item.id === "a").status, "open");
  assert.deepEqual(result.states.find((item) => item.id === "s1"), original.states[1]);
  assert.deepEqual(result.states.find((item) => item.id === "merge").parentStateIds, ["left", "right"]);
});

test("snapshots reject dangling, cross-field, wrong-type, and duplicate IDs", () => {
  const changes = [
    (s) => { s.nodes[0].fieldId = "other"; },
    (s) => { s.nodes.push(mutable(s.nodes[0])); },
    (s) => { s.edges[0].id = "a"; },
    (s) => { s.states[1].nodeIds.push("missing"); },
    (s) => { s.states[1].edgeIds.push("a"); },
    (s) => { s.states[1].parentStateIds = ["missing"]; },
    (s) => { s.states[1].nodeIds = ["a", "q"]; },
    (s) => { s.edges[0].to = "missing"; },
    (s) => { s.nodes.push(mutable(node("unused"))); }
  ];
  for (const change of changes) {
    const input = mutable(snapshot()); change(input);
    const before = JSON.stringify(input);
    invalid(() => validateFieldSnapshot(input));
    assert.equal(JSON.stringify(input), before);
  }
});

test("ancestry rejects cycles, nonempty/multiple roots, and same-state derivation", () => {
  for (const change of [
    (s) => { s.states[0].nodeIds = ["q"]; },
    (s) => { s.states.push(mutable(state("root2"))); },
    (s) => { s.states[1].parentStateIds = ["loop"]; s.states.push(mutable(state("loop", ["s1"]))); },
    (s) => { s.nodes[1].derivedFrom = ["q"]; },
    (s) => { s.nodes[1].revises = "ab"; }
  ]) { const input = mutable(snapshot()); change(input); invalid(() => validateFieldSnapshot(input)); }
});

test("a sibling cannot borrow a revision target without its parent ancestry", () => {
  const input = snapshot();
  input.nodes.push(node("a2", { revises: "a" }));
  input.states.push(state("unrelated", ["root"], ["a2"]));
  invalid(() => validateFieldSnapshot(input));
});

test("a new assessment may cite older omitted history without erasing it", () => {
  const input = snapshot();
  input.nodes.push(node("a2", { revises: "a" }));
  input.states.push(state("empty-view", ["s1"]), state("new-view", ["empty-view"], ["a2"]));
  assert.equal(validateFieldSnapshot(input).states.length, 4);
});
