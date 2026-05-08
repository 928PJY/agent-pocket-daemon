import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  expandPath,
  resolveClaudeExecutable,
  assertWorkingDirectoryExists,
} from '../src/sessions/path-utils.js';

// ---------------------------------------------------------------------------
// expandPath
// ---------------------------------------------------------------------------

test('expandPath: bare ~ -> homedir', () => {
  assert.equal(expandPath('~'), os.homedir());
});

test('expandPath: ~/sub -> $HOME/sub', () => {
  assert.equal(expandPath('~/x/y'), path.normalize(path.join(os.homedir(), 'x/y')));
});

test('expandPath: ~user (no slash, not bare) is left alone', () => {
  // Implementation only handles ~ and ~/, not ~user
  assert.equal(expandPath('~root'), path.normalize('~root'));
});

test('expandPath: $VAR + ${VAR} expansion', () => {
  process.env.AP_TEST_VAR_X = 'hello';
  try {
    assert.equal(expandPath('$AP_TEST_VAR_X/end'), path.normalize('hello/end'));
    assert.equal(expandPath('${AP_TEST_VAR_X}-tail'), path.normalize('hello-tail'));
  } finally {
    delete process.env.AP_TEST_VAR_X;
  }
});

test('expandPath: unset $VAR left as-is', () => {
  delete process.env.AP_NO_SUCH_VAR_Z;
  assert.equal(expandPath('$AP_NO_SUCH_VAR_Z/x'), path.normalize('$AP_NO_SUCH_VAR_Z/x'));
});

test('expandPath: normalizes .. segments', () => {
  assert.equal(expandPath('/a/b/../c'), path.normalize('/a/c'));
});

// ---------------------------------------------------------------------------
// resolveClaudeExecutable
// ---------------------------------------------------------------------------

test('resolveClaudeExecutable: AGENT_POCKET_CLAUDE_PATH wins when file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apc-'));
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fake, 0o755);

  const oldOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  process.env.AGENT_POCKET_CLAUDE_PATH = fake;
  try {
    assert.equal(resolveClaudeExecutable(), fake);
  } finally {
    if (oldOverride === undefined) delete process.env.AGENT_POCKET_CLAUDE_PATH;
    else process.env.AGENT_POCKET_CLAUDE_PATH = oldOverride;
  }
});

test('resolveClaudeExecutable: ignores AGENT_POCKET_CLAUDE_PATH when file missing', () => {
  const oldOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  const oldPath = process.env.PATH;
  process.env.AGENT_POCKET_CLAUDE_PATH = '/nonexistent/path/to/claude';
  process.env.PATH = '';
  try {
    assert.equal(resolveClaudeExecutable(), undefined);
  } finally {
    if (oldOverride === undefined) delete process.env.AGENT_POCKET_CLAUDE_PATH;
    else process.env.AGENT_POCKET_CLAUDE_PATH = oldOverride;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test('resolveClaudeExecutable: walks PATH when no override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apc-'));
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fake, 0o755);

  const oldOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  const oldPath = process.env.PATH;
  delete process.env.AGENT_POCKET_CLAUDE_PATH;
  process.env.PATH = `/nope/dir${path.delimiter}${dir}`;
  try {
    assert.equal(resolveClaudeExecutable(), fake);
  } finally {
    if (oldOverride !== undefined) process.env.AGENT_POCKET_CLAUDE_PATH = oldOverride;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test('resolveClaudeExecutable: returns undefined when neither override nor PATH match', () => {
  const oldOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  const oldPath = process.env.PATH;
  delete process.env.AGENT_POCKET_CLAUDE_PATH;
  process.env.PATH = '/no/such/dir-abc';
  try {
    assert.equal(resolveClaudeExecutable(), undefined);
  } finally {
    if (oldOverride !== undefined) process.env.AGENT_POCKET_CLAUDE_PATH = oldOverride;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test('resolveClaudeExecutable: skips empty PATH segments', () => {
  const oldOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  const oldPath = process.env.PATH;
  delete process.env.AGENT_POCKET_CLAUDE_PATH;
  // Two leading delimiters create an empty segment first
  process.env.PATH = `${path.delimiter}${path.delimiter}/no/such/dir-empty-seg`;
  try {
    assert.equal(resolveClaudeExecutable(), undefined);
  } finally {
    if (oldOverride !== undefined) process.env.AGENT_POCKET_CLAUDE_PATH = oldOverride;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test('resolveClaudeExecutable: skips PATH entry where claude is a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apc-'));
  // Create a DIRECTORY named 'claude' — should not match
  fs.mkdirSync(path.join(dir, 'claude'));

  const oldOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  const oldPath = process.env.PATH;
  delete process.env.AGENT_POCKET_CLAUDE_PATH;
  process.env.PATH = dir;
  try {
    assert.equal(resolveClaudeExecutable(), undefined);
  } finally {
    if (oldOverride !== undefined) process.env.AGENT_POCKET_CLAUDE_PATH = oldOverride;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// assertWorkingDirectoryExists
// ---------------------------------------------------------------------------

test('assertWorkingDirectoryExists: passes for an existing dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awde-'));
  assert.doesNotThrow(() => assertWorkingDirectoryExists(dir));
});

test('assertWorkingDirectoryExists: throws "does not exist" for missing path', () => {
  assert.throws(
    () => assertWorkingDirectoryExists('/nope/such/dir/agent-pocket-test'),
    /does not exist/,
  );
});

test('assertWorkingDirectoryExists: throws "is not a directory" for files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awde-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => assertWorkingDirectoryExists(file), /is not a directory/);
});
