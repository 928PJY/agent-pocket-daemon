<p align="center">
  <img src="docs/icon.png" alt="Agent Pocket" width="120" style="border-radius: 24px" />
</p>

<h1 align="center">Agent Pocket</h1>

<p align="center">
  <strong>Control your AI coding agent from your phone.</strong><br>
  Approve permissions, send messages, and monitor sessions — anywhere.
</p>

---

## What is Agent Pocket?

A lightweight daemon for your Mac that bridges AI coding agent sessions to the **Agent Pocket iOS app**. Currently supports [Claude Code](https://docs.anthropic.com/en/docs/claude-code), with Gemini CLI and Codex on the roadmap. Session content is end-to-end encrypted — the relay server cannot read your messages.

- 📱 Remote control — approve/deny permissions, send messages, review plans
- 🔄 Seamless handoff — switch between phone and terminal without losing context, zero setup
- 🔍 Auto-discovery — finds all running sessions (CLI + VS Code) automatically
- 🔔 Push notifications — permission requests, task completions, questions
- 👥 Agent team visualization — see multi-agent workflows in a rich visual interface
- 🔒 E2E encrypted — ChaCha20-Poly1305, ECDH key exchange, SAS verification
- 🌐 Works anywhere — cloud relay or direct LAN connection

### 🔄 Seamless Phone ↔ Terminal Handoff

Walk away from your desk — your session continues on your phone. Come back — pick up right where you left off in the terminal. No commands to run, no state to sync. The daemon keeps everything in sync automatically.

### 👥 Agent Team Visualization

When Claude spawns a team of agents, Agent Pocket gives you a visual overview of the entire multi-agent workflow — agent hierarchy, task assignments, progress, and inter-agent communication — all in a native iOS interface.

## 📲 iOS App

<p align="center">
  <a href="https://apps.apple.com/app/pocket-agent/id0000000000">
    <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="Download on the App Store" height="50" />
  </a>
</p>

> Currently in TestFlight beta. Contact the developer for access.

## 📋 Requirements

- **macOS** (Windows support on the roadmap)
- **Node.js 20+**
- **Claude Code** (Gemini CLI / Codex support on the roadmap)
- **Agent Pocket iOS app** (Android on the roadmap)

## ⚡ Quick Start

```bash
npm install -g agent-pocket
agent-pocket start
# Scan the QR code with the iOS app → verify the 6-digit code → done
```

The daemon runs in the background. Open Claude Code in any terminal — it appears in the app automatically.

## ✨ Features

### 🖥️ Session Management

- **Auto-discovery** — Continuously scans for CLI and VS Code Claude sessions
- **Observer mode** — Monitors existing terminal sessions without taking control
- **Controller mode** — Creates and manages sessions via the Claude Agent SDK
- **Session history** — Browse full conversation history with streaming output

### 🛡️ Permissions & Interactions

- **One-tap approve/deny** with risk indicators (LOW → CRITICAL)
- **Always Allow** to permanently permit a tool pattern per session
- **Remote messaging** — Send follow-up instructions from your phone
- **Plan review** — Review and approve Claude's implementation plans
- **User questions** — Answer Claude's interactive questions remotely
- **Emergency abort** — Kill all Claude processes instantly (`agent-pocket panic`)

### 🔒 Security

- **ECDH key exchange** (X25519) during pairing
- **ChaCha20-Poly1305** authenticated encryption for all session messages
- **6-digit SAS code** verification to prevent MITM attacks
- **Ed25519 signed** permission responses
- **Apple Sign In** required before pairing

> **Push notifications preserve the payload boundary.**
> When the iOS app is offline, the relay sends a generic APNs wake notification. Session names, message bodies, request IDs, and other user/session content remain inside the encrypted payload and are not exposed through relay-visible push metadata. Rich notification content should be generated client-side after the app decrypts the message, or by a future Notification Service Extension.

### 🌐 Connection Modes

| Mode | Use case | Command |
|------|----------|---------|
| **Relay** (default) | Anywhere — cloud relay forwards encrypted messages | `agent-pocket start` |
| **LAN** | Same network — direct connection via Bonjour | `agent-pocket start --lan` |

## 🔧 Commands

```
agent-pocket start       Start daemon (auto-pairs if needed)
agent-pocket stop        Stop daemon
agent-pocket restart     Restart daemon
agent-pocket status      Show connection and session status
agent-pocket logs [-f]   View logs (--trace for verbose)
agent-pocket pair        Pair with iOS app (--reset to re-pair)
agent-pocket unpair      Clear pairing
agent-pocket sessions    List discovered Claude sessions
agent-pocket panic       Emergency kill all Claude processes
```

## ⚙️ How It Works

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│  Claude  │ hooks → │  Daemon  │ ═══E2E══│  Phone   │
│  (CLI)   │         │ (agent-  │  relay   │  (iOS    │
│          │ ← pty   │  pocket) │  or LAN  │   app)   │
└──────────┘         └──────────┘         └──────────┘
```

**Observer mode** — Claude runs in your terminal. The daemon tails the JSONL session file for output and handles permissions via Claude's [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks). Messages from the phone are injected into the terminal.

**Controller mode** — The daemon owns the session via the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk). Full control without a terminal.

## 💻 Supported Terminals

| Terminal | Message Injection | Interrupt |
|----------|:-:|:-:|
| iTerm2 | ✅ | ✅ |
| tmux | ✅ | ✅ |
| VS Code | ✅ Discovery | — |
| Terminal.app | Observer only | — |

## 🐛 Troubleshooting

```bash
agent-pocket status          # Check connection state
agent-pocket logs -f         # Live logs
agent-pocket restart --trace # Verbose debug mode
agent-pocket pair --reset    # Fix pairing issues
```

## 🗺️ Roadmap

- 🪟 **Windows support** — Daemon for Windows with PowerShell/Windows Terminal injection
- 🤖 **Gemini CLI / Codex** — Support for additional AI coding agents
- 📱 **Android app** — Agent Pocket for Android

## 📄 License

MIT
