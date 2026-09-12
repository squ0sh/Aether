# Local Field storage

Implemented 2026-09-11 in the v0.13.1 development tree. This is a library adapter,
not a new HTTP endpoint or a change to live chat. No existing conversation is
imported automatically. The application version and runtime flow are unchanged.

## Interface

`LocalFieldStore` is exported from `src/core/field-store.js`.

- `new LocalFieldStore({ root, maxBytes })`: optional settings. The default root
  is `fields/` under `AETHER_DATA_DIR`, or under the current working directory's
  `data/` when that variable is unset. Settings are resolved at construction.
- `save(snapshot, { requestId })`: publish a complete validated history. Returns
  `{ fieldId, revision, requestId, replayed }`. The caller supplies IDs and a
  unique request ID; retain the exact request payload for retries.
- `load(fieldId)`: returns `{ revision, snapshot, headStateIds }`, or `null` if
  absent. Snapshots and returned views are immutable. Reads create no directories.
- `exportSnapshot(fieldId)`: explicitly returns portable JSON text. It does not
  write an export file or transmit anything. Import by parsing that text and
  explicitly saving it in another store. Save receipts are local metadata and
  are not exported with Field records.
- `deleteField(fieldId, {requestId, expectedRevision, permission: true})`: explicitly
  deletes the entire local Field at the reviewed storage revision. Returns
  `{fieldId, revision, requestId, deleted: true, replayed}`. This is a library
  operation, not an exposed HTTP route or automatic conversation cascade.

## Explicit deletion

Review `load(fieldId)` before deletion and supply its exact `revision`. A changed
revision is rejected with `FIELD_CONFLICT`; missing permission is rejected with
`FIELD_PERMISSION_REQUIRED`. Deletion uses the same exclusive writer lock as saves
and never steals an interrupted writer's lock. Missing or corrupt Fields are not
silently deleted. Use a new request ID, distinct from prior save requests.

Publication atomically replaces the snapshot and save receipts with a version-2
deletion marker. The marker retains only a hashed Field ID, hashed deletion request
ID, storage revision, deletion flag, format version, and checksum—not record text,
provenance, or raw IDs. Hashes are not encryption and can reveal equality or be
guessed for predictable IDs. This minimal marker prevents stale saves and retries
from resurrecting content under the same ID. Do not remove it during routine cleanup.
`load`, export, and all saves for that ID now return `FIELD_DELETED`. There is no
undelete or same-ID reuse in this adapter; external copies in another store remain
outside this protection.

While holding the lock, deletion also removes this Field's adapter-named staging
files. Other Fields and unrelated files are untouched. Cleanup rejects nonregular
entries. `FIELD_DELETE_UNCERTAIN` means publication, staging cleanup, or directory
sync could not be confirmed. Retry with exactly the same ID, request ID, reviewed
revision, and permission; a published marker blocks saves even while cleanup is
pending. A retry completes cleanup and sync before acknowledging success.

Deletion is not secure media erasure. Backups, external exports, filesystem
snapshots, other stores, and already-returned in-memory/read responses are not
revoked. Those copies need separate handling. Deleting an entire Field is deliberate
history removal, not a normal revision. Per-record redaction and linked conversation
deletion remain unimplemented; no live conversation data is duplicated yet.

The filesystem adapter is separate from the platform-independent record module.
A `fileSystem` option exists for fault-injection tests; normal callers use the
default Node filesystem implementation. Other storage implementations can consume
the same validated snapshots without depending on this on-disk envelope.

## Saving and retry behavior

Each Field has one file containing its full retained snapshot, a monotonically
increasing storage revision, all save receipts, and a SHA-256 integrity checksum.
A storage revision counts accepted save requests; it is not a truth score or a
Field state ID. Head IDs are derived, preserving multiple branches without a winner.

Before writing, the adapter validates the snapshot and compares it to the last
saved history. Every old node, edge, and state must still exist byte-equivalently
under canonical JSON; object key ordering does not matter. Field extension
metadata also stays unchanged. Ordinary evolution adds new IDs, never changes or
deletes prior records. A stale full snapshot is rejected instead of dropping newer
work. Reload and explicitly incorporate that history; no merge is guessed.

Replaying a request ID with the same snapshot returns its original save revision
without writing another copy or rolling current history back. A different snapshot
with that ID is rejected. Array order is significant to the retry fingerprint;
object property order is not. Retrying an older request can return an older receipt;
call `load` separately to obtain the current state.

Publication uses a uniquely named sibling staging file, file flush, and atomic
rename of the complete envelope. POSIX directory sync is requested before
acknowledgement, including retries after uncertain publication. Windows lacks an
equivalent directory-sync guarantee in this adapter. This protects against partial
application writes on suitable local filesystems; it is not a universal guarantee
against hardware failure or arbitrary network-filesystem semantics. Only Linux
has been exercised here so far.

Readers see the old or new complete envelope and ignore staging files. Invalid
JSON, checksum failures, schema errors, and invalid receipt history are reported;
the store never replaces a corrupt Field with an empty one. Checksums detect
accidental damage, not forgery by someone able to rewrite the file and checksum.

## Writer ownership and recovery

An exclusive per-Field lock file protects cooperating writers across instances
and processes. Competing writes return `FIELD_LOCKED`; reads still work. Different
Fields use independent locks. No elapsed-time heuristic steals a lock.

A process that exits mid-save may leave its lock and staging file. Recovery is
deliberate: stop all writers using this storage root, confirm no writer remains,
inspect the published Field and preserve any recovery material, then move the
specific stale lock aside before retrying the original request. The lock's PID
and creation time are diagnostic hints, not sufficient proof that ownership has
ended. Never remove a lock solely because it looks old. There is no automatic
stale-lock cleanup or recovery endpoint in this increment.

`FIELD_WRITE_UNCERTAIN` means rename or its durability acknowledgement may have
completed. Retry the identical snapshot/request ID once ownership is available.
The receipt distinguishes an already-published save from one still needing to
publish. `FIELD_LOCK_RELEASE_FAILED` requires inspection: publication may have
completed, but safe ownership release failed.

Other notable errors: `FIELD_REQUEST_CONFLICT` (reused request ID),
`FIELD_CONFLICT` (attempted history replacement/removal), `FIELD_CORRUPT`,
`FIELD_TOO_LARGE`, `FIELD_UNSAFE_PATH`, and record validation's `INVALID_FIELD`.
Ordinary filesystem errors such as out-of-space before publication are preserved.

## Privacy, scope, and limits

Field IDs are opaque and mapped to SHA-256 filenames; they are not interpolated
as paths. Files are created with mode 0600 and the storage directory with 0700.
On POSIX, existing entries that expose group/other permission bits are rejected.
Symlink roots and Field entries are rejected. Configured parent directories and
the operating-system account remain trusted; this is not a sandbox against an
attacker controlling that account or those parents. On Windows, privacy also
depends on the configured directory's ACLs. Files are not encrypted by this adapter.

The default `data/fields/` path is covered by the project's existing data ignore
rule. A custom root must be excluded from version control separately. Exports
can contain private content and require an intentional caller action.

This first adapter rewrites and validates the complete history per save. Its
configurable default size budget is 16 MiB per envelope, including retry receipts.
It reports an error rather than pruning old history/receipts. This is a small-local-
store tradeoff, not a permanent limit on Aether; larger workloads can increase the
budget or use a later indexed adapter with equivalent correctness guarantees.

[Editing operations](FIELD-OPERATIONS.md) now construct complete proposals from
attributed changes or explicit multi-parent integration. Durable incremental commits,
per-record redaction, linked-content deletion, recovery tooling, and live
conversation integration remain separate follow-ups. In particular, do not start
duplicating private conversation content before linked-content deletion behavior
and inference-versus-persistence failure handling are implemented.

## Verification

`npm run test:field` covers records, editing operations, and persistence. Tests use generated temporary
data, never the user's models or conversations. Coverage includes reopening from
a separate process, process exit before publication, conflicting writers, retries,
stale updates, corrupted data, failed writes, lost acknowledgement, explicit
export/import, private permissions, symlink rejection, and path-like IDs.
