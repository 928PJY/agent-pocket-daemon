import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { getSubagentHistory } from '../src/discovery/subagent-history.js';

// ---------------------------------------------------------------------------
// In-memory fs fake
// ---------------------------------------------------------------------------

interface FakeStat { size: number; }

interface FakeFsState {
  files: Map<string, string>;       // absolute path -> contents
  dirs: Set<string>;                // absolute path
  writes: Map<string, string>;      // captures writeFileSync
  fdMap: Map<number, string>;       // fd -> path (for openSync/readSync/closeSync)
  nextFd: number;
}

function makeFakeFs(state: FakeFsState) {
  return {
    existsSync: (p: string) => state.files.has(p) || state.dirs.has(p),
    readdirSync: ((p: string) => {
      if (!state.dirs.has(p)) throw new Error(`ENOENT: ${p}`);
      const prefix = p.endsWith('/') ? p : p + '/';
      const out = new Set<string>();
      for (const f of state.files.keys()) {
        if (f.startsWith(prefix)) {
          const tail = f.slice(prefix.length);
          if (!tail.includes('/')) out.add(tail);
        }
      }
      return Array.from(out);
    }) as unknown as typeof import('node:fs').readdirSync,
    statSync: ((p: string): FakeStat => {
      const c = state.files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return { size: Buffer.byteLength(c, 'utf-8') };
    }) as unknown as typeof import('node:fs').statSync,
    readFileSync: ((p: string) => {
      const c = state.files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    }) as unknown as typeof import('node:fs').readFileSync,
    openSync: ((p: string): number => {
      if (!state.files.has(p)) throw new Error(`ENOENT: ${p}`);
      const fd = state.nextFd++;
      state.fdMap.set(fd, p);
      return fd;
    }) as unknown as typeof import('node:fs').openSync,
    readSync: ((fd: number, buf: Buffer, offset: number, length: number, position: number): number => {
      const p = state.fdMap.get(fd);
      if (!p) throw new Error('bad fd');
      const c = state.files.get(p)!;
      const slice = Buffer.from(c, 'utf-8').slice(position, position + length);
      slice.copy(buf, offset);
      return slice.length;
    }) as unknown as typeof import('node:fs').readSync,
    closeSync: ((fd: number) => { state.fdMap.delete(fd); }) as unknown as typeof import('node:fs').closeSync,
    writeFileSync: ((p: string, data: string) => {
      state.writes.set(p, data);
      state.files.set(p, data);
    }) as unknown as typeof import('node:fs').writeFileSync,
  };
}

function emptyState(): FakeFsState {
  return { files: new Map(), dirs: new Set(), writes: new Map(), fdMap: new Map(), nextFd: 1 };
}

function setup(sessionFilePath: string) {
  const state = emptyState();
  const jsonlDir = path.dirname(sessionFilePath);
  const base = path.basename(sessionFilePath, '.jsonl');
  const subagentsDir = path.join(jsonlDir, base, 'subagents');
  return { state, subagentsDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SESSION = '/proj/abc/sess.jsonl';

test('returns [] when subagents dir does not exist', () => {
  const state = emptyState();
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.deepEqual(out, []);
});

test('returns [] when readdir throws', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  const fake = makeFakeFs(state);
  const out = getSubagentHistory(SESSION, {
    fsImpl: { ...fake, readdirSync: (() => { throw new Error('EACCES'); }) as unknown as typeof import('node:fs').readdirSync },
  });
  assert.deepEqual(out, []);
});

test('skips non-.jsonl entries in subagents dir', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'README.txt'), 'ignore');
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.deepEqual(out, []);
});

test('parses a single subagent JSONL with text + tool_use blocks (no archive, no meta)', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  const jsonl = [
    JSON.stringify({ type: 'assistant', timestamp: '2025-01-01T00:00:00.000Z', message: { content: [
      { type: 'text', text: 'hi from sub' },
      { type: 'tool_use', name: 'Read', id: 't1', input: { path: '/x' } },
    ] } }),
  ].join('\n');
  state.files.set(path.join(subagentsDir, 'agent-aaa.jsonl'), jsonl);
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'subagent');
  assert.equal(out[0].content, 'hi from sub');
  assert.equal(out[0].agentId, 'aaa');
  assert.equal(out[0].agentName, 'Subagent');
  assert.equal(out[0].agentType, 'unknown');
  assert.equal(out[0].innerEventType, 'assistant_message');
  assert.equal(out[1].innerEventType, 'tool_use');
  assert.equal(out[1].toolName, 'Read');
  assert.equal(out[1].toolId, 't1');
  assert.deepEqual(out[1].toolInput, { path: '/x' });
});

test('reads meta.json for agentName + agentType', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-x.meta.json'), JSON.stringify({
    description: 'My Agent', agentType: 'researcher',
  }));
  state.files.set(path.join(subagentsDir, 'agent-x.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'hi' }] } }),
  );
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.equal(out[0].agentName, 'My Agent');
  assert.equal(out[0].agentType, 'researcher');
});

test('falls back to defaults when meta.json is corrupt', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-x.meta.json'), '{not json');
  state.files.set(path.join(subagentsDir, 'agent-x.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'hi' }] } }),
  );
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.equal(out[0].agentName, 'Subagent');
  assert.equal(out[0].agentType, 'unknown');
});

test('reads archive.json for status / counts (fast path)', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-x.archive.json'), JSON.stringify({
    status: 'done', toolUseCount: 7, tokenCount: 12345,
  }));
  state.files.set(path.join(subagentsDir, 'agent-x.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'hi' }] } }),
  );
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.equal(out[0].agentStatus, 'done');
  assert.equal(out[0].subagentToolUseCount, 7);
  assert.equal(out[0].subagentTokenCount, 12345);
});

test('treats corrupt archive.json as missing (continues to replay)', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-x.archive.json'), 'broken');
  state.files.set(path.join(subagentsDir, 'agent-x.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'a' }],
    } }),
  );
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state), nowFn: () => 1000 });
  assert.equal(out[0].subagentToolUseCount, 1);
  assert.equal(out[0].subagentTokenCount, 30);
});

test('replays JSONL when archive missing — sums tokens (cache + input + output) and dedups tool_use ids', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  const jsonl = [
    JSON.stringify({ type: 'assistant', timestamp: '2025-01-01T00:00:00.000Z', message: {
      usage: { input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
      content: [{ type: 'tool_use', id: 'A' }, { type: 'tool_use', id: 'B' }],
    } }),
    JSON.stringify({ type: 'assistant', timestamp: '2025-01-01T00:01:00.000Z', message: {
      usage: { input_tokens: 100, output_tokens: 200 },
      content: [{ type: 'tool_use', id: 'A' }, { type: 'tool_use', id: 'C' }, { type: 'text', text: 'last' }],
    } }),
  ].join('\n');
  state.files.set(path.join(subagentsDir, 'agent-z.jsonl'), jsonl);
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  // tokens = LATEST usage (not summed across rows): 100 + 200 = 300
  assert.equal(out[0].subagentTokenCount, 300);
  // tools deduped: A, B, C = 3
  assert.equal(out[0].subagentToolUseCount, 3);
});

test('writes archive.json when JSONL ends with stop_reason=end_turn and archive missing', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  const jsonl = JSON.stringify({
    type: 'assistant',
    timestamp: '2025-01-01T00:00:00.000Z',
    message: {
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [{ type: 'tool_use', id: 'A' }, { type: 'text', text: 'done' }],
    },
  });
  state.files.set(path.join(subagentsDir, 'agent-w.jsonl'), jsonl);
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state), nowFn: () => 9999 });
  assert.equal(out[0].agentStatus, 'done');
  const archivePath = path.join(subagentsDir, 'agent-w.archive.json');
  assert.ok(state.writes.has(archivePath));
  const arc = JSON.parse(state.writes.get(archivePath)!);
  assert.equal(arc.status, 'done');
  assert.equal(arc.toolUseCount, 1);
  assert.equal(arc.tokenCount, 3);
  assert.equal(arc.archivedAt, 9999);
  assert.equal(arc.agentId, 'w');
});

test('does NOT write archive when JSONL did not end with end_turn', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-q.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: {
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'midway' }],
    } }),
  );
  getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state), nowFn: () => 100 });
  assert.equal(state.writes.size, 0);
});

test('archive write swallows errors (non-fatal)', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-e.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: {
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }],
    } }),
  );
  const fake = makeFakeFs(state);
  const out = getSubagentHistory(SESSION, {
    fsImpl: { ...fake, writeFileSync: (() => { throw new Error('EROFS'); }) as unknown as typeof import('node:fs').writeFileSync },
    nowFn: () => 1,
  });
  // Status still set; just no persistence
  assert.equal(out[0].agentStatus, 'done');
});

test('skips files where statSync throws (e.g. concurrent unlink)', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-a.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'a' }] } }),
  );
  const fake = makeFakeFs(state);
  const out = getSubagentHistory(SESSION, {
    fsImpl: { ...fake, statSync: (() => { throw new Error('ENOENT'); }) as unknown as typeof import('node:fs').statSync },
  });
  assert.deepEqual(out, []);
});

test('uses tail-read when JSONL exceeds 20MB', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  // First line will be partial — function discards everything before first newline.
  const big = 'partial-line-discarded\n' + 'x'.repeat(20 * 1024 * 1024);
  // The tail will be all 'x's; not valid JSON, all parse errors are skipped.
  state.files.set(path.join(subagentsDir, 'agent-big.jsonl'), big);
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.deepEqual(out, []);
});

test('skips unparseable lines during emit pass (and during replay)', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  const jsonl = [
    'not-json',
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'good' }] } }),
  ].join('\n');
  state.files.set(path.join(subagentsDir, 'agent-m.jsonl'), jsonl);
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'good');
});

test('skips non-assistant entries in emit pass', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  const jsonl = [
    JSON.stringify({ type: 'user', timestamp: 't', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'a' }] } }),
  ].join('\n');
  state.files.set(path.join(subagentsDir, 'agent-n.jsonl'), jsonl);
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'a');
});

test('skips assistant rows with missing/non-array content in emit pass', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  const jsonl = [
    JSON.stringify({ type: 'assistant', message: { content: 'string-not-array' } }),
    JSON.stringify({ type: 'assistant', message: {} }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } }),
  ].join('\n');
  state.files.set(path.join(subagentsDir, 'agent-s.jsonl'), jsonl);
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'kept');
});

test('truncates tool_use input via truncateToolInput', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  const long = 'y'.repeat(3000);
  state.files.set(path.join(subagentsDir, 'agent-t.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { content: [
      { type: 'tool_use', name: 'Write', id: 'tt', input: { content: long } },
    ] } }),
  );
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  const body = (out[0].toolInput as { content: string }).content;
  assert.ok(body.length < long.length);
  assert.ok(body.endsWith('chars]'));
});

test('sorts results by timestamp ascending across multiple agent files', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-a.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: '2025-01-01T00:00:02.000Z', message: { content: [{ type: 'text', text: 'second' }] } }),
  );
  state.files.set(path.join(subagentsDir, 'agent-b.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: '2025-01-01T00:00:01.000Z', message: { content: [{ type: 'text', text: 'first' }] } }),
  );
  const out = getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state) });
  assert.equal(out[0].content, 'first');
  assert.equal(out[1].content, 'second');
});

test('handles entries with no timestamp during replay (firstTs/lastTs stay null)', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-nt.jsonl'),
    JSON.stringify({ type: 'assistant', message: {
      stop_reason: 'end_turn', usage: { input_tokens: 1 }, content: [{ type: 'text', text: 'hi' }],
    } }),
  );
  getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state), nowFn: () => 5 });
  const arc = JSON.parse(state.writes.get(path.join(subagentsDir, 'agent-nt.archive.json'))!);
  assert.equal(arc.firstEventAt, null);
  assert.equal(arc.lastEventAt, null);
});

test('handles entries with non-parseable timestamps during replay', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  state.files.set(path.join(subagentsDir, 'agent-bt.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 'not-a-date', message: {
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }],
    } }),
  );
  getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state), nowFn: () => 7 });
  const arc = JSON.parse(state.writes.get(path.join(subagentsDir, 'agent-bt.archive.json'))!);
  assert.equal(arc.firstEventAt, null);
});

test('does not double-write archive when archive already exists', () => {
  const { state, subagentsDir } = setup(SESSION);
  state.dirs.add(subagentsDir);
  // archive present with only status missing
  state.files.set(path.join(subagentsDir, 'agent-x.archive.json'), JSON.stringify({
    toolUseCount: 4, tokenCount: 9,
  }));
  state.files.set(path.join(subagentsDir, 'agent-x.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: 't', message: {
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }],
    } }),
  );
  getSubagentHistory(SESSION, { fsImpl: makeFakeFs(state), nowFn: () => 1 });
  // We did NOT writeFileSync because existsSync(archivePath) was true.
  assert.equal(state.writes.size, 0);
});

test('default fsImpl + nowFn are usable (smoke test against real fs miss)', () => {
  // Real fs: subagents dir does not exist → returns []
  const out = getSubagentHistory('/nonexistent-dir/whatever.jsonl');
  assert.deepEqual(out, []);
});
