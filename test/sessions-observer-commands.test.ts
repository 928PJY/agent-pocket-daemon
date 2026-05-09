import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import {
  BUILTIN_TERMINAL_COMMANDS,
  OBSERVER_HIDDEN_COMMANDS,
  getObserverCommands,
  _resetObserverCommandsCacheForTest,
  _seedSdkCommandsCacheForTest,
} from '../src/sessions/observer-commands.js';

function reset() {
  _resetObserverCommandsCacheForTest();
}

test('getObserverCommands: returns built-ins minus hidden when SDK list is empty', async () => {
  reset();
  _seedSdkCommandsCacheForTest([]);
  const out = await getObserverCommands();
  const names = new Set(out.map(c => c.name));

  for (const builtin of BUILTIN_TERMINAL_COMMANDS) {
    if (OBSERVER_HIDDEN_COMMANDS.has(builtin.name)) {
      assert.equal(names.has(builtin.name), false, `${builtin.name} should be hidden`);
    } else {
      assert.equal(names.has(builtin.name), true, `${builtin.name} should be present`);
    }
  }
});

test('getObserverCommands: SDK commands are appended after built-ins', async () => {
  reset();
  const sdkOnly: SlashCommand[] = [
    { name: 'simplify', description: 'Simplify code', argumentHint: '' },
    { name: 'superpowers:debug', description: 'Plugin debug', argumentHint: '' },
  ];
  _seedSdkCommandsCacheForTest(sdkOnly);
  const out = await getObserverCommands();
  const names = out.map(c => c.name);

  assert.ok(names.includes('simplify'));
  assert.ok(names.includes('superpowers:debug'));
});

test('getObserverCommands: built-in wins on name collision with SDK', async () => {
  reset();
  // /clear is a built-in (not hidden). If the SDK happens to also report
  // /clear, the built-in entry's description must be the one returned.
  const sdkClash: SlashCommand[] = [
    { name: 'clear', description: 'SDK-provided clear (should lose)', argumentHint: '' },
  ];
  _seedSdkCommandsCacheForTest(sdkClash);
  const out = await getObserverCommands();
  const clears = out.filter(c => c.name === 'clear');

  assert.equal(clears.length, 1, 'no duplicates');
  assert.notEqual(clears[0].description, 'SDK-provided clear (should lose)');
});

test('getObserverCommands: hidden blacklist filters both built-ins and SDK', async () => {
  reset();
  // Pick a few sentinel hidden names from each blacklist category.
  const sdkHidden: SlashCommand[] = [
    { name: 'copy', description: 'sdk copy', argumentHint: '' },
    { name: 'doctor', description: 'sdk doctor', argumentHint: '' },
    { name: 'install-github-app', description: 'sdk gh app', argumentHint: '' },
  ];
  _seedSdkCommandsCacheForTest(sdkHidden);
  const out = await getObserverCommands();
  const names = new Set(out.map(c => c.name));

  assert.equal(names.has('copy'), false);
  assert.equal(names.has('doctor'), false);
  assert.equal(names.has('install-github-app'), false);
});

test('OBSERVER_HIDDEN_COMMANDS: covers the documented categories', () => {
  // Sanity check that we didn't accidentally drop a category.
  // Local-only:
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('copy'));
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('terminal-setup'));
  // Cloud setup:
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('setup-bedrock'));
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('setup-vertex'));
  // OAuth/account:
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('install-github-app'));
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('upgrade'));
  // Diagnostic:
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('doctor'));
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('heapdump'));
  // TUI-only / picker-required (verified empirically against Claude Code 2.1.x):
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('permissions'));
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('agents'));
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('plan'));
  assert.ok(OBSERVER_HIDDEN_COMMANDS.has('effort'));
});

test('BUILTIN_TERMINAL_COMMANDS: no internal duplicates', () => {
  const names = BUILTIN_TERMINAL_COMMANDS.map(c => c.name);
  assert.equal(new Set(names).size, names.length, 'duplicate built-in command name');
});

test('getObserverCommands: SDK command hidden when one of its aliases is blacklisted', async () => {
  reset();
  // 'app' is in OBSERVER_HIDDEN_COMMANDS as a /desktop alias. If the SDK
  // ever surfaces a command whose alias collides, alias-aware filtering
  // must drop it too.
  const sdkAliasClash: SlashCommand[] = [
    { name: 'someother', description: 'x', argumentHint: '', aliases: ['app'] },
  ];
  _seedSdkCommandsCacheForTest(sdkAliasClash);
  const out = await getObserverCommands();
  assert.equal(out.find(c => c.name === 'someother'), undefined);
});

test('BUILTIN_TERMINAL_COMMANDS: /context absorbs /usage as alias', () => {
  const ctx = BUILTIN_TERMINAL_COMMANDS.find(c => c.name === 'context');
  assert.ok(ctx, 'context command exists');
  assert.ok(ctx!.aliases?.includes('usage'), '/context aliases include usage');
  // /usage must not exist as a standalone command — selection should always
  // insert /context.
  assert.equal(BUILTIN_TERMINAL_COMMANDS.find(c => c.name === 'usage'), undefined);
});
