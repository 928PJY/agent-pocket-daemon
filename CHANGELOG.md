# Changelog

All notable changes to `agent-pocket` (the Mac daemon) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
