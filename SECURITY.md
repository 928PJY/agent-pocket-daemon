# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Agent Pocket — particularly in the
pairing handshake, end-to-end encryption (ChaCha20-Poly1305 / X25519 ECDH),
SAS verification, signed permission responses, or anything that could let a
third party read or inject session traffic — please **do not open a public
issue**.

Instead, report it privately via GitHub's
[private vulnerability reporting](https://github.com/928PJY/agent-pocket-daemon/security/advisories/new),
or email the maintainer at the address listed on the
[GitHub profile](https://github.com/928PJY).

Please include:

- A description of the vulnerability and the affected component
- Steps to reproduce, or a proof-of-concept if available
- The version of `agent-pocket` you tested against
- Any relevant logs (with secrets redacted)

You can expect an initial acknowledgement within a few days. Coordinated
disclosure timelines will be agreed on a case-by-case basis depending on
severity.

## Supported Versions

Only the latest published release on npm receives security updates while the
project is pre-1.0.

## Scope

In scope:

- The `agent-pocket` daemon (this repository)
- The wire protocol used between daemon and mobile app
- The pairing flow

Out of scope:

- The closed-source iOS app (report via TestFlight feedback)
- The hosted relay infrastructure at `wss://www.agent-pocket.com` (report
  privately to the maintainer)
- Vulnerabilities in upstream dependencies that have not been demonstrated to
  affect Agent Pocket — please report those to the upstream project first
