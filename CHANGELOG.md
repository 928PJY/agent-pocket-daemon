# Changelog

All notable changes to `agent-pocket` (the Mac daemon) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **HISTORY_CURSOR_MS — timestamp-based history cursor** (PR #77). Daemon
  side of the cursor switch from `session_seq` to a normalized epoch-ms
  timestamp. Activates only when peer announces `history.cursor_ms`; legacy
  seq path is unchanged. Requires `agent-pocket-protocol@^0.8.0`.
  - `getSessionHistory` (both `SessionDiscovery` and `CodexDiscovery`)
    assigns `parseIndex` + `tsMs` to every row. Missing-ts rows use the
    prev-row's `tsMs + 1` so they can't float to head or tail. Final sort
    is `(tsMs ASC, parseIndex ASC)`. Wire `timestamp` is re-encoded from
    the normalized `tsMs` so the phone can use it verbatim as the next
    `since_ms`.
  - `HistoryPage` gains `tailMs` — the FILTERED-SET tail (not page tail).
    Verify/divergence cursors must reflect "everything we can deliver"
    independent of pagination; a page tail would lie for offset>0
    requests and for parent-window pagination where `pageMessages` omits
    the actual newest filtered row.
  - `getSessionHistory` filter precedence: `sinceMs` > `sinceSeq` > `since`.
  - `sendSessionHistory` returns `{ tailSeq?, tailMs? }` and threads
    `sinceMs` end-to-end. Wire event carries `tail_ms` alongside `tail_seq`.
  - `handleGetHistory` forwards `command.since_ms`; `handleSyncRequest`
    reads `command.known_ms` and prefers it over `known_seqs`, populates
    `last_ms` in `delivered[]` and `session_history_done`.
  - `handleVerifyHistory` prefers phone-sent `tail_ms` over `tail_seq`
    when comparing. After daemon-side reshuffles (subagent ts anchoring)
    the allocator hands out new seqs to back-dated rows, so phone seq
    drifts permanently and seq-based divergence loops on every reconnect.
    `tail_ms` is stable because wire timestamp is re-encoded from the
    normalized `tsMs`. Adds `tail_ms_mismatch` reason variant.
  - Subagent ts anchoring: subagent rows are anchored to the spawning
    Task tool_use's ts on the main thread, so panels sort adjacent to
    where they were invoked instead of using their own JSONL ts (which
    is wall-clock from inside the subagent run, often minutes off).
  - `agent-pocket dump-history` now accepts `--limit / --offset /
    --since-ms` and emits `ts/tool/agentId` columns, matching what
    phone-side `[OrderFull]` shows.

  Test coverage: new `test/history-order-invariants.test.ts` (9 cases)
  asserts determinism, total-order, missing-ts placement, tailMs identity
  across page windows, `since_ms` idempotence + strict-`>` semantics,
  subagent anchoring, and `hasMore` head-inclusion. Canary-verified:
  reverting `tailMs` to `pageMessages[last]` fails the identity test.

### Added (legacy)
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
