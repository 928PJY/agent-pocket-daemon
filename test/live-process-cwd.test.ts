import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { getLiveProcessCwd } from '../src/discovery/session-discovery.js';

test('getLiveProcessCwd returns undefined for invalid pids', () => {
  assert.equal(getLiveProcessCwd(0), undefined);
  assert.equal(getLiveProcessCwd(-1), undefined);
});

test('getLiveProcessCwd resolves cwd for the current process', { skip: process.platform === 'win32' }, () => {
  assert.equal(getLiveProcessCwd(process.pid), process.cwd());
});

test('getLiveProcessCwd parses lsof field output on macOS-style platforms', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-lsof-'));
  const bin = join(dir, 'lsof');
  writeFileSync(bin, '#!/bin/sh\nprintf "p12345\\nn/Users/test/worktree\\n"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;

  try {
    process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
    assert.equal(getLiveProcessCwd(12345), '/Users/test/worktree');
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
