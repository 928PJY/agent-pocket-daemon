import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager, expandPath } from '../src/sessions/session-manager.js';

test('createSession rejects a non-existent working_directory with a clear message', () => {
  const manager = new SessionManager();
  try {
    assert.throws(
      () => manager.createSession({ working_directory: '/tmp/agent-pocket-does-not-exist-xyz' }),
      /Working directory does not exist: \/tmp\/agent-pocket-does-not-exist-xyz/,
    );
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

test('expandPath expands ~ to the user home directory', () => {
  assert.equal(expandPath('~'), homedir());
});

test('expandPath expands ~/subdir style paths', () => {
  const tmpName = `agent-pocket-tilde-${Date.now()}`;
  const realPath = join(homedir(), tmpName);
  mkdirSync(realPath, { recursive: true });
  try {
    assert.equal(expandPath(`~/${tmpName}`), realPath);
  } finally {
    rmSync(realPath, { recursive: true, force: true });
  }
});

test('expandPath expands $VAR and ${VAR} environment references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-envvar-'));
  process.env.AGENT_POCKET_TEST_CWD = dir;
  try {
    assert.equal(expandPath('$AGENT_POCKET_TEST_CWD'), dir);
    assert.equal(expandPath('${AGENT_POCKET_TEST_CWD}'), dir);
  } finally {
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
