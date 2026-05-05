// Real end-to-end test: spawns the actual `claude` binary via the SDK and
// drives a tiny conversation through SessionManager. Skipped by default — set
// AGENT_POCKET_RUN_E2E=1 to run. Requires:
//   - A working `claude` binary on PATH (or AGENT_POCKET_CLAUDE_PATH set).
//   - A reachable Anthropic API endpoint (ANTHROPIC_BASE_URL / auth env vars
//     respected by the binary).
//
// Hits the network, costs tokens, takes ~5–30s. Local-only.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStatus } from 'agent-pocket-protocol';
import type { ClaudeEvent } from 'agent-pocket-protocol';
import { SessionManager } from '../src/sessions/session-manager.js';

const ENABLED = process.env.AGENT_POCKET_RUN_E2E === '1';
const E2E_TIMEOUT_MS = 60_000;

test('e2e: controller mode drives a real claude turn end-to-end', { skip: ENABLED ? false : 'set AGENT_POCKET_RUN_E2E=1 to enable', timeout: E2E_TIMEOUT_MS }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-pocket-e2e-'));
  const manager = new SessionManager();

  const outputs: ClaudeEvent[] = [];
  const statuses: SessionStatus[] = [];
  const errors: Error[] = [];
  let sessionEndedExitCode: number | undefined;

  manager.on('session_output', (_id, event) => outputs.push(event));
  manager.on('session_status', (_id, status) => statuses.push(status));
  manager.on('error', (_id, err) => errors.push(err));
  manager.on('session_ended', (_id, code) => { sessionEndedExitCode = code; });

  try {
    const sessionId = manager.createSession({
      working_directory: cwd,
      initial_message: 'Reply with exactly the single word: PONG. Do not call any tools.',
    });

    const session = manager.getSession(sessionId)!;

    // Wait until the SDK either reaches READY (turn finished) or errors out.
    const start = Date.now();
    while (
      session.status !== SessionStatus.READY &&
      session.status !== SessionStatus.HISTORY &&
      session.status !== SessionStatus.ERROR &&
      errors.length === 0
    ) {
      if (Date.now() - start > E2E_TIMEOUT_MS - 5_000) {
        throw new Error(`E2E timeout — last status=${session.status}, outputs=${outputs.length}, errors=${errors.length}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (errors.length > 0) {
      throw new Error(`SessionManager emitted error(s): ${errors.map((e) => e.message).join(' | ')}`);
    }

    assert.equal(sessionEndedExitCode, undefined, 'session should not have ended in this turn');
    assert.equal(session.status, SessionStatus.READY, `expected READY after one turn, got ${session.status}`);
    assert.ok(session.claudeSessionId, 'claudeSessionId must be assigned by the SDK');
    assert.ok(statuses.includes(SessionStatus.READY), 'READY status must be emitted');

    const assistantText = outputs
      .filter((e): e is ClaudeEvent & { type: 'assistant_message'; message: string } => e.type === 'assistant_message')
      .map((e) => e.message)
      .join('');
    assert.ok(assistantText.length > 0, `expected at least one assistant_message, got events: ${JSON.stringify(outputs)}`);
    assert.match(assistantText, /pong/i, `assistant reply should contain "PONG", got: ${JSON.stringify(assistantText)}`);
  } finally {
    manager.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});
