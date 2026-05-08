import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MANAGED_BY_TAG,
  managedEntry,
  persistentCommandEntry,
  codexManagedGroup,
  isCodexManagedGroup,
  isHttpManagedEntry,
  isManagedEntry,
  installSessionStartScript,
  installCodexHookScript,
  findTomlSection,
  enableCodexHooksFeature,
  installClaudeHooks,
  installCodexHooks,
  removeClaudeHooks,
  removeCodexHooks,
  type HooksManagerPaths,
} from '../src/cli/hooks-manager.js';

// ---------------------------------------------------------------------------
// Tmpdir scaffolding
// ---------------------------------------------------------------------------

function makePaths(): HooksManagerPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aphm-'));
  return {
    hooksDir: path.join(root, 'hooks'),
    claudeSettingsFile: path.join(root, 'claude', 'settings.json'),
    codexConfigFile: path.join(root, 'codex', 'config.toml'),
    codexHooksFile: path.join(root, 'codex', 'hooks.json'),
    hookDebugLogFile: path.join(root, 'hook-debug.log'),
  };
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Entry constructors
// ---------------------------------------------------------------------------

test('managedEntry: builds http entry with port + endpoint + timeout', () => {
  const e = managedEntry(9999, 'permission-request', 600);
  assert.equal(e._managedBy, MANAGED_BY_TAG);
  assert.equal(e.hooks.length, 1);
  assert.equal(e.hooks[0].type, 'http');
  assert.equal(e.hooks[0].url, 'http://127.0.0.1:9999/hooks/permission-request');
  assert.equal(e.hooks[0].timeout, 600);
});

test('persistentCommandEntry: builds command entry tagged managed', () => {
  const e = persistentCommandEntry('/tmp/script.sh', 5);
  assert.equal(e._managedBy, MANAGED_BY_TAG);
  assert.equal(e.hooks[0].type, 'command');
  assert.equal(e.hooks[0].command, '/tmp/script.sh');
  assert.equal(e.hooks[0].timeout, 5);
});

test('codexManagedGroup: includes statusMessage when given', () => {
  const g = codexManagedGroup('/x/codex-hook.sh permission-request', 600, 'Waiting');
  assert.equal(g.matcher, '*');
  assert.equal(g._managedBy, MANAGED_BY_TAG);
  const hook = (g.hooks as Array<Record<string, unknown>>)[0];
  assert.equal(hook.command, '/x/codex-hook.sh permission-request');
  assert.equal(hook.statusMessage, 'Waiting');
  assert.equal(hook._managedBy, MANAGED_BY_TAG);
});

test('codexManagedGroup: omits statusMessage when not given', () => {
  const g = codexManagedGroup('/x/codex-hook.sh stop', 10);
  const hook = (g.hooks as Array<Record<string, unknown>>)[0];
  assert.equal(hook.statusMessage, undefined);
});

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

test('isCodexManagedGroup: matches by group _managedBy', () => {
  const e = codexManagedGroup('/x/codex-hook.sh stop', 10);
  assert.equal(isCodexManagedGroup(e, '/x/codex-hook.sh'), true);
});

test('isCodexManagedGroup: matches by inner hook _managedBy', () => {
  const e = { hooks: [{ _managedBy: MANAGED_BY_TAG, command: 'x' }] };
  assert.equal(isCodexManagedGroup(e, '/x/codex-hook.sh'), true);
});

test('isCodexManagedGroup: matches by command path containing script', () => {
  const e = { hooks: [{ command: '/x/codex-hook.sh stop' }] };
  assert.equal(isCodexManagedGroup(e, '/x/codex-hook.sh'), true);
});

test('isCodexManagedGroup: rejects non-objects + nulls + arrays without hooks', () => {
  assert.equal(isCodexManagedGroup(null, '/x/codex-hook.sh'), false);
  assert.equal(isCodexManagedGroup('str', '/x/codex-hook.sh'), false);
  assert.equal(isCodexManagedGroup({}, '/x/codex-hook.sh'), false);
  assert.equal(isCodexManagedGroup({ hooks: 'no' }, '/x/codex-hook.sh'), false);
});

test('isCodexManagedGroup: returns false for unrelated entries', () => {
  const e = { hooks: [{ command: '/some/other.sh' }] };
  assert.equal(isCodexManagedGroup(e, '/x/codex-hook.sh'), false);
});

test('isHttpManagedEntry: managed group with command-type first hook returns false', () => {
  const e = { _managedBy: MANAGED_BY_TAG, hooks: [{ type: 'command', command: 'x' }] };
  assert.equal(isHttpManagedEntry(e), false);
});

test('isHttpManagedEntry: managed group with http first hook returns true', () => {
  const e = { _managedBy: MANAGED_BY_TAG, hooks: [{ type: 'http', url: 'http://x' }] };
  assert.equal(isHttpManagedEntry(e), true);
});

test('isHttpManagedEntry: detects entries by /hooks/ url substring', () => {
  const e = { hooks: [{ url: 'http://127.0.0.1:1/hooks/stop' }] };
  assert.equal(isHttpManagedEntry(e), true);
});

test('isHttpManagedEntry: rejects nulls + non-objects + empty hooks', () => {
  assert.equal(isHttpManagedEntry(null), false);
  assert.equal(isHttpManagedEntry(42), false);
  assert.equal(isHttpManagedEntry({}), false);
  assert.equal(isHttpManagedEntry({ hooks: [] }), false);
});

test('isManagedEntry: matches by _managedBy', () => {
  assert.equal(isManagedEntry({ _managedBy: MANAGED_BY_TAG }), true);
});

test('isManagedEntry: matches by hooks[0].url containing /hooks/', () => {
  assert.equal(isManagedEntry({ hooks: [{ url: 'http://1/hooks/foo' }] }), true);
});

test('isManagedEntry: matches by command path with agent-pocket / pocket-agent / /hooks/', () => {
  assert.equal(isManagedEntry({ hooks: [{ command: '/x/agent-pocket/hook.sh' }] }), true);
  assert.equal(isManagedEntry({ hooks: [{ command: '/x/pocket-agent/hook.sh' }] }), true);
  assert.equal(isManagedEntry({ hooks: [{ command: '/x/hooks/foo.sh' }] }), true);
});

test('isManagedEntry: rejects unrelated entries', () => {
  assert.equal(isManagedEntry(null), false);
  assert.equal(isManagedEntry({}), false);
  assert.equal(isManagedEntry({ hooks: [] }), false);
  assert.equal(isManagedEntry({ hooks: [{ command: '/usr/bin/foo' }] }), false);
  assert.equal(isManagedEntry({ hooks: [{ url: 'http://x/notmatched' }] }), false);
});

// ---------------------------------------------------------------------------
// Script emitters
// ---------------------------------------------------------------------------

test('installSessionStartScript: writes executable bash with port baked in', () => {
  const paths = makePaths();
  installSessionStartScript(7777, paths);
  const scriptPath = path.join(paths.hooksDir, 'session-start.sh');
  assert.equal(fs.existsSync(scriptPath), true);
  const body = fs.readFileSync(scriptPath, 'utf-8');
  assert.match(body, /#!\/bin\/bash/);
  assert.match(body, /127\.0\.0\.1:7777\/hooks\/session-start/);
  const mode = fs.statSync(scriptPath).mode & 0o777;
  assert.equal((mode & 0o100) !== 0, true, 'should be executable by owner');
});

test('installCodexHookScript: writes script with port + debug log path', () => {
  const paths = makePaths();
  installCodexHookScript(8888, paths);
  const scriptPath = path.join(paths.hooksDir, 'codex-hook.sh');
  const body = fs.readFileSync(scriptPath, 'utf-8');
  assert.match(body, /127\.0\.0\.1:8888\/hooks\/codex/);
  assert.ok(body.includes(paths.hookDebugLogFile));
  const mode = fs.statSync(scriptPath).mode & 0o777;
  assert.equal((mode & 0o100) !== 0, true);
});

// ---------------------------------------------------------------------------
// findTomlSection
// ---------------------------------------------------------------------------

test('findTomlSection: returns null when section absent', () => {
  assert.equal(findTomlSection('# nothing\n', 'features'), null);
});

test('findTomlSection: locates body of a single section', () => {
  const c = '[features]\ncodex_hooks = true\n';
  const r = findTomlSection(c, 'features');
  assert.ok(r);
  assert.equal(c.slice(r!.bodyStart, r!.bodyEnd), 'codex_hooks = true\n');
});

test('findTomlSection: stops body at next section header', () => {
  const c = '[a]\nx = 1\n[b]\ny = 2\n';
  const ra = findTomlSection(c, 'a')!;
  assert.equal(c.slice(ra.bodyStart, ra.bodyEnd), 'x = 1\n');
  const rb = findTomlSection(c, 'b')!;
  assert.equal(c.slice(rb.bodyStart, rb.bodyEnd), 'y = 2\n');
});

// ---------------------------------------------------------------------------
// enableCodexHooksFeature
// ---------------------------------------------------------------------------

test('enableCodexHooksFeature: creates file with [features] when missing', () => {
  const paths = makePaths();
  enableCodexHooksFeature(paths);
  const body = fs.readFileSync(paths.codexConfigFile, 'utf-8');
  assert.equal(body, '[features]\ncodex_hooks = true\n');
});

test('enableCodexHooksFeature: appends [features] section to non-empty config', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.codexConfigFile), { recursive: true });
  fs.writeFileSync(paths.codexConfigFile, '[other]\nfoo = "bar"\n', 'utf-8');
  enableCodexHooksFeature(paths);
  const body = fs.readFileSync(paths.codexConfigFile, 'utf-8');
  assert.match(body, /\[other\][\s\S]*\[features\]\ncodex_hooks = true\n/);
});

test('enableCodexHooksFeature: no-op when codex_hooks already true', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.codexConfigFile), { recursive: true });
  const original = '[features]\ncodex_hooks = true\nother = 1\n';
  fs.writeFileSync(paths.codexConfigFile, original, 'utf-8');
  enableCodexHooksFeature(paths);
  assert.equal(fs.readFileSync(paths.codexConfigFile, 'utf-8'), original);
});

test('enableCodexHooksFeature: flips codex_hooks=false → true', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.codexConfigFile), { recursive: true });
  fs.writeFileSync(paths.codexConfigFile, '[features]\ncodex_hooks = false\n', 'utf-8');
  enableCodexHooksFeature(paths);
  const body = fs.readFileSync(paths.codexConfigFile, 'utf-8');
  assert.match(body, /codex_hooks = true/);
  assert.doesNotMatch(body, /codex_hooks = false/);
});

test('enableCodexHooksFeature: appends key inside existing [features] without it', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.codexConfigFile), { recursive: true });
  fs.writeFileSync(paths.codexConfigFile, '[features]\nother = 1\n', 'utf-8');
  enableCodexHooksFeature(paths);
  const body = fs.readFileSync(paths.codexConfigFile, 'utf-8');
  assert.match(body, /\[features\]\nother = 1\ncodex_hooks = true\n/);
});

// ---------------------------------------------------------------------------
// installClaudeHooks
// ---------------------------------------------------------------------------

test('installClaudeHooks: writes settings + session-start script with all events', () => {
  const paths = makePaths();
  installClaudeHooks(5555, paths);

  // Script
  assert.equal(fs.existsSync(path.join(paths.hooksDir, 'session-start.sh')), true);

  // Settings
  const settings = readJson(paths.claudeSettingsFile);
  const hooks = settings.hooks as Record<string, unknown[]>;
  for (const ev of ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop',
    'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd']) {
    assert.ok(Array.isArray(hooks[ev]), `${ev} should be array`);
    assert.equal(hooks[ev].length, 1, `${ev} should have 1 entry`);
  }
  // SessionStart is the persistent command form
  const ss = hooks.SessionStart[0] as Record<string, unknown>;
  const ssHooks = ss.hooks as Array<Record<string, unknown>>;
  assert.equal(ssHooks[0].type, 'command');
  // PreToolUse is http
  const pre = (hooks.PreToolUse[0] as Record<string, unknown>).hooks as Array<Record<string, unknown>>;
  assert.equal(pre[0].type, 'http');
  assert.match(pre[0].url as string, /:5555\/hooks\/permission-request/);
});

test('installClaudeHooks: preserves user-defined non-managed entries, replaces managed', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ command: '/usr/local/bin/user-hook.sh' }] },
        // managed (will be replaced)
        { _managedBy: MANAGED_BY_TAG, hooks: [{ type: 'http', url: 'http://127.0.0.1:1/hooks/old' }] },
      ],
    },
    other: 'preserved',
  }), 'utf-8');

  installClaudeHooks(6666, paths);
  const settings = readJson(paths.claudeSettingsFile);
  const pre = (settings.hooks as Record<string, unknown[]>).PreToolUse;
  assert.equal(pre.length, 2);
  // First is preserved user entry
  const userHooks = (pre[0] as Record<string, unknown>).hooks as Array<Record<string, unknown>>;
  assert.equal(userHooks[0].command, '/usr/local/bin/user-hook.sh');
  // Second is the freshly-installed managed entry on new port
  const newHooks = (pre[1] as Record<string, unknown>).hooks as Array<Record<string, unknown>>;
  assert.match(newHooks[0].url as string, /:6666\//);
  assert.equal(settings.other, 'preserved');
});

test('installClaudeHooks: starts fresh when settings file is unparseable', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsFile, '{not-json', 'utf-8');
  installClaudeHooks(1234, paths);
  const settings = readJson(paths.claudeSettingsFile);
  assert.ok(settings.hooks);
});

// ---------------------------------------------------------------------------
// installCodexHooks
// ---------------------------------------------------------------------------

test('installCodexHooks: writes hooks.json with 4 events + enables feature', () => {
  const paths = makePaths();
  installCodexHooks(4444, paths);
  // Script written
  assert.equal(fs.existsSync(path.join(paths.hooksDir, 'codex-hook.sh')), true);
  // Feature toggled
  assert.match(fs.readFileSync(paths.codexConfigFile, 'utf-8'), /codex_hooks = true/);
  // hooks.json
  const cfg = readJson(paths.codexHooksFile);
  const hooks = cfg.hooks as Record<string, unknown[]>;
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']) {
    assert.ok(Array.isArray(hooks[ev]), `${ev} array`);
    assert.equal(hooks[ev].length, 1);
  }
  // PermissionRequest carries statusMessage
  const pr = hooks.PermissionRequest[0] as Record<string, unknown>;
  const prHook = (pr.hooks as Array<Record<string, unknown>>)[0];
  assert.equal(prHook.statusMessage, 'Waiting for Agent Pocket approval');
  // Commands include the codex-hook.sh path
  const ss = hooks.SessionStart[0] as Record<string, unknown>;
  const ssHook = (ss.hooks as Array<Record<string, unknown>>)[0];
  assert.match(ssHook.command as string, /codex-hook\.sh session-start/);
});

test('installCodexHooks: preserves non-managed groups, replaces managed', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.codexHooksFile), { recursive: true });
  fs.writeFileSync(paths.codexHooksFile, JSON.stringify({
    hooks: {
      Stop: [
        { matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/userhook' }] },
        { _managedBy: MANAGED_BY_TAG, hooks: [{ type: 'command', command: 'old', _managedBy: MANAGED_BY_TAG }] },
      ],
    },
  }), 'utf-8');
  installCodexHooks(2222, paths);
  const cfg = readJson(paths.codexHooksFile);
  const stop = (cfg.hooks as Record<string, unknown[]>).Stop;
  assert.equal(stop.length, 2);
  const first = (stop[0] as Record<string, unknown>).hooks as Array<Record<string, unknown>>;
  assert.equal(first[0].command, '/usr/local/bin/userhook');
});

test('installCodexHooks: starts fresh when hooks.json unparseable', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.codexHooksFile), { recursive: true });
  fs.writeFileSync(paths.codexHooksFile, 'garbage', 'utf-8');
  installCodexHooks(3333, paths);
  const cfg = readJson(paths.codexHooksFile);
  assert.ok(cfg.hooks);
});

// ---------------------------------------------------------------------------
// removeClaudeHooks
// ---------------------------------------------------------------------------

test('removeClaudeHooks: no-op when settings file missing', () => {
  const paths = makePaths();
  removeClaudeHooks(paths); // should not throw
  assert.equal(fs.existsSync(paths.claudeSettingsFile), false);
});

test('removeClaudeHooks: strips http-managed entries, keeps others', () => {
  const paths = makePaths();
  installClaudeHooks(9000, paths);
  // Add a user-defined http entry that does NOT look managed
  const settings = readJson(paths.claudeSettingsFile);
  const hooks = settings.hooks as Record<string, unknown[]>;
  hooks.PreToolUse = [
    { hooks: [{ command: '/usr/local/bin/user-hook.sh' }] },
    ...hooks.PreToolUse,
  ];
  fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify(settings), 'utf-8');

  removeClaudeHooks(paths);
  const after = readJson(paths.claudeSettingsFile);
  const afterHooks = (after.hooks ?? {}) as Record<string, unknown[]>;
  // PreToolUse should retain the user entry only
  assert.equal((afterHooks.PreToolUse as unknown[]).length, 1);
  // SessionStart (command-type managed group) is NOT http-managed → preserved
  assert.ok(afterHooks.SessionStart);
});

test('removeClaudeHooks: deletes empty hooks key when nothing left', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify({
    hooks: {
      PreToolUse: [{ _managedBy: MANAGED_BY_TAG, hooks: [{ type: 'http', url: 'http://x/hooks/y' }] }],
    },
  }), 'utf-8');
  removeClaudeHooks(paths);
  const after = readJson(paths.claudeSettingsFile);
  assert.equal(after.hooks, undefined);
});

test('removeClaudeHooks: swallows JSON parse errors', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsFile, 'broken', 'utf-8');
  removeClaudeHooks(paths); // no throw
  assert.equal(fs.readFileSync(paths.claudeSettingsFile, 'utf-8'), 'broken');
});

test('removeClaudeHooks: no-op when no hooks key', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify({ other: 1 }), 'utf-8');
  removeClaudeHooks(paths);
  const after = readJson(paths.claudeSettingsFile);
  assert.equal(after.other, 1);
});

// ---------------------------------------------------------------------------
// removeCodexHooks
// ---------------------------------------------------------------------------

test('removeCodexHooks: no-op when hooks.json missing', () => {
  const paths = makePaths();
  removeCodexHooks(paths);
  assert.equal(fs.existsSync(paths.codexHooksFile), false);
});

test('removeCodexHooks: strips managed groups + deletes empty hooks key', () => {
  const paths = makePaths();
  installCodexHooks(7777, paths);
  removeCodexHooks(paths);
  const cfg = readJson(paths.codexHooksFile);
  assert.equal(cfg.hooks, undefined);
});

test('removeCodexHooks: preserves non-managed groups', () => {
  const paths = makePaths();
  installCodexHooks(7777, paths);
  // Inject a user group
  const cfg = readJson(paths.codexHooksFile);
  (cfg.hooks as Record<string, unknown[]>).Stop = [
    { matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/keep' }] },
    ...(cfg.hooks as Record<string, unknown[]>).Stop,
  ];
  fs.writeFileSync(paths.codexHooksFile, JSON.stringify(cfg), 'utf-8');

  removeCodexHooks(paths);
  const after = readJson(paths.codexHooksFile);
  const stop = (after.hooks as Record<string, unknown[]>).Stop;
  assert.equal(stop.length, 1);
  const keep = (stop[0] as Record<string, unknown>).hooks as Array<Record<string, unknown>>;
  assert.equal(keep[0].command, '/usr/local/bin/keep');
});

test('removeCodexHooks: swallows JSON parse errors', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.codexHooksFile), { recursive: true });
  fs.writeFileSync(paths.codexHooksFile, 'broken', 'utf-8');
  removeCodexHooks(paths);
  assert.equal(fs.readFileSync(paths.codexHooksFile, 'utf-8'), 'broken');
});

test('removeCodexHooks: no-op when hooks key missing or non-object', () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.codexHooksFile), { recursive: true });
  fs.writeFileSync(paths.codexHooksFile, JSON.stringify({}), 'utf-8');
  removeCodexHooks(paths);
  assert.deepEqual(readJson(paths.codexHooksFile), {});
});
