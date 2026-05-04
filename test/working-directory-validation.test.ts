import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

test('createSession expands ~ to the user home directory', () => {
  // Anything that exists under $HOME works — pick the home dir itself, since
  // it must exist for Node to be running at all.
  const manager = new SessionManager();
  manager.on('error', () => {});
  try {
    // Should not throw — `~` expands to homedir(), which exists.
    assert.doesNotThrow(() => manager.createSession({ working_directory: '~' }));
    const session = manager.getAllSessions()[0];
    assert.equal(session.workingDirectory, homedir());
  } finally {
    manager.shutdown();
  }
});

test('createSession expands ~/subdir style paths', () => {
  // Use $HOME itself as the parent + a path segment we create.
  const tmpName = `agent-pocket-tilde-${Date.now()}`;
  const realPath = join(homedir(), tmpName);
  const tildeInput = `~/${tmpName}`;
  mkdirSync(realPath, { recursive: true });

  const manager = new SessionManager();
  manager.on('error', () => {});
  try {
    assert.doesNotThrow(() => manager.createSession({ working_directory: tildeInput }));
    const session = manager.getAllSessions()[0];
    assert.equal(session.workingDirectory, realPath);
  } finally {
    manager.shutdown();
    rmSync(realPath, { recursive: true, force: true });
  }
});

test('createSession expands $VAR and ${VAR} environment references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-envvar-'));
  process.env.AGENT_POCKET_TEST_CWD = dir;

  const manager = new SessionManager();
  manager.on('error', () => {});
  try {
    assert.doesNotThrow(() => manager.createSession({ working_directory: '$AGENT_POCKET_TEST_CWD' }));
    assert.doesNotThrow(() => manager.createSession({ working_directory: '${AGENT_POCKET_TEST_CWD}' }));
    const sessions = manager.getAllSessions();
    assert.equal(sessions.length, 2);
    for (const s of sessions) {
      assert.equal(s.workingDirectory, dir);
    }
  } finally {
    manager.shutdown();
    delete process.env.AGENT_POCKET_TEST_CWD;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createSession leaves unset $VAR references untouched (and surfaces a clear error)', () => {
  delete process.env.AGENT_POCKET_TEST_UNSET_XYZ;
  const manager = new SessionManager();
  try {
    assert.throws(
      () => manager.createSession({ working_directory: '$AGENT_POCKET_TEST_UNSET_XYZ/foo' }),
      /Working directory does not exist: \$AGENT_POCKET_TEST_UNSET_XYZ\/foo/,
    );
  } finally {
    manager.shutdown();
  }
});
