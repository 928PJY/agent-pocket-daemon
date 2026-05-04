import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexObserver } from '../src/observers/codex-observer.js';

type CodexObserverInternals = CodexObserver & { readNewEntries(): void };

test('CodexObserver emits output and status changes from appended rollout entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-codex-observer-'));
  const rolloutPath = join(dir, 'rollout.jsonl');
  writeFileSync(rolloutPath, '');

  const observer = new CodexObserver('codex:thread-1', rolloutPath);
  const statuses: string[] = [];
  const outputs: unknown[] = [];
  observer.on('status_change', (status) => statuses.push(status));
  observer.on('output', (event) => outputs.push(event));

  try {
    observer.start(false);
    writeFileSync(rolloutPath, [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Ready.' }],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'exec_command_end', call_id: 'call-1', exit_code: 0, aggregated_output: 'ok' },
      }),
    ].join('\n') + '\n');

    (observer as CodexObserverInternals).readNewEntries();

    assert.deepEqual(statuses, ['running', 'running', 'ready']);
    assert.deepEqual(outputs, [
      { type: 'assistant_message', message: 'Ready.' },
      { type: 'tool_result', tool_id: 'call-1', status: 'success', output: 'ok' },
    ]);
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CodexObserver buffers partial lines and handles lifecycle entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-codex-observer-'));
  const rolloutPath = join(dir, 'rollout.jsonl');
  writeFileSync(rolloutPath, '');

  const observer = new CodexObserver('codex:thread-1', rolloutPath);
  const statuses: string[] = [];
  const completed: Array<string | undefined> = [];
  const errors: string[] = [];
  observer.on('status_change', (status) => statuses.push(status));
  observer.on('completed', (summary) => completed.push(summary));
  observer.on('error', (err) => errors.push(err.message));

  try {
    observer.start(false);
    const assistant = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'partial' }],
      },
    });
    writeFileSync(rolloutPath, assistant.slice(0, -2));
    (observer as CodexObserverInternals).readNewEntries();
    assert.deepEqual(statuses, []);

    writeFileSync(rolloutPath, [
      assistant,
      JSON.stringify({ type: 'event_msg', payload: { type: 'turn_completed', summary: 'Done.' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'turn_failed', message: 'network failed' } }),
    ].join('\n') + '\n');
    (observer as CodexObserverInternals).readNewEntries();

    assert.deepEqual(statuses, ['running', 'ready']);
    assert.deepEqual(completed, ['Done.']);
    assert.deepEqual(errors, ['network failed']);
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CodexObserver reports file read errors while active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-codex-observer-'));
  const rolloutPath = join(dir, 'missing.jsonl');
  const observer = new CodexObserver('codex:thread-1', rolloutPath);
  const errors: string[] = [];
  observer.on('error', (err) => errors.push(err.message));

  try {
    observer.start(false);
    (observer as CodexObserverInternals).readNewEntries();

    assert.equal(errors.length, 1);
    assert.match(errors[0], /ENOENT/);
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
