import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexProcessList } from '../src/discovery/codex-discovery.js';

test('parseCodexProcessList matches only Codex executables', () => {
  const pids = parseCodexProcessList(`
    101 /opt/homebrew/bin/codex
    102 /usr/local/bin/codex-cli --model gpt-5
    103 /usr/local/bin/codex-foo
    104 node /tmp/codex
    105 /Applications/Codex.app/Contents/MacOS/codex
  `);

  assert.deepEqual(pids, [101, 102, 105]);
});
