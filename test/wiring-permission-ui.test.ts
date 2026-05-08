import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import {
  buildPermissionContext,
  isPlanModeTool,
  findWorkingDirForSession,
  sendPlanForReview,
  type FindWorkingDirDeps,
  type SendPlanForReviewDeps,
} from '../src/wiring/permission-ui.js';
import type { PcEvent } from 'agent-pocket-protocol';

// ---------------------------------------------------------------------------
// buildPermissionContext
// ---------------------------------------------------------------------------

test('buildPermissionContext: minimal — only Tool prefix', () => {
  assert.equal(buildPermissionContext('Foo', {}), 'Tool: Foo');
});

test('buildPermissionContext: command field', () => {
  assert.equal(buildPermissionContext('Bash', { command: 'ls' }), 'Tool: Bash | Command: ls');
});

test('buildPermissionContext: description only included for Bash', () => {
  assert.equal(buildPermissionContext('Bash', { description: 'list files' }), 'Tool: Bash | Description: list files');
  // For non-Bash, description is ignored
  assert.equal(buildPermissionContext('Other', { description: 'ignored' }), 'Tool: Other');
});

test('buildPermissionContext: file_path / path / url / pattern', () => {
  assert.equal(buildPermissionContext('Read', { file_path: '/x' }), 'Tool: Read | File: /x');
  assert.equal(buildPermissionContext('Glob', { path: '/x' }), 'Tool: Glob | Path: /x');
  assert.equal(buildPermissionContext('WebFetch', { url: 'https://x' }), 'Tool: WebFetch | URL: https://x');
  assert.equal(buildPermissionContext('Grep', { pattern: 'foo' }), 'Tool: Grep | Pattern: foo');
});

test('buildPermissionContext: subject only included for TaskCreate / TaskUpdate', () => {
  assert.equal(buildPermissionContext('TaskCreate', { subject: 'do thing' }), 'Tool: TaskCreate | Subject: do thing');
  assert.equal(buildPermissionContext('TaskUpdate', { subject: 'do thing' }), 'Tool: TaskUpdate | Subject: do thing');
  assert.equal(buildPermissionContext('Other', { subject: 'ignored' }), 'Tool: Other');
});

test('buildPermissionContext: taskId / status', () => {
  assert.equal(buildPermissionContext('TaskUpdate', { taskId: '7' }), 'Tool: TaskUpdate | Task: #7');
  assert.equal(buildPermissionContext('TaskUpdate', { status: 'completed' }), 'Tool: TaskUpdate | Status: completed');
});

test('buildPermissionContext: combines multiple fields with " | "', () => {
  const out = buildPermissionContext('Bash', {
    command: 'ls -la',
    description: 'list everything',
  });
  assert.equal(out, 'Tool: Bash | Command: ls -la | Description: list everything');
});

// ---------------------------------------------------------------------------
// isPlanModeTool
// ---------------------------------------------------------------------------

test('isPlanModeTool: EnterPlanMode / ExitPlanMode are true', () => {
  assert.equal(isPlanModeTool('EnterPlanMode', {}), true);
  assert.equal(isPlanModeTool('ExitPlanMode', {}), true);
});

test('isPlanModeTool: Edit / Write inside .claude/plans/ are true', () => {
  assert.equal(isPlanModeTool('Edit', { file_path: '/u/x/.claude/plans/v1.md' }), true);
  assert.equal(isPlanModeTool('Write', { file_path: '/u/x/.claude/plans/v1.md' }), true);
});

test('isPlanModeTool: Edit / Write outside .claude/plans/ are false', () => {
  assert.equal(isPlanModeTool('Edit', { file_path: '/u/x/src/foo.ts' }), false);
  assert.equal(isPlanModeTool('Write', { file_path: '/u/x/notes.md' }), false);
});

test('isPlanModeTool: Edit / Write with missing file_path → false', () => {
  assert.equal(isPlanModeTool('Edit', {}), false);
  assert.equal(isPlanModeTool('Write', {}), false);
});

test('isPlanModeTool: other tool names always false', () => {
  assert.equal(isPlanModeTool('Bash', { file_path: '/u/x/.claude/plans/v1.md' }), false);
});

// ---------------------------------------------------------------------------
// findWorkingDirForSession
// ---------------------------------------------------------------------------

function makeFindWorkingDirDeps(opts: {
  cached?: Array<{ sessionId: string; projectDir: string }> | null;
  defaultWorkingDirectory?: string;
  cwd?: string;
}): FindWorkingDirDeps {
  return {
    sessionDiscovery: {
      getCachedSessions: () => opts.cached as never,
    },
    defaultWorkingDirectory: opts.defaultWorkingDirectory,
    cwdFn: opts.cwd !== undefined ? () => opts.cwd! : undefined,
  };
}

test('findWorkingDirForSession: returns projectDir when cache has match', () => {
  const deps = makeFindWorkingDirDeps({
    cached: [
      { sessionId: 'a', projectDir: '/proj-a' },
      { sessionId: 'b', projectDir: '/proj-b' },
    ],
  });
  assert.equal(findWorkingDirForSession(deps, 'b'), '/proj-b');
});

test('findWorkingDirForSession: falls back to defaultWorkingDirectory when cache missing', () => {
  const deps = makeFindWorkingDirDeps({
    cached: [],
    defaultWorkingDirectory: '/fallback',
  });
  assert.equal(findWorkingDirForSession(deps, 'unknown'), '/fallback');
});

test('findWorkingDirForSession: falls back to defaultWorkingDirectory when getCachedSessions returns null', () => {
  const deps = makeFindWorkingDirDeps({
    cached: null,
    defaultWorkingDirectory: '/from-config',
  });
  assert.equal(findWorkingDirForSession(deps, 'x'), '/from-config');
});

test('findWorkingDirForSession: falls back to cwdFn when no defaultWorkingDirectory', () => {
  const deps = makeFindWorkingDirDeps({
    cached: null,
    cwd: '/runtime/cwd',
  });
  assert.equal(findWorkingDirForSession(deps, 'x'), '/runtime/cwd');
});

// ---------------------------------------------------------------------------
// sendPlanForReview
// ---------------------------------------------------------------------------

interface FakeFs {
  files: Map<string, { content: string; mtimeMs: number }>;
  dirs: Set<string>;
  readFails: Set<string>;
}

function makeFakeFs(opts: {
  files?: Record<string, { content: string; mtimeMs: number }>;
  readFails?: string[];
} = {}): { fs: SendPlanForReviewDeps['fsImpl']; state: FakeFs } {
  const files = new Map(Object.entries(opts.files ?? {}));
  const dirs = new Set<string>();
  for (const fp of files.keys()) dirs.add(path.dirname(fp));
  const readFails = new Set<string>(opts.readFails ?? []);
  const state: FakeFs = { files, dirs, readFails };
  const impl: SendPlanForReviewDeps['fsImpl'] = {
    existsSync: (p: string) => dirs.has(p),
    readdirSync: ((p: string) => {
      const out: string[] = [];
      for (const fp of files.keys()) {
        if (path.dirname(fp) === p) out.push(path.basename(fp));
      }
      return out;
    }) as never,
    statSync: ((p: string) => {
      if (readFails.has(p)) throw new Error('ENOENT-stat');
      const f = files.get(p);
      if (!f) throw new Error('ENOENT');
      return { mtimeMs: f.mtimeMs } as never;
    }) as never,
    readFileSync: ((p: string) => {
      if (readFails.has(p)) throw new Error('ENOENT-read');
      const f = files.get(p);
      if (!f) throw new Error('ENOENT');
      return f.content;
    }) as never,
  };
  return { fs: impl, state };
}

interface SendPlanFixture {
  deps: SendPlanForReviewDeps;
  notifications: Array<{ event: PcEvent; eventType: string; sessionId: string; requestId: string; wakePayload: unknown }>;
  blocking: Array<{ requestId: string; sessionId: string; event: PcEvent; type: string }>;
}

function makeSendPlanFixture(opts: {
  fsImpl?: SendPlanForReviewDeps['fsImpl'];
  homedir?: string;
  nowIso?: string;
  sessionName?: string;
} = {}): SendPlanFixture {
  const notifications: SendPlanFixture['notifications'] = [];
  const blocking: SendPlanFixture['blocking'] = [];
  const deps: SendPlanForReviewDeps = {
    getSessionName: () => opts.sessionName ?? 'fallback-name',
    sendNotificationEventToPhone: (event, eventType, sessionId, requestId, wakePayload) => {
      notifications.push({ event, eventType, sessionId, requestId, wakePayload });
    },
    trackBlockingRequest: (requestId, sessionId, event, type) => {
      blocking.push({ requestId, sessionId, event, type });
    },
    fsImpl: opts.fsImpl,
    homedirFn: opts.homedir !== undefined ? () => opts.homedir! : undefined,
    nowIso: opts.nowIso !== undefined ? () => opts.nowIso! : undefined,
  };
  return { deps, notifications, blocking };
}

test('sendPlanForReview: reads latest project-local plan when present', () => {
  const { fs } = makeFakeFs({
    files: {
      '/proj/.claude/plans/old.md': { content: 'old plan', mtimeMs: 100 },
      '/proj/.claude/plans/new.md': { content: 'new plan', mtimeMs: 500 },
    },
  });
  const f = makeSendPlanFixture({ fsImpl: fs, homedir: '/home/u' });
  sendPlanForReview(f.deps, 'sid', 'rid', { allowedPrompts: ['p1'] }, '/proj');
  assert.equal(f.notifications.length, 1);
  const ev = f.notifications[0].event as unknown as { plan_content: string; allowed_prompts: string[]; output_type: string };
  assert.equal(ev.plan_content, 'new plan');
  assert.deepEqual(ev.allowed_prompts, ['p1']);
  assert.equal(ev.output_type, 'plan_review');
  assert.equal(f.notifications[0].eventType, 'plan_review');
});

test('sendPlanForReview: falls back to global plans when no project-local', () => {
  const { fs } = makeFakeFs({
    files: {
      '/home/u/.claude/plans/global.md': { content: 'global plan', mtimeMs: 100 },
    },
  });
  const f = makeSendPlanFixture({ fsImpl: fs, homedir: '/home/u' });
  sendPlanForReview(f.deps, 'sid', 'rid', {}, '/proj');
  const ev = f.notifications[0].event as unknown as { plan_content: string };
  assert.equal(ev.plan_content, 'global plan');
});

test('sendPlanForReview: prefers project-local over global', () => {
  const { fs } = makeFakeFs({
    files: {
      '/proj/.claude/plans/local.md': { content: 'local plan', mtimeMs: 200 },
      '/home/u/.claude/plans/global.md': { content: 'global plan', mtimeMs: 999 },
    },
  });
  const f = makeSendPlanFixture({ fsImpl: fs, homedir: '/home/u' });
  sendPlanForReview(f.deps, 'sid', 'rid', {}, '/proj');
  const ev = f.notifications[0].event as unknown as { plan_content: string };
  assert.equal(ev.plan_content, 'local plan');
});

test('sendPlanForReview: uses placeholder when no plan files exist', () => {
  const { fs } = makeFakeFs({});
  const f = makeSendPlanFixture({ fsImpl: fs, homedir: '/home/u' });
  sendPlanForReview(f.deps, 'sid', 'rid', {}, '/proj');
  const ev = f.notifications[0].event as unknown as { plan_content: string };
  assert.equal(ev.plan_content, '(Could not read plan file)');
});

test('sendPlanForReview: ignores non-.md files in the plans directory', () => {
  const { fs } = makeFakeFs({
    files: {
      '/proj/.claude/plans/notes.txt': { content: 'not a plan', mtimeMs: 999 },
      '/proj/.claude/plans/plan.md': { content: 'real plan', mtimeMs: 100 },
    },
  });
  const f = makeSendPlanFixture({ fsImpl: fs, homedir: '/home/u' });
  sendPlanForReview(f.deps, 'sid', 'rid', {}, '/proj');
  const ev = f.notifications[0].event as unknown as { plan_content: string };
  assert.equal(ev.plan_content, 'real plan');
});

test('sendPlanForReview: catches read errors gracefully (logs warn, falls through)', () => {
  const { fs } = makeFakeFs({
    files: {
      '/proj/.claude/plans/broken.md': { content: 'never read', mtimeMs: 100 },
    },
    readFails: ['/proj/.claude/plans/broken.md'],
  });
  const f = makeSendPlanFixture({ fsImpl: fs, homedir: '/home/u' });
  sendPlanForReview(f.deps, 'sid', 'rid', {}, '/proj');
  const ev = f.notifications[0].event as unknown as { plan_content: string };
  assert.equal(ev.plan_content, '(Could not read plan file)');
});

test('sendPlanForReview: notification + blocking request both registered', () => {
  const { fs } = makeFakeFs({
    files: { '/proj/.claude/plans/p.md': { content: 'plan body', mtimeMs: 100 } },
  });
  const f = makeSendPlanFixture({
    fsImpl: fs,
    homedir: '/home/u',
    nowIso: '2026-05-08T00:00:00Z',
    sessionName: 'My Session',
  });
  sendPlanForReview(f.deps, 'sid', 'req-42', { allowedPrompts: [] }, '/proj');

  // Notification
  assert.equal(f.notifications.length, 1);
  const n = f.notifications[0];
  assert.equal(n.eventType, 'plan_review');
  assert.equal(n.sessionId, 'sid');
  assert.equal(n.requestId, 'req-42');
  const ev = n.event as unknown as { type: string; session_id: string; request_id: string; timestamp: string };
  assert.equal(ev.type, 'session_output');
  assert.equal(ev.session_id, 'sid');
  assert.equal(ev.request_id, 'req-42');
  assert.equal(ev.timestamp, '2026-05-08T00:00:00Z');

  // Wake payload
  const wp = n.wakePayload as { type: string; session_name: string; body: string; sound: string; category: string };
  assert.equal(wp.type, 'plan_review');
  assert.equal(wp.session_name, 'My Session');
  assert.equal(wp.body, 'plan body');
  assert.equal(wp.sound, 'default');
  assert.equal(wp.category, 'PLAN_REVIEW');

  // Blocking request
  assert.equal(f.blocking.length, 1);
  const b = f.blocking[0];
  assert.equal(b.requestId, 'req-42');
  assert.equal(b.sessionId, 'sid');
  assert.equal(b.type, 'plan_review');
});

test('sendPlanForReview: wake payload body falls back to "A plan is ready..." when no plan content', () => {
  const { fs } = makeFakeFs({});
  const f = makeSendPlanFixture({ fsImpl: fs, homedir: '/home/u' });
  sendPlanForReview(f.deps, 'sid', 'rid', {}, '/proj');
  const wp = f.notifications[0].wakePayload as { body: string };
  assert.equal(wp.body, 'A plan is ready for your review');
});

test('sendPlanForReview: allowed_prompts defaults to [] when toolInput omits it', () => {
  const { fs } = makeFakeFs({});
  const f = makeSendPlanFixture({ fsImpl: fs, homedir: '/home/u' });
  sendPlanForReview(f.deps, 'sid', 'rid', {}, '/proj');
  const ev = f.notifications[0].event as unknown as { allowed_prompts: unknown[] };
  assert.deepEqual(ev.allowed_prompts, []);
});
