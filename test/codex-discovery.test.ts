import test from 'node:test';
import assert from 'node:assert/strict';
import { codexStateDbReadonlyUri, parseCodexProcessList } from '../src/discovery/codex-discovery.js';

test('parseCodexProcessList matches terminal Codex executables', () => {
  const pids = parseCodexProcessList(`
    101 /opt/homebrew/bin/codex
    102 /usr/local/bin/codex-cli --model gpt-5
    103 /usr/local/bin/codex-foo
    104 node /tmp/codex
    105 /Applications/Codex.app/Contents/MacOS/codex
    106 /Applications/Codex.app/Contents/MacOS/codex app-server --analytics-default-enabled
  `);

  assert.deepEqual(pids, [101, 102, 105]);
});

test('codexStateDbReadonlyUri opens immutable read-only snapshots', () => {
  assert.equal(
    codexStateDbReadonlyUri('/Users/test user/.codex/state_5.sqlite'),
    'file:///Users/test%20user/.codex/state_5.sqlite?mode=ro&immutable=1',
  );
});
