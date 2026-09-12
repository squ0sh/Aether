import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { validateFieldSnapshot } from "./field.js";

export class FieldStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "FieldStoreError";
    this.code = code;
  }
}

const fail = (code, message, cause) => { throw new FieldStoreError(code, message, cause); };
const hash = (text) => createHash("sha256").update(text).digest("hex");
// Record objects may arrive with different key ordering; array ordering is kept.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function identifier(value) {
  if (typeof value !== "string" || !value.trim()) fail("FIELD_INVALID_ID", "A nonempty Field or request ID is required");
  return value;
}

function heads(snapshot) {
  const parents = new Set(snapshot.states.flatMap((state) => state.parentStateIds));
  return Object.freeze(snapshot.states.filter((state) => !parents.has(state.id)).map((state) => state.id));
}

function sameKeys(value, names) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key));
}

function validateEnvelope(envelope, fieldId) {
  try {
    if (!sameKeys(envelope, ["payload", "checksum"]) || hash(canonical(envelope.payload)) !== envelope.checksum) throw new Error("checksum mismatch");
    const payload = envelope.payload;
    if (payload?.formatVersion === 2) {
      if (!sameKeys(payload, ["formatVersion", "fieldKey", "revision", "deleted", "requestDigest"]) ||
          payload.fieldKey !== hash(fieldId) || payload.deleted !== true ||
          !Number.isSafeInteger(payload.revision) || payload.revision < 2 ||
          !/^[a-f0-9]{64}$/.test(payload.requestDigest)) throw new Error("invalid deletion marker");
      return payload;
    }
    if (!sameKeys(payload, ["formatVersion", "fieldId", "revision", "snapshot", "requests"]) || payload.formatVersion !== 1 || payload.fieldId !== fieldId) throw new Error("unsupported or mismatched envelope");
    const snapshot = validateFieldSnapshot(payload.snapshot);
    if (snapshot.id !== fieldId || !Number.isSafeInteger(payload.revision) || payload.revision < 1 || !Array.isArray(payload.requests) || payload.requests.length !== payload.revision) throw new Error("invalid revision history");
    const ids = new Set();
    payload.requests.forEach((request, index) => {
      if (!sameKeys(request, ["id", "digest", "revision"]) || typeof request.id !== "string" || !request.id.trim() || ids.has(request.id) || !/^[a-f0-9]{64}$/.test(request.digest) || request.revision !== index + 1) throw new Error("invalid request receipt");
      ids.add(request.id);
    });
    if (payload.requests.at(-1).digest !== hash(canonical(snapshot))) throw new Error("snapshot does not match latest receipt");
    return { ...payload, snapshot };
  } catch (error) {
    fail("FIELD_CORRUPT", "Field storage is invalid; it was not reset or repaired automatically", error);
  }
}

function assertExtension(previous, next) {
  if (canonical(previous.extensions) !== canonical(next.extensions)) fail("FIELD_CONFLICT", "Existing Field extensions cannot be silently changed");
  for (const group of ["nodes", "edges", "states"]) {
    const candidates = new Map(next[group].map((record) => [record.id, record]));
    for (const record of previous[group]) {
      if (!candidates.has(record.id) || canonical(candidates.get(record.id)) !== canonical(record)) fail("FIELD_CONFLICT", "Saving must retain every existing record unchanged; use a new revision ID");
    }
  }
}

// A small single-writer local adapter. Save publishes one complete history plus
// its retry receipts in one file. Core Field records remain storage-independent.
export class LocalFieldStore {
  constructor({ root = join(process.env.AETHER_DATA_DIR || join(process.cwd(), "data"), "fields"), maxBytes = 16 * 1024 * 1024, fileSystem = fs } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");
    this.root = resolve(root);
    this.maxBytes = maxBytes;
    this.io = fileSystem;
  }

  #paths(fieldId) {
    const key = hash(identifier(fieldId));
    return { file: join(this.root, `${key}.json`), lock: join(this.root, `${key}.lock`), key };
  }

  async #directory(create = false) {
    if (create) await this.io.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const stat = await this.io.lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("FIELD_UNSAFE_PATH", "Field storage root must be a real directory");
      if (process.platform !== "win32" && (stat.mode & 0o077)) fail("FIELD_UNSAFE_PATH", "Field storage root must be private to its owner (0700)");
      return true;
    } catch (error) {
      if (error.code === "ENOENT" && !create) return false;
      throw error;
    }
  }

  async #read(fieldId) {
    const { file } = this.#paths(fieldId);
    let handle;
    try {
      const stat = await this.io.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("FIELD_UNSAFE_PATH", "Field storage entry must be a regular file");
      handle = await this.io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || (process.platform !== "win32" && (opened.mode & 0o077))) fail("FIELD_UNSAFE_PATH", "Field storage file must be private to its owner (0600)");
      if (opened.size > this.maxBytes) fail("FIELD_TOO_LARGE", "Field exceeds this adapter's configured size budget");
      const text = await handle.readFile("utf8");
      if (Buffer.byteLength(text) > this.maxBytes) fail("FIELD_TOO_LARGE", "Field exceeds this adapter's configured size budget");
      let envelope;
      try { envelope = JSON.parse(text); }
      catch (error) { fail("FIELD_CORRUPT", "Field storage is not complete JSON; it was not reset", error); }
      return validateEnvelope(envelope, fieldId);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    } finally { await handle?.close(); }
  }

  async load(fieldId) {
    identifier(fieldId);
    if (!await this.#directory()) return null;
    const payload = await this.#read(fieldId);
    if (payload?.deleted) fail("FIELD_DELETED", "This Field was explicitly deleted; its ID cannot be reused in this store");
    return payload ? Object.freeze({ revision: payload.revision, snapshot: payload.snapshot, headStateIds: heads(payload.snapshot) }) : null;
  }

  async exportSnapshot(fieldId) {
    const saved = await this.load(fieldId);
    if (!saved) fail("FIELD_NOT_FOUND", "Field does not exist");
    // Explicit caller operation; returns text, never uploads or writes an export.
    return canonical(saved.snapshot) + "\n";
  }

  async #syncDirectory() {
    // Windows does not offer equivalent directory-fsync through this interface.
    if (process.platform === "win32") return;
    const handle = await this.io.open(this.root, constants.O_RDONLY);
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  async save(input, { requestId } = {}) {
    // Capture before the first await so callers cannot change pending writes.
    const snapshot = validateFieldSnapshot(input);
    identifier(requestId);
    return this.#mutate(snapshot.id, requestId, snapshot);
  }

  async deleteField(fieldId, { requestId, expectedRevision, permission } = {}) {
    identifier(fieldId);
    identifier(requestId);
    if (permission !== true) fail("FIELD_PERMISSION_REQUIRED", "Explicit permission is required to delete an entire Field");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail("FIELD_CONFLICT", "Deletion requires the exact reviewed storage revision");
    return this.#mutate(fieldId, requestId, null, expectedRevision);
  }

  async #removeStaging(key) {
    // Only this Field's adapter-generated staging names, never other Fields.
    const pattern = new RegExp(`^\\.${key}\\.[a-f0-9-]{36}\\.incoming$`);
    for (const name of await this.io.readdir(this.root)) {
      if (!pattern.test(name)) continue;
      const path = join(this.root, name);
      const stat = await this.io.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("FIELD_UNSAFE_PATH", "Deletion staging cleanup requires regular files");
      await this.io.unlink(path);
    }
  }

  async #mutate(fieldId, requestId, snapshot, expectedRevision) {
    const digest = hash(canonical(snapshot));
    const { file, lock, key } = this.#paths(fieldId);
    await this.#directory(true);
    let lockHandle;
    try { lockHandle = await this.io.open(lock, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") fail("FIELD_LOCKED", "Another writer or an interrupted writer owns this Field; no lock was stolen", error);
      throw error;
    }
    const temporary = join(this.root, `.${key}.${randomUUID()}.incoming`);
    let temporaryHandle;
    let publishAttempted = false;
    try {
      await lockHandle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n");
      const previous = await this.#read(fieldId);
      if (previous?.deleted) {
        if (snapshot) fail("FIELD_DELETED", "Deleted Field IDs cannot be restored by saves or old retries");
        if (previous.requestDigest !== hash(requestId) || previous.revision !== expectedRevision + 1) fail("FIELD_REQUEST_CONFLICT", "Retry deletion with its original request ID and reviewed revision");
        publishAttempted = true;
        await this.#removeStaging(key);
        await this.#syncDirectory();
        return Object.freeze({ fieldId, revision: previous.revision, requestId, deleted: true, replayed: true });
      }
      if (!snapshot) {
        if (!previous) fail("FIELD_NOT_FOUND", "Field does not exist");
        if (previous.revision !== expectedRevision) fail("FIELD_CONFLICT", "Field changed since review; review it again before deleting");
        if (previous.requests.some((request) => request.id === requestId)) fail("FIELD_REQUEST_CONFLICT", "Deletion needs a new request ID");
      }
      const receipt = snapshot && previous?.requests.find((request) => request.id === requestId);
      if (receipt) {
        if (receipt.digest !== digest) fail("FIELD_REQUEST_CONFLICT", "This request ID was already used with a different snapshot");
        // A previous attempt may have renamed successfully but failed to sync
        // its directory. Retry that barrier before acknowledging the receipt.
        publishAttempted = true;
        await this.#syncDirectory();
        return Object.freeze({ fieldId: snapshot.id, revision: receipt.revision, requestId, replayed: true });
      }
      if (previous && snapshot) assertExtension(previous.snapshot, snapshot);
      const revision = (previous?.revision || 0) + 1;
      const payload = snapshot
        ? { formatVersion: 1, fieldId, revision, snapshot, requests: [...(previous?.requests || []), { id: requestId, digest, revision }] }
        : { formatVersion: 2, fieldKey: key, revision, deleted: true, requestDigest: hash(requestId) };
      const encoded = JSON.stringify({ payload, checksum: hash(canonical(payload)) }) + "\n";
      if (Buffer.byteLength(encoded) > this.maxBytes) fail("FIELD_TOO_LARGE", "Field exceeds this adapter's configured size budget");
      temporaryHandle = await this.io.open(temporary, "wx", 0o600);
      await temporaryHandle.writeFile(encoded);
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = null;
      publishAttempted = true;
      await this.io.rename(temporary, file);
      if (!snapshot) await this.#removeStaging(key);
      await this.#syncDirectory();
      return Object.freeze({ fieldId, revision, requestId, replayed: false, ...(!snapshot ? { deleted: true } : {}) });
    } catch (error) {
      if (publishAttempted) fail(snapshot ? "FIELD_WRITE_UNCERTAIN" : "FIELD_DELETE_UNCERTAIN", "Publication or cleanup may have completed; retry the identical operation with the same request ID", error);
      throw error;
    } finally {
      // A crashed process leaves its lock and possibly staging data. Readers
      // ignore staging files; operators must confirm the writer is gone before
      // moving a stale lock aside. Never automatically steal a timed-out lock.
      try {
        await temporaryHandle?.close();
        await this.io.rm(temporary, { force: true });
      } finally {
        await lockHandle.close();
        try { await this.io.unlink(lock); }
        catch (error) { fail("FIELD_LOCK_RELEASE_FAILED", "A save may have completed but its lock could not be released; inspect before retrying", error); }
      }
    }
  }
}
