import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '../src/sessions/session-manager.js';

test('createSession rejects a non-existent working_directory with a clear message', () => {
  const manager = new SessionManager();
  try {
    assert.throws(
      () => manager.createSession({ working_directory: '/tmp/agent-pocket-does-not-exist-xyz' }),
      /Working directory does not exist: \/tmp\/agent-pocket-does-not-exist-xyz/,
    );
    // No session should have leaked into the map
    assert.equal(manager.getAllSessions().length, 0);
  } finally {
    manager.shutdown();
  }
});

test('createSession rejects a working_directory that points at a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-cwd-'));
  const filePath = join(dir, 'not-a-dir.txt');
  writeFileSync(filePath, '');

  const manager = new SessionManager();
  try {
    assert.throws(
      () => manager.createSession({ working_directory: filePath }),
      /Working directory is not a directory:/,
    );
    assert.equal(manager.getAllSessions().length, 0);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumeSession rejects a non-existent working_directory', () => {
  const manager = new SessionManager();
  try {
    assert.throws(
      () => manager.resumeSession('claude-sess-1', { working_directory: '/tmp/agent-pocket-does-not-exist-xyz-2' }),
      /Working directory does not exist:/,
    );
    assert.equal(manager.getAllSessions().length, 0);
  } finally {
    manager.shutdown();
  }
});
