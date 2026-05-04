import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { test } from 'node:test';
import { resolveClaudeExecutable } from '../src/sessions/session-manager.js';

test('AGENT_POCKET_CLAUDE_PATH override wins when the file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-claude-path-'));
  const fake = join(dir, 'claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);

  const prevOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  process.env.AGENT_POCKET_CLAUDE_PATH = fake;
  try {
    assert.equal(resolveClaudeExecutable(), fake);
  } finally {
    if (prevOverride === undefined) delete process.env.AGENT_POCKET_CLAUDE_PATH;
    else process.env.AGENT_POCKET_CLAUDE_PATH = prevOverride;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-existent override is ignored and PATH search runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-claude-path-'));
  const fake = join(dir, 'claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);

  const prevOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  const prevPath = process.env.PATH;
  process.env.AGENT_POCKET_CLAUDE_PATH = '/definitely/does/not/exist/claude';
  process.env.PATH = `${dir}${delimiter}${prevPath ?? ''}`;
  try {
    assert.equal(resolveClaudeExecutable(), fake);
  } finally {
    if (prevOverride === undefined) delete process.env.AGENT_POCKET_CLAUDE_PATH;
    else process.env.AGENT_POCKET_CLAUDE_PATH = prevOverride;
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns undefined when nothing is found', () => {
  const prevOverride = process.env.AGENT_POCKET_CLAUDE_PATH;
  const prevPath = process.env.PATH;
  delete process.env.AGENT_POCKET_CLAUDE_PATH;
  process.env.PATH = '/var/empty-agent-pocket-test-xyz';
  try {
    assert.equal(resolveClaudeExecutable(), undefined);
  } finally {
    if (prevOverride !== undefined) process.env.AGENT_POCKET_CLAUDE_PATH = prevOverride;
    process.env.PATH = prevPath;
  }
});
