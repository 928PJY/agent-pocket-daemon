<!--
Thanks for opening a PR! A few things to check before requesting review:
- The change is described in (or linked to) an issue
- `npm run build` and `npm test` pass locally
- Protocol/capability changes are called out below
-->

## Summary

<!-- 1-3 sentences: what does this change and why? -->

## Related issue

<!-- e.g. "Closes #42" or "Refs #1" — required for non-trivial changes -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (wire protocol, public CLI flags, or config schema)
- [ ] Documentation
- [ ] Internal refactor / chore

## Protocol or capability impact

- [ ] None — this PR doesn't touch `src/shared/` or wire-level behavior
- [ ] Adds a new peer capability (gated, backward-compatible)
- [ ] Changes an existing message shape or constant
- [ ] Bumps `WIRE_VERSION_*`

> If any box other than "None" is checked, please describe what the relay-server and iOS app would need to do to stay compatible. The daemon's `src/shared/` is currently a manual copy of the protocol — see [#1](https://github.com/928PJY/agent-pocket-daemon/issues/1).

## How was this tested?

<!--
- Unit tests added/updated?
- Manually exercised against a real Claude session? Which terminal (iTerm/tmux/VS Code)?
- E2E with the iOS app — pairing, permission approval, message round-trip?
-->

## Screenshots / logs (optional)

<!-- For UX-affecting changes (CLI output, log format, etc.), paste a before/after. -->
