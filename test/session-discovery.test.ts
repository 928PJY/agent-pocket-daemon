import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionDiscovery } from '../src/discovery/session-discovery.js';

test('SessionDiscovery scans recent project sessions with titles and sorted mtimes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-discovery-'));
  const claudeDir = join(dir, '.claude');
  const projectA = join(claudeDir, 'projects', '%2Ftmp%2Fproject_a');
  const projectB = join(claudeDir, 'projects', 'project-b');
  const subagents = join(projectA, 'subagents');
  mkdirSync(subagents, { recursive: true });
  mkdirSync(projectB, { recursive: true });

  const older = join(projectA, 'older-session.jsonl');
  const newer = join(projectB, 'newer-session.jsonl');
  const stale = join(projectB, 'stale-session.jsonl');
  const ignoredSubagent = join(subagents, 'agent-ignored.jsonl');
  writeFileSync(older, JSON.stringify({ type: 'custom-title', customTitle: 'User title' }) + '\n');
  writeFileSync(newer, JSON.stringify({ type: 'ai-title', aiTitle: 'Generated title' }) + '\n');
  writeFileSync(stale, '{}\n');
  writeFileSync(ignoredSubagent, '{}\n');
  const now = Date.now();
  utimesSync(older, new Date(now - 2_000), new Date(now - 2_000));
  utimesSync(newer, new Date(now - 1_000), new Date(now - 1_000));
  utimesSync(stale, new Date(now - 11 * 24 * 60 * 60 * 1000), new Date(now - 11 * 24 * 60 * 60 * 1000));

  try {
    const discovery = new SessionDiscovery(claudeDir);
    const sessions = await discovery.discoverSessions();

    assert.deepEqual(sessions.map((session) => session.sessionId), ['newer-session', 'older-session']);
    assert.equal(sessions[0].customTitle, 'Generated title');
    assert.equal(sessions[1].customTitle, 'User title');
    assert.equal(sessions[1].projectDir, '/tmp/project_a');
    assert.equal(discovery.getCachedSessions(), sessions);
    assert.equal(discovery.getProjectsDir(), join(claudeDir, 'projects'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionDiscovery parses history, tool results, filtering, and parent pagination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-history-'));
  const claudeDir = join(dir, '.claude');
  const projectDir = join(claudeDir, 'projects', 'project');
  mkdirSync(projectDir, { recursive: true });
  const sessionPath = join(projectDir, 'session-1.jsonl');
  const longInput = 'x'.repeat(2_100);
  const longOutput = 'y'.repeat(5_100);
  writeFileSync(sessionPath, [
    JSON.stringify({ type: 'user', timestamp: '2026-05-04T00:00:00.000Z', message: { content: 'first' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-05-04T00:00:01.000Z', message: { content: '<system-reminder>ignore me</system-reminder>' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-04T00:00:02.000Z',
      message: {
        content: [
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'tool-1', name: 'Write', input: { content: longInput, file_path: 'a.txt' } },
        ],
      },
    }),
    JSON.stringify({ type: 'user', timestamp: '2026-05-04T00:00:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: longOutput }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-05-04T00:00:04.000Z', message: { content: '[Request interrupted by user]' } }),
  ].join('\n') + '\n');

  try {
    const discovery = new SessionDiscovery(claudeDir);
    await discovery.discoverSessions();
    const history = discovery.getSessionHistory('session-1', { limit: 10 });

    assert.equal(history.totalCount, 4);
    assert.equal(history.tailSeq, 4);
    assert.deepEqual(history.messages.map((message) => message.role), ['user', 'assistant', 'tool_use', 'system']);
    const toolUse = history.messages.find((message) => message.role === 'tool_use')!;
    assert.equal(toolUse.toolStatus, 'success');
    assert.equal(toolUse.toolInput?.file_path, 'a.txt');
    assert.match(toolUse.toolInput?.content as string, /\[\+100 chars\]$/);
    assert.match(toolUse.toolResultContent ?? '', /\[\+100 chars\]$/);

    const sinceSeq = discovery.getSessionHistory('session-1', { sinceSeq: 2, limit: 10 });
    assert.deepEqual(sinceSeq.messages.map((message) => message.role), ['tool_use', 'system']);
    assert.equal(sinceSeq.totalCount, 2);

    const paged = discovery.getSessionHistory('session-1', { offset: 0, limit: 2 });
    assert.deepEqual(paged.messages.map((message) => message.role), ['tool_use', 'system']);
    assert.equal(paged.hasMore, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionDiscovery includes subagent history and writes archive fallback metrics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-subagents-'));
  const claudeDir = join(dir, '.claude');
  const projectDir = join(claudeDir, 'projects', 'project');
  const subagentsDir = join(projectDir, 'session-1', 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  const sessionPath = join(projectDir, 'session-1.jsonl');
  writeFileSync(sessionPath, JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-04T00:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }] },
  }) + '\n');
  writeFileSync(join(subagentsDir, 'agent-agent-a.meta.json'), JSON.stringify({
    agentType: 'Explore',
    description: 'Inspect state',
  }));
  writeFileSync(join(subagentsDir, 'agent-agent-a.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-04T00:00:01.000Z',
    message: {
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 5 },
      content: [
        { type: 'text', text: 'sub done' },
        { type: 'tool_use', id: 'sub-tool-1', name: 'Read', input: { file_path: 'src/a.ts' } },
      ],
    },
  }) + '\n');

  try {
    const discovery = new SessionDiscovery(claudeDir);
    await discovery.discoverSessions();
    const history = discovery.getSessionHistory('session-1', { limit: 10 });

    assert.deepEqual(history.messages.map((message) => message.role), ['tool_use', 'subagent', 'subagent']);
    const subagent = history.messages.find((message) => message.role === 'subagent' && message.innerEventType === 'assistant_message')!;
    assert.equal(subagent.agentId, 'agent-a');
    assert.equal(subagent.agentName, 'Inspect state');
    assert.equal(subagent.agentType, 'Explore');
    assert.equal(subagent.agentStatus, 'done');
    assert.equal(subagent.subagentTokenCount, 8);
    assert.equal(subagent.subagentToolUseCount, 1);

    const archive = JSON.parse(readFileSync(join(subagentsDir, 'agent-agent-a.archive.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(archive.status, 'done');
    assert.equal(archive.tokenCount, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionDiscovery reads PID metadata and tolerates malformed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-pids-'));
  const claudeDir = join(dir, '.claude');
  const sessionsDir = join(claudeDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'bad.json'), '{');
  writeFileSync(join(sessionsDir, 'current.json'), JSON.stringify({
    pid: process.pid,
    sessionId: 'session-1',
    cwd: dir,
    entrypoint: 'claude-vscode',
    name: 'VSCode',
  }));

  try {
    const discovery = new SessionDiscovery(claudeDir);
    const info = discovery.getSessionPidInfo('session-1');
    assert.deepEqual(info, {
      pid: process.pid,
      sessionId: 'session-1',
      // Live process cwd wins over the (stale) cwd recorded in the PID file
      // when the process is alive — see issue #85.
      cwd: process.cwd(),
      entrypoint: 'claude-vscode',
      isAlive: true,
      name: 'VSCode',
    });
    assert.deepEqual([...discovery.getRunningSessionEntrypoints()], [['session-1', 'claude-vscode']]);
    assert.equal(discovery.getSessionPidInfo('missing'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
