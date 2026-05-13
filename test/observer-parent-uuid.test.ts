import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ClaudeEvent } from 'agent-pocket-protocol';
import { SessionObserver } from '../src/observers/session-observer.js';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// String content local_command_output with parentUuid
// ---------------------------------------------------------------------------

test('observer emits parent_invoke_sdk_uuid on string-content local_command_output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-parent-'));
  const jsonl = join(dir, 'test.jsonl');
  writeFileSync(jsonl, '');
  const observer = new SessionObserver('sess-1', jsonl, { hasPeerCapability: () => true });
  const outputs: ClaudeEvent[] = [];
  observer.on('output', (event: ClaudeEvent) => outputs.push(event));
  observer.start(false);

  appendFileSync(jsonl, JSON.stringify({
    type: 'user',
    uuid: 'output-uuid-1',
    parentUuid: 'parent-1',
    message: { role: 'user', content: '<local-command-stdout>cost: $0.42</local-command-stdout>' },
  }) + '\n');

  await waitFor(() => outputs.length > 0);
  observer.stop();

  const ev = outputs[0] as { type: string; parent_invoke_sdk_uuid?: string };
  assert.equal(ev.type, 'local_command_output');
  assert.equal(ev.parent_invoke_sdk_uuid, 'parent-1');

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Array-block content local_command_output with parentUuid
// ---------------------------------------------------------------------------

test('observer emits parent_invoke_sdk_uuid on array-block local_command_output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-parent-arr-'));
  const jsonl = join(dir, 'test.jsonl');
  writeFileSync(jsonl, '');
  const observer = new SessionObserver('sess-2', jsonl, { hasPeerCapability: () => true });
  const outputs: ClaudeEvent[] = [];
  observer.on('output', (event: ClaudeEvent) => outputs.push(event));
  observer.start(false);

  appendFileSync(jsonl, JSON.stringify({
    type: 'user',
    uuid: 'output-uuid-2',
    parentUuid: 'parent-2',
    message: { role: 'user', content: [
      { type: 'text', text: '<local-command-stdout>status: ready</local-command-stdout>' },
    ] },
  }) + '\n');

  await waitFor(() => outputs.length > 0);
  observer.stop();

  const ev = outputs[0] as { type: string; parent_invoke_sdk_uuid?: string };
  assert.equal(ev.type, 'local_command_output');
  assert.equal(ev.parent_invoke_sdk_uuid, 'parent-2');

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// System subtype local_command with parentUuid
// ---------------------------------------------------------------------------

test('observer emits parent_invoke_sdk_uuid on system local_command subtype', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-parent-sys-'));
  const jsonl = join(dir, 'test.jsonl');
  writeFileSync(jsonl, '');
  const observer = new SessionObserver('sess-3', jsonl, { hasPeerCapability: () => true });
  const outputs: ClaudeEvent[] = [];
  observer.on('output', (event: ClaudeEvent) => outputs.push(event));
  observer.start(false);

  appendFileSync(jsonl, JSON.stringify({
    type: 'system',
    subtype: 'local_command',
    uuid: 'sys-uuid-1',
    parentUuid: 'parent-3',
    content: '<local-command-stdout>context: 50%</local-command-stdout>',
  }) + '\n');

  await waitFor(() => outputs.length > 0);
  observer.stop();

  const ev = outputs[0] as { type: string; parent_invoke_sdk_uuid?: string };
  assert.equal(ev.type, 'local_command_output');
  assert.equal(ev.parent_invoke_sdk_uuid, 'parent-3');

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Negative: local_command_invoke does NOT get parent_invoke_sdk_uuid
// ---------------------------------------------------------------------------

test('observer: local_command_invoke does NOT carry parent_invoke_sdk_uuid even if parentUuid is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-parent-neg-'));
  const jsonl = join(dir, 'test.jsonl');
  writeFileSync(jsonl, '');
  const observer = new SessionObserver('sess-4', jsonl, { hasPeerCapability: () => true });
  const outputs: ClaudeEvent[] = [];
  observer.on('output', (event: ClaudeEvent) => outputs.push(event));
  observer.start(false);

  appendFileSync(jsonl, JSON.stringify({
    type: 'user',
    uuid: 'invoke-uuid-1',
    parentUuid: 'parent-4',
    message: { role: 'user', content: '<command-name>/cost</command-name>' },
  }) + '\n');

  await waitFor(() => outputs.length > 0);
  observer.stop();

  const ev = outputs[0] as { type: string; parent_invoke_sdk_uuid?: string };
  assert.equal(ev.type, 'local_command_invoke');
  assert.equal(ev.parent_invoke_sdk_uuid, undefined);

  rmSync(dir, { recursive: true, force: true });
});
