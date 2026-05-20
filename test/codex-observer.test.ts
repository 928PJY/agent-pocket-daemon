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
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].type, 'assistant_message');
    assert.equal((outputs[0] as { message: string }).message, 'Ready.');
    assert.match((outputs[0] as { sdkUuid?: string }).sdkUuid ?? '', /^codex_msg:/);
    assert.deepEqual(outputs[1], { type: 'tool_result', tool_id: 'call-1', status: 'success', output: 'ok' });
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

test('CodexObserver collapses same-mode codex_collaboration_mode rows; only transitions emit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-codex-observer-'));
  const rolloutPath = join(dir, 'rollout.jsonl');
  writeFileSync(rolloutPath, '');

  const observer = new CodexObserver('codex:thread-1', rolloutPath);
  const outputs: unknown[] = [];
  observer.on('output', (event) => outputs.push(event));

  try {
    observer.start(false);
    // Three task_started entries: default → default (dup) → plan.
    // Without the lastEmittedMode diff we'd see THREE codex_collaboration_mode
    // events; with it only TWO (the transition into default and the
    // transition into plan).
    writeFileSync(rolloutPath, [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't1', collaboration_mode_kind: 'default' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't2', collaboration_mode_kind: 'default' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't3', collaboration_mode_kind: 'plan' },
      }),
    ].join('\n') + '\n');

    (observer as CodexObserverInternals).readNewEntries();

    const modeEvents = outputs.filter(
      (e) => (e as { type?: string }).type === 'codex_collaboration_mode',
    ) as Array<{ mode: string; sdkUuid?: string }>;
    assert.equal(modeEvents.length, 2, 'expected 2 transitions, dup default suppressed');
    assert.equal(modeEvents[0].mode, 'Default');
    assert.equal(modeEvents[1].mode, 'Plan');
    // sdkUuid must be mirrored from the message onto the event so the
    // wire flattener picks it up — without it phone fingerprints the row
    // as `local|<random>` and history replay lands as a duplicate.
    assert.equal(modeEvents[0].sdkUuid, 'codex_collaboration_mode:t1');
    assert.equal(modeEvents[1].sdkUuid, 'codex_collaboration_mode:t3');
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
