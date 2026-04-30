import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HookServer, type HookPermissionPrompt } from '../src/hooks/hook-server.js';

async function postHook(port: number, path: string, payload: Record<string, unknown>): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.text();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for hook event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('HookServer rejects Codex hooks without a session id', async () => {
  const server = new HookServer(0);
  const port = await server.start();
  let emitted = false;
  server.on('codex_session_start', () => { emitted = true; });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/hooks/codex/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'SessionStart' }),
    });

    assert.equal(response.status, 400);
    assert.equal(emitted, false);
  } finally {
    await server.stop();
  }
});

test('HookServer rejects Codex permission hooks without a session id', async () => {
  const server = new HookServer(0);
  const port = await server.start();
  let emitted = false;
  server.on('codex_permission_request', () => { emitted = true; });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/hooks/codex/permission-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
    });

    assert.equal(response.status, 400);
    assert.equal(emitted, false);
  } finally {
    await server.stop();
  }
});

test('HookServer correlates concurrent same-tool permission prompts in FIFO order', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  const prompts: HookPermissionPrompt[] = [];
  const dismissed: Array<{ toolUseId: string; toolResponse?: unknown }> = [];

  server.on('permission_request', (request) => {
    server.resolvePermissionEmpty(request.toolUseId);
  });
  server.on('permission_prompt', (request) => {
    prompts.push(request);
  });
  server.on('permission_dismissed', (toolUseId, _toolName, _sessionId, toolResponse) => {
    dismissed.push({ toolUseId, toolResponse });
  });

  await postHook(port, '/hooks/permission-request', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo one' },
  });
  await postHook(port, '/hooks/permission-request', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-2',
    tool_name: 'Bash',
    tool_input: { command: 'echo two' },
  });

  const promptResponse1 = postHook(port, '/hooks/permission-prompt', {
    session_id: 'session-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo one' },
  });
  await waitFor(() => prompts.length === 1);
  const promptId1 = prompts[0].toolUseId;

  const promptResponse2 = postHook(port, '/hooks/permission-prompt', {
    session_id: 'session-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo two' },
  });
  await waitFor(() => prompts.length === 2);
  const promptId2 = prompts[1].toolUseId;

  assert.notEqual(promptId1, promptId2);

  await postHook(port, '/hooks/post-tool-use', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo one' },
    tool_response: { output: 'one' },
  });

  await waitFor(() => dismissed.length === 1);
  assert.equal(dismissed[0].toolUseId, promptId1);
  assert.deepEqual(dismissed[0].toolResponse, { output: 'one' });
  assert.equal(server.hasPendingPermission(promptId1), false);
  assert.equal(server.hasPendingPermission(promptId2), true);

  await postHook(port, '/hooks/post-tool-use', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-2',
    tool_name: 'Bash',
    tool_input: { command: 'echo two' },
    tool_response: { output: 'two' },
  });

  await waitFor(() => dismissed.length === 2);
  assert.equal(dismissed[1].toolUseId, promptId2);
  assert.deepEqual(dismissed[1].toolResponse, { output: 'two' });
  assert.equal(server.hasPendingPermission(promptId2), false);

  await Promise.all([promptResponse1, promptResponse2]);
});
