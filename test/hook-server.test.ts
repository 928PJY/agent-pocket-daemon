import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HookServer,
  type CodexHookRequest,
  type HookPermissionPrompt,
  type HookPermissionRequest,
} from '../src/hooks/hook-server.js';

async function postHookResponse(port: number, path: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function postHook(port: number, path: string, payload: Record<string, unknown>): Promise<string> {
  const response = await postHookResponse(port, path, payload);
  return response.text();
}

async function requestHook(
  port: number,
  path: string,
  body: string,
  method: string = 'POST',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

function setHookTimeoutForTest(server: HookServer, timeoutMs: number): void {
  (server as unknown as { DEFAULT_TIMEOUT_MS: number }).DEFAULT_TIMEOUT_MS = timeoutMs;
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

test('HookServer rejects malformed payloads and unknown hook routes', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  let sessionStartEmitted = false;
  server.on('session_start', () => { sessionStartEmitted = true; });

  const malformed = await requestHook(port, '/hooks/session-start', '{');
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid JSON' });

  const invalidShape = await requestHook(port, '/hooks/session-start', 'null');
  assert.equal(invalidShape.status, 400);
  assert.deepEqual(await invalidShape.json(), { error: 'Invalid JSON' });
  assert.equal(sessionStartEmitted, false);

  const unknownRoute = await postHookResponse(port, '/hooks/not-a-hook', { session_id: 'session-1' });
  assert.equal(unknownRoute.status, 404);
  assert.deepEqual(await unknownRoute.json(), { error: 'Not found' });

  const wrongMethod = await requestHook(port, '/hooks/session-start', '', 'PUT');
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(await wrongMethod.json(), { error: 'Method not allowed' });
});

test('HookServer preserves unknown Codex hook event names on informational endpoints', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  const received: CodexHookRequest[] = [];
  server.on('codex_user_prompt_submit', (request) => {
    received.push(request);
  });

  const response = await postHookResponse(port, '/hooks/codex/user-prompt-submit', {
    hook_event_name: 'FutureCodexEvent',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    prompt: 'hello',
    agent_pocket_hook_pid: '123',
    agent_pocket_codex_pid: 456,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  await waitFor(() => received.length === 1);
  assert.equal(received[0].hookEventName, 'FutureCodexEvent');
  assert.equal(received[0].sessionId, 'thread-1');
  assert.equal(received[0].threadId, 'thread-1');
  assert.equal(received[0].turnId, 'turn-1');
  assert.equal(received[0].hookPid, 123);
  assert.equal(received[0].codexPid, 456);
});

test('HookServer resolves AskUserQuestion with updated answers', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  const requests: HookPermissionRequest[] = [];
  server.on('permission_request', (request) => {
    requests.push(request);
  });

  const originalInput = { question: 'Pick one', options: ['A', 'B'] };
  const responsePromise = postHook(port, '/hooks/permission-request', {
    session_id: 'session-ask',
    tool_use_id: 'ask-1',
    tool_name: 'AskUserQuestion',
    tool_input: originalInput,
  });

  await waitFor(() => requests.length === 1);
  assert.equal(server.hasPendingPermission('ask-1'), true);
  assert.equal(server.getPendingToolName('ask-1'), 'AskUserQuestion');
  assert.deepEqual(server.getPendingToolInput('ask-1'), originalInput);

  assert.equal(server.resolveQuestion('ask-1', originalInput, { answer: 'A' }), true);

  const body = JSON.parse(await responsePromise) as {
    hookSpecificOutput: { permissionDecision: string; updatedInput: Record<string, unknown> };
  };
  assert.equal(body.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(body.hookSpecificOutput.updatedInput, {
    ...originalInput,
    answers: { answer: 'A' },
  });
  assert.equal(server.hasPendingPermission('ask-1'), false);
});

test('HookServer resolves PreToolUse allow and deny responses', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  const requests: HookPermissionRequest[] = [];
  server.on('permission_request', (request) => {
    requests.push(request);
  });

  const allowResponse = postHook(port, '/hooks/permission-request', {
    session_id: 'session-pre',
    tool_use_id: 'pre-allow',
    tool_name: 'Bash',
    tool_input: { command: 'rm draft.txt' },
  });
  await waitFor(() => requests.length === 1);
  assert.equal(server.resolvePermission('pre-allow', 'allow', { command: 'rm archived-draft.txt' }), true);
  assert.deepEqual(JSON.parse(await allowResponse), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { command: 'rm archived-draft.txt' },
    },
  });

  const denyResponse = postHook(port, '/hooks/permission-request', {
    session_id: 'session-pre',
    tool_use_id: 'pre-deny',
    tool_name: 'Bash',
    tool_input: { command: 'rm live.txt' },
  });
  await waitFor(() => requests.length === 2);
  assert.equal(server.resolvePermission('pre-deny', 'deny'), true);
  assert.deepEqual(JSON.parse(await denyResponse), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Denied by phone',
    },
  });
  assert.equal(server.resolvePermission('missing', 'allow'), false);
});

test('HookServer resolves PermissionRequest prompt allow and deny responses', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  const prompts: HookPermissionPrompt[] = [];
  server.on('permission_prompt', (request) => {
    prompts.push(request);
  });

  const suggestions = [{ rule: 'Bash(git status:*)' }];
  const allowResponse = postHook(port, '/hooks/permission-prompt', {
    session_id: 'session-prompt',
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
    permission_suggestions: suggestions,
  });
  await waitFor(() => prompts.length === 1);

  const allowPromptId = prompts[0].toolUseId;
  assert.match(allowPromptId, /^hook_/);
  assert.deepEqual(server.getPendingPermissionSuggestions(allowPromptId), suggestions);
  assert.equal(server.resolvePermissionPrompt(
    allowPromptId,
    'allow',
    { command: 'git status --short' },
    [{ rule: 'Bash(git status:*)', behavior: 'allow' }],
  ), true);
  assert.deepEqual(JSON.parse(await allowResponse), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { command: 'git status --short' },
        updatedPermissions: [{ rule: 'Bash(git status:*)', behavior: 'allow' }],
      },
    },
  });

  const denyResponse = postHook(port, '/hooks/permission-prompt', {
    session_id: 'session-prompt',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
  });
  await waitFor(() => prompts.length === 2);
  const denyPromptId = prompts[1].toolUseId;
  assert.equal(server.resolvePermissionPrompt(denyPromptId, 'deny'), true);
  assert.deepEqual(JSON.parse(await denyResponse), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: 'Denied by phone',
      },
    },
  });
  assert.equal(server.resolvePermissionPrompt('missing', 'allow'), false);
});

test('HookServer handles PostToolUse without a pending permission correlation', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  const results: Array<{ toolUseId: string; toolResponse: unknown }> = [];
  let dismissed = false;
  server.on('tool_result', (result) => {
    results.push({ toolUseId: result.toolUseId, toolResponse: result.toolResponse });
  });
  server.on('permission_dismissed', () => { dismissed = true; });

  const response = await postHookResponse(port, '/hooks/post-tool-use', {
    session_id: 'session-post',
    tool_use_id: 'uncorrelated-tool',
    tool_name: 'Bash',
    tool_input: { command: 'echo done' },
    tool_response: { output: 'done' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  await waitFor(() => results.length === 1);
  assert.deepEqual(results[0], {
    toolUseId: 'uncorrelated-tool',
    toolResponse: { output: 'done' },
  });
  assert.equal(dismissed, false);
});

test('HookServer expires pending PermissionRequest prompts on timeout', async (t) => {
  const server = new HookServer(0);
  setHookTimeoutForTest(server, 20);
  const port = await server.start();
  t.after(() => server.stop());

  const prompts: HookPermissionPrompt[] = [];
  const expired: string[] = [];
  server.on('permission_prompt', (request) => {
    prompts.push(request);
  });
  server.on('permission_expired', (event) => {
    expired.push(event.toolUseId);
  });

  const responseBody = await postHook(port, '/hooks/permission-prompt', {
    session_id: 'session-timeout',
    tool_name: 'Bash',
    tool_input: { command: 'sleep 1' },
  });

  assert.equal(responseBody, '{}');
  assert.equal(prompts.length, 1);
  assert.deepEqual(expired, [prompts[0].toolUseId]);
  assert.equal(server.hasPendingPermission(prompts[0].toolUseId), false);
});

test('HookServer stop resolves pending hooks with empty responses', async () => {
  const server = new HookServer(0);
  const port = await server.start();

  const prompts: HookPermissionPrompt[] = [];
  server.on('permission_prompt', (request) => {
    prompts.push(request);
  });

  const responsePromise = postHook(port, '/hooks/permission-prompt', {
    session_id: 'session-stop',
    tool_name: 'Bash',
    tool_input: { command: 'git commit' },
  });

  await waitFor(() => prompts.length === 1);
  const promptId = prompts[0].toolUseId;
  assert.equal(server.hasPendingPermission(promptId), true);

  await server.stop();
  assert.equal(await responsePromise, '{}');
  assert.equal(server.hasPendingPermission(promptId), false);
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

test('HookServer removes direct-correlated PreToolUse IDs from the fallback queue', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  const prompts: HookPermissionPrompt[] = [];
  const dismissed: string[] = [];

  server.on('permission_request', (request) => {
    server.resolvePermissionEmpty(request.toolUseId);
  });
  server.on('permission_prompt', (request) => {
    prompts.push(request);
  });
  server.on('permission_dismissed', (toolUseId) => {
    dismissed.push(toolUseId);
  });

  await postHook(port, '/hooks/permission-request', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-direct',
    tool_name: 'Bash',
    tool_input: { command: 'echo direct' },
  });
  const directPromptResponse = postHook(port, '/hooks/permission-prompt', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-direct',
    tool_name: 'Bash',
    tool_input: { command: 'echo direct' },
  });
  await waitFor(() => prompts.length === 1);
  const directPromptId = prompts[0].toolUseId;

  await postHook(port, '/hooks/permission-request', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-fallback',
    tool_name: 'Bash',
    tool_input: { command: 'echo fallback' },
  });
  const fallbackPromptResponse = postHook(port, '/hooks/permission-prompt', {
    session_id: 'session-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo fallback' },
  });
  await waitFor(() => prompts.length === 2);
  const fallbackPromptId = prompts[1].toolUseId;

  await postHook(port, '/hooks/post-tool-use', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-fallback',
    tool_name: 'Bash',
    tool_input: { command: 'echo fallback' },
    tool_response: { output: 'fallback' },
  });

  await waitFor(() => dismissed.length === 1);
  assert.equal(dismissed[0], fallbackPromptId);
  assert.notEqual(fallbackPromptId, directPromptId);
  assert.equal(server.hasPendingPermission(fallbackPromptId), false);
  assert.equal(server.hasPendingPermission(directPromptId), true);

  server.resolvePermissionPrompt(directPromptId, 'allow');
  await Promise.all([directPromptResponse, fallbackPromptResponse]);
});

test('HookServer keeps phone request visible when PermissionRequest connection closes before PostToolUse', async (t) => {
  const server = new HookServer(0);
  const port = await server.start();
  t.after(() => server.stop());

  const prompts: HookPermissionPrompt[] = [];
  const expired: string[] = [];
  const dismissed: string[] = [];

  server.on('permission_request', (request) => {
    server.resolvePermissionEmpty(request.toolUseId);
  });
  server.on('permission_prompt', (request) => {
    prompts.push(request);
  });
  server.on('permission_expired', (event) => {
    expired.push(event.toolUseId);
  });
  server.on('permission_dismissed', (toolUseId) => {
    dismissed.push(toolUseId);
  });

  await postHook(port, '/hooks/permission-request', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-close-race',
    tool_name: 'Bash',
    tool_input: { command: 'echo close-race' },
  });

  const controller = new AbortController();
  const promptRequest = fetch(`http://127.0.0.1:${port}/hooks/permission-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: 'session-1',
      tool_name: 'Bash',
      tool_input: { command: 'echo close-race' },
    }),
    signal: controller.signal,
  }).catch((err: Error) => err);

  await waitFor(() => prompts.length === 1);
  const promptId = prompts[0].toolUseId;

  controller.abort();
  await waitFor(() => expired.includes(promptId));
  assert.deepEqual(dismissed, []);

  await postHook(port, '/hooks/post-tool-use', {
    session_id: 'session-1',
    tool_use_id: 'tool-use-close-race',
    tool_name: 'Bash',
    tool_input: { command: 'echo close-race' },
    tool_response: { output: 'close-race' },
  });

  await waitFor(() => dismissed.includes(promptId));
  await promptRequest;
});
