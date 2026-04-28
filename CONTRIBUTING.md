# Contributing to Agent Pocket

Thanks for taking the time to look at this — issues and pull requests are welcome.

This is a small project run by one maintainer outside of work hours, so please open an issue **before** starting on anything substantial. A 5-minute conversation will save both of us from chasing the wrong direction in a 500-line PR.

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Running the tests](#running-the-tests)
- [Working on the daemon locally](#working-on-the-daemon-locally)
- [Wire-protocol / capability changes](#wire-protocol--capability-changes)
- [Pull request checklist](#pull-request-checklist)
- [Commit style](#commit-style)
- [Release process](#release-process)
- [Reporting security issues](#reporting-security-issues)

## Code of Conduct

Be kind. Assume good faith. We follow the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) — harassment, personal attacks, and discriminatory language are not welcome here. If something feels off, [open a confidential report](https://github.com/928PJY/agent-pocket-daemon/security/advisories/new) and the maintainer will follow up.

## Development setup

Requirements:

- **Node.js 20 or 22** (CI tests both)
- **macOS** for end-to-end testing (the daemon's terminal injection currently targets macOS — see [Roadmap](README.md#roadmap) for cross-platform plans)
- **Claude Code** installed, if you want to run the daemon against real sessions

```bash
git clone https://github.com/928PJY/agent-pocket-daemon.git
cd agent-pocket-daemon
npm install
npm run build
npm test
```

`npm link` will expose your working copy as the global `agent-pocket` command:

```bash
npm link
agent-pocket --help
```

When you're done, `npm unlink -g agent-pocket` to drop the link.

## Project layout

```
src/
├── cli.ts                 # argv parsing, subcommands, pairing UX
├── index.ts               # daemon main loop / wiring
├── pairing.ts             # initial QR pairing flow
├── logger.ts              # rotating file logger
├── crypto/                # ChaCha20-Poly1305 + X25519 ECDH + key formatting
├── discovery/             # finds running Claude sessions (CLI + VS Code)
├── observers/             # tails JSONL session files; subagent observation
├── sessions/              # per-session state machine, observer/controller modes
├── hooks/                 # HTTP server that backs Claude's settings.local.json hooks
├── pty/                   # tmux/iTerm message injection
├── relay/                 # WebSocket client to the cloud relay
├── lan/                   # Bonjour discovery + direct LAN server (no relay)
├── protocol/              # NDJSON framing for E2E payloads
├── shared/                # protocol/capability/constant definitions (vendored copy)
└── utils/
test/                      # node:test suites — run with `npm test`
```

There's a deeper walkthrough in [ARCHITECTURE.md](ARCHITECTURE.md) if you want the why behind the layout.

## Running the tests

```bash
npm test            # all unit tests via node:test + tsx
npm run build       # type-check (`tsc` produces dist/)
```

The test suite is fast (~3s) and runs entirely in-process — no relay or Claude needed. CI runs the same command on Node 20 and Node 22.

End-to-end testing against a real relay + iOS app is manual. There's a `test-e2e.mjs` script that exercises pairing, but most "did this break the integration?" verification still happens by running the daemon against the production relay and the iOS TestFlight build.

## Working on the daemon locally

```bash
npm run dev         # tsx watch on src/index.ts
```

Or, to test as the global CLI users will hit it:

```bash
npm run build && npm link
agent-pocket restart
agent-pocket logs -f
```

`agent-pocket logs -f` is your friend — almost everything important goes through `logger`. Avoid `console.log`; the daemon is normally daemonized and you won't see it.

## Wire-protocol / capability changes

The daemon's `src/shared/` is currently a **manual copy** of the protocol definitions that also live in the closed-source monorepo (relay-server + iOS). When you change anything under `src/shared/`:

- The relay-server's matching `shared/protocol.ts` and the iOS app's `PeerCapabilities.swift` need parallel updates.
- Bump capability constants on **both** sides — the daemon and the peer — and gate behavior on the **peer's** announced capability, never your own. See [`src/shared/capabilities.ts`](src/shared/capabilities.ts) for the existing list.
- Don't bump the wire version unless an old peer would *fail* to handle the new message; prefer a new capability for additive changes.

There's a tracking issue to fix this duplication by publishing `shared/` as its own npm package: [#1](https://github.com/928PJY/agent-pocket-daemon/issues/1). Until that lands, please call out protocol-touching changes prominently in your PR description so the maintainer remembers to mirror them.

## Pull request checklist

Before opening a PR:

- [ ] An issue exists describing the change (skip for typo/docs trivia)
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] New behavior has a test (where reasonable — UX flows are hard to test)
- [ ] If you changed protocol/capabilities, the PR description says so explicitly
- [ ] No secrets, tokens, or relay URLs other than the public default in any new code or fixtures

PRs that don't pass CI won't be reviewed until the build is green. The CI workflow is the same `build + test` that you run locally, on Node 20 and 22.

## Commit style

No strict format — write clear, present-tense subject lines under ~70 characters, with a body explaining *why* when the *what* isn't obvious from the diff. Examples from the existing history:

```
Quote test glob so it works in bash without globstar
Add CI/CD, security policy, and refine README
Initial public release of Agent Pocket daemon
```

Squash-merge is the default for PRs, so the PR title becomes the merged commit subject — make it count.

## Release process

Releases are handled by GitHub Actions:

1. Bump `version` in `package.json` on `main` (PR + merge).
2. Tag the commit: `git tag v0.1.1 && git push --tags`.
3. The `release.yml` workflow runs `build + test`, verifies the tag matches `package.json`, publishes to npm with provenance, and creates a GitHub release with auto-generated notes.

You don't need npm credentials locally — only the maintainer with the `NPM_TOKEN` repo secret can release. If you want to *test* a publish locally, `npm pack --dry-run` shows exactly what would be uploaded.

## Reporting security issues

**Don't open a public issue.** See [SECURITY.md](SECURITY.md) for the private disclosure process.

---

Questions that don't fit into an issue? Mention `@928PJY` on any open PR/issue, or reach out via GitHub.
