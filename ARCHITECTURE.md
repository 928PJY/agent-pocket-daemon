# Architecture

This is a high-level map of how the daemon is organized internally and what happens during a typical session. If you're trying to figure out *where* something belongs in the code, start here.

## 30-second summary

The daemon is a long-running Node.js process on the user's Mac. It does three things:

1. **Discovers** Claude Code sessions running anywhere on the machine.
2. **Bridges** each session to the user's phone over an end-to-end encrypted channel — either through a public relay server, or via a direct LAN connection.
3. **Mediates permission requests** — when Claude wants to run a tool, the daemon intercepts via Claude's hook system, forwards the request to the phone, and returns the user's decision.

Everything else (pairing, UX, retry, observation, capability negotiation) is in service of those three things.

## Component layout

```
                       ┌─────────────────────┐
                       │      cli.ts         │  argv → subcommand handlers
                       └──────────┬──────────┘
                                  │ (one of: start | stop | pair | logs | ...)
                                  ▼
                       ┌─────────────────────┐
                       │     index.ts        │  daemon main loop, signal handling,
                       │                     │  module wiring
                       └──┬──────────────┬───┘
                          │              │
            ┌─────────────┘              └────────────┐
            ▼                                          ▼
   ┌───────────────────┐                    ┌────────────────────┐
   │  discovery/       │  finds Claude       │  hooks/            │  HTTP server that
   │  session-discovery│  sessions           │  hook-server       │  Claude calls back
   └────────┬──────────┘                    └──────────┬─────────┘
            │                                          │
            │   pid files, JSONL paths,                │  PreToolUse +
            │   workspace dirs                         │  PermissionRequest
            ▼                                          ▼
   ┌────────────────────────────────────────────────────────┐
   │                  sessions/session-manager              │
   │  one Session per Claude PID, two modes:                │
   │   - Observer: tails JSONL, pty-injects messages        │
   │   - Controller: owns the session via Claude Agent SDK  │
   └────────┬────────────────────────────┬──────────────────┘
            │                            │
            ▼                            ▼
   ┌──────────────────┐         ┌──────────────────┐
   │ observers/       │         │ pty/             │
   │ session-observer │         │ tmux-injector    │
   │ subagent-observer│         │ (iTerm/tmux)     │
   └──────────────────┘         └──────────────────┘
            │
            │ session events, output deltas, permission requests
            ▼
   ┌────────────────────────────────────────────────────────┐
   │               protocol/ndjson-handler                  │
   │   length-prefixed NDJSON, framing, backpressure        │
   └────────┬───────────────────────────────────────────────┘
            │
            │ ChaCha20-Poly1305 encrypted envelopes
            │ (crypto/crypto-engine handles the box)
            ▼
   ┌──────────────────────┐    ┌──────────────────────┐
   │ relay/relay-client   │    │ lan/lan-server       │
   │ WebSocket to cloud   │ OR │ Direct TCP + Bonjour │
   │ (default)            │    │ (--lan flag)         │
   └──────────────────────┘    └──────────────────────┘
            │                              │
            ▼                              ▼
                    ┌──────────────┐
                    │  iOS app     │
                    └──────────────┘
```

## Key concepts

### Observer mode vs Controller mode

A session is in exactly one mode at any time:

- **Observer** — Claude is running in a terminal the user opened. The daemon doesn't own the process. It tails the session's JSONL transcript at `~/.claude/projects/<path>/<sessionId>.jsonl`, intercepts permission prompts via the HTTP hook server, and injects messages back into the terminal via tmux/iTerm. This is the "phone keeps up with what's happening on the laptop" mode.
- **Controller** — No terminal Claude is attached. The daemon holds the session itself via [`@anthropic-ai/claude-agent-sdk`'s `query()` API](https://docs.anthropic.com/en/docs/claude-code/sdk). User input from the phone goes straight to the SDK; output is streamed back. This is the "drive Claude entirely from the phone" mode.

The mode can flip during a session — for example, if the user closes the terminal, the next time the daemon notices it can promote itself to controller. The transition is the trickiest part of the codebase; most of `sessions/session-manager.ts` exists to make it safe.

### Hook integration

Claude Code can call out to external processes for permission decisions and lifecycle events ([hooks docs](https://docs.anthropic.com/en/docs/claude-code/hooks)). On daemon startup, `hooks/hook-server.ts`:

1. Spawns an HTTP server on a free local port.
2. Writes `~/.claude/settings.local.json` with hook configs that point at that port.
3. On daemon shutdown, removes those hook configs cleanly.

When Claude wants to run a tool, the `PermissionRequest` hook fires → daemon forwards the request to the phone → phone returns approve/deny → daemon returns the verdict to Claude. The whole round-trip is bounded by Claude's hook timeout (10 minutes max — see `HOOK_HOLD_TIMEOUT_MS`).

Codex lifecycle hooks follow the same local-daemon shape for session start, user prompt, stop, and permission forwarding, but the permission UX is not yet equivalent to Claude Code. The current Codex `PermissionRequest` hook is held while the app approves or denies it, so the actionable request is visible in the app rather than in both the Codex terminal and the app. Track the terminal/app dual-approval investigation in [#17](https://github.com/928PJY/agent-pocket-daemon/issues/17).

Codex terminal permission prompts can include an "always allow"-style option, but Codex CLI 0.125.0 does not expose the required `available_decisions` / `additional_permissions` data through the installed shell hook payload. Those fields appear to be part of Codex's internal approval protocol rather than the `PermissionRequest` hook stdin. Until Codex exposes a hook-supported permission amendment response, the daemon keeps `has_always_allow=false` for Codex requests so the app only offers one-time approve/deny actions.

### End-to-end encryption

The relay server is *intentionally* unable to read session content. Pairing establishes:

- **X25519 ECDH** key exchange between daemon and phone.
- A 6-digit **SAS** code shown on both sides that the user must verify (defends against an active MITM).
- A symmetric session key used by **ChaCha20-Poly1305** to encrypt every payload.
- An **Ed25519** signing key for permission responses, so the daemon can prove to itself that an approval came from the paired phone and not from a tampered relay.

The relay only sees: source/destination peer IDs, encrypted blob length, and an opaque "wake hint" used for push notifications. See `crypto/crypto-engine.ts`.

### Capability negotiation

Wire-level "version bumps" are painful (they break old clients). For most additive features, the daemon and app instead exchange a list of capability strings in a `peer_hello` message right after connection. Each side checks `peerCapabilities.has('category.feature')` before using a feature; if absent, it falls back or skips silently.

This means a v0.1.5 daemon can talk to a v0.1.0 iOS app (and vice versa) as long as nothing fundamental changed. New features are discoverable but optional.

See `src/shared/capabilities.ts` for the canonical list and [CONTRIBUTING.md](CONTRIBUTING.md#wire-protocol--capability-changes) for how to add one.

### Pairing

`pairing.ts` runs once per device pair:

1. Daemon hits the relay's `/pair/initiate` and gets a one-time JWT + pair ID.
2. Daemon prints a QR code containing the relay URL, pair ID, and JWT.
3. Phone scans, both sides do ECDH, and both display the same 6-digit SAS.
4. User confirms the SAS matches on both screens.
5. Daemon persists the pairing (peer ID, public keys, signing keys) to `~/.agent-pocket/config.json`.

Subsequent runs skip pairing and reuse the saved keys.

### LAN mode

`agent-pocket start --lan` skips the cloud relay entirely. Instead, the daemon advertises itself via Bonjour (`_agent-pocket._tcp`) on the local network and accepts a direct WebSocket connection from the phone. Same crypto, same protocol — just no intermediary.

This is useful when the relay is down, when you don't want session metadata to transit a third party at all, or for development.

## Where to put new code

| If you're adding... | It probably goes in... |
|---|---|
| A new CLI subcommand or flag | `src/cli.ts` |
| A new way to discover sessions (e.g. JetBrains plugin support) | `src/discovery/` |
| A new terminal target for message injection | `src/pty/` |
| A new protocol message type | `src/shared/protocol.ts` (and the matching capability) |
| A new permission policy / risk classifier | `src/hooks/` |
| Anything cryptographic | `src/crypto/` — and please open an issue first |

## Things that look weird and aren't

- **`src/shared/` is duplicated from another repo.** This is intentional today, painful tomorrow. Tracked in [#1](https://github.com/928PJY/agent-pocket-daemon/issues/1).
- **`logger` writes to a file, not stdout.** The daemon is normally daemonized; nothing would read stdout. Use `agent-pocket logs -f`.
- **Lots of "is this stale?" checks on PID files.** `~/.claude/sessions/<PID>.json` files don't get cleaned up reliably (Claude doesn't always remove them on `/clear` or context compaction), so the daemon has to validate each one against the actual running process.
- **The hook HTTP server listens on a random port, not a fixed one.** That's so multiple daemons (e.g. dev + installed) can coexist; the port is written into `settings.local.json` at startup.

If you find something that looks wrong and isn't documented here as intentional, it probably *is* a bug — please open an issue.
