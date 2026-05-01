# Changelog

All notable changes to `agent-pocket` (the Mac daemon) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `sync_request` command handler. On receipt, the daemon replays missed
  history (full or `since_seq`-filtered, per session) for every session
  in the union of phone cursors + locally-known sessions, then emits a
  `sync_complete` terminator carrying the per-session tail seqs. Phone
  uses the terminator to commit a side-staged batch in one transaction
  instead of rendering each backfilled message individually (issue #160).
  The capability is implemented but **not yet announced**:
  `SYNC_BOUNDARY` is appended to `CURRENT_PEER_CAPABILITIES` in a
  follow-up release after `agent-pocket-protocol@0.2.1` ships.

### Changed
- Bumped `agent-pocket-protocol` to `^0.2.0`. Brings in the `sync_request` /
  `sync_complete` types and the `SYNC_BOUNDARY` capability constant. No
  behavior change yet — daemon does not announce `SYNC_BOUNDARY` and has no
  handler; both arrive in the next release (Phase 2 of agent-pocket #160).
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
