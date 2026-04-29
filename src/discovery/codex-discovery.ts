import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ClaudeEvent } from '../shared/index.js';
import type { HistoryMessage, HistoryPage } from './session-discovery.js';
import { logger } from '../logger.js';

const FIELD_SEP = '\x1f';
const CODEX_PREFIX = 'codex:';
const HISTORY_TOOL_OUTPUT_CAP = 5000;

export type CodexLifecycleEvent =
  | { type: 'turn_completed'; summary?: string; timestamp?: string }
  | { type: 'turn_failed'; message: string; timestamp?: string };

export interface CodexSession {
  threadId: string;
  sessionId: string;
  rolloutPath: string;
  cwd: string;
  title?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  cliVersion?: string;
  model?: string;
}

export interface CodexLiveSession {
  sessionId: string;
  threadId: string;
  pid: number;
  rolloutPath: string;
  lastActivityMs: number;
}

export function isCodexSessionId(sessionId: string): boolean {
  return sessionId.startsWith(CODEX_PREFIX);
}

export function codexExternalSessionId(threadId: string): string {
  return `${CODEX_PREFIX}${threadId}`;
}

export function codexThreadIdFromSessionId(sessionId: string): string {
  return isCodexSessionId(sessionId) ? sessionId.slice(CODEX_PREFIX.length) : sessionId;
}

export class CodexDiscovery {
  private codexDir: string;
  private cachedSessions: CodexSession[] | null = null;
  private historyCache: Map<string, { messages: HistoryMessage[]; mtime: number }> = new Map();

  constructor(codexDir?: string) {
    this.codexDir = codexDir ?? path.join(os.homedir(), '.codex');
  }

  discoverSessions(limit = 200): CodexSession[] {
    const stateDb = path.join(this.codexDir, 'state_5.sqlite');
    if (!fs.existsSync(stateDb)) return [];

    const query = `
      select
        ifnull(id, ''),
        ifnull(rollout_path, ''),
        ifnull(cwd, ''),
        ifnull(title, ''),
        ifnull(created_at_ms, 0),
        ifnull(updated_at_ms, 0),
        ifnull(cli_version, ''),
        ifnull(model, '')
      from threads
      where archived is null or archived = 0
      order by updated_at_ms desc
      limit ${Math.max(1, Math.min(limit, 500))};
    `;

    try {
      const out = execFileSync('sqlite3', [codexStateDbReadonlyUri(stateDb), '-separator', FIELD_SEP, query], {
        encoding: 'utf-8',
        timeout: 2000,
      });
      const sessions = out.split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line): CodexSession | null => {
          const [threadId, rolloutPath, cwd, title, createdAt, updatedAt, cliVersion, model] = line.split(FIELD_SEP);
          if (!threadId || !rolloutPath || !fs.existsSync(rolloutPath)) return null;
          return {
            threadId,
            sessionId: codexExternalSessionId(threadId),
            rolloutPath,
            cwd: cwd || path.dirname(rolloutPath),
            title: title || undefined,
            createdAtMs: Number(createdAt) || undefined,
            updatedAtMs: Number(updatedAt) || undefined,
            cliVersion: cliVersion || undefined,
            model: model || undefined,
          };
        })
        .filter((s): s is CodexSession => s !== null);

      this.cachedSessions = sessions;
      return sessions;
    } catch (err) {
      logger.warn('codex-discovery', `Codex discovery failed: ${(err as Error).message}`);
      return [];
    }
  }

  getCachedSessions(): CodexSession[] | null {
    return this.cachedSessions;
  }

  getSession(threadOrSessionId: string): CodexSession | undefined {
    const threadId = codexThreadIdFromSessionId(threadOrSessionId);
    const cached = this.cachedSessions ?? this.discoverSessions();
    const session = cached.find((s) => s.threadId === threadId || s.sessionId === threadOrSessionId);
    if (session) return session;

    const refreshed = this.discoverSessions();
    return refreshed.find((s) => s.threadId === threadId || s.sessionId === threadOrSessionId);
  }

  discoverLiveSessions(sessions = this.cachedSessions ?? this.discoverSessions()): Map<string, CodexLiveSession> {
    if (sessions.length === 0) return new Map();
    const byRolloutPath = new Map(sessions.map((s) => [normalizePath(s.rolloutPath), s]));
    const live = new Map<string, CodexLiveSession>();

    for (const pid of findCodexPids()) {
      for (const liveSession of codexLiveSessionsFromOpenedRollouts(pid, findOpenCodexRollouts(pid, this.codexDir), byRolloutPath)) {
        if (!live.has(liveSession.sessionId)) {
          live.set(liveSession.sessionId, liveSession);
        }
      }
    }

    return live;
  }

  getSessionHistory(sessionId: string, options?: { offset?: number; limit?: number; since?: string; sinceSeq?: number }): HistoryPage {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 30;
    const session = this.getSession(sessionId);
    if (!session || !fs.existsSync(session.rolloutPath)) {
      return { messages: [], totalCount: 0, offset, hasMore: false };
    }

    try {
      const stat = fs.statSync(session.rolloutPath);
      const cached = this.historyCache.get(session.threadId);
      let allMessages: HistoryMessage[];

      if (cached && cached.mtime === stat.mtimeMs) {
        allMessages = cached.messages;
      } else {
        const raw = fs.readFileSync(session.rolloutPath, 'utf-8');
        allMessages = [];
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            allMessages.push(...parseCodexHistoryEntry(entry));
          } catch {
            // Ignore malformed or partial lines.
          }
        }
        for (let i = 0; i < allMessages.length; i++) {
          allMessages[i].seq = i + 1;
        }
        this.historyCache.set(session.threadId, { messages: allMessages, mtime: stat.mtimeMs });
      }

      let filtered = allMessages;
      if (options?.sinceSeq !== undefined) {
        filtered = allMessages.filter((m) => (m.seq ?? 0) > options.sinceSeq!);
      } else if (options?.since) {
        const sinceTime = new Date(options.since).getTime();
        if (!Number.isNaN(sinceTime)) {
          filtered = allMessages.filter((m) => {
            if (!m.timestamp) return true;
            const t = new Date(m.timestamp).getTime();
            return !Number.isNaN(t) && t > sinceTime;
          });
        }
      }

      const total = filtered.length;
      const end = Math.max(total - offset, 0);
      const start = Math.max(end - limit, 0);
      return {
        messages: filtered.slice(start, end),
        totalCount: total,
        offset,
        hasMore: start > 0,
        tailSeq: allMessages.length > 0 ? allMessages[allMessages.length - 1].seq : undefined,
      };
    } catch (err) {
      logger.warn('codex-discovery', `Codex history read failed: ${(err as Error).message}`, { sessionId });
      return { messages: [], totalCount: 0, offset, hasMore: false };
    }
  }
}

export function codexLiveSessionsFromOpenedRollouts(
  pid: number,
  openedPaths: string[],
  byRolloutPath: Map<string, CodexSession>,
): CodexLiveSession[] {
  const live: CodexLiveSession[] = [];
  const seen = new Set<string>();
  for (const openedPath of openedPaths) {
    const session = byRolloutPath.get(normalizePath(openedPath));
    if (!session || seen.has(session.sessionId)) continue;
    const lastActivityMs = getCodexRolloutMtimeMs(session.rolloutPath);
    if (lastActivityMs === undefined) continue;
    seen.add(session.sessionId);
    live.push({
      sessionId: session.sessionId,
      threadId: session.threadId,
      pid,
      rolloutPath: session.rolloutPath,
      lastActivityMs,
    });
  }
  return live;
}

export function codexStateDbReadonlyUri(stateDb: string): string {
  const normalized = path.resolve(stateDb).split(path.sep).map(encodeURIComponent).join('/');
  return `file://${normalized}?mode=ro&immutable=1`;
}

export function findCodexPids(): number[] {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8', timeout: 2000 });
    return parseCodexProcessList(output);
  } catch {
    return [];
  }
}

export function parseCodexProcessList(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid)) continue;
    const args = match[2].split(/\s+/);
    const executable = path.basename(args[0] ?? '');
    if ((executable === 'codex' || executable === 'codex-cli') && args[1] !== 'app-server') {
      pids.push(pid);
    }
  }
  return pids;
}

export function findOpenCodexRollouts(pid: number, codexDir = path.join(os.homedir(), '.codex')): string[] {
  try {
    const output = execFileSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf-8', timeout: 2000 });
    const prefix = normalizePath(path.join(codexDir, 'sessions')) + path.sep;
    const paths: string[] = [];
    for (const line of output.split('\n')) {
      if (!line.startsWith('n')) continue;
      const filePath = normalizePath(line.slice(1));
      if (filePath.startsWith(prefix) && path.basename(filePath).startsWith('rollout-') && filePath.endsWith('.jsonl')) {
        paths.push(filePath);
      }
    }
    return paths;
  } catch {
    return [];
  }
}

export function getCodexRolloutMtimeMs(rolloutPath: string): number | undefined {
  try {
    return fs.statSync(rolloutPath).mtimeMs;
  } catch {
    return undefined;
  }
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

export function parseCodexHistoryEntry(entry: Record<string, unknown>): HistoryMessage[] {
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
  const type = entry.type as string | undefined;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload) return [];

  if (type === 'response_item') {
    return parseCodexResponseItem(payload, timestamp);
  }

  if (type === 'event_msg') {
    const payloadType = payload.type as string | undefined;
    if (payloadType === 'exec_command_end') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      const output = stringifyCodexOutput(payload.aggregated_output ?? payload.output ?? '');
      return [{
        role: 'tool_result',
        content: output.slice(0, HISTORY_TOOL_OUTPUT_CAP),
        toolId: callId,
        toolStatus: payload.exit_code === 0 ? 'success' : 'error',
        toolResultContent: output.slice(0, HISTORY_TOOL_OUTPUT_CAP),
        timestamp,
      }];
    }
    if (payloadType === 'agent_message' && typeof payload.message === 'string') {
      return [{ role: 'assistant', content: payload.message, timestamp }];
    }
  }

  return [];
}

export function parseCodexLifecycleEntry(entry: Record<string, unknown>): CodexLifecycleEvent | null {
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
  const type = entry.type as string | undefined;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload) return null;

  const payloadType = payload.type as string | undefined;

  if (type === 'event_msg') {
    if (payloadType === 'turn_completed' || payloadType === 'turn.complete' || payloadType === 'turn.completed' || payloadType === 'task_complete') {
      return { type: 'turn_completed', summary: extractLifecycleSummary(payload), timestamp };
    }
    if (payloadType === 'turn_failed' || payloadType === 'turn.fail' || payloadType === 'turn.failed' || payloadType === 'task_failed' || payloadType === 'error') {
      return { type: 'turn_failed', message: extractLifecycleError(payload), timestamp };
    }
  }

  if (type === 'response_item') {
    if (payloadType === 'error') {
      return { type: 'turn_failed', message: extractLifecycleError(payload), timestamp };
    }
    if (payloadType === 'message' && payload.status === 'failed') {
      return { type: 'turn_failed', message: extractLifecycleError(payload), timestamp };
    }
  }

  return null;
}

export function parseCodexResponseItem(payload: Record<string, unknown>, timestamp?: string): HistoryMessage[] {
  const itemType = payload.type as string | undefined;
  if (itemType === 'message') {
    const role = payload.role === 'user' ? 'user' : 'assistant';
    const content = extractCodexContentText(payload.content);
    if (!content) return [];
    return [{ role, content, timestamp }];
  }

  if (itemType === 'function_call') {
    const toolName = typeof payload.name === 'string' ? payload.name : 'tool';
    const toolId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    return [{
      role: 'tool_use',
      content: '',
      toolName,
      toolId,
      toolInput: parseToolArguments(payload.arguments),
      timestamp,
    }];
  }

  if (itemType === 'function_call_output') {
    const output = stringifyCodexOutput(payload.output ?? '');
    return [{
      role: 'tool_result',
      content: output.slice(0, HISTORY_TOOL_OUTPUT_CAP),
      toolId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
      toolStatus: 'success',
      toolResultContent: output.slice(0, HISTORY_TOOL_OUTPUT_CAP),
      timestamp,
    }];
  }

  return [];
}

export function codexHistoryMessageToEvent(message: HistoryMessage): ClaudeEvent | null {
  switch (message.role) {
    case 'user':
      return { type: 'user_message', message: message.content };
    case 'assistant':
      return { type: 'assistant_message', message: message.content };
    case 'tool_use':
      return {
        type: 'tool_use',
        tool_id: message.toolId ?? `codex_tool_${Date.now()}`,
        tool_name: message.toolName ?? 'tool',
        tool_input: message.toolInput ?? {},
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_id: message.toolId ?? `codex_tool_${Date.now()}`,
        status: message.toolStatus ?? 'success',
        output: message.toolResultContent ?? message.content,
      };
    case 'system':
      return { type: 'system_message', message: message.content };
    default:
      return null;
  }
}

function extractCodexContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const b = block as Record<string, unknown>;
    if (typeof b.text === 'string') return b.text;
    if (typeof b.output_text === 'string') return b.output_text;
    if (typeof b.input_text === 'string') return b.input_text;
    if (typeof b.content === 'string') return b.content;
    return '';
  }).filter(Boolean).join('\n');
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value };
  } catch {
    return { value };
  }
}

function stringifyCodexOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value ?? '');
  }
}

function extractLifecycleSummary(payload: Record<string, unknown>): string | undefined {
  const candidates = [payload.last_agent_message, payload.summary, payload.message, payload.output, payload.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

function extractLifecycleError(payload: Record<string, unknown>): string {
  const candidates = [payload.message, payload.error, payload.reason, payload.aggregated_output, payload.output];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
    if (candidate && typeof candidate === 'object') return stringifyCodexOutput(candidate);
  }
  return 'Codex turn failed';
}
