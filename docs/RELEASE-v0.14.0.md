# Aether v0.14.0

Release date: 2026-09-12.

## Included

- Portable Field records for questions, claims, relationships, provenance,
  uncertainty, revisions, and state ancestry.
- Local snapshot persistence with atomic publication, writer locks, save retry
  receipts, explicit export/import, and validation against lost history.
- Attributed editing and explicit branch integration without selecting a winner
  or erasing competing interpretations.
- Permission-gated whole-Field deletion at a reviewed revision, staging cleanup,
  and deletion markers that block stale saves from restoring deleted content.
- Completed inference is no longer retried through another model when subsequent
  conversation or measurement saving fails.
- Browser answers remain visible with warnings on saving failures or interrupted
  streams. A final completion event is required for success.
- Localhost-only server binding by default. Explicit `AETHER_HOST` overrides remain
  available; remote binding is unauthenticated and requires trusted access controls.

## Scope and remaining work

The existing llama.cpp/Ollama chat, routing, benchmarks, and operation protection
remain in place. Field APIs are libraries, not HTTP endpoints, and live conversation
content is not automatically copied into the Field. Linked conversation deletion,
per-record redaction, and opt-in chat integration remain future work. Local deletion
does not erase backups, exports, or underlying storage media securely.

Earlier Field documents refer to implementation in the v0.13.1 development tree;
those increments are included in this release. No resident training or autonomous
execution is introduced.

## Distribution and verification

`Aether-v0.14.0.zip` contains source, browser assets, tests, and documentation under
an `Aether-v0.14.0/` directory. It excludes private data, downloaded models, portable
runtimes, Git metadata, and development-agent configuration. Keep your existing
working installation and data; extract the release into a separate directory.

From the extracted directory, run `npm run check` and `npm test`, then `npm start`.
The source package contains no installed runtime or model. Configure those through
the existing setup flow or deliberately migrate your own installation assets.
