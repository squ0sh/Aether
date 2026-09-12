import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LocalFieldStore } from "../src/core/field-store.js";
import { createNode, createState, createProvenance } from "../src/core/field.js";

const provenance = createProvenance({ sourceType: "human", sourceId: "test-owner", method: "explicit test input" });
const base = (id, fieldId = "test-field") => ({ id, fieldId, createdAt: "2026-09-11T00:00:00.000Z", provenance });
function initial(id = "test-field") {
  return { schemaVersion: 1, id, extensions: { "test:label": "portable" }, nodes: [], edges: [], states: [createState(base("root", id))] };
}
function expanded() {
  const snapshot = initial();
  snapshot.nodes.push(createNode({ ...base("question"), kind: "question", content: { format: "text/plain", text: "What would distinguish these explanations?" } }));
  snapshot.states.push(createState({ ...base("next"), parentStateIds: ["root"], nodeIds: ["question"] }));
  return snapshot;
}
const key = (id = "test-field") => createHash("sha256").update(id).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const deletion = (overrides = {}) => ({ requestId: "delete-sensitive-request", expectedRevision: 1, permission: true, ...overrides });

test("explicit Field deletion removes content and blocks old saves after reopening", async (context) => {
  const { store, root, file } = await fixture(context);
  const snapshot = expanded();
  await store.save(snapshot, { requestId: "original-sensitive-request" });
  const result = await store.deleteField("test-field", deletion());
  assert.equal(result.deleted, true);
  assert.equal(result.revision, 2);
  const raw = await fs.readFile(file, "utf8");
  for (const content of ["test-field", "test-owner", "What would distinguish", "original-sensitive-request", "delete-sensitive-request"]) assert.equal(raw.includes(content), false);
  const reopened = new LocalFieldStore({ root });
  await assert.rejects(reopened.load("test-field"), { code: "FIELD_DELETED" });
  await assert.rejects(reopened.exportSnapshot("test-field"), { code: "FIELD_DELETED" });
  for (const requestId of ["original-sensitive-request", "new-request"]) await assert.rejects(reopened.save(snapshot, { requestId }), { code: "FIELD_DELETED" });
  assert.equal((await reopened.deleteField("test-field", deletion())).replayed, true);
  await assert.rejects(reopened.deleteField("test-field", deletion({ requestId: "different" })), { code: "FIELD_REQUEST_CONFLICT" });
  await assert.rejects(reopened.deleteField("test-field", deletion({ expectedRevision: 2 })), { code: "FIELD_REQUEST_CONFLICT" });
});

test("deletion requires permission, a reviewed current revision, and a new request ID", async (context) => {
  const { store } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  await assert.rejects(store.deleteField("test-field", deletion({ permission: false })), { code: "FIELD_PERMISSION_REQUIRED" });
  for (const expectedRevision of [0, null, 1.5, 2]) await assert.rejects(store.deleteField("test-field", deletion({ expectedRevision })), { code: "FIELD_CONFLICT" });
  await assert.rejects(store.deleteField("test-field", deletion({ requestId: "one" })), { code: "FIELD_REQUEST_CONFLICT" });
  await store.save(expanded(), { requestId: "two" });
  await assert.rejects(store.deleteField("test-field", deletion()), { code: "FIELD_CONFLICT" });
  assert.deepEqual((await store.load("test-field")).snapshot, expanded());
  await assert.rejects(store.deleteField("absent", deletion()), { code: "FIELD_NOT_FOUND" });
});

test("deletion cleans only matching staging files and leaves other Fields intact", async (context) => {
  const { store, root } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  await store.save(initial("other"), { requestId: "other" });
  const staging = `.${key()}.12345678-1234-1234-1234-123456789abc.incoming`;
  await fs.writeFile(join(root, staging), "private interrupted snapshot", { mode: 0o600 });
  await fs.writeFile(join(root, "unrelated.incoming"), "other data", { mode: 0o600 });
  await store.deleteField("test-field", deletion());
  assert.equal((await fs.readdir(root)).includes(staging), false);
  assert.equal(await fs.readFile(join(root, "unrelated.incoming"), "utf8"), "other data");
  assert.deepEqual((await store.load("other")).snapshot, initial("other"));
});

test("deletion refuses interrupted-writer locks and corrupt storage", async (context) => {
  const { store, lock, file } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  await fs.writeFile(lock, "interrupted", { mode: 0o600 });
  await assert.rejects(store.deleteField("test-field", deletion()), { code: "FIELD_LOCKED" });
  await fs.unlink(lock);
  await fs.writeFile(file, "broken", { mode: 0o600 });
  await assert.rejects(store.deleteField("test-field", deletion()), { code: "FIELD_CORRUPT" });
  assert.equal(await fs.readFile(file, "utf8"), "broken");
});

for (const afterRename of [false, true]) {
  test(`deletion publication failure ${afterRename ? "after" : "before"} rename retries safely`, async (context) => {
    const { store, root } = await fixture(context);
    await store.save(initial(), { requestId: "one" });
    const faulty = new LocalFieldStore({ root, fileSystem: { ...fs, async rename(...args) {
      if (afterRename) await fs.rename(...args);
      throw new Error("simulated lost publication");
    } } });
    await assert.rejects(faulty.deleteField("test-field", deletion()), { code: "FIELD_DELETE_UNCERTAIN" });
    if (afterRename) await assert.rejects(store.load("test-field"), { code: "FIELD_DELETED" });
    else assert.deepEqual((await store.load("test-field")).snapshot, initial());
    const retried = await store.deleteField("test-field", deletion());
    assert.equal(retried.replayed, afterRename);
    await assert.rejects(store.save(initial(), { requestId: "one" }), { code: "FIELD_DELETED" });
  });
}

test("failed deletion staging cleanup stays uncertain and is retried", async (context) => {
  const { store, root } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  const staging = join(root, `.${key()}.12345678-1234-1234-1234-123456789abc.incoming`);
  await fs.writeFile(staging, "private staging", { mode: 0o600 });
  const faulty = new LocalFieldStore({ root, fileSystem: { ...fs, async unlink(path) {
    if (path === staging) throw new Error("cleanup blocked");
    return fs.unlink(path);
  } } });
  await assert.rejects(faulty.deleteField("test-field", deletion()), { code: "FIELD_DELETE_UNCERTAIN" });
  await assert.rejects(store.save(initial(), { requestId: "one" }), { code: "FIELD_DELETED" });
  assert.equal((await store.deleteField("test-field", deletion())).replayed, true);
  await assert.rejects(fs.stat(staging), { code: "ENOENT" });
});
async function fixture(context, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), "aether-field-store-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = join(directory, "fields");
  return { directory, root, file: join(root, `${key()}.json`), lock: join(root, `${key()}.lock`), store: new LocalFieldStore({ root, ...options }) };
}

test("Field saves and reopens complete history with private storage", async (context) => {
  const { store, root, file } = await fixture(context);
  assert.equal(await store.load("test-field"), null);
  const first = await store.save(initial(), { requestId: "initialize" });
  assert.equal(first.revision, 1);
  await store.save(expanded(), { requestId: "question" });
  const loaded = await new LocalFieldStore({ root }).load("test-field");
  assert.equal(loaded.revision, 2);
  assert.deepEqual(loaded.snapshot, expanded());
  assert.deepEqual(loaded.headStateIds, ["next"]);
  assert.equal(loaded.snapshot.nodes[0].confidence.value, null);
  assert.throws(() => loaded.snapshot.nodes.pop(), TypeError);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await fs.readdir(root), [`${key()}.json`]);
});

test("a separate Node process can reopen a Field without any model", async (context) => {
  const { store, root } = await fixture(context);
  await store.save(expanded(), { requestId: "save" });
  const script = `import { LocalFieldStore } from ${JSON.stringify(new URL("../src/core/field-store.js", import.meta.url).href)};
const result = await new LocalFieldStore({ root: process.argv[1] }).load("test-field");
console.log(JSON.stringify(result));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, root], { timeout: 5000 });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.snapshot, expanded());
  assert.deepEqual(result.headStateIds, ["next"]);
});

test("process exit before publication leaves readable history and a recovery lock", async (context) => {
  const { store, root, lock } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  const script = `import * as fs from "node:fs/promises";
import { LocalFieldStore } from ${JSON.stringify(new URL("../src/core/field-store.js", import.meta.url).href)};
const store = new LocalFieldStore({ root: process.argv[1], fileSystem: { ...fs, rename: async () => process.exit(0) } });
await store.save(${JSON.stringify(expanded())}, { requestId: "interrupted" });`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, root], { timeout: 5000 });
  assert.deepEqual((await store.load("test-field")).snapshot, initial());
  assert.ok((await fs.readdir(root)).some((name) => name.endsWith(".incoming")));
  assert.ok(await fs.stat(lock));
  await assert.rejects(store.save(expanded(), { requestId: "interrupted" }), { code: "FIELD_LOCKED" });
});

test("retry receipts survive restart and an old retry cannot roll history back", async (context) => {
  const { store, root, file } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  await store.save(expanded(), { requestId: "two" });
  const before = await fs.readFile(file, "utf8");
  const retry = await new LocalFieldStore({ root }).save(initial(), { requestId: "one" });
  assert.deepEqual(retry, { fieldId: "test-field", revision: 1, requestId: "one", replayed: true });
  assert.equal(await fs.readFile(file, "utf8"), before);
  await assert.rejects(store.save(expanded(), { requestId: "one" }), { code: "FIELD_REQUEST_CONFLICT" });
  assert.equal((await store.load("test-field")).revision, 2);
});

test("retry fingerprint ignores object-key ordering without losing extension data", async (context) => {
  const { store } = await fixture(context);
  const data = expanded();
  await store.save(data, { requestId: "same" });
  const reordered = Object.fromEntries(Object.entries(data).reverse());
  assert.equal((await store.save(reordered, { requestId: "same" })).replayed, true);
});

test("saving rejects changed or removed history and stale updates", async (context) => {
  const { store, file } = await fixture(context);
  await store.save(expanded(), { requestId: "one" });
  const before = await fs.readFile(file, "utf8");
  const modified = clone(expanded());
  modified.nodes[0].content.text = "silently replaced";
  await assert.rejects(store.save(modified, { requestId: "change" }), { code: "FIELD_CONFLICT" });
  await assert.rejects(store.save(initial(), { requestId: "stale" }), { code: "FIELD_CONFLICT" });
  const metadata = clone(expanded()); metadata.extensions["test:label"] = "changed";
  await assert.rejects(store.save(metadata, { requestId: "metadata" }), { code: "FIELD_CONFLICT" });
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("writers exclude each other while readers see the last complete save", async (context) => {
  const { store, root } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  let reached, finish;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const released = new Promise((resolve) => { finish = resolve; });
  const writer = new LocalFieldStore({ root, fileSystem: { ...fs, rename: async (...args) => { reached(); await released; return fs.rename(...args); } } });
  const saving = writer.save(expanded(), { requestId: "two" });
  try {
    await waiting;
    await assert.rejects(store.save(expanded(), { requestId: "three" }), { code: "FIELD_LOCKED" });
    assert.deepEqual((await store.load("test-field")).snapshot, initial());
  } finally { finish(); await saving; }
  assert.deepEqual((await store.load("test-field")).snapshot, expanded());
});

test("save captures caller data before yielding", async (context) => {
  const { store } = await fixture(context);
  const input = clone(expanded());
  const saving = store.save(input, { requestId: "one" });
  input.nodes[0].content.text = "modified after invocation";
  await saving;
  assert.deepEqual((await store.load("test-field")).snapshot, expanded());
});

test("a failed staging write leaves the previous save intact and releases ownership", async (context) => {
  const { store, root } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  const broken = new LocalFieldStore({ root, fileSystem: { ...fs, open: async (path, ...args) => {
    if (String(path).endsWith(".incoming")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return fs.open(path, ...args);
  } } });
  await assert.rejects(broken.save(expanded(), { requestId: "two" }), { code: "ENOSPC" });
  assert.deepEqual((await store.load("test-field")).snapshot, initial());
  assert.deepEqual(await fs.readdir(root), [`${key()}.json`]);
  await store.save(expanded(), { requestId: "two" });
});

test("failed publication is retryable without a partial snapshot", async (context) => {
  const { store, root } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  const broken = new LocalFieldStore({ root, fileSystem: { ...fs, rename: async () => { throw new Error("publication failed"); } } });
  await assert.rejects(broken.save(expanded(), { requestId: "two" }), { code: "FIELD_WRITE_UNCERTAIN" });
  assert.deepEqual((await store.load("test-field")).snapshot, initial());
  await store.save(expanded(), { requestId: "two" });
  assert.equal((await store.load("test-field")).revision, 2);
});

test("a lost acknowledgement after rename replays instead of saving twice", async (context) => {
  const { store, root } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  const uncertain = new LocalFieldStore({ root, fileSystem: { ...fs, rename: async (...args) => { await fs.rename(...args); throw new Error("lost acknowledgement"); } } });
  await assert.rejects(uncertain.save(expanded(), { requestId: "two" }), { code: "FIELD_WRITE_UNCERTAIN" });
  assert.equal((await store.save(expanded(), { requestId: "two" })).replayed, true);
  assert.equal((await store.load("test-field")).revision, 2);
});

test("directory-sync failure stays uncertain until a healthy retry", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX directory sync");
  const { store, root } = await fixture(context);
  const uncertain = new LocalFieldStore({ root, fileSystem: { ...fs, open: async (path, ...args) => {
    if (path === root) return { sync: async () => { throw new Error("sync failed"); }, close: async () => {} };
    return fs.open(path, ...args);
  } } });
  await assert.rejects(uncertain.save(initial(), { requestId: "one" }), { code: "FIELD_WRITE_UNCERTAIN" });
  await assert.rejects(uncertain.save(initial(), { requestId: "one" }), { code: "FIELD_WRITE_UNCERTAIN" });
  assert.equal((await store.save(initial(), { requestId: "one" })).replayed, true);
  assert.equal((await store.load("test-field")).revision, 1);
});

test("corrupt JSON and checksum mismatches are reported, never overwritten", async (context) => {
  const { store, file } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  const original = await fs.readFile(file, "utf8");
  const damaged = JSON.parse(original); damaged.payload.revision = 99;
  for (const text of [original.slice(0, 50), JSON.stringify(damaged)]) {
    await fs.writeFile(file, text);
    await assert.rejects(store.load("test-field"), { code: "FIELD_CORRUPT" });
    await assert.rejects(store.save(expanded(), { requestId: "two" }), { code: "FIELD_CORRUPT" });
    assert.equal(await fs.readFile(file, "utf8"), text);
  }
});

test("orphan staging is ignored and interrupted-writer locks are never stolen", async (context) => {
  const { store, root, lock } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  const orphan = join(root, ".abandoned.incoming");
  await fs.writeFile(orphan, "incomplete", { mode: 0o600 });
  await fs.writeFile(lock, '{"pid":0}', { mode: 0o600 });
  assert.deepEqual((await store.load("test-field")).snapshot, initial());
  await assert.rejects(store.save(expanded(), { requestId: "two" }), { code: "FIELD_LOCKED" });
  assert.equal(await fs.readFile(orphan, "utf8"), "incomplete");
  assert.equal(await fs.readFile(lock, "utf8"), '{"pid":0}');
});

test("explicit export and import to another store preserve all Field records", async (context) => {
  const { store, directory } = await fixture(context);
  await store.save(expanded(), { requestId: "one" });
  const exported = await store.exportSnapshot("test-field");
  const destination = new LocalFieldStore({ root: join(directory, "imported") });
  await destination.save(JSON.parse(exported), { requestId: "import" });
  assert.deepEqual((await destination.load("test-field")).snapshot, expanded());
  assert.equal(await destination.exportSnapshot("test-field"), exported);
  await assert.rejects(store.exportSnapshot("missing"), { code: "FIELD_NOT_FOUND" });
});

test("opaque Field IDs cannot escape the configured directory", async (context) => {
  const { store, root, directory } = await fixture(context);
  const id = "../../outside/field";
  await store.save(initial(id), { requestId: "../../request" });
  assert.deepEqual(await fs.readdir(directory), ["fields"]);
  assert.deepEqual(await fs.readdir(root), [`${key(id)}.json`]);
  assert.equal((await store.load(id)).snapshot.id, id);
  await assert.rejects(store.load(" "), { code: "FIELD_INVALID_ID" });
});

test("symlink storage entries and roots are rejected", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX symlink fixture");
  const { store, root, directory, file } = await fixture(context);
  const outside = join(directory, "outside.json");
  await fs.writeFile(outside, "untouched", { mode: 0o600 });
  await fs.mkdir(root, { mode: 0o700 });
  await fs.symlink(outside, file);
  await assert.rejects(store.load("test-field"), { code: "FIELD_UNSAFE_PATH" });
  await assert.rejects(store.save(initial(), { requestId: "one" }), { code: "FIELD_UNSAFE_PATH" });
  const alias = join(directory, "alias");
  await fs.symlink(root, alias);
  await assert.rejects(new LocalFieldStore({ root: alias }).save(initial(), { requestId: "one" }), { code: "FIELD_UNSAFE_PATH" });
  assert.equal(await fs.readFile(outside, "utf8"), "untouched");
});

test("size budgets and invalid snapshots fail without destroying saved data", async (context) => {
  const { store, root, file } = await fixture(context);
  await store.save(initial(), { requestId: "one" });
  const original = await fs.readFile(file, "utf8");
  const limited = new LocalFieldStore({ root, maxBytes: Buffer.byteLength(original) + 10 });
  await assert.rejects(limited.save(expanded(), { requestId: "two" }), { code: "FIELD_TOO_LARGE" });
  const malformed = expanded(); malformed.states.pop();
  await assert.rejects(store.save(malformed, { requestId: "bad" }), { code: "INVALID_FIELD" });
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.deepEqual(await fs.readdir(root), [`${key()}.json`]);
});
