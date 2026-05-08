import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PcEvent } from 'agent-pocket-protocol';
import type { CommandContext, SendSessionHistoryOptions } from '../src/commands/command-context.js';
import {
  detectLanguageFromExtension,
  handleReadFile,
  handleGetHistory,
  handleSyncRequest,
  READ_FILE_MAX_BYTES,
} from '../src/commands/handlers/file-and-history.js';

interface SentEvent { event: PcEvent; }
interface SentError { requestId?: string; message: string; code: string; }
interface HistoryCall { sessionId: string; options?: SendSessionHistoryOptions; }

interface FakeSession { claudeSessionId?: string }

function makeCtx(overrides: {
  sendSessionHistory?: (id: string, opts?: SendSessionHistoryOptions) => number | undefined;
  sessions?: FakeSession[];
} = {}) {
  const sentEvents: SentEvent[] = [];
  const sentErrors: SentError[] = [];
  const historyCalls: HistoryCall[] = [];
  const ctx: CommandContext = {
    sendToPhone: (event) => { sentEvents.push({ event }); },
    sendError: (requestId, message, code) => { sentErrors.push({ requestId, message, code }); },
    resolveInternalSessionId: (id) => id,
    sendSessionHistory: (id, options) => {
      historyCalls.push({ sessionId: id, options });
      return overrides.sendSessionHistory ? overrides.sendSessionHistory(id, options) : undefined;
    },
    sessionManager: {
      getAllSessions: () => overrides.sessions ?? [],
    } as unknown as CommandContext['sessionManager'],
  };
  return { ctx, sentEvents, sentErrors, historyCalls };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-history-test-'));
}

// ---------------------------------------------------------------------------
// detectLanguageFromExtension
// ---------------------------------------------------------------------------

test('detectLanguageFromExtension maps known extensions to language tags', () => {
  assert.equal(detectLanguageFromExtension('foo.ts'), 'typescript');
  assert.equal(detectLanguageFromExtension('foo.tsx'), 'typescript');
  assert.equal(detectLanguageFromExtension('foo.PY'), 'python');
  assert.equal(detectLanguageFromExtension('a/b/c.rs'), 'rust');
  assert.equal(detectLanguageFromExtension('script.SH'), 'bash');
});

test('detectLanguageFromExtension returns undefined for unknown extensions', () => {
  assert.equal(detectLanguageFromExtension('mystery.xyz'), undefined);
  assert.equal(detectLanguageFromExtension('no-ext'), undefined);
});

// ---------------------------------------------------------------------------
// handleReadFile
// ---------------------------------------------------------------------------

test('handleReadFile reads a file and emits file_content with detected language', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'hello.ts');
  fs.writeFileSync(file, 'export const x = 1;\n', 'utf-8');

  const { ctx, sentEvents, sentErrors } = makeCtx();
  await handleReadFile(ctx, { type: 'read_file', path: file, request_id: 'r1' } as never);

  assert.equal(sentErrors.length, 0);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    request_id: string;
    path: string;
    content: string;
    language?: string;
  };
  assert.equal(ev.type, 'file_content');
  assert.equal(ev.request_id, 'r1');
  assert.equal(ev.path, path.resolve(file));
  assert.equal(ev.content, 'export const x = 1;\n');
  assert.equal(ev.language, 'typescript');
});

test('handleReadFile emits FILE_TOO_LARGE when file exceeds READ_FILE_MAX_BYTES', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'big.txt');
  // Write just over the limit (1 MiB + 1 byte)
  fs.writeFileSync(file, Buffer.alloc(READ_FILE_MAX_BYTES + 1, 'a'));

  const { ctx, sentEvents, sentErrors } = makeCtx();
  await handleReadFile(ctx, { type: 'read_file', path: file, request_id: 'r1' } as never);

  assert.equal(sentEvents.length, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'FILE_TOO_LARGE');
  assert.match(sentErrors[0].message, /File too large/);
  assert.equal(sentErrors[0].requestId, 'r1');
});

test('handleReadFile emits READ_FILE_ERROR when the file is missing', async () => {
  const { ctx, sentEvents, sentErrors } = makeCtx();
  await handleReadFile(ctx, { type: 'read_file', path: '/no/such/file.txt', request_id: 'r1' } as never);

  assert.equal(sentEvents.length, 0);
  assert.equal(sentErrors.length, 1);
  assert.equal(sentErrors[0].code, 'READ_FILE_ERROR');
  assert.match(sentErrors[0].message, /Failed to read file/);
});

test('handleReadFile leaves language undefined for unknown extensions', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'mystery.xyz');
  fs.writeFileSync(file, 'hi', 'utf-8');

  const { ctx, sentEvents } = makeCtx();
  await handleReadFile(ctx, { type: 'read_file', path: file, request_id: 'r1' } as never);

  const ev = sentEvents[0].event as unknown as { language?: string };
  assert.equal(ev.language, undefined);
});

// ---------------------------------------------------------------------------
// handleGetHistory
// ---------------------------------------------------------------------------

test('handleGetHistory forwards all options to sendSessionHistory', () => {
  const { ctx, historyCalls } = makeCtx();
  handleGetHistory(ctx, {
    type: 'get_history',
    session_id: 'sess-1',
    since: '2025-01-01T00:00:00Z',
    since_seq: 42,
    offset: 10,
    limit: 100,
  } as never);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].sessionId, 'sess-1');
  assert.deepEqual(historyCalls[0].options, {
    since: '2025-01-01T00:00:00Z',
    sinceSeq: 42,
    offset: 10,
    limit: 100,
  });
});

test('handleGetHistory passes undefined options through unchanged', () => {
  const { ctx, historyCalls } = makeCtx();
  handleGetHistory(ctx, { type: 'get_history', session_id: 'sess-1' } as never);
  assert.deepEqual(historyCalls[0].options, {
    since: undefined,
    sinceSeq: undefined,
    offset: undefined,
    limit: undefined,
  });
});

// ---------------------------------------------------------------------------
// handleSyncRequest
// ---------------------------------------------------------------------------

test('handleSyncRequest replays history for daemon sessions and phone-cursored sessions', () => {
  const { ctx, sentEvents, historyCalls } = makeCtx({
    sessions: [{ claudeSessionId: 'sess-a' }, { claudeSessionId: 'sess-b' }],
    sendSessionHistory: () => 99,
  });
  handleSyncRequest(ctx, {
    type: 'sync_request',
    request_id: 'req-1',
    cursors: [
      { session_id: 'sess-b', last_seq: 50 },
      { session_id: 'sess-c', last_seq: 0 },
    ],
  } as never);

  // sessions union: a (daemon), b (both), c (phone)
  const replayedIds = new Set(historyCalls.map((c) => c.sessionId));
  assert.equal(replayedIds.size, 3);
  assert.ok(replayedIds.has('sess-a'));
  assert.ok(replayedIds.has('sess-b'));
  assert.ok(replayedIds.has('sess-c'));

  // 'sess-b' had a cursor of 50 -> sinceSeq 50; others have no cursor -> sinceSeq undefined
  const callForB = historyCalls.find((c) => c.sessionId === 'sess-b');
  assert.equal(callForB?.options?.sinceSeq, 50);
  const callForA = historyCalls.find((c) => c.sessionId === 'sess-a');
  assert.equal(callForA?.options?.sinceSeq, undefined);

  // 'sess-c' last_seq is 0 (>=0) -> sinceSeq 0
  const callForC = historyCalls.find((c) => c.sessionId === 'sess-c');
  assert.equal(callForC?.options?.sinceSeq, 0);

  // sync_complete event includes one delivery per session (all returned 99)
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as {
    type: string;
    request_id: string;
    delivered: Array<{ session_id: string; last_seq: number }>;
  };
  assert.equal(ev.type, 'sync_complete');
  assert.equal(ev.request_id, 'req-1');
  assert.equal(ev.delivered.length, 3);
  for (const d of ev.delivered) assert.equal(d.last_seq, 99);
});

test('handleSyncRequest excludes sessions whose sendSessionHistory returns undefined', () => {
  const { ctx, sentEvents } = makeCtx({
    sessions: [{ claudeSessionId: 'sess-a' }],
    sendSessionHistory: (id) => (id === 'sess-a' ? undefined : 7),
  });
  handleSyncRequest(ctx, {
    type: 'sync_request',
    request_id: 'req-1',
    cursors: [{ session_id: 'sess-b', last_seq: 0 }],
  } as never);

  const ev = sentEvents[0].event as unknown as {
    delivered: Array<{ session_id: string; last_seq: number }>;
  };
  // sess-a returned undefined -> skipped; sess-b returned 7 -> kept
  assert.equal(ev.delivered.length, 1);
  assert.equal(ev.delivered[0].session_id, 'sess-b');
  assert.equal(ev.delivered[0].last_seq, 7);
});

test('handleSyncRequest tolerates an empty cursors array and an empty session list', () => {
  const { ctx, sentEvents, historyCalls } = makeCtx({ sessions: [] });
  handleSyncRequest(ctx, { type: 'sync_request', request_id: 'req-1' } as never);
  assert.equal(historyCalls.length, 0);
  assert.equal(sentEvents.length, 1);
  const ev = sentEvents[0].event as unknown as { type: string; delivered: unknown[] };
  assert.equal(ev.type, 'sync_complete');
  assert.deepEqual(ev.delivered, []);
});

test('handleSyncRequest filters out sessions without claudeSessionId', () => {
  const { ctx, historyCalls } = makeCtx({
    sessions: [
      { claudeSessionId: 'sess-a' },
      {}, // no claudeSessionId
      { claudeSessionId: undefined },
    ],
    sendSessionHistory: () => 1,
  });
  handleSyncRequest(ctx, { type: 'sync_request', request_id: 'req-1' } as never);
  const ids = historyCalls.map((c) => c.sessionId);
  assert.deepEqual(ids, ['sess-a']);
});
