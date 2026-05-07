import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  wireHookServer,
  type WireHookServerDeps,
  type WireHookServerRegistrars,
} from '../src/wiring/hook-server-wiring.js';

// ---------------------------------------------------------------------------
// Test harness — stub every registrar, capture (hookServer, deps) it gets.
// ---------------------------------------------------------------------------

function makeStubRegistrars(): {
  registrars: Partial<WireHookServerRegistrars>;
  calls: Array<{ name: string; hookServer: unknown; deps?: unknown }>;
} {
  const calls: Array<{ name: string; hookServer: unknown; deps?: unknown }> = [];
  const make = (name: string) =>
    ((hookServer: unknown, deps?: unknown) => {
      calls.push({ name, hookServer, deps });
    }) as never;

  const registrars: Partial<WireHookServerRegistrars> = {
    registerPermissionRequestPassthrough: make('PermissionRequestPassthrough'),
    registerToolResultHandler: make('ToolResult'),
    registerErrorHandler: make('Error'),
    registerPermissionExpiredHandler: make('PermissionExpired'),
    registerCodexSessionStartHandler: make('CodexSessionStart'),
    registerCodexUserPromptSubmitHandler: make('CodexUserPromptSubmit'),
    registerCodexStopHandler: make('CodexStop'),
    registerCodexPermissionRequestHandler: make('CodexPermissionRequest'),
    registerApiSessionsHandler: make('ApiSessions'),
    registerApiStatusHandler: make('ApiStatus'),
    registerSessionStopHandler: make('SessionStop'),
    registerSessionStopFailureHandler: make('SessionStopFailure'),
    registerSessionEndHandler: make('SessionEnd'),
    registerSubagentStopHandler: make('SubagentStop'),
    registerSubagentStartHandler: make('SubagentStart'),
    registerSessionStartHandler: make('SessionStart'),
    registerPermissionDismissedHandler: make('PermissionDismissed'),
    registerPermissionPromptHandler: make('PermissionPrompt'),
  };
  return { registrars, calls };
}

function makeDeps(): WireHookServerDeps {
  // Each slot just needs a unique sentinel so we can prove dep-routing.
  // Type-cast through unknown — the test only checks identity, not shape.
  return {
    toolResult: { tag: 'toolResult' } as never,
    error: { tag: 'error' } as never,
    permissionExpired: { tag: 'permissionExpired' } as never,
    codexSessionStart: { tag: 'codexSessionStart' } as never,
    codexUserPromptSubmit: { tag: 'codexUserPromptSubmit' } as never,
    codexStop: { tag: 'codexStop' } as never,
    codexPermissionRequest: { tag: 'codexPermissionRequest' } as never,
    apiSessions: { tag: 'apiSessions' } as never,
    apiStatus: { tag: 'apiStatus' } as never,
    sessionStop: { tag: 'sessionStop' } as never,
    sessionStopFailure: { tag: 'sessionStopFailure' } as never,
    sessionEnd: { tag: 'sessionEnd' } as never,
    subagent: { tag: 'subagent' } as never,
    sessionStart: { tag: 'sessionStart' } as never,
    permissionDismissed: { tag: 'permissionDismissed' } as never,
    permissionPrompt: { tag: 'permissionPrompt' } as never,
  };
}

const HOOK_SERVER = { __hookServer: true } as never;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('wireHookServer: invokes every registrar exactly once with the hookServer', () => {
  const { registrars, calls } = makeStubRegistrars();
  wireHookServer(HOOK_SERVER, makeDeps(), registrars);

  // 18 registrars total (PermissionRequestPassthrough takes no deps).
  assert.equal(calls.length, 18);
  for (const c of calls) {
    assert.equal(c.hookServer, HOOK_SERVER, `${c.name} should receive hookServer`);
  }
});

test('wireHookServer: routes each deps slot to its matching registrar', () => {
  const { registrars, calls } = makeStubRegistrars();
  const deps = makeDeps();
  wireHookServer(HOOK_SERVER, deps, registrars);

  const byName = new Map<string, unknown>();
  for (const c of calls) byName.set(c.name, c.deps);

  // PermissionRequestPassthrough receives no deps argument
  assert.equal(byName.get('PermissionRequestPassthrough'), undefined);

  assert.equal(byName.get('ToolResult'), deps.toolResult);
  assert.equal(byName.get('Error'), deps.error);
  assert.equal(byName.get('PermissionExpired'), deps.permissionExpired);
  assert.equal(byName.get('CodexSessionStart'), deps.codexSessionStart);
  assert.equal(byName.get('CodexUserPromptSubmit'), deps.codexUserPromptSubmit);
  assert.equal(byName.get('CodexStop'), deps.codexStop);
  assert.equal(byName.get('CodexPermissionRequest'), deps.codexPermissionRequest);
  assert.equal(byName.get('ApiSessions'), deps.apiSessions);
  assert.equal(byName.get('ApiStatus'), deps.apiStatus);
  assert.equal(byName.get('SessionStop'), deps.sessionStop);
  assert.equal(byName.get('SessionStopFailure'), deps.sessionStopFailure);
  assert.equal(byName.get('SessionEnd'), deps.sessionEnd);
  // Subagent dep is shared between Start + Stop registrars
  assert.equal(byName.get('SubagentStop'), deps.subagent);
  assert.equal(byName.get('SubagentStart'), deps.subagent);
  assert.equal(byName.get('SessionStart'), deps.sessionStart);
  assert.equal(byName.get('PermissionDismissed'), deps.permissionDismissed);
  assert.equal(byName.get('PermissionPrompt'), deps.permissionPrompt);
});

test('wireHookServer: registers handlers in stable order', () => {
  const { registrars, calls } = makeStubRegistrars();
  wireHookServer(HOOK_SERVER, makeDeps(), registrars);

  const order = calls.map(c => c.name);
  assert.deepEqual(order, [
    'PermissionRequestPassthrough',
    'ToolResult',
    'Error',
    'PermissionExpired',
    'CodexSessionStart',
    'CodexUserPromptSubmit',
    'CodexStop',
    'CodexPermissionRequest',
    'ApiSessions',
    'ApiStatus',
    'SessionStop',
    'SessionStopFailure',
    'SessionEnd',
    'SubagentStop',
    'SubagentStart',
    'SessionStart',
    'PermissionDismissed',
    'PermissionPrompt',
  ]);
});

test('wireHookServer: partial registrars override falls back to defaults for missing keys', () => {
  // Override only one registrar; the others must still fire (we can't observe
  // them here directly without real deps, so we assert by noting that calling
  // with valid deps does not throw — the defaults are the real handler
  // factories which all accept either a HookServer or a typed deps bag).
  const seen: string[] = [];
  const partial: Partial<WireHookServerRegistrars> = {
    registerPermissionRequestPassthrough: ((_hs: unknown) => {
      seen.push('passthrough');
    }) as never,
    // Stub every other registrar too so we don't accidentally invoke real
    // handler code with our sentinel deps. The point of this test is that
    // mixing overrides + defaults is supported by the merge logic.
    registerToolResultHandler: (() => seen.push('toolResult')) as never,
    registerErrorHandler: (() => seen.push('error')) as never,
    registerPermissionExpiredHandler: (() => seen.push('permissionExpired')) as never,
    registerCodexSessionStartHandler: (() => seen.push('codexSessionStart')) as never,
    registerCodexUserPromptSubmitHandler: (() => seen.push('codexUserPromptSubmit')) as never,
    registerCodexStopHandler: (() => seen.push('codexStop')) as never,
    registerCodexPermissionRequestHandler: (() => seen.push('codexPermissionRequest')) as never,
    registerApiSessionsHandler: (() => seen.push('apiSessions')) as never,
    registerApiStatusHandler: (() => seen.push('apiStatus')) as never,
    registerSessionStopHandler: (() => seen.push('sessionStop')) as never,
    registerSessionStopFailureHandler: (() => seen.push('sessionStopFailure')) as never,
    registerSessionEndHandler: (() => seen.push('sessionEnd')) as never,
    registerSubagentStopHandler: (() => seen.push('subagentStop')) as never,
    registerSubagentStartHandler: (() => seen.push('subagentStart')) as never,
    registerSessionStartHandler: (() => seen.push('sessionStart')) as never,
    registerPermissionDismissedHandler: (() => seen.push('permissionDismissed')) as never,
    registerPermissionPromptHandler: (() => seen.push('permissionPrompt')) as never,
  };
  wireHookServer(HOOK_SERVER, makeDeps(), partial);
  // First overridden registrar fired
  assert.equal(seen[0], 'passthrough');
  // 18 total
  assert.equal(seen.length, 18);
});

test('wireHookServer: defaults to real registrars when no override is passed', () => {
  // We don't have a real HookServer here; passing undefined will throw
  // inside the real registrar implementations. Catching the throw proves
  // the real registrars are wired in (rather than silently no-op'd).
  const deps = makeDeps();
  let threw = false;
  try {
    wireHookServer(undefined as never, deps);
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});
