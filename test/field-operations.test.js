import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvenance } from "../src/core/field.js";
import { createField, applyFieldChange, integrateFieldStates, readFieldState } from "../src/core/field-operations.js";
import { LocalFieldStore } from "../src/core/field-store.js";

const provenance = createProvenance({ sourceType: "human", sourceId: "owner", method: "explicit contribution" });
const createdAt = "2026-09-11T00:00:00.000Z";
const initial = () => createField({ id: "field", initialStateId: "root", createdAt, provenance });
const command = (actions = [], overrides = {}) => ({ parentStateId: "root", stateId: "next", createdAt, provenance, actions, ...overrides });
const node = (id, kind = "question") => ({ type: "add-node", record: { id, kind, content: { format: "text/plain", text: `Content of ${id}` } } });
const edge = (id = "link") => ({ type: "add-edge", record: { id, from: "a", to: "b", relation: "contradicts" } });
const populated = () => applyFieldChange(initial(), command([node("a"), node("b", "hypothesis"), edge()]));
const revise = (type, targetId, record) => ({ type, targetId, record });
const integration = (overrides = {}) => ({ parentStateIds: ["left", "right"], stateId: "joined", createdAt, provenance, actions: [], ...overrides });
function branches() {
  let field = populated();
  for (const side of ["left", "right", "unselected"]) {
    const author = createProvenance({ sourceType: "human", sourceId: side, method: "independent review" });
    field = applyFieldChange(field, command([
      revise("revise-node", "b", { id: side, content: { format: "text/plain", text: `${side} explanation` } })
    ], { parentStateId: "next", stateId: `${side}-state`, provenance: author }));
  }
  return field;
}
const joinBranches = (field, overrides = {}) => integrateFieldStates(field, integration({ parentStateIds: ["left-state", "right-state"], ...overrides }));

test("integration unions selected membership without resolving competing revisions", () => {
  const original = branches();
  const field = joinBranches(original);
  const view = readFieldState(field, "joined");
  assert.deepEqual(view.state.parentStateIds, ["left-state", "right-state"]);
  assert.deepEqual(view.state.nodeIds, ["a", "b", "left", "right"]);
  assert.deepEqual(view.state.edgeIds, ["link"]);
  assert.deepEqual(field.nodes, original.nodes);
  assert.deepEqual(field.edges, original.edges);
  assert.deepEqual(field.states.slice(0, -1), original.states);
  for (const id of ["left", "right"]) {
    const claim = view.nodes.find((item) => item.id === id);
    assert.equal(claim.provenance.sourceId, id);
    assert.equal(claim.revises, "b");
    assert.equal(claim.confidence.value, null);
    assert.equal(claim.status, "open");
  }
  assert.equal(view.nodes.some((item) => item.id === "unselected"), false);
  assert.ok(field.nodes.some((item) => item.id === "unselected"));
  assert.throws(() => view.state.parentStateIds.pop(), TypeError);
});

test("integration can add an attributed synthesis and cross-branch disagreement", () => {
  const synthesis = node("synthesis", "inference");
  synthesis.record.derivedFrom = ["left", "right"];
  const field = joinBranches(branches(), { actions: [
    synthesis,
    { type: "add-edge", record: { id: "disagreement", from: "left", to: "right", relation: "contradicts" } },
    revise("revise-node", "right", { id: "reviewed-right", context: "Considered together" }),
    revise("revise-edge", "link", { id: "new-link", to: "synthesis" })
  ] });
  assert.deepEqual(field.nodes.find((item) => item.id === "synthesis").derivedFrom, ["left", "right"]);
  assert.deepEqual(field.edges.at(-2).provenance, provenance);
  assert.equal(field.nodes.at(-1).revises, "right");
  assert.equal(field.edges.at(-1).revises, "link");
  assert.equal(field.edges[0].to, "b");
});

test("integration rejects missing, duplicate, implicit, or invalid parent selections", () => {
  for (const parentStateIds of [[], ["left-state"], ["left-state", "left-state"], ["left-state", "missing"], ["left-state", "b"], ["left-state", ""], "all", null]) {
    assert.throws(() => joinBranches(branches(), { parentStateIds }), { code: "INVALID_FIELD_CHANGE" });
  }
  assert.throws(() => joinBranches(branches(), { parentStateId: "root" }));
  assert.throws(() => joinBranches(branches(), { stateId: "left-state" }));
  assert.throws(() => joinBranches(branches(), { actions: null }));
  assert.throws(() => joinBranches(branches(), { extensions: null }));
});

test("integration cannot borrow unselected history or same-batch revision targets", () => {
  const derived = node("synthesis", "inference");
  derived.record.derivedFrom = ["unselected"];
  for (const actions of [
    [revise("revise-node", "unselected", { id: "x" })],
    [derived],
    [{ type: "add-edge", record: { id: "bad-link", from: "left", to: "unselected", relation: "supports" } }],
    [node("x"), revise("revise-node", "x", { id: "y" })]
  ]) {
    const field = branches();
    const change = integration({ parentStateIds: ["left-state", "right-state"], actions });
    const before = JSON.stringify({ field, change });
    assert.throws(() => integrateFieldStates(field, change));
    assert.equal(JSON.stringify({ field, change }), before);
  }
});

test("integration supports historical, overlapping, and more than two parents explicitly", () => {
  const field = branches();
  const combined = joinBranches(field, { parentStateIds: ["next", "right-state", "left-state", "unselected-state"] });
  assert.deepEqual(combined.states.at(-1).nodeIds, ["a", "b", "right", "left", "unselected"]);
  assert.deepEqual(combined.states.at(-1).edgeIds, ["link"]);
  const continued = applyFieldChange(combined, command([node("follow-up")], { parentStateId: "joined", stateId: "continued" }));
  assert.deepEqual(continued.states.at(-1).nodeIds, ["a", "b", "right", "left", "unselected", "follow-up"]);
  assert.deepEqual(combined, joinBranches(field, { parentStateIds: ["next", "right-state", "left-state", "unselected-state"] }));
});

test("integration retains JSON and identity safeguards", () => {
  let called = false;
  const change = integration();
  Object.defineProperty(change, "actions", { get() { called = true; return []; } });
  assert.throws(() => integrateFieldStates(branches(), change));
  assert.equal(called, false);
  assert.throws(() => joinBranches(branches(), { actions: [node("joined")] }));
  assert.throws(() => joinBranches(branches(), { actions: [node("duplicate"), node("duplicate")] }));
});

test("integrated branches survive reopening and exact retry without losing other heads", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aether-field-integration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalFieldStore({ root });
  const original = branches();
  await store.save(original, { requestId: "branches" });
  const proposal = joinBranches(original);
  await store.save(proposal, { requestId: "integration" });
  const reopened = new LocalFieldStore({ root });
  const loaded = await reopened.load("field");
  assert.deepEqual(loaded.snapshot, proposal);
  assert.deepEqual(new Set(loaded.headStateIds), new Set(["joined", "unselected-state"]));
  assert.equal((await reopened.save(proposal, { requestId: "integration" })).replayed, true);
  const stale = applyFieldChange(original, command([], { parentStateId: "left-state", stateId: "stale" }));
  await assert.rejects(reopened.save(stale, { requestId: "stale" }), { code: "FIELD_CONFLICT" });
  assert.deepEqual((await reopened.load("field")).snapshot, proposal);
});

test("creates an empty detached Field with caller-supplied identity", () => {
  const field = initial();
  assert.deepEqual(field.states[0].nodeIds, []);
  assert.equal(field.states[0].id, "root");
  assert.equal(field.states[0].createdAt, createdAt);
  assert.ok(Object.isFrozen(field.states[0].provenance));
  assert.throws(() => createField({ id: "x", initialStateId: "root", createdAt, provenance, extensions: null }));
});

test("adds sourced questions and relationships atomically without resolving uncertainty", () => {
  const field = populated();
  const view = readFieldState(field, "next");
  assert.equal(view.nodes[0].kind, "question");
  assert.equal(view.nodes[1].kind, "hypothesis");
  assert.equal(view.nodes[1].confidence.value, null);
  assert.equal(view.nodes[1].status, "open");
  assert.deepEqual(view.edges[0].provenance, provenance);
  assert.deepEqual(readFieldState(field, "root").nodes, []);
  assert.throws(() => view.nodes.push({}), TypeError);
  assert.throws(() => { view.nodes[0].content.text = "changed"; }, TypeError);
});

test("batch edge order need not precede or follow its added endpoints", () => {
  assert.equal(applyFieldChange(initial(), command([edge(), node("a"), node("b")])).edges.length, 1);
});

test("node revisions retain the original and attribute the new contribution", () => {
  const old = populated();
  const author = createProvenance({ sourceType: "human", sourceId: "reviewer", method: "review" });
  const updated = applyFieldChange(old, command([revise("revise-node", "a", { id: "a2", context: "Reconsidered" })], {
    parentStateId: "next", stateId: "review", provenance: author, createdAt: "2026-09-11T01:00:00.000Z"
  }));
  assert.deepEqual(updated.nodes[0], old.nodes[0]);
  const revision = updated.nodes[2];
  assert.equal(revision.revises, "a");
  assert.deepEqual(revision.content, old.nodes[0].content);
  assert.deepEqual(revision.provenance, author);
  assert.equal(revision.createdAt, "2026-09-11T01:00:00.000Z");
  assert.deepEqual(readFieldState(updated, "review").state.nodeIds, ["a", "b", "a2"]);
  assert.equal(updated.edges[0].from, "a");
});

test("edge revisions require explicit retargeting and can have their own provenance", () => {
  const author = createProvenance({ sourceType: "tool", sourceId: "review-tool", method: "explicit review" });
  const updated = applyFieldChange(populated(), command([
    revise("revise-edge", "link", { id: "link2", from: "b", to: "a", provenance: author })
  ], { parentStateId: "next", stateId: "review" }));
  assert.equal(updated.edges[0].from, "a");
  assert.equal(updated.edges[1].from, "b");
  assert.equal(updated.edges[1].revises, "link");
  assert.deepEqual(updated.edges[1].provenance, author);
});

test("explicit historical parents create separate branches without dropping siblings", () => {
  const field = applyFieldChange(populated(), command([node("other")], { stateId: "branch" }));
  assert.deepEqual(readFieldState(field, "branch").state.nodeIds, ["other"]);
  assert.deepEqual(readFieldState(field, "next").state.nodeIds, ["a", "b"]);
  assert.equal(field.nodes.length, 3);
});

test("revision targets must have the right type and exist in parent ancestry", () => {
  for (const [parentStateId, type, targetId] of [["root", "revise-node", "a"], ["next", "revise-node", "link"], ["next", "revise-edge", "a"], ["next", "revise-node", "missing"]]) {
    assert.throws(() => applyFieldChange(populated(), command([revise(type, targetId, { id: "revision" })], { parentStateId, stateId: "review" })), { code: "INVALID_FIELD_CHANGE" });
  }
  assert.throws(() => applyFieldChange(initial(), command([node("a"), revise("revise-node", "a", { id: "a2" })])));
});

test("derivation retains the existing parent-history boundary", () => {
  const action = node("derived", "inference");
  action.record.derivedFrom = ["a"];
  assert.throws(() => applyFieldChange(initial(), command([node("a"), action])));
  const field = applyFieldChange(populated(), command([action], { parentStateId: "next", stateId: "derived-state" }));
  assert.deepEqual(field.nodes[2].derivedFrom, ["a"]);
});

test("IDs cannot collide across records, states, or within a batch", () => {
  for (const actions of [[node("root")], [node("next")], [node("a"), node("a")], [node("a"), node("b"), edge("a")]]) {
    assert.throws(() => applyFieldChange(initial(), command(actions)), { code: "INVALID_FIELD_CHANGE" });
  }
  assert.throws(() => applyFieldChange(populated(), command([], { stateId: "next" })));
});

test("rejects unknown commands and reserved record metadata", () => {
  for (const key of ["fieldId", "schemaVersion", "createdAt", "revises"]) {
    const action = node("a");
    action.record[key] = "unexpected";
    assert.throws(() => applyFieldChange(initial(), command([action])), { code: "INVALID_FIELD_CHANGE" });
  }
  assert.throws(() => applyFieldChange(initial(), command([{ ...node("a"), targetId: "x" }])));
  assert.throws(() => applyFieldChange(initial(), command([], { autoMerge: true })));
  assert.throws(() => applyFieldChange(initial(), command([{ type: "delete-node", record: { id: "a" } }])));
  assert.throws(() => applyFieldChange(initial(), command([], { extensions: null })));
});

test("invalid batches do not mutate inputs or partially publish records", () => {
  const field = initial();
  const change = command([node("a"), edge()]);
  const before = JSON.stringify({ field, change });
  assert.throws(() => applyFieldChange(field, change));
  assert.equal(JSON.stringify({ field, change }), before);
});

test("captures strict JSON without executing getters or stripping invalid input", () => {
  let called = false;
  const change = command();
  Object.defineProperty(change, "extra", { enumerable: true, get() { called = true; return 1; } });
  assert.throws(() => applyFieldChange(initial(), change));
  assert.equal(called, false);
  assert.throws(() => applyFieldChange(initial(), command([], { extra: undefined })));
});

test("explicit empty checkpoints and deterministic proposals are supported", () => {
  const field = populated();
  const change = command([], { parentStateId: "next", stateId: "checkpoint" });
  const next = applyFieldChange(field, change);
  assert.deepEqual(next, applyFieldChange(field, change));
  assert.deepEqual(next.states.at(-1).nodeIds, ["a", "b"]);
  assert.throws(() => readFieldState(next, "unknown"));
  assert.throws(() => applyFieldChange(field, command([], { parentStateId: "unknown" })));
});

test("prepared proposals persist, reopen, replay safely, and reject stale competing saves", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "aether-field-operations-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalFieldStore({ root });
  const base = initial();
  await store.save(base, { requestId: "initialize" });
  const proposal = applyFieldChange(base, command([node("a")]));
  await store.save(proposal, { requestId: "add-a" });
  const later = applyFieldChange(proposal, command([node("b")], { parentStateId: "next", stateId: "later" }));
  await store.save(later, { requestId: "add-b" });
  assert.equal((await store.save(proposal, { requestId: "add-a" })).replayed, true);
  const stale = applyFieldChange(base, command([node("other")], { stateId: "other-state" }));
  await assert.rejects(store.save(stale, { requestId: "stale" }), { code: "FIELD_CONFLICT" });
  assert.deepEqual((await new LocalFieldStore({ root }).load("field")).snapshot, later);
});
