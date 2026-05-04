import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SubagentObserver } from '../src/observers/subagent-observer.js';
import type { SubagentEvent } from 'agent-pocket-protocol';

test('SubagentObserver drains pending output and archives metrics when hook marks an agent done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-subagent-observer-'));
  const subagentsDir = join(dir, 'subagents');
  mkdirSync(subagentsDir);

  const observer = new SubagentObserver(subagentsDir);
  const events: SubagentEvent[] = [];
  observer.on('output', (event) => events.push(event));

  try {
    writeFileSync(join(subagentsDir, 'agent-agent-a.meta.json'), JSON.stringify({
      agentType: 'Research',
      description: 'Find the regression',
    }));

    observer.markAgentStart('agent-a', 'Task');
    writeFileSync(join(subagentsDir, 'agent-agent-a.jsonl'), JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-04T01:02:03.000Z',
      message: {
        stop_reason: 'end_turn',
        usage: {
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          input_tokens: 5,
          output_tokens: 7,
        },
        content: [
          { type: 'text', text: 'I found it.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/example.ts' } },
        ],
      },
    }) + '\n');

    observer.markAgentDone('agent-a');

    assert.equal(events.length, 4);
    assert.equal(events[0].agent_status, 'running');
    assert.equal(events[0].agent_name, 'Find the regression');
    assert.equal(events[0].agent_type, 'Research');

    assert.deepEqual(events[1].inner_event, { type: 'assistant_message', message: 'I found it.' });
    assert.equal(events[1].token_count, 17);
    assert.equal(events[1].agent_status, 'idle');

    assert.deepEqual(events[2].inner_event, {
      type: 'tool_use',
      tool_id: 'tool-1',
      tool_name: 'Read',
      tool_input: { file_path: 'src/example.ts' },
    });
    assert.equal(events[2].tool_use_count, 1);
    assert.equal(events[2].token_count, 17);

    assert.equal(events[3].agent_status, 'done');
    assert.equal(events[3].tool_use_count, 1);
    assert.equal(events[3].token_count, 17);

    const archive = JSON.parse(readFileSync(join(subagentsDir, 'agent-agent-a.archive.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(archive.status, 'done');
    assert.equal(archive.toolUseCount, 1);
    assert.equal(archive.tokenCount, 17);
    assert.equal(archive.firstEventAt, Date.parse('2026-05-04T01:02:03.000Z'));
    assert.equal(archive.lastEventAt, Date.parse('2026-05-04T01:02:03.000Z'));
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SubagentObserver initial scan archives completed historical agents without replaying output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-subagent-historic-'));
  const subagentsDir = join(dir, 'subagents');
  mkdirSync(subagentsDir);

  const jsonlPath = join(subagentsDir, 'agent-historic.jsonl');
  writeFileSync(join(subagentsDir, 'agent-historic.meta.json'), JSON.stringify({
    agentType: 'Explore',
    description: 'Inspect old state',
  }));
  writeFileSync(jsonlPath, [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-04T01:00:00.000Z',
      message: {
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [{ type: 'tool_use', id: 'tool-a', name: 'Glob', input: {} }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-04T01:01:00.000Z',
      message: {
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
        content: [
          { type: 'tool_use', id: 'tool-a', name: 'Glob', input: {} },
          { type: 'text', text: 'Done' },
        ],
      },
    }),
  ].join('\n') + '\n');
  const old = new Date(Date.now() - 180_000);
  utimesSync(jsonlPath, old, old);

  const observer = new SubagentObserver(subagentsDir);
  const events: SubagentEvent[] = [];
  observer.on('output', (event) => events.push(event));

  try {
    observer.start();

    assert.deepEqual(events, []);
    const archive = JSON.parse(readFileSync(join(subagentsDir, 'agent-historic.archive.json'), 'utf-8')) as Record<string, unknown>;
    assert.equal(archive.agentId, 'historic');
    assert.equal(archive.agentType, 'Explore');
    assert.equal(archive.agentName, 'Inspect old state');
    assert.equal(archive.status, 'done');
    assert.equal(archive.toolUseCount, 1);
    assert.equal(archive.tokenCount, 30);
    assert.equal(archive.firstEventAt, Date.parse('2026-05-04T01:00:00.000Z'));
    assert.equal(archive.lastEventAt, Date.parse('2026-05-04T01:01:00.000Z'));
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
