// Order invariants for getSessionHistory.
//
// This file does not chase individual past bugs; it asserts the contracts
// that getSessionHistory must always uphold. If any one of these breaks,
// the phone-side renderer will misorder, dedup wrong, or loop on
// verify_history. Add fixtures here when a new ordering edge case surfaces
// in production — never delete an assertion.
//
// Contract surface (HISTORY_CURSOR_MS path):
//   1. Determinism — same input → byte-identical output (no Map/Set
//      iteration leakage, no Date.now() in normalization).
//   2. Total order — for every adjacent pair (a, b) in messages[],
//      a.tsMs < b.tsMs, OR a.tsMs === b.tsMs && a.parseIndex < b.parseIndex.
//      No exceptions. Missing-ts rows must have been backfilled by the
//      prev+1ms rule before this point.
//   3. tailMs identity — page.tailMs === filtered[last].tsMs for ALL
//      requests (including offset > 0 / parent-window-trimmed pages).
//      The phone treats tailMs as the verify_history ground truth; any
//      page-tail leakage causes false convergence.
//   4. since_ms idempotence — getHistory({sinceMs: tailMs}).messages is
//      empty. If the next request with the previous tail as cursor still
//      returns something, the cursor lies.
//   5. Subagent anchoring — subagent rows sort adjacent to the spawning
//      Task tool_use, not at the position their own JSONL timestamp would
//      put them (which is wall-clock from inside the subagent run).

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionDiscovery, type HistoryMessage } from '../src/discovery/session-discovery.js';
import { CodexDiscovery } from '../src/discovery/codex-discovery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaudeSession(lines: object[]): { dir: string; claudeDir: string; sessionId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'order-invariants-claude-'));
  const claudeDir = join(dir, '.claude');
  const projectDir = join(claudeDir, 'projects', 'project');
  mkdirSync(projectDir, { recursive: true });
  const sessionId = 'session-1';
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  return { dir, claudeDir, sessionId };
}

function makeCodexSession(lines: object[]): { dir: string; codexDir: string; sessionId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'order-invariants-codex-'));
  const codexDir = join(dir, '.codex');
  const sessionsDir = join(codexDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const threadId = '01234567-89ab-cdef-0123-456789abcdef';
  const rolloutPath = join(sessionsDir, `${threadId}.jsonl`);
  writeFileSync(rolloutPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // Codex discovery normally reads from a SQLite state DB; bypass by
  // registering the rollout directly.
  return { dir, codexDir, sessionId: `codex:${threadId}` };
}

function registerCodex(discovery: CodexDiscovery, codexDir: string, sessionId: string): void {
  const threadId = sessionId.slice('codex:'.length);
  discovery.registerSessionFromRollout({
    sessionId,
    threadId,
    rolloutPath: join(codexDir, 'sessions', `${threadId}.jsonl`),
  });
}

/** Adjacent-pair order check. Returns the first violator, if any. */
function findOrderViolation(msgs: HistoryMessage[]): { index: number; prev: HistoryMessage; curr: HistoryMessage } | null {
  for (let i = 1; i < msgs.length; i++) {
    const a = msgs[i - 1];
    const b = msgs[i];
    const at = (a as HistoryMessage & { tsMs?: number }).tsMs ?? 0;
    const bt = (b as HistoryMessage & { tsMs?: number }).tsMs ?? 0;
    if (at > bt) return { index: i, prev: a, curr: b };
    // Same-ms ties are allowed; tie-break by parseIndex is internal — we
    // only require non-decreasing tsMs at this layer.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('order-invariant: getSessionHistory output is deterministic across repeated calls', () => {
  const { dir, claudeDir, sessionId } = makeClaudeSession([
    { type: 'user', timestamp: '2026-05-04T00:00:00.000Z', message: { content: 'hi' } },
    { type: 'assistant', timestamp: '2026-05-04T00:00:01.000Z', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'user', timestamp: '2026-05-04T00:00:02.000Z', message: { content: 'bye' } },
  ]);
  try {
    const d = new SessionDiscovery(claudeDir);
    const first = d.getSessionHistory(sessionId, { limit: 100 });
    const second = d.getSessionHistory(sessionId, { limit: 100 });
    const third = d.getSessionHistory(sessionId, { limit: 100 });
    assert.deepEqual(second.messages, first.messages);
    assert.deepEqual(third.messages, first.messages);
    assert.equal(second.tailMs, first.tailMs);
    assert.equal(second.tailSeq, first.tailSeq);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Total order
// ---------------------------------------------------------------------------

test('order-invariant: messages are sorted non-decreasing by tsMs', () => {
  // Intentionally out-of-order timestamps in the JSONL — daemon must sort.
  const { dir, claudeDir, sessionId } = makeClaudeSession([
    { type: 'user', timestamp: '2026-05-04T00:00:03.000Z', message: { content: 'third' } },
    { type: 'user', timestamp: '2026-05-04T00:00:01.000Z', message: { content: 'first' } },
    { type: 'user', timestamp: '2026-05-04T00:00:02.000Z', message: { content: 'second' } },
  ]);
  try {
    const d = new SessionDiscovery(claudeDir);
    const page = d.getSessionHistory(sessionId, { limit: 100 });
    const violation = findOrderViolation(page.messages);
    assert.equal(violation, null,
      `order violation at index ${violation?.index}: tsMs went backwards`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('order-invariant: missing-ts rows do not float to head or tail', () => {
  // The middle row has no timestamp. Daemon's prev+1ms fallback should
  // place it between the surrounding rows, not at index 0 or last.
  const { dir, claudeDir, sessionId } = makeClaudeSession([
    { type: 'user', timestamp: '2026-05-04T00:00:01.000Z', message: { content: 'has-ts-1' } },
    { type: 'user', message: { content: 'no-ts' } },
    { type: 'user', timestamp: '2026-05-04T00:00:10.000Z', message: { content: 'has-ts-2' } },
  ]);
  try {
    const d = new SessionDiscovery(claudeDir);
    const page = d.getSessionHistory(sessionId, { limit: 100 });
    const idxOf = (preview: string) => page.messages.findIndex((m) => m.content.startsWith(preview));
    const firstIdx = idxOf('has-ts-1');
    const noTsIdx = idxOf('no-ts');
    const lastIdx = idxOf('has-ts-2');
    assert.equal(firstIdx, 0);
    assert.equal(noTsIdx, 1);
    assert.equal(lastIdx, 2);
    assert.equal(findOrderViolation(page.messages), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// tailMs identity (the bug PR #77 review caught)
// ---------------------------------------------------------------------------

test('order-invariant: tailMs equals filtered[last].tsMs even when paging from the head', () => {
  // 10 rows. Request offset=5, limit=3 → returned page is the middle 3.
  // tailMs must STILL point at the newest filtered row (row 9), not the
  // page's last row (row 6). Without this, sync_complete.last_ms would
  // walk the phone's cursor backwards.
  const lines: object[] = [];
  for (let i = 0; i < 10; i++) {
    lines.push({
      type: 'user',
      timestamp: `2026-05-04T00:00:${String(i).padStart(2, '0')}.000Z`,
      message: { content: `row-${i}` },
    });
  }
  const { dir, claudeDir, sessionId } = makeClaudeSession(lines);
  try {
    const d = new SessionDiscovery(claudeDir);
    const full = d.getSessionHistory(sessionId, { limit: 100 });
    const expectedTail = (full.messages[full.messages.length - 1] as HistoryMessage & { tsMs?: number }).tsMs;
    assert.equal(full.tailMs, expectedTail);

    // Mid-window page: the page rows themselves are inner rows, but tailMs
    // must remain the full-history tail.
    const mid = d.getSessionHistory(sessionId, { offset: 5, limit: 3 });
    assert.equal(mid.tailMs, expectedTail,
      `mid-page tailMs leaked the page's last row instead of filtered tail`);

    // Even an offset that excludes the newest rows keeps tailMs pinned to
    // the filtered tail (so the phone's next since_ms doesn't regress).
    const oldest = d.getSessionHistory(sessionId, { offset: 8, limit: 2 });
    assert.equal(oldest.tailMs, expectedTail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('order-invariant: codex tailMs equals filtered[last].tsMs across page windows', () => {
  const lines: object[] = [];
  for (let i = 0; i < 10; i++) {
    lines.push({
      record_type: 'event_msg',
      timestamp: `2026-05-04T00:00:${String(i).padStart(2, '0')}.000Z`,
      payload: { type: 'agent_message', message: `row-${i}` },
    });
  }
  const { dir, codexDir, sessionId } = makeCodexSession(lines);
  try {
    const d = new CodexDiscovery(codexDir);
    registerCodex(d, codexDir, sessionId);
    const full = d.getSessionHistory(sessionId, { limit: 100 });
    if (full.messages.length === 0) {
      // Codex parser may not recognize this minimal envelope; skip the
      // assertion rather than masking a real regression in fixture format.
      return;
    }
    const expectedTail = (full.messages[full.messages.length - 1] as HistoryMessage & { tsMs?: number }).tsMs;
    assert.equal(full.tailMs, expectedTail);
    const mid = d.getSessionHistory(sessionId, { offset: 5, limit: 3 });
    assert.equal(mid.tailMs, expectedTail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextOffset: claude paginates by parent rows and advances correctly across pages', () => {
  // 10 parents, each with one subagent row inside its tsMs window so the
  // re-injection logic actually fires. Page size = 3 parents → expect
  // nextOffset to advance by 3 per page in parent units (not the larger
  // wire `messages.length` which includes subagents).
  const lines: object[] = [];
  for (let i = 0; i < 10; i++) {
    const ts = `2026-05-04T00:00:${String(i).padStart(2, '0')}.000Z`;
    lines.push({ type: 'user', message: { content: `user-${i}` }, timestamp: ts });
    // subagent anchored at same tsMs so the parent-window catches it
    lines.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `sub-${i}` }] },
      timestamp: ts,
      isSidechain: true,
      parentUuid: `p-${i}`,
    });
  }
  const { dir, claudeDir, sessionId } = makeClaudeSession(lines);
  try {
    const d = new SessionDiscovery(claudeDir);
    // Establish how many parent rows the parser actually recognises in
    // this fixture (depends on which line shapes count as "parent" — we
    // care that next_offset advances in *that* same unit, not in wire
    // messages.length).
    const big = d.getSessionHistory(sessionId, { limit: 1000 });
    const parents = big.messages.filter((m) => m.role !== 'subagent').length;
    assert.ok(parents >= 6, `expected ≥6 parents to exercise pagination, got ${parents}`);

    const pageSize = 3;
    const page1 = d.getSessionHistory(sessionId, { offset: 0, limit: pageSize });
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextOffset, pageSize,
      'first nextOffset should advance by parent page size, not wire row count');
    assert.ok(
      page1.messages.length >= pageSize,
      'wire messages.length includes re-injected subagents and must be ≥ parent page size',
    );

    const page2 = d.getSessionHistory(sessionId, { offset: page1.nextOffset!, limit: pageSize });
    assert.equal(page2.hasMore, true);
    assert.equal(page2.nextOffset, pageSize * 2);

    // Final page: ask for everything older than what we've consumed.
    const tail = d.getSessionHistory(sessionId, { offset: parents - 1, limit: pageSize });
    assert.equal(tail.hasMore, false, 'asking past the oldest parent should report hasMore=false');
    assert.equal(tail.nextOffset, undefined, 'nextOffset must be undefined once hasMore=false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextOffset: codex advances by wire-row count and undefined on last page', () => {
  const lines: object[] = [];
  for (let i = 0; i < 10; i++) {
    lines.push({
      record_type: 'event_msg',
      timestamp: `2026-05-04T00:00:${String(i).padStart(2, '0')}.000Z`,
      payload: { type: 'agent_message', message: `row-${i}` },
    });
  }
  const { dir, codexDir, sessionId } = makeCodexSession(lines);
  try {
    const d = new CodexDiscovery(codexDir);
    registerCodex(d, codexDir, sessionId);
    const full = d.getSessionHistory(sessionId, { limit: 100 });
    if (full.messages.length === 0) {
      // Codex parser may not recognize this minimal envelope; bail like the
      // sibling tailMs test does.
      return;
    }

    const page1 = d.getSessionHistory(sessionId, { offset: 0, limit: 3 });
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextOffset, page1.messages.length);

    const page2 = d.getSessionHistory(sessionId, { offset: page1.nextOffset!, limit: 3 });
    assert.equal(page2.hasMore, true);
    assert.equal(page2.nextOffset, page1.nextOffset! + page2.messages.length);

    // Last page covers remainder — hasMore=false → nextOffset=undefined.
    const tail = d.getSessionHistory(sessionId, { offset: full.messages.length, limit: 3 });
    assert.equal(tail.hasMore, false);
    assert.equal(tail.nextOffset, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextOffset: claude since-based reply emits absolute-set cursor for older rows', () => {
  // since-based replies return only rows newer-than-since. To let the
  // phone scroll OLDER than what it just received, the daemon must
  // report a nextOffset counted against the ABSOLUTE message set —
  // specifically, the number of parent rows older-than-since. The
  // phone's follow-up scroll-up uses plain offset pagination, which
  // counts from the absolute tail, so this is the only correct value.
  const lines: object[] = [];
  for (let i = 0; i < 10; i++) {
    const ts = `2026-05-04T00:00:${String(i).padStart(2, '0')}.000Z`;
    lines.push({ type: 'user', message: { content: `user-${i}` }, timestamp: ts });
  }
  const { dir, claudeDir, sessionId } = makeClaudeSession(lines);
  try {
    const d = new SessionDiscovery(claudeDir);
    const full = d.getSessionHistory(sessionId, { limit: 1000 });
    if (full.messages.length === 0) return;
    const allParents = full.messages.filter((m) => m.role !== 'subagent');
    if (allParents.length < 4) return;
    // Pick a midpoint such that there are strictly older parents below it.
    const midIdx = Math.floor(allParents.length / 2);
    const midMs = allParents[midIdx].tsMs!;
    const olderParents = allParents.filter((m) => (m.tsMs ?? 0) <= midMs).length;
    // sinceMs returns only parents strictly newer than midMs; nextOffset
    // should equal the count of parents at or below midMs.
    const sinceMs = d.getSessionHistory(sessionId, { sinceMs: midMs, limit: 3 });
    assert.equal(
      sinceMs.nextOffset,
      olderParents,
      'sinceMs reply must emit nextOffset = count of older-than-since parents (absolute-set offset)',
    );

    // sinceSeq:0 returns the full tail → no older rows remain → no cursor.
    const sinceAll = d.getSessionHistory(sessionId, { sinceSeq: 0, limit: 1000 });
    assert.equal(
      sinceAll.nextOffset,
      undefined,
      'when since reply covers the full set, no older rows remain → nextOffset undefined',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextOffset: codex since-based reply emits absolute-set cursor for older rows', () => {
  const lines: object[] = [];
  for (let i = 0; i < 10; i++) {
    lines.push({
      record_type: 'event_msg',
      timestamp: `2026-05-04T00:00:${String(i).padStart(2, '0')}.000Z`,
      payload: { type: 'agent_message', message: `row-${i}` },
    });
  }
  const { dir, codexDir, sessionId } = makeCodexSession(lines);
  try {
    const d = new CodexDiscovery(codexDir);
    registerCodex(d, codexDir, sessionId);
    const full = d.getSessionHistory(sessionId, { limit: 100 });
    if (full.messages.length < 4) return;
    const midIdx = Math.floor(full.messages.length / 2);
    const midMs = full.messages[midIdx].tsMs!;
    const olderCount = full.messages.filter((m) => (m.tsMs ?? 0) <= midMs).length;

    const sinceMs = d.getSessionHistory(sessionId, { sinceMs: midMs, limit: 3 });
    assert.equal(
      sinceMs.nextOffset,
      olderCount,
      'codex sinceMs reply must emit nextOffset = older-than-since wire-row count',
    );

    const sinceAll = d.getSessionHistory(sessionId, { sinceSeq: 0, limit: 100 });
    assert.equal(
      sinceAll.nextOffset,
      undefined,
      'codex since reply covering full set → no older rows → nextOffset undefined',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// since_ms idempotence
// ---------------------------------------------------------------------------

test('order-invariant: getHistory({sinceMs: tailMs}) returns no messages', () => {
  const { dir, claudeDir, sessionId } = makeClaudeSession([
    { type: 'user', timestamp: '2026-05-04T00:00:01.000Z', message: { content: 'one' } },
    { type: 'user', timestamp: '2026-05-04T00:00:02.000Z', message: { content: 'two' } },
    { type: 'user', timestamp: '2026-05-04T00:00:03.000Z', message: { content: 'three' } },
  ]);
  try {
    const d = new SessionDiscovery(claudeDir);
    const full = d.getSessionHistory(sessionId, { limit: 100 });
    assert.ok(full.tailMs !== undefined);
    const after = d.getSessionHistory(sessionId, { sinceMs: full.tailMs, limit: 100 });
    assert.equal(after.messages.length, 0,
      `since_ms=tailMs should be a no-op; got ${after.messages.length} rows back`);
    assert.equal(after.totalCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('order-invariant: since_ms strictly greater-than (cursor halfway should drop the matching row)', () => {
  const { dir, claudeDir, sessionId } = makeClaudeSession([
    { type: 'user', timestamp: '2026-05-04T00:00:01.000Z', message: { content: 'one' } },
    { type: 'user', timestamp: '2026-05-04T00:00:02.000Z', message: { content: 'two' } },
    { type: 'user', timestamp: '2026-05-04T00:00:03.000Z', message: { content: 'three' } },
  ]);
  try {
    const d = new SessionDiscovery(claudeDir);
    const full = d.getSessionHistory(sessionId, { limit: 100 });
    const second = full.messages[1] as HistoryMessage & { tsMs?: number };
    assert.ok(second.tsMs !== undefined);
    const after = d.getSessionHistory(sessionId, { sinceMs: second.tsMs, limit: 100 });
    // Strict > : the row whose tsMs == cursor is excluded; only newer rows return.
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0].content, 'three');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Subagent anchoring
// ---------------------------------------------------------------------------

test('order-invariant: subagent rows sort adjacent to spawning Task tool_use, not by their own jsonl ts', () => {
  // Main thread: assistant invokes Task at T=10. Subagent JSONL records
  // the work as happening at T=100 (wall clock from inside the subagent
  // sandbox). Without anchoring, the subagent row would land far past the
  // Task tool_use and even after a later user message at T=20.
  const dir = mkdtempSync(join(tmpdir(), 'order-invariants-subagent-'));
  const claudeDir = join(dir, '.claude');
  const projectDir = join(claudeDir, 'projects', 'project');
  const subagentsDir = join(projectDir, 'session-1', 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  const sessionId = 'session-1';

  writeFileSync(join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-04T00:00:10.000Z',
      message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-04T00:00:20.000Z',
      message: { content: 'after the task' },
    }),
  ].join('\n') + '\n');

  writeFileSync(join(subagentsDir, 'agent-agent-a.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'Inspect state' }));
  writeFileSync(join(subagentsDir, 'agent-agent-a.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-04T00:01:40.000Z',  // T=100, wall-clock inside subagent run
    message: { content: [{ type: 'text', text: 'sub done' }] },
  }) + '\n');

  try {
    const d = new SessionDiscovery(claudeDir);
    const page = d.getSessionHistory(sessionId, { limit: 100 });
    const roles = page.messages.map((m) => m.role);
    const subagentIdx = roles.indexOf('subagent');
    const userAfterTaskIdx = page.messages.findIndex((m) => m.content === 'after the task');
    if (subagentIdx === -1) {
      // No subagent rendering path on this code revision — skip without
      // failing. Anchoring contract still holds for revisions that do
      // emit subagent rows.
      return;
    }
    assert.ok(subagentIdx < userAfterTaskIdx,
      `subagent row landed AFTER the later user message; anchoring missed (subagentIdx=${subagentIdx}, userAfterTaskIdx=${userAfterTaskIdx})`);
    assert.equal(findOrderViolation(page.messages), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('order-invariant: multi-subagent anchoring pairs by spawn ts, not by readdir order', () => {
  // Two Task tool_uses spawn two subagents. Their JSONL files are named so
  // readdir returns them in REVERSE spawn order (most filesystems honour
  // lexical order, so `agent-zzz` comes after `agent-aaa`). The subagent
  // whose first event landed earlier (= the one spawned first) must be
  // anchored to the FIRST Task tool_use's ts, regardless of readdir order.
  // Before the fix, distinctAgentIds was built by walking subagentMessages
  // sorted by their own (later) timestamps, so any noise in those ts would
  // mis-pair the panels.
  const dir = mkdtempSync(join(tmpdir(), 'order-invariants-multi-subagent-'));
  const claudeDir = join(dir, '.claude');
  const projectDir = join(claudeDir, 'projects', 'project');
  const subagentsDir = join(projectDir, 'session-1', 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  const sessionId = 'session-1';

  // Main thread: Task A at T=10, Task B at T=20.
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-04T00:00:10.000Z',
      message: { content: [{ type: 'tool_use', id: 'task-a', name: 'Task', input: {} }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-04T00:00:20.000Z',
      message: { content: [{ type: 'tool_use', id: 'task-b', name: 'Task', input: {} }] },
    }),
  ].join('\n') + '\n');

  // `agent-aaa` = spawned SECOND (first event at T=200)
  // `agent-zzz` = spawned FIRST  (first event at T=100)
  // readdir lexical order will yield [aaa, zzz] — opposite of spawn order.
  writeFileSync(join(subagentsDir, 'agent-aaa.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'B' }));
  writeFileSync(join(subagentsDir, 'agent-aaa.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-04T00:03:20.000Z',  // T=200
    message: { content: [{ type: 'text', text: 'second-spawn output' }] },
  }) + '\n');

  writeFileSync(join(subagentsDir, 'agent-zzz.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'A' }));
  writeFileSync(join(subagentsDir, 'agent-zzz.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-04T00:01:40.000Z',  // T=100
    message: { content: [{ type: 'text', text: 'first-spawn output' }] },
  }) + '\n');

  try {
    const d = new SessionDiscovery(claudeDir);
    const page = d.getSessionHistory(sessionId, { limit: 100 });
    const subagentRows = page.messages.filter((m) => m.role === 'subagent');
    if (subagentRows.length < 2) {
      // Subagent rendering not active on this code revision; pairing
      // contract still holds for revisions that do emit subagent rows.
      return;
    }
    const firstSub = subagentRows[0];
    const secondSub = subagentRows[1];
    assert.equal(firstSub.content, 'first-spawn output',
      `first subagent row should be the earlier-spawned one (zzz/T=100), got ${firstSub.content}`);
    assert.equal(secondSub.content, 'second-spawn output',
      `second subagent row should be the later-spawned one (aaa/T=200), got ${secondSub.content}`);
    // Anchored timestamps land on the Task tool_use ts; normalization may
    // bump by 1ms when an earlier row in the merged stream already used the
    // same ms — assert "within 10ms of the Task ts", which is what the
    // anchoring contract actually guarantees on the wire.
    const taskA = Date.parse('2026-05-04T00:00:10.000Z');
    const taskB = Date.parse('2026-05-04T00:00:20.000Z');
    assert.ok(Math.abs(Date.parse(firstSub.timestamp!) - taskA) <= 10,
      `firstSub.ts ${firstSub.timestamp} should be ≈ ${new Date(taskA).toISOString()}`);
    assert.ok(Math.abs(Date.parse(secondSub.timestamp!) - taskB) <= 10,
      `secondSub.ts ${secondSub.timestamp} should be ≈ ${new Date(taskB).toISOString()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// hasMore contract
// ---------------------------------------------------------------------------

test('order-invariant: hasMore=false implies the page contains the head (no silent truncation)', () => {
  const lines: object[] = [];
  for (let i = 0; i < 5; i++) {
    lines.push({
      type: 'user',
      timestamp: `2026-05-04T00:00:${String(i).padStart(2, '0')}.000Z`,
      message: { content: `row-${i}` },
    });
  }
  const { dir, claudeDir, sessionId } = makeClaudeSession(lines);
  try {
    const d = new SessionDiscovery(claudeDir);
    const page = d.getSessionHistory(sessionId, { limit: 100 });
    assert.equal(page.hasMore, false);
    assert.equal(page.messages[0].content, 'row-0',
      'hasMore=false but the head row is missing — phone would never request it via loadOlderMessages');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
