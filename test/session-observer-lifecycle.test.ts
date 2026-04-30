import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionObserver } from '../src/observers/session-observer.js';
import { SessionManager } from '../src/sessions/session-manager.js';

test('SessionObserver stops quietly when the watched JSONL file disappears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-observer-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const observer = new SessionObserver('session-1', jsonlPath);
  const errors: Error[] = [];
  observer.on('error', (err) => errors.push(err));

  try {
    observer.start(false);
    unlinkSync(jsonlPath);
    await waitFor(() => !observer.isActive());

    assert.equal(observer.isActive(), false);
    assert.deepEqual(errors, []);
  } finally {
    observer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager.removeSession stops observed session watchers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-pocket-session-manager-'));
  const jsonlPath = join(dir, 'session.jsonl');
  writeFileSync(jsonlPath, '');

  const manager = new SessionManager();
  const sessionId = manager.observeSession('claude-session-1', jsonlPath, dir, 12345);
  const session = manager.getSession(sessionId);

  try {
    assert.equal(session?.observer?.isActive(), true);

    manager.removeSession(sessionId);

    assert.equal(manager.getSession(sessionId), undefined);
    assert.equal(session?.observer?.isActive(), false);
  } finally {
    session?.observer?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
