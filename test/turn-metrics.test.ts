import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionObserver } from '../src/observers/session-observer.js';
import { SessionDiscovery } from '../src/discovery/session-discovery.js';
import { SessionManager } from '../src/sessions/session-manager.js';

type SessionObserverInternals = SessionObserver & { readNewEntries(): void };
type AssistantEvent = {
  type: 'assistant_message';
  message: string;
  sdkBlockIndex?: number;
  turnMetrics?: { totalTokens: number; toolUseCount: number; durationSec: number };
};

function writeEntries(filePath: string, entries: unknown[]): void {
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function appendEntries(filePath: string, entries: unknown[]): void {
  appendFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Live observer path
// ---------------------------------------------------------------------------

test('SessionObserver attaches turnMetrics to the assistant_message on end_turn (live path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-turn-metrics-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const observer = new SessionObserver('session-1', jsonlPath);
  const outputs: unknown[] = [];
  observer.on('output', (event) => outputs.push(event));

  try {
    observer.start(false);
    appendEntries(jsonlPath, [
      {
        type: 'user',
        timestamp: '2026-05-17T00:00:00.000Z',
        message: { content: 'go' },
      },
      // Mid-turn assistant entry (tool_use stop_reason). Carries usage and a
      // tool_use block — both must contribute to the accumulator but NO
      // turnMetrics should be emitted on its assistant_message rows.
      {
        type: 'assistant',
        timestamp: '2026-05-17T00:00:01.000Z',
        message: {
          stop_reason: 'tool_use',
          usage: { output_tokens: 100, cache_creation_input_tokens: 50 },
          content: [
            { type: 'text', text: 'thinking out loud' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-05-17T00:00:02.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
      // Final assistant entry (end_turn) with a single text block.
      {
        type: 'assistant',
        timestamp: '2026-05-17T00:00:10.000Z',
        message: {
          stop_reason: 'end_turn',
          usage: { output_tokens: 200, cache_creation_input_tokens: 25 },
          content: [{ type: 'text', text: 'final reply' }],
        },
      },
    ]);

    (observer as SessionObserverInternals).readNewEntries();

    const assistantEvents = outputs.filter(
      (e): e is AssistantEvent => (e as { type: string }).type === 'assistant_message',
    );

    // Mid-turn assistant_message rows: never carry turnMetrics
    const midTurn = assistantEvents.find((e) => e.message === 'thinking out loud');
    assert.ok(midTurn, 'mid-turn assistant event missing');
    assert.equal(midTurn!.turnMetrics, undefined);

    // End-turn assistant_message: carries the per-turn aggregate
    const endTurn = assistantEvents.find((e) => e.turnMetrics !== undefined);
    assert.ok(endTurn, 'end-turn assistant event with turnMetrics missing');
    // tokens = 100+50 (mid) + 200+25 (end) = 375
    assert.equal(endTurn!.turnMetrics!.totalTokens, 375);
    // tool_use count = 1 (from mid-turn)
    assert.equal(endTurn!.turnMetrics!.toolUseCount, 1);
    // duration = (00:00:10 - 00:00:00) = 10s
    assert.equal(endTurn!.turnMetrics!.durationSec, 10);
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionObserver resets turnMetrics accumulator on a real user turn (not on tool_result-only user)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-turn-metrics-reset-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const observer = new SessionObserver('session-2', jsonlPath);
  const outputs: unknown[] = [];
  observer.on('output', (event) => outputs.push(event));

  try {
    observer.start(false);
    appendEntries(jsonlPath, [
      // --- Turn A ---
      {
        type: 'user',
        timestamp: '2026-05-17T00:00:00.000Z',
        message: { content: 'turn A' },
      },
      {
        type: 'assistant',
        timestamp: '2026-05-17T00:00:05.000Z',
        message: {
          stop_reason: 'end_turn',
          usage: { output_tokens: 999, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'a-reply' }],
        },
      },
      // --- Turn B: a fresh user turn must reset the accumulator ---
      {
        type: 'user',
        timestamp: '2026-05-17T00:01:00.000Z',
        message: { content: 'turn B' },
      },
      {
        type: 'assistant',
        timestamp: '2026-05-17T00:01:03.000Z',
        message: {
          stop_reason: 'end_turn',
          usage: { output_tokens: 10, cache_creation_input_tokens: 5 },
          content: [{ type: 'text', text: 'b-reply' }],
        },
      },
    ]);

    (observer as SessionObserverInternals).readNewEntries();

    const assistantEvents = outputs.filter(
      (e): e is AssistantEvent => (e as { type: string }).type === 'assistant_message',
    );
    const a = assistantEvents.find((e) => e.message === 'a-reply');
    const b = assistantEvents.find((e) => e.message === 'b-reply');

    assert.ok(a?.turnMetrics, 'turn A must have metrics');
    assert.equal(a!.turnMetrics!.totalTokens, 999);
    assert.equal(a!.turnMetrics!.durationSec, 5);

    assert.ok(b?.turnMetrics, 'turn B must have metrics');
    // If the accumulator hadn't reset, b would be 999+15=1014.
    assert.equal(b!.turnMetrics!.totalTokens, 15);
    assert.equal(b!.turnMetrics!.durationSec, 3);
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// History path
// ---------------------------------------------------------------------------

test('SessionDiscovery.getSessionHistory computes turnMetrics on end_turn rows from JSONL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-history-metrics-'));
  const claudeDir = join(dir, '.claude');
  const projectDir = join(claudeDir, 'projects', 'test-project');
  mkdirSync(projectDir, { recursive: true });
  const jsonlPath = join(projectDir, 'sess-history.jsonl');

  writeEntries(jsonlPath, [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-05-17T00:00:00.000Z',
      message: { content: 'do thing' },
    },
    // Mid-turn assistant (tool_use): contributes to accumulator, no metrics emitted
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-05-17T00:00:02.000Z',
      message: {
        stop_reason: 'tool_use',
        usage: { output_tokens: 80, cache_creation_input_tokens: 20 },
        content: [
          { type: 'text', text: 'using a tool' },
          { type: 'tool_use', id: 'tool-x', name: 'Read', input: {} },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-05-17T00:00:03.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-x', content: 'ok' }] },
    },
    // End-turn assistant with two text blocks. turnMetrics must land on
    // block index 1 (the last text block), not block 0.
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-05-17T00:00:08.000Z',
      message: {
        stop_reason: 'end_turn',
        usage: { output_tokens: 50, cache_creation_input_tokens: 50 },
        content: [
          { type: 'text', text: 'wrap-up 1' },
          { type: 'text', text: 'wrap-up 2' },
        ],
      },
    },
  ]);

  try {
    const discovery = new SessionDiscovery(claudeDir);
    await discovery.discoverSessions();
    const page = discovery.getSessionHistory('sess-history', { limit: 100 });

    const assistantMsgs = page.messages.filter((m) => m.role === 'assistant');
    // Expect: 1 from a1 ("using a tool") + 2 from a2 ("wrap-up 1", "wrap-up 2")
    assert.equal(assistantMsgs.length, 3);

    const midTurn = assistantMsgs.find((m) => m.content === 'using a tool');
    const endTurnFirst = assistantMsgs.find((m) => m.content === 'wrap-up 1');
    const endTurnLast = assistantMsgs.find((m) => m.content === 'wrap-up 2');

    assert.equal(midTurn?.turnMetrics, undefined);
    assert.equal(endTurnFirst?.turnMetrics, undefined);
    assert.ok(endTurnLast?.turnMetrics, 'history end_turn last block must have turnMetrics');
    // Tokens: a1 (80+20) + a2 (50+50) = 200
    assert.equal(endTurnLast!.turnMetrics!.totalTokens, 200);
    // 1 tool_use
    assert.equal(endTurnLast!.turnMetrics!.toolUseCount, 1);
    // Duration: 00:00:08 - 00:00:00 = 8s
    assert.equal(endTurnLast!.turnMetrics!.durationSec, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionDiscovery.getSessionHistory keeps turnMetrics independent across multiple turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-history-metrics-multi-'));
  const claudeDir = join(dir, '.claude');
  const projectDir = join(claudeDir, 'projects', 'test-project');
  mkdirSync(projectDir, { recursive: true });
  const jsonlPath = join(projectDir, 'sess-multi.jsonl');

  writeEntries(jsonlPath, [
    // Turn A
    { type: 'user', uuid: 'u1', timestamp: '2026-05-17T00:00:00.000Z', message: { content: 'A' } },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-05-17T00:00:04.000Z',
      message: {
        stop_reason: 'end_turn',
        usage: { output_tokens: 300, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'A done' }],
      },
    },
    // Turn B
    { type: 'user', uuid: 'u2', timestamp: '2026-05-17T01:00:00.000Z', message: { content: 'B' } },
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-05-17T01:00:02.000Z',
      message: {
        stop_reason: 'end_turn',
        usage: { output_tokens: 7, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'B done' }],
      },
    },
  ]);

  try {
    const discovery = new SessionDiscovery(claudeDir);
    await discovery.discoverSessions();
    const page = discovery.getSessionHistory('sess-multi', { limit: 100 });
    const a = page.messages.find((m) => m.content === 'A done');
    const b = page.messages.find((m) => m.content === 'B done');

    assert.equal(a?.turnMetrics?.totalTokens, 300);
    assert.equal(a?.turnMetrics?.durationSec, 4);

    // Critical: B's metrics must NOT include A's tokens — the accumulator
    // resets on every real user turn.
    assert.equal(b?.turnMetrics?.totalTokens, 7);
    assert.equal(b?.turnMetrics?.durationSec, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Controller mode (SDK mapper) — addresses PR #78 review comment that
// controller sessions never see turnMetrics because the new path skipped
// session-manager.ts while the legacy completion_metrics emit was gated off.
// ---------------------------------------------------------------------------

test('SessionManager controller mapper attaches turnMetrics on end_turn assistant_message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-controller-tm-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const outputs: AssistantEvent[] = [];
  manager.on('session_output', (_sessionId, event) => {
    if ((event as { type: string }).type === 'assistant_message') {
      outputs.push(event as AssistantEvent);
    }
  });
  const privateManager = manager as unknown as {
    handleSDKMessage(state: ReturnType<SessionManager['getSession']>, message: unknown): void;
  };

  try {
    const sessionId = manager.observeSession('claude-controller-1', jsonlPath, dir, 999);
    const session = manager.getSession(sessionId)!;
    outputs.length = 0;

    // Real user turn — resets accumulator + sets turnStartMs to now
    privateManager.handleSDKMessage(session, {
      type: 'user',
      message: { content: 'do thing' },
    });
    // Mid-turn assistant (tool_use): contributes tokens + 1 tool, no metrics emitted
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        usage: { output_tokens: 100, cache_creation_input_tokens: 50 },
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    });
    // Tool result back to model — must NOT reset accumulator
    privateManager.handleSDKMessage(session, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    // End-turn assistant — emits metrics on its (only) text block
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        usage: { output_tokens: 200, cache_creation_input_tokens: 25 },
        content: [{ type: 'text', text: 'final reply' }],
      },
    });

    const midTurn = outputs.find((e) => e.message === 'thinking out loud');
    assert.ok(midTurn, 'mid-turn assistant_message missing');
    assert.equal(midTurn!.turnMetrics, undefined);

    const endTurn = outputs.find((e) => e.turnMetrics !== undefined);
    assert.ok(endTurn, 'end-turn assistant_message with turnMetrics missing');
    // tokens = 100+50 (mid) + 200+25 (end) = 375
    assert.equal(endTurn!.turnMetrics!.totalTokens, 375);
    assert.equal(endTurn!.turnMetrics!.toolUseCount, 1);
    // durationSec uses Date.now() — assert it's a sane non-negative integer
    assert.equal(typeof endTurn!.turnMetrics!.durationSec, 'number');
    assert.ok(endTurn!.turnMetrics!.durationSec >= 0);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager controller mapper resets turnMetrics accumulator on a real user turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-controller-tm-reset-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const outputs: AssistantEvent[] = [];
  manager.on('session_output', (_sessionId, event) => {
    if ((event as { type: string }).type === 'assistant_message') {
      outputs.push(event as AssistantEvent);
    }
  });
  const privateManager = manager as unknown as {
    handleSDKMessage(state: ReturnType<SessionManager['getSession']>, message: unknown): void;
  };

  try {
    const sessionId = manager.observeSession('claude-controller-2', jsonlPath, dir, 999);
    const session = manager.getSession(sessionId)!;
    outputs.length = 0;

    // Turn A
    privateManager.handleSDKMessage(session, { type: 'user', message: { content: 'A' } });
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        usage: { output_tokens: 999, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'A done' }],
      },
    });
    // Turn B — must reset accumulator. Without reset, B would report 999+15.
    privateManager.handleSDKMessage(session, { type: 'user', message: { content: 'B' } });
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        usage: { output_tokens: 10, cache_creation_input_tokens: 5 },
        content: [{ type: 'text', text: 'B done' }],
      },
    });

    const a = outputs.find((e) => e.message === 'A done');
    const b = outputs.find((e) => e.message === 'B done');
    assert.equal(a?.turnMetrics?.totalTokens, 999);
    assert.equal(b?.turnMetrics?.totalTokens, 15);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: end_turn message that repeats already-emitted text must still
// surface turnMetrics live (addresses PR #78 review comment).
// ---------------------------------------------------------------------------

test('SessionObserver emits metadata-only assistant_message when end_turn repeats text already emitted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-tm-repeat-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const observer = new SessionObserver('session-repeat', jsonlPath, { hasPeerCapability: () => true });
  const outputs: unknown[] = [];
  observer.on('output', (event) => outputs.push(event));

  try {
    observer.start(false);
    appendEntries(jsonlPath, [
      { type: 'user', timestamp: '2026-05-17T00:00:00.000Z', message: { content: 'go' } },
      // First chunk emits the full text under STABLE_SDK_UUID (fullTextEmit).
      {
        type: 'assistant',
        uuid: 'asst-1',
        timestamp: '2026-05-17T00:00:01.000Z',
        message: {
          stop_reason: 'tool_use',
          usage: { output_tokens: 30, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'all of the reply' }],
        },
      },
      // Final end_turn message REPEATS the same text — the length guard
      // would normally skip emit. With the fix, we still send a metadata-
      // only assistant_message so the chip lands on the existing row.
      {
        type: 'assistant',
        uuid: 'asst-1',
        timestamp: '2026-05-17T00:00:02.000Z',
        message: {
          stop_reason: 'end_turn',
          usage: { output_tokens: 5, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'all of the reply' }],
        },
      },
    ]);

    (observer as SessionObserverInternals).readNewEntries();

    const assistantEvents = outputs.filter(
      (e): e is AssistantEvent => (e as { type: string }).type === 'assistant_message',
    );
    const withMetrics = assistantEvents.find((e) => e.turnMetrics !== undefined);
    assert.ok(withMetrics, 'must emit a turnMetrics-carrying assistant_message even when text is unchanged');
    // tokens = 30 + 5 = 35
    assert.equal(withMetrics!.turnMetrics!.totalTokens, 35);
    // payload may be empty (metadata-only) when there's no new text delta
    assert.equal(typeof withMetrics!.message, 'string');
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager controller mapper emits metadata-only metrics on end_turn with no text delta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-controller-tm-repeat-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const outputs: AssistantEvent[] = [];
  manager.on('session_output', (_sessionId, event) => {
    if ((event as { type: string }).type === 'assistant_message') {
      outputs.push(event as AssistantEvent);
    }
  });
  const privateManager = manager as unknown as {
    handleSDKMessage(state: ReturnType<SessionManager['getSession']>, message: unknown): void;
  };

  try {
    const sessionId = manager.observeSession('claude-controller-repeat', jsonlPath, dir, 999);
    const session = manager.getSession(sessionId)!;
    outputs.length = 0;

    privateManager.handleSDKMessage(session, { type: 'user', message: { content: 'go' } });
    // First chunk: full text emitted
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      uuid: 'asst-1',
      message: {
        stop_reason: 'tool_use',
        usage: { output_tokens: 30, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'final reply' }],
      },
    });
    // end_turn: same text, no new delta — controller must still emit
    // metadata-only event carrying turnMetrics.
    privateManager.handleSDKMessage(session, {
      type: 'assistant',
      uuid: 'asst-1',
      message: {
        stop_reason: 'end_turn',
        usage: { output_tokens: 5, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'final reply' }],
      },
    });

    const withMetrics = outputs.find((e) => e.turnMetrics !== undefined);
    assert.ok(withMetrics, 'controller must emit metrics event even when text is unchanged');
    assert.equal(withMetrics!.turnMetrics!.totalTokens, 35);
  } finally {
    manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
