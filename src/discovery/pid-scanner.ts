// Agent Pocket — PID file scanner (Step 2.1c)
//
// Extracted from session-discovery.ts. The three public methods on
// SessionDiscovery —
//
//   getRunningCliSessions       cli-only running sessions
//   getRunningAllSessions       all running sessions (any entrypoint)
//   getRunningSessionEntrypoints  sessionId → entrypoint map
//
// — all walk the same `~/.claude/sessions/*.json` PID-file directory,
// JSON-parse each, kill(pid, 0) for liveness, then differ in the projection
// applied to surviving rows.
//
// This module exposes those three as free functions over a `claudeDir` string,
// plus a `PidScannerDeps` bag of test seams (fs, kill, findTerminal,
// isProcessSuspendedOrZombie). SessionDiscovery's public methods become thin
// delegators so its `Pick<SessionDiscovery, ...>` consumers see no API change.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  findTerminalForPid as defaultFindTerminalForPid,
  type TerminalTarget,
} from '../pty/tmux-injector.js';

/**
 * Check if a process is suspended (T) or zombie (Z).
 * Uses `ps -p <pid> -o state=` via execFileSync to avoid shell injection.
 */
export function isProcessSuspendedOrZombie(pid: number): boolean {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'state='], {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    const state = output.charAt(0).toUpperCase();
    return state === 'T' || state === 'Z';
  } catch {
    return false;
  }
}

export function getLiveProcessCwd(pid: number): string | undefined {
  if (pid <= 0) return undefined;

  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }

  try {
    const output = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    const line = output.split('\n').find((part) => part.startsWith('n'));
    return line && line.length > 1 ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

export interface RunningCliSession {
  pid: number;
  sessionId: string;
  cwd: string;
  terminalTarget?: TerminalTarget;
  entrypoint: string;
  name?: string;
}

export interface PidScannerDeps {
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'readFileSync'>;
  killFn?: (pid: number, signal: 0) => void;
  findTerminalForPid?: (pid: number) => TerminalTarget | null;
  isProcessSuspendedOrZombie?: (pid: number) => boolean;
  getLiveProcessCwd?: (pid: number) => string | undefined;
}

interface PidFileRow {
  filePath: string;
  data: Record<string, unknown>;
  pid: number;
}

function readLivePidRows(claudeDir: string, deps: PidScannerDeps): PidFileRow[] {
  const fsImpl = deps.fsImpl ?? fs;
  const kill = deps.killFn ?? ((pid, sig) => process.kill(pid, sig));

  const sessionsDir = path.join(claudeDir, 'sessions');
  if (!fsImpl.existsSync(sessionsDir)) return [];

  const out: PidFileRow[] = [];
  let entries: string[];
  try {
    entries = fsImpl.readdirSync(sessionsDir) as string[];
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(sessionsDir, entry);
    try {
      const data = JSON.parse(fsImpl.readFileSync(filePath, 'utf-8') as string) as Record<string, unknown>;
      const pid = data.pid as number;
      if (!pid) continue;
      try {
        kill(pid, 0);
      } catch {
        continue;
      }
      out.push({ filePath, data, pid });
    } catch {
      // skip unparseable file
    }
  }
  return out;
}

function projectRunning(
  rows: PidFileRow[],
  deps: PidScannerDeps,
  opts: { entrypointFilter?: string; forceCliEntrypoint?: boolean },
): RunningCliSession[] {
  const findTerm = deps.findTerminalForPid ?? defaultFindTerminalForPid;
  const isSusp = deps.isProcessSuspendedOrZombie ?? isProcessSuspendedOrZombie;
  const liveCwd = deps.getLiveProcessCwd ?? getLiveProcessCwd;

  const out: RunningCliSession[] = [];
  for (const { data, pid } of rows) {
    if (opts.entrypointFilter !== undefined && data.entrypoint !== opts.entrypointFilter) continue;
    if (isSusp(pid)) continue;

    const entrypoint = opts.forceCliEntrypoint
      ? 'cli'
      : ((data.entrypoint as string) ?? 'unknown');

    out.push({
      pid,
      sessionId: (data.sessionId as string) ?? '',
      cwd: liveCwd(pid) ?? (data.cwd as string) ?? '',
      terminalTarget: entrypoint === 'cli' ? (findTerm(pid) ?? undefined) : undefined,
      entrypoint,
      name: typeof data.name === 'string' ? (data.name as string) : undefined,
    });
  }
  return out;
}

export function getRunningCliSessions(
  claudeDir: string,
  deps: PidScannerDeps = {},
): RunningCliSession[] {
  const rows = readLivePidRows(claudeDir, deps);
  return projectRunning(rows, deps, { entrypointFilter: 'cli', forceCliEntrypoint: true });
}

export function getRunningAllSessions(
  claudeDir: string,
  deps: PidScannerDeps = {},
): RunningCliSession[] {
  const rows = readLivePidRows(claudeDir, deps);
  return projectRunning(rows, deps, {});
}

export function getRunningSessionEntrypoints(
  claudeDir: string,
  deps: PidScannerDeps = {},
): Map<string, string> {
  const rows = readLivePidRows(claudeDir, deps);
  const out = new Map<string, string>();
  for (const { data } of rows) {
    const sessionId = data.sessionId as string;
    const entrypoint = (data.entrypoint as string) ?? 'unknown';
    if (sessionId) out.set(sessionId, entrypoint);
  }
  return out;
}
