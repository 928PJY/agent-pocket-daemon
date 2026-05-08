import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __setTmuxInjectorDepsForTest,
  findTerminalForPid,
  sendInterrupt,
  sendMessage,
  sendQuit,
  type TerminalTarget,
} from '../src/pty/tmux-injector.js';

type SpawnResult = { status: number | null; stdout?: Buffer; stderr?: Buffer };

function ok(stdout = ''): SpawnResult {
  return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.from('') };
}

function fail(stderr = 'failed'): SpawnResult {
  return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from(stderr) };
}

test('sendMessage dispatches tmux clear, literal text, and enter keys', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = __setTmuxInjectorDepsForTest({
    spawnSync(command, args) {
      calls.push({ command, args: args as string[] });
      return ok() as ReturnType<typeof import('node:child_process').spawnSync>;
    },
  });

  try {
    sendMessage({ type: 'tmux', socket: '/tmp/tmux/socket', target: 'main:0.1' }, 'hello "world"');
  } finally {
    restore();
  }

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args.slice(0, 5), ['-S', '/tmp/tmux/socket', 'send-keys', '-t', 'main:0.1']);
  assert.equal(calls[0].args.length, 205);
  assert.equal(calls[0].args[5], 'BSpace');
  assert.deepEqual(calls[1], {
    command: 'tmux',
    args: ['-S', '/tmp/tmux/socket', 'send-keys', '-t', 'main:0.1', '-l', 'hello "world"'],
  });
  assert.deepEqual(calls[2], {
    command: 'tmux',
    args: ['-S', '/tmp/tmux/socket', 'send-keys', '-t', 'main:0.1', 'Enter'],
  });
});

test('sendInterrupt dispatches tmux Escape', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = __setTmuxInjectorDepsForTest({
    spawnSync(command, args) {
      calls.push({ command, args: args as string[] });
      return ok() as ReturnType<typeof import('node:child_process').spawnSync>;
    },
  });

  try {
    sendInterrupt({ type: 'tmux', socket: '/tmp/tmux/socket', target: 'main:0.1' });
  } finally {
    restore();
  }

  assert.deepEqual(calls, [{
    command: 'tmux',
    args: ['-S', '/tmp/tmux/socket', 'send-keys', '-t', 'main:0.1', 'Escape'],
  }]);
});

test('sendMessage dispatches iTerm2 AppleScript with escaped text', () => {
  const scripts: string[] = [];
  const restore = __setTmuxInjectorDepsForTest({
    execFileSync(command, args) {
      assert.equal(command, 'osascript');
      scripts.push((args as string[])[1]);
      return Buffer.from('ok\n') as ReturnType<typeof import('node:child_process').execFileSync>;
    },
  });

  try {
    sendMessage({ type: 'iterm2', target: '/dev/ttys037' }, 'say "hi" \\ now');
  } finally {
    restore();
  }

  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /tty of s contains "\/dev\/ttys037"/);
  assert.match(scripts[0], /write s text "say \\"hi\\" \\\\ now" newline no/);
});

test('sendInterrupt dispatches iTerm2 Escape AppleScript', () => {
  const scripts: string[] = [];
  const restore = __setTmuxInjectorDepsForTest({
    execFileSync(command, args) {
      assert.equal(command, 'osascript');
      scripts.push((args as string[])[1]);
      return Buffer.from('ok\n') as ReturnType<typeof import('node:child_process').execFileSync>;
    },
  });

  try {
    sendInterrupt({ type: 'iterm2', target: '/dev/ttys037' });
  } finally {
    restore();
  }

  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /ASCII character 27/);
});

test('findTerminalForPid prefers iTerm2 when the TTY is present there', () => {
  const restore = __setTmuxInjectorDepsForTest({
    spawnSync(command, args) {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-p', '1234', '-o', 'tty=']);
      return ok('ttys037\n') as ReturnType<typeof import('node:child_process').spawnSync>;
    },
    execFileSync(command, args) {
      assert.equal(command, 'osascript');
      assert.match((args as string[])[1], /ttys037/);
      return Buffer.from('found\n') as ReturnType<typeof import('node:child_process').execFileSync>;
    },
  });

  try {
    assert.deepEqual(findTerminalForPid(1234), { type: 'iterm2', target: '/dev/ttys037' });
  } finally {
    restore();
  }
});

test('findTerminalForPid falls back to tmux pane by walking the PPID chain', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = __setTmuxInjectorDepsForTest({
    getuid: () => 501,
    readdirSync(dir) {
      assert.equal(dir.toString(), '/private/tmp/tmux-501');
      return ['default'] as ReturnType<typeof import('node:fs').readdirSync>;
    },
    execFileSync() {
      throw new Error('iTerm2 is not running');
    },
    spawnSync(command, args) {
      calls.push({ command, args: args as string[] });
      if (command === 'ps' && (args as string[]).includes('tty=')) return ok('ttys037\n') as ReturnType<typeof import('node:child_process').spawnSync>;
      if (command === 'tmux') return ok('4321 main:0.1\n') as ReturnType<typeof import('node:child_process').spawnSync>;
      if (command === 'ps' && (args as string[])[1] === '1234') return ok('4321\n') as ReturnType<typeof import('node:child_process').spawnSync>;
      throw new Error(`unexpected call: ${command} ${(args as string[]).join(' ')}`);
    },
  });

  try {
    assert.deepEqual(findTerminalForPid(1234), {
      type: 'tmux',
      socket: '/private/tmp/tmux-501/default',
      target: 'main:0.1',
    });
  } finally {
    restore();
  }

  assert.deepEqual(calls.map((call) => [call.command, call.args.slice(0, 3)]), [
    ['ps', ['-p', '1234', '-o']],
    ['tmux', ['-S', '/private/tmp/tmux-501/default', 'list-panes']],
    ['ps', ['-p', '1234', '-o']],
  ]);
});

test('findTerminalForPid returns null when iTerm2 and tmux discovery fail', () => {
  const restore = __setTmuxInjectorDepsForTest({
    getuid: () => 501,
    readdirSync: () => ['default'] as ReturnType<typeof import('node:fs').readdirSync>,
    execFileSync() {
      throw new Error('iTerm2 is not running');
    },
    spawnSync(command, args) {
      if (command === 'ps' && (args as string[]).includes('tty=')) return ok('ttys037\n') as ReturnType<typeof import('node:child_process').spawnSync>;
      if (command === 'tmux') return fail('no server') as ReturnType<typeof import('node:child_process').spawnSync>;
      throw new Error(`unexpected call: ${command} ${(args as string[]).join(' ')}`);
    },
  });

  try {
    assert.equal(findTerminalForPid(1234), null);
  } finally {
    restore();
  }
});

test('tmux sendMessage reports clear, text, and enter failures', () => {
  const target: TerminalTarget = { type: 'tmux', socket: '/tmp/tmux/socket', target: 'main:0.1' };

  for (const [failingCall, expected] of [
    [1, /tmux send BSpace failed: clear bad/],
    [2, /tmux send-keys failed: text bad/],
    [3, /tmux send Enter failed: enter bad/],
  ] as const) {
    let count = 0;
    const restore = __setTmuxInjectorDepsForTest({
      spawnSync() {
        count += 1;
        if (count === failingCall) return fail(failingCall === 1 ? 'clear bad' : failingCall === 2 ? 'text bad' : 'enter bad') as ReturnType<typeof import('node:child_process').spawnSync>;
        return ok() as ReturnType<typeof import('node:child_process').spawnSync>;
      },
    });

    try {
      assert.throws(() => sendMessage(target, 'hello'), expected);
    } finally {
      restore();
    }
  }
});

test('tmux sendInterrupt reports Escape failure', () => {
  const restore = __setTmuxInjectorDepsForTest({
    spawnSync() {
      return fail('escape bad') as ReturnType<typeof import('node:child_process').spawnSync>;
    },
  });

  try {
    assert.throws(
      () => sendInterrupt({ type: 'tmux', socket: '/tmp/tmux/socket', target: 'main:0.1' }),
      /tmux send Escape failed: escape bad/,
    );
  } finally {
    restore();
  }
});

test('iTerm2 sendMessage and sendInterrupt report not-found and AppleScript failures', () => {
  for (const [action, output, thrown, expected] of [
    ['message', 'not found\n', undefined, /iTerm2 session with TTY \/dev\/ttys037 not found/],
    ['message', undefined, new Error('boom'), /iTerm2 AppleScript failed: boom/],
    ['interrupt', 'not found\n', undefined, /iTerm2 session with TTY \/dev\/ttys037 not found/],
    ['interrupt', undefined, new Error('boom'), /iTerm2 AppleScript failed: boom/],
  ] as const) {
    const restore = __setTmuxInjectorDepsForTest({
      execFileSync() {
        if (thrown) throw thrown;
        return Buffer.from(output) as ReturnType<typeof import('node:child_process').execFileSync>;
      },
    });

    try {
      assert.throws(() => {
        if (action === 'message') sendMessage({ type: 'iterm2', target: '/dev/ttys037' }, 'hello');
        else sendInterrupt({ type: 'iterm2', target: '/dev/ttys037' });
      }, expected);
    } finally {
      restore();
    }
  }
});

test('sendQuit dispatches tmux send-keys C-c twice with a sleep in between', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restore = __setTmuxInjectorDepsForTest({
    spawnSync(command, args) {
      calls.push({ command, args: args as string[] });
      return ok() as ReturnType<typeof import('node:child_process').spawnSync>;
    },
    execFileSync(command, args) {
      calls.push({ command, args: args as string[] });
      return Buffer.from('') as ReturnType<typeof import('node:child_process').execFileSync>;
    },
  });

  try {
    sendQuit({ type: 'tmux', socket: '/tmp/tmux/socket', target: 'main:0.1' });
  } finally {
    restore();
  }

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    command: 'tmux',
    args: ['-S', '/tmp/tmux/socket', 'send-keys', '-t', 'main:0.1', 'C-c'],
  });
  assert.equal(calls[1].command, 'sleep');
  assert.deepEqual(calls[2], {
    command: 'tmux',
    args: ['-S', '/tmp/tmux/socket', 'send-keys', '-t', 'main:0.1', 'C-c'],
  });
});

test('sendQuit dispatches iTerm2 ASCII Ctrl-C twice with a sleep in between', () => {
  const calls: Array<{ command: string; arg: string }> = [];
  const restore = __setTmuxInjectorDepsForTest({
    execFileSync(command, args) {
      const argList = args as string[];
      // osascript args are ['-e', <script>]; sleep args are [<seconds>].
      // Capture whichever is the meaningful payload for each command so the
      // assertions below stay readable.
      if (command === 'osascript') {
        calls.push({ command, arg: argList[1] });
        return Buffer.from('ok\n') as ReturnType<typeof import('node:child_process').execFileSync>;
      }
      calls.push({ command, arg: argList[0] });
      return Buffer.from('') as ReturnType<typeof import('node:child_process').execFileSync>;
    },
  });

  try {
    sendQuit({ type: 'iterm2', target: '/dev/ttys037' });
  } finally {
    restore();
  }

  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, 'osascript');
  assert.match(calls[0].arg, /ttys037/);
  assert.match(calls[0].arg, /ASCII character 3/);
  assert.equal(calls[1].command, 'sleep');
  assert.equal(calls[2].command, 'osascript');
  assert.match(calls[2].arg, /ASCII character 3/);
});

test('sendQuit swallows sleep failures (best-effort) and still sends both Ctrl-C', () => {
  const tmuxCalls: number[] = [];
  const restore = __setTmuxInjectorDepsForTest({
    spawnSync() {
      tmuxCalls.push(Date.now());
      return ok() as ReturnType<typeof import('node:child_process').spawnSync>;
    },
    execFileSync(command) {
      if (command === 'sleep') throw new Error('sleep blew up');
      return Buffer.from('') as ReturnType<typeof import('node:child_process').execFileSync>;
    },
  });

  try {
    sendQuit({ type: 'tmux', socket: '/tmp/tmux/socket', target: 'main:0.1' });
  } finally {
    restore();
  }

  assert.equal(tmuxCalls.length, 2);
  // If sleep had silently slept anyway (e.g. catch in wrong place), the two
  // Ctrl-C timestamps would be ~150ms apart. Anything well under that proves
  // the throw short-circuited the gap.
  assert.ok(tmuxCalls[1] - tmuxCalls[0] < 50, `expected near-zero gap, got ${tmuxCalls[1] - tmuxCalls[0]}ms`);
});
