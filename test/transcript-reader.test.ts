import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLastTurnSummary } from '../src/utils/transcript-reader.js';

function tempTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-transcript-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

test('readLastTurnSummary summarizes only the latest completed assistant turn', async () => {
  const file = tempTranscript([
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'old answer' }],
        usage: { output_tokens: 10, cache_creation_input_tokens: 1, input_tokens: 999 },
      },
    },
    { type: 'user', timestamp: '2026-01-01T00:01:00.000Z' },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:01:02.000Z',
      message: {
        content: [{ type: 'tool_use' }],
        usage: { output_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 500 },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:01:05.000Z',
      message: {
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: ' final answer ' },
          { type: 'text', text: 'second paragraph' },
        ],
        usage: { output_tokens: 8, cache_creation_input_tokens: 2, input_tokens: 1000 },
      },
    },
  ]);

  assert.deepEqual(await readLastTurnSummary(file), {
    text: 'final answer\nsecond paragraph',
    toolUseCount: 1,
    totalTokens: 17,
    durationSec: 5,
  });
});

test('readLastTurnSummary ignores malformed lines and waits for an end_turn after the last user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-transcript-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }),
    '{malformed json}',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'streaming' }] } }),
  ].join('\n'));

  const started = Date.now();
  const summary = await readLastTurnSummary(file);

  assert.equal(summary, null);
  assert.ok(Date.now() - started >= 1_500);
});

test('readLastTurnSummary returns null for missing transcript path', async () => {
  assert.equal(await readLastTurnSummary(''), null);
});
