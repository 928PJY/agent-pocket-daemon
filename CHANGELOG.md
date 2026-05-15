# Changelog

All notable changes to `agent-pocket` (the Mac daemon) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `agent-pocket dump-history <sessionId>` CLI subcommand. Prints every
  history row in seq order with `[i, seq, role, sdkUuid_prefix, content_preview]`
  columns — useful as a cross-check oracle against the phone's in-memory
  order when triaging "messages out of order" reports (companion to
  phone-side `[OrderFull]` diagnostic dump).
- `sync_request` command handler. On receipt, the daemon replays missed
  history (full or `since_seq`-filtered, per session) for every session
  in the union of phone cursors + locally-known sessions, then emits a
  `sync_complete` terminator carrying the per-session tail seqs. Phone
  uses the terminator to commit a side-staged batch in one transaction
  instead of rendering each backfilled message individually (issue #160).

### Fixed
- `getSessionHistory` now sorts the returned message array by seq after
  seq stamping (both `SessionDiscovery` and `CodexDiscovery`). The seq
  allocator hands out IDs in chronological order on first parse, but on
  re-parses any row whose timestamp is older than the current allocator
  tail (subagent backfill, late arrivals, codex injected echoes) gets a
  fresh high seq — its timestamp says "old", its seq says "newest". Without
  the final sort, daemon-side history page disagrees with the seq it just
  assigned, so the phone (which sorts by seq) sees a different sequence
  than the daemon thinks it sent.

### Changed
- Bumped `agent-pocket-protocol` to `^0.2.1`. 0.2.1 appends
  `SYNC_BOUNDARY` to `CURRENT_PEER_CAPABILITIES`, so this build now
  announces the capability in `peer_hello` — phones gating on
  `peerCapabilities.has(SYNC_BOUNDARY)` will start using `sync_request`.
- Switched wire-protocol source from the bundled `src/shared/` copy to the
  published [`agent-pocket-protocol`](https://www.npmjs.com/package/agent-pocket-protocol)
  npm package. `VERSION` moved to `src/version.ts`. No behavioral change — both
  ends already agreed on the same constants byte-for-byte.

## [0.1.0] - 2026-04-30

### Added
- Initial public release of the Agent Pocket daemon.
- Observer mode (tail Claude session JSONL, mediate permission hooks) and
  controller mode (own the session via Claude Agent SDK `query()`).
- Relay client with E2E encrypted channel, peer capability negotiation, and
  offline message buffering.
- LAN pairing via Bonjour for first-time setup without the relay.
- CLI: `start`, `stop`, `restart`, `status`, `logs`, `pair`, `sessions`,
  `panic`.
