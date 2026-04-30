import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HookServer } from '../src/hooks/hook-server.js';

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
