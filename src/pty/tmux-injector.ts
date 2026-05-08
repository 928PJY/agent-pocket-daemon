// Agent Pocket -- Terminal Injector
// Injects text into terminal sessions as if the user typed it.
// Supports iTerm2 (via AppleScript) and tmux (via send-keys).
// Used to send phone messages into terminal Claude sessions.

import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface TmuxInjectorDeps {
  spawnSync: typeof spawnSync;
  execFileSync: typeof execFileSync;
  readdirSync: typeof fs.readdirSync;
  getuid: () => number | undefined;
}

let deps: TmuxInjectorDeps = {
  spawnSync,
  execFileSync,
  readdirSync: fs.readdirSync,
  getuid: () => process.getuid?.(),
};

export function __setTmuxInjectorDepsForTest(overrides: Partial<TmuxInjectorDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...overrides };
  return () => {
    deps = previous;
  };
}

// ============================================================================
// Types
// ============================================================================

export interface TerminalTarget {
  type: 'iterm2' | 'tmux';
  /** iTerm2: the TTY path (e.g., "/dev/ttys037"). tmux: the pane target (e.g., "main:0.1"). */
  target: string;
  /** tmux only: the socket path */
  socket?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Find how to inject into the terminal running a given PID.
 * Tries iTerm2 first (most common on macOS), then tmux.
 */
export function findTerminalForPid(pid: number): TerminalTarget | null {
  // Get the TTY for this PID
  const tty = getTtyForPid(pid);

  // Try iTerm2 first — skip pgrep check (unreliable on macOS),
  // just ask iTerm2 directly via AppleScript (fails fast if not running)
  if (tty) {
    const found = iTerm2HasTty(tty);
    if (found) {
      return { type: 'iterm2', target: `/dev/${tty}` };
    }
  }

  // Try tmux
  const tmuxTarget = findTmuxPaneForPid(pid);
  if (tmuxTarget) {
    return { type: 'tmux', target: tmuxTarget.target, socket: tmuxTarget.socket };
  }

  return null;
}

/**
 * Send a message to a terminal session as if the user typed it + pressed Enter.
 * Clears any existing input line first (Ctrl-U) to avoid mixing with partially typed text.
 */
export function sendMessage(target: TerminalTarget, text: string): void {
  switch (target.type) {
    case 'iterm2':
      iTerm2ClearAndWriteText(target.target, text);
      break;
    case 'tmux':
      tmuxClearAndSendKeys(target.socket!, target.target, text);
      break;
  }
}

/**
 * Send an Escape keypress to a terminal session to interrupt the current operation.
 * In Claude Code, Escape interrupts the current turn gracefully.
 */
export function sendInterrupt(target: TerminalTarget): void {
  switch (target.type) {
    case 'iterm2':
      iTerm2SendEscape(target.target);
      break;
    case 'tmux':
      tmuxSendEscape(target.socket!, target.target);
      break;
  }
}

/**
 * Send two Ctrl-C presses ~150ms apart to a terminal session running Claude
 * Code's REPL. The first cancels the current input/turn; the second confirms
 * exit and prints `claude --resume <id>` so the user can pick up where they
 * left off. Sending only one Ctrl-C does not exit.
 */
export function sendQuit(target: TerminalTarget): void {
  switch (target.type) {
    case 'iterm2':
      iTerm2SendCtrlC(target.target);
      // Tiny delay so Claude's REPL processes the first Ctrl-C as "cancel"
      // before the second one is read as "confirm exit".
      sleepBlocking(150);
      iTerm2SendCtrlC(target.target);
      break;
    case 'tmux':
      tmuxSendCtrlC(target.socket!, target.target);
      sleepBlocking(150);
      tmuxSendCtrlC(target.socket!, target.target);
      break;
  }
}

function sleepBlocking(ms: number): void {
  // execFileSync blocks the event loop, which is what we want here — the next
  // injection must observe the REPL's reaction to the first Ctrl-C.
  try { deps.execFileSync('sleep', [String(ms / 1000)], { timeout: ms + 500 }); } catch { /* best-effort */ }
}

// ============================================================================
// iTerm2 (AppleScript)
// ============================================================================

/**
 * Check if iTerm2 has a session with the given TTY.
 */
function iTerm2HasTty(tty: string): boolean {
  try {
    const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s contains "${tty}" then
          return "found"
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;
    const result = deps.execFileSync('osascript', ['-e', script], { timeout: 3000 });
    return result.toString().trim() === 'found';
  } catch {
    return false;
  }
}

/**
 * Clear the current input line then write text to the iTerm2 session.
 * Sends backspaces via a loop to erase any partially-typed text, since
 * Claude Code uses a custom Ink-based input that ignores Ctrl-U.
 */
function iTerm2ClearAndWriteText(ttyPath: string, text: string): void {
  // Escape backslashes and double quotes for AppleScript string literal
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // Send backspaces to clear existing input, delay, then write text + newline separately.
  const bsCount = 200;
  const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s contains "${ttyPath}" then
          set bs to ASCII character 127
          set clearStr to ""
          repeat ${bsCount} times
            set clearStr to clearStr & bs
          end repeat
          write s text clearStr newline no
          delay 0.15
          write s text "${escaped}" newline no
          delay 0.05
          write s text (ASCII character 10)
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not found"
end tell`;

  try {
    const result = deps.execFileSync('osascript', ['-e', script], { timeout: 5000 });
    const output = result.toString().trim();
    if (output === 'not found') {
      throw new Error(`iTerm2 session with TTY ${ttyPath} not found`);
    }
  } catch (err) {
    if ((err as Error).message.includes('not found')) throw err;
    throw new Error(`iTerm2 AppleScript failed: ${(err as Error).message}`);
  }
}

/**
 * Send an Escape character to an iTerm2 session.
 */
function iTerm2SendEscape(ttyPath: string): void {
  // ASCII 27 = Escape. Use «write text» with newline:no to avoid sending Enter after it.
  const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s contains "${ttyPath}" then
          write s text (ASCII character 27) newline no
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not found"
end tell`;

  try {
    const result = deps.execFileSync('osascript', ['-e', script], { timeout: 5000 });
    const output = result.toString().trim();
    if (output === 'not found') {
      throw new Error(`iTerm2 session with TTY ${ttyPath} not found`);
    }
  } catch (err) {
    if ((err as Error).message.includes('not found')) throw err;
    throw new Error(`iTerm2 AppleScript failed: ${(err as Error).message}`);
  }
}

/**
 * Send an ETX (Ctrl-C, ASCII 3) character to an iTerm2 session.
 */
function iTerm2SendCtrlC(ttyPath: string): void {
  const script = `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s contains "${ttyPath}" then
          write s text (ASCII character 3) newline no
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not found"
end tell`;

  try {
    const result = deps.execFileSync('osascript', ['-e', script], { timeout: 5000 });
    const output = result.toString().trim();
    if (output === 'not found') {
      throw new Error(`iTerm2 session with TTY ${ttyPath} not found`);
    }
  } catch (err) {
    if ((err as Error).message.includes('not found')) throw err;
    throw new Error(`iTerm2 AppleScript failed: ${(err as Error).message}`);
  }
}

// ============================================================================
// tmux
// ============================================================================

function findTmuxPaneForPid(pid: number): { socket: string; target: string } | null {
  const sockets = getAllTmuxSockets();
  if (sockets.length === 0) return null;

  for (const socketPath of sockets) {
    const result = deps.spawnSync('tmux', [
      '-S', socketPath, 'list-panes', '-a', '-F',
      '#{pane_pid} #{session_name}:#{window_index}.#{pane_index}',
    ]);
    if (result.status !== 0) continue;

    const paneMap = new Map<string, string>();
    for (const line of result.stdout.toString().trim().split('\n')) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) continue;
      paneMap.set(line.slice(0, spaceIdx), line.slice(spaceIdx + 1));
    }

    // Walk up the PPID chain from the target PID
    let currentPid = String(pid);
    while (currentPid && currentPid !== '1' && currentPid !== '0') {
      const target = paneMap.get(currentPid);
      if (target) {
        return { socket: socketPath, target };
      }
      const ppidResult = deps.spawnSync('ps', ['-p', currentPid, '-o', 'ppid=']);
      if (ppidResult.status !== 0) break;
      currentPid = ppidResult.stdout.toString().trim();
    }
  }

  return null;
}

function tmuxClearAndSendKeys(socket: string, target: string, text: string): void {
  // Send a burst of backspaces to clear any partially-typed text.
  // Claude Code uses a custom Ink input that ignores Ctrl-U, so we use BSpace.
  const bsCount = 200;
  const bsArgs: string[] = [];
  for (let i = 0; i < bsCount; i++) bsArgs.push('BSpace');
  const clearResult = deps.spawnSync('tmux', [
    '-S', socket, 'send-keys', '-t', target, ...bsArgs,
  ]);
  if (clearResult.status !== 0) {
    throw new Error(`tmux send BSpace failed: ${clearResult.stderr?.toString() ?? 'unknown error'}`);
  }

  const textResult = deps.spawnSync('tmux', [
    '-S', socket, 'send-keys', '-t', target, '-l', text,
  ]);
  if (textResult.status !== 0) {
    throw new Error(`tmux send-keys failed: ${textResult.stderr?.toString() ?? 'unknown error'}`);
  }

  const enterResult = deps.spawnSync('tmux', [
    '-S', socket, 'send-keys', '-t', target, 'Enter',
  ]);
  if (enterResult.status !== 0) {
    throw new Error(`tmux send Enter failed: ${enterResult.stderr?.toString() ?? 'unknown error'}`);
  }
}

function tmuxSendEscape(socket: string, target: string): void {
  const result = deps.spawnSync('tmux', [
    '-S', socket, 'send-keys', '-t', target, 'Escape',
  ]);
  if (result.status !== 0) {
    throw new Error(`tmux send Escape failed: ${result.stderr?.toString() ?? 'unknown error'}`);
  }
}

function tmuxSendCtrlC(socket: string, target: string): void {
  const result = deps.spawnSync('tmux', [
    '-S', socket, 'send-keys', '-t', target, 'C-c',
  ]);
  if (result.status !== 0) {
    throw new Error(`tmux send C-c failed: ${result.stderr?.toString() ?? 'unknown error'}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getTtyForPid(pid: number): string | null {
  try {
    const result = deps.spawnSync('ps', ['-p', String(pid), '-o', 'tty=']);
    if (result.status !== 0) return null;
    const tty = result.stdout.toString().trim();
    return tty && tty !== '??' ? tty : null;
  } catch {
    return null;
  }
}

function getAllTmuxSockets(): string[] {
  const uid = deps.getuid();
  if (uid === undefined) return [];

  const tmuxDir = `/private/tmp/tmux-${uid}`;
  try {
    return deps.readdirSync(tmuxDir).map((f) => path.join(tmuxDir, f));
  } catch {
    return [];
  }
}
