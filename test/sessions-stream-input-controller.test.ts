import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { StreamInputController } from '../src/sessions/stream-input-controller.js';

function userMsg(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

// ---------------------------------------------------------------------------
// closed flag
// ---------------------------------------------------------------------------

test('closed: starts false; flips to true after close()', () => {
  const c = new StreamInputController();
  assert.equal(c.closed, false);
  c.close();
  assert.equal(c.closed, true);
});

// ---------------------------------------------------------------------------
// push before stream — message sits in queue, then yields on consume
// ---------------------------------------------------------------------------

test('push before stream: queued msg is the first yielded value', async () => {
  const c = new StreamInputController();
  c.push(userMsg('hello'));
  c.push(userMsg('world'));

  const out: string[] = [];
  (async () => {
    for await (const m of c.stream()) {
      const content = (m.message as { content: string }).content;
      out.push(content);
      if (out.length === 2) c.close();
    }
  })();

  // Wait for the loop to drain
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, ['hello', 'world']);
});

// ---------------------------------------------------------------------------
// push after stream parked — wakes the waiter
// ---------------------------------------------------------------------------

test('push while consumer waiting: hands message directly to the waiter', async () => {
  const c = new StreamInputController();
  const out: string[] = [];
  const done = (async () => {
    for await (const m of c.stream()) {
      out.push((m.message as { content: string }).content);
      if (out.length === 1) c.close();
    }
  })();
  // Yield so stream() parks on the Promise
  await new Promise((r) => setImmediate(r));
  c.push(userMsg('async-pushed'));
  await done;
  assert.deepEqual(out, ['async-pushed']);
});

// ---------------------------------------------------------------------------
// close while consumer waiting — generator exits cleanly
// ---------------------------------------------------------------------------

test('close while waiting: generator returns without yielding the dummy', async () => {
  const c = new StreamInputController();
  let yields = 0;
  const done = (async () => {
    for await (const _ of c.stream()) {
      yields++;
    }
  })();
  await new Promise((r) => setImmediate(r));
  c.close();
  await done;
  assert.equal(yields, 0);
});

// ---------------------------------------------------------------------------
// push after close — dropped silently (warn logged)
// ---------------------------------------------------------------------------

test('push after close: dropped, generator already exited', async () => {
  const c = new StreamInputController();
  c.ownerSessionId = 'abcdef0123456789';
  c.close();
  c.push(userMsg('dropped'));
  // No throw, no yield
  let count = 0;
  for await (const _ of c.stream()) count++;
  assert.equal(count, 0);
});

// ---------------------------------------------------------------------------
// stream returns immediately if controller already closed
// ---------------------------------------------------------------------------

test('stream() on already-closed controller yields nothing', async () => {
  const c = new StreamInputController();
  c.close();
  let count = 0;
  for await (const _ of c.stream()) count++;
  assert.equal(count, 0);
});
