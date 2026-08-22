import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getSessionPreview,
  clearPreviewCacheForTests,
  CLAUDE_PREVIEW_PARSER,
} from '../src/discovery/preview-cache.js';

function tmpJsonl(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-cache-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function userRow(text: string, ts = '2026-06-03T00:00:00.000Z'): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${text}`,
    timestamp: ts,
    message: { role: 'user', content: text },
  });
}

function assistantRow(text: string, ts = '2026-06-03T00:00:01.000Z'): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${text}`,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

test('returns last N preview messages without normalising', () => {
  clearPreviewCacheForTests();
  const file = tmpJsonl([
    userRow('first'),
    assistantRow('reply 1'),
    userRow('second'),
    assistantRow('reply 2'),
    userRow('third'),
  ]);
  const out = getSessionPreview(file, CLAUDE_PREVIEW_PARSER, 3);
  assert.equal(out.length, 3);
  assert.equal(out[2].role, 'user');
  assert.equal(out[2].content, 'third');
});

test('cache is mtime-keyed — re-reads when file grows', () => {
  clearPreviewCacheForTests();
  const file = tmpJsonl([userRow('one')]);
  const first = getSessionPreview(file, CLAUDE_PREVIEW_PARSER, 3);
  assert.equal(first.length, 1);

  // Append a new row + bump mtime to a strictly later value (some macOS
  // filesystems have second-level mtime resolution, so explicit utimes).
  fs.appendFileSync(file, assistantRow('two') + '\n');
  const future = Date.now() / 1000 + 5;
  fs.utimesSync(file, future, future);
  const second = getSessionPreview(file, CLAUDE_PREVIEW_PARSER, 3);
  assert.equal(second.length, 2);
  assert.equal(second[1].role, 'assistant');
});

test('returns empty for missing file', () => {
  clearPreviewCacheForTests();
  const out = getSessionPreview('/tmp/does-not-exist-xyz.jsonl', CLAUDE_PREVIEW_PARSER, 3);
  assert.deepEqual(out, []);
});

test('skips unparseable lines without throwing', () => {
  clearPreviewCacheForTests();
  const file = tmpJsonl([
    userRow('valid-1'),
    '{not json',
    assistantRow('valid-2'),
  ]);
  const out = getSessionPreview(file, CLAUDE_PREVIEW_PARSER, 5);
  assert.equal(out.length, 2);
});

test('tail-only read does not load the whole file for huge transcripts', () => {
  clearPreviewCacheForTests();
  // Build a >256KB file. The preview should still return correct tail rows
  // — and crucially without parsing the entire body — but we can only assert
  // correctness; the speed property is checked by the larger e2e harness.
  const big: string[] = [];
  for (let i = 0; i < 5000; i++) big.push(userRow(`row-${i}`));
  const file = tmpJsonl(big);
  const out = getSessionPreview(file, CLAUDE_PREVIEW_PARSER, 3);
  assert.equal(out.length, 3);
  // The very last row should be present and intact.
  assert.equal(out[2].content, 'row-4999');
});
