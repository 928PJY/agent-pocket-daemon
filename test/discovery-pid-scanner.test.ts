import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import {
  isProcessSuspendedOrZombie,
  getRunningCliSessions,
  getRunningAllSessions,
  getRunningSessionEntrypoints,
  type PidScannerDeps,
} from '../src/discovery/pid-scanner.js';

// ---------------------------------------------------------------------------
// In-memory fs fake
// ---------------------------------------------------------------------------

interface FakeFsState {
  files: Map<string, string>;
  dirs: Set<string>;
}

function makeFakeFs(state: FakeFsState) {
  return {
    existsSync: (p: string) => state.files.has(p) || state.dirs.has(p),
    readdirSync: ((p: string) => {
      if (!state.dirs.has(p)) throw new Error(`ENOENT: ${p}`);
      const prefix = p.endsWith('/') ? p : p + '/';
      const out: string[] = [];
      for (const f of state.files.keys()) {
        if (f.startsWith(prefix)) {
          const tail = f.slice(prefix.length);
          if (!tail.includes('/')) out.push(tail);
        }
      }
      return out;
    }) as unknown as typeof import('node:fs').readdirSync,
    readFileSync: ((p: string) => {
      const c = state.files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    }) as unknown as typeof import('node:fs').readFileSync,
  };
}

const CLAUDE_DIR = '/home/u/.claude';
const SESSIONS = path.join(CLAUDE_DIR, 'sessions');

interface PidFile {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  entrypoint?: string;
  name?: unknown;
}

function setup(files: Record<string, PidFile | string>) {
  const state: FakeFsState = { files: new Map(), dirs: new Set([SESSIONS]) };
  for (const [name, body] of Object.entries(files)) {
    state.files.set(path.join(SESSIONS, name),
      typeof body === 'string' ? body : JSON.stringify(body));
  }
  return state;
}

function makeDeps(
  state: FakeFsState,
  opts: {
    deadPids?: number[];
    suspendedPids?: number[];
    terminals?: Record<number, { tmux: string }>;
  } = {},
): PidScannerDeps {
  const dead = new Set(opts.deadPids ?? []);
  const susp = new Set(opts.suspendedPids ?? []);
  return {
    fsImpl: makeFakeFs(state),
    killFn: (pid) => { if (dead.has(pid)) throw new Error('ESRCH'); },
    findTerminalForPid: (pid) => (opts.terminals?.[pid] as never) ?? null,
    isProcessSuspendedOrZombie: (pid) => susp.has(pid),
    getLiveProcessCwd: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// isProcessSuspendedOrZombie (real impl smoke test)
// ---------------------------------------------------------------------------

test('isProcessSuspendedOrZombie: false for current process (running, not zombie)', () => {
  assert.equal(isProcessSuspendedOrZombie(process.pid), false);
});

test('isProcessSuspendedOrZombie: false for nonexistent pid (ps fails)', () => {
  // 999999 unlikely to be alive on a fresh box; even if it is, "running" is also false
  assert.equal(isProcessSuspendedOrZombie(999999), false);
});

// ---------------------------------------------------------------------------
// getRunningCliSessions
// ---------------------------------------------------------------------------

test('getRunningCliSessions: returns [] when sessions dir does not exist', () => {
  const state: FakeFsState = { files: new Map(), dirs: new Set() };
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state));
  assert.deepEqual(out, []);
});

test('getRunningCliSessions: returns [] when readdir throws', () => {
  const state: FakeFsState = { files: new Map(), dirs: new Set([SESSIONS]) };
  const fake = makeFakeFs(state);
  const out = getRunningCliSessions(CLAUDE_DIR, {
    ...makeDeps(state),
    fsImpl: { ...fake, readdirSync: (() => { throw new Error('EACCES'); }) as unknown as typeof import('node:fs').readdirSync },
  });
  assert.deepEqual(out, []);
});

test('getRunningCliSessions: filters out non-.json files', () => {
  const state = setup({ 'README.txt': '...' });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state));
  assert.deepEqual(out, []);
});

test('getRunningCliSessions: skips files with non-cli entrypoint', () => {
  const state = setup({
    '111.json': { pid: 111, entrypoint: 'vscode', sessionId: 's-vsc' },
    '222.json': { pid: 222, entrypoint: 'cli', sessionId: 's-cli', cwd: '/u/a' },
  });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state));
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 's-cli');
});

test('getRunningCliSessions: skips files missing pid', () => {
  const state = setup({
    'noop.json': { entrypoint: 'cli' },
  });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state));
  assert.deepEqual(out, []);
});

test('getRunningCliSessions: skips dead processes (kill throws)', () => {
  const state = setup({ '333.json': { pid: 333, entrypoint: 'cli', sessionId: 's' } });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state, { deadPids: [333] }));
  assert.deepEqual(out, []);
});

test('getRunningCliSessions: skips suspended/zombie processes', () => {
  const state = setup({ '444.json': { pid: 444, entrypoint: 'cli', sessionId: 's' } });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state, { suspendedPids: [444] }));
  assert.deepEqual(out, []);
});

test('getRunningCliSessions: skips unparseable JSON files', () => {
  const state = setup({ 'bad.json': '{not-json' });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state));
  assert.deepEqual(out, []);
});

test('getRunningCliSessions: maps to RunningCliSession with terminal target + name + entrypoint forced to cli', () => {
  const state = setup({
    '555.json': { pid: 555, entrypoint: 'cli', sessionId: 's-555', cwd: '/u/x', name: 'Research' },
  });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state, {
    terminals: { 555: { tmux: 'sess:0.0' } as never },
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].pid, 555);
  assert.equal(out[0].sessionId, 's-555');
  assert.equal(out[0].cwd, '/u/x');
  assert.equal(out[0].entrypoint, 'cli');
  assert.equal(out[0].name, 'Research');
  assert.deepEqual(out[0].terminalTarget, { tmux: 'sess:0.0' });
});

test('getRunningCliSessions: terminalTarget undefined when findTerminalForPid returns null', () => {
  const state = setup({ '666.json': { pid: 666, entrypoint: 'cli', sessionId: 's' } });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state)); // no terminals
  assert.equal(out[0].terminalTarget, undefined);
});

test('getRunningCliSessions: defaults sessionId/cwd to "" when missing; name undefined when not string', () => {
  const state = setup({
    '777.json': { pid: 777, entrypoint: 'cli', name: 42 as unknown },
  });
  const out = getRunningCliSessions(CLAUDE_DIR, makeDeps(state));
  assert.equal(out[0].sessionId, '');
  assert.equal(out[0].cwd, '');
  assert.equal(out[0].name, undefined);
});

// ---------------------------------------------------------------------------
// getRunningAllSessions
// ---------------------------------------------------------------------------

test('getRunningAllSessions: includes both cli and non-cli entrypoints', () => {
  const state = setup({
    '1.json': { pid: 1, entrypoint: 'cli', sessionId: 'a' },
    '2.json': { pid: 2, entrypoint: 'claude-vscode', sessionId: 'b' },
  });
  const out = getRunningAllSessions(CLAUDE_DIR, makeDeps(state));
  assert.equal(out.length, 2);
  const eps = out.map((r) => r.entrypoint).sort();
  assert.deepEqual(eps, ['claude-vscode', 'cli']);
});

test('getRunningAllSessions: only resolves terminalTarget for cli entrypoints', () => {
  const state = setup({
    '11.json': { pid: 11, entrypoint: 'cli', sessionId: 'a' },
    '22.json': { pid: 22, entrypoint: 'vscode', sessionId: 'b' },
  });
  const out = getRunningAllSessions(CLAUDE_DIR, makeDeps(state, {
    terminals: { 11: { tmux: 'x' } as never, 22: { tmux: 'y' } as never },
  }));
  const cli = out.find((r) => r.entrypoint === 'cli')!;
  const other = out.find((r) => r.entrypoint === 'vscode')!;
  assert.deepEqual(cli.terminalTarget, { tmux: 'x' });
  assert.equal(other.terminalTarget, undefined);
});

test('getRunningAllSessions: defaults entrypoint to "unknown" when missing', () => {
  const state = setup({ '33.json': { pid: 33, sessionId: 'noep' } });
  const out = getRunningAllSessions(CLAUDE_DIR, makeDeps(state));
  assert.equal(out[0].entrypoint, 'unknown');
});

test('getRunningAllSessions: skips dead + suspended processes', () => {
  const state = setup({
    '40.json': { pid: 40, entrypoint: 'cli', sessionId: 'alive' },
    '41.json': { pid: 41, entrypoint: 'cli', sessionId: 'dead' },
    '42.json': { pid: 42, entrypoint: 'cli', sessionId: 'susp' },
  });
  const out = getRunningAllSessions(CLAUDE_DIR, makeDeps(state, {
    deadPids: [41], suspendedPids: [42],
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'alive');
});

test('getRunningAllSessions: returns [] when sessions dir missing', () => {
  const state: FakeFsState = { files: new Map(), dirs: new Set() };
  assert.deepEqual(getRunningAllSessions(CLAUDE_DIR, makeDeps(state)), []);
});

// ---------------------------------------------------------------------------
// getRunningSessionEntrypoints
// ---------------------------------------------------------------------------

test('getRunningSessionEntrypoints: returns sessionId → entrypoint map for live PIDs', () => {
  const state = setup({
    '50.json': { pid: 50, entrypoint: 'cli', sessionId: 's-cli' },
    '51.json': { pid: 51, entrypoint: 'vscode', sessionId: 's-vsc' },
    '52.json': { pid: 52, sessionId: 's-noep' },
  });
  const out = getRunningSessionEntrypoints(CLAUDE_DIR, makeDeps(state));
  assert.equal(out.size, 3);
  assert.equal(out.get('s-cli'), 'cli');
  assert.equal(out.get('s-vsc'), 'vscode');
  assert.equal(out.get('s-noep'), 'unknown');
});

test('getRunningSessionEntrypoints: skips dead PIDs', () => {
  const state = setup({
    '60.json': { pid: 60, entrypoint: 'cli', sessionId: 'alive' },
    '61.json': { pid: 61, entrypoint: 'cli', sessionId: 'dead' },
  });
  const out = getRunningSessionEntrypoints(CLAUDE_DIR, makeDeps(state, { deadPids: [61] }));
  assert.equal(out.size, 1);
  assert.equal(out.has('alive'), true);
});

test('getRunningSessionEntrypoints: skips files missing sessionId', () => {
  const state = setup({ '70.json': { pid: 70, entrypoint: 'cli' } });
  const out = getRunningSessionEntrypoints(CLAUDE_DIR, makeDeps(state));
  assert.equal(out.size, 0);
});

test('getRunningSessionEntrypoints: returns empty Map when dir missing', () => {
  const state: FakeFsState = { files: new Map(), dirs: new Set() };
  const out = getRunningSessionEntrypoints(CLAUDE_DIR, makeDeps(state));
  assert.equal(out.size, 0);
});

test('getRunningSessionEntrypoints: returns empty Map when readdir throws', () => {
  const state: FakeFsState = { files: new Map(), dirs: new Set([SESSIONS]) };
  const fake = makeFakeFs(state);
  const out = getRunningSessionEntrypoints(CLAUDE_DIR, {
    ...makeDeps(state),
    fsImpl: { ...fake, readdirSync: (() => { throw new Error('EACCES'); }) as unknown as typeof import('node:fs').readdirSync },
  });
  assert.equal(out.size, 0);
});

test('getRunningSessionEntrypoints: skips unparseable JSON files', () => {
  const state = setup({ 'bad.json': 'not-json', '80.json': { pid: 80, entrypoint: 'cli', sessionId: 'good' } });
  const out = getRunningSessionEntrypoints(CLAUDE_DIR, makeDeps(state));
  assert.equal(out.size, 1);
  assert.equal(out.get('good'), 'cli');
});

test('getRunningSessionEntrypoints: skips files missing pid', () => {
  const state = setup({ '90.json': { entrypoint: 'cli', sessionId: 'noop' } });
  const out = getRunningSessionEntrypoints(CLAUDE_DIR, makeDeps(state));
  assert.equal(out.size, 0);
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('default fsImpl + killFn are usable (smoke against real fs miss)', () => {
  // Sessions dir certainly doesn't exist under /nonexistent
  assert.deepEqual(getRunningCliSessions('/nonexistent/.claude'), []);
  assert.deepEqual(getRunningAllSessions('/nonexistent/.claude'), []);
  assert.equal(getRunningSessionEntrypoints('/nonexistent/.claude').size, 0);
});
