// Agent Pocket — Structured Logger
// Writes to ~/.agent-pocket/logs/daemon.log (level-filtered) and
// daemon-trace.log (everything when trace is on). Rotates at 5MB per file.
// Also writes to stdout when running in foreground.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Types
// ============================================================================

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
};

// ============================================================================
// Configuration
// ============================================================================

const LOG_DIR = path.join(os.homedir(), '.agent-pocket', 'logs');
const DAEMON_LOG = path.join(LOG_DIR, 'daemon.log');
const TRACE_LOG = path.join(LOG_DIR, 'daemon-trace.log');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function parseLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (!value) return fallback;
  const upper = value.toUpperCase();
  if (upper === 'TRACE' || upper === 'DEBUG' || upper === 'INFO' || upper === 'WARN' || upper === 'ERROR') {
    return upper;
  }
  return fallback;
}

// ============================================================================
// Timestamp (UTC+8)
// ============================================================================

/** Format current time as ISO-like string in UTC+8 (e.g. "2026-04-17T14:30:45.123+08:00"). */
export function formatTimestamp(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace('Z', '+08:00');
}

// ============================================================================
// Logger
// ============================================================================

class Logger {
  private level: LogLevel = 'INFO';
  private traceFile = false;
  private foreground = true;
  private initialized = false;

  /** Call once at startup to configure the logger. */
  init(opts: { level?: LogLevel; trace?: boolean; foreground?: boolean } = {}): void {
    // Precedence: explicit opts.level > env var > opts.trace shortcut > default INFO
    const envLevel = parseLevel(process.env.AGENT_POCKET_LOG_LEVEL, 'INFO');
    this.level = opts.level ?? (opts.trace ? 'TRACE' : envLevel);
    this.traceFile = opts.trace ?? this.level === 'TRACE';
    this.foreground = opts.foreground ?? true;

    fs.mkdirSync(LOG_DIR, { recursive: true });
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  trace(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('TRACE', component, message, data);
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', component, message, data);
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('INFO', component, message, data);
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('WARN', component, message, data);
  }

  error(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('ERROR', component, message, data);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
    const passesThreshold = LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
    // Trace file (when enabled) gets everything regardless of threshold.
    const writeTrace = this.initialized && this.traceFile;
    const writeMain = this.initialized && passesThreshold;
    const writeStdout = this.foreground && passesThreshold;
    if (!writeTrace && !writeMain && !writeStdout) return;

    const timestamp = formatTimestamp();
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    const line = `[${timestamp}] [${level}] [${component}] ${message}${suffix}\n`;

    if (writeMain) this.appendToFile(DAEMON_LOG, line);
    if (writeTrace) this.appendToFile(TRACE_LOG, line);
    if (writeStdout) process.stdout.write(line);
  }

  private appendToFile(filePath: string, line: string): void {
    try {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size >= MAX_FILE_SIZE) {
          const oldPath = filePath + '.old';
          try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
          fs.renameSync(filePath, oldPath);
        }
      } catch {
        // File doesn't exist yet, that's fine
      }

      fs.appendFileSync(filePath, line);
    } catch {
      // If we can't write logs, don't crash the daemon
    }
  }
}

// Singleton
export const logger = new Logger();
