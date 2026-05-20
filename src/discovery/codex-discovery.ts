import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ClaudeEvent } from 'agent-pocket-protocol';
import type { HistoryMessage, HistoryPage } from './session-discovery.js';
import { SessionSeqAllocatorManager } from './seq-allocator.js';
import { logger } from '../logger.js';
import { detectInterruptText, interruptMessageText } from '../utils/interrupt-messages.js';
import { extractCodexMetaEvents } from '../utils/codex-tag-extract.js';

const FIELD_SEP = '\x1f';
const CODEX_PREFIX = 'codex:';
const HISTORY_TOOL_OUTPUT_CAP = 5000;

export type CodexLifecycleEvent =
  | { type: 'turn_completed'; summary?: string; timestamp?: string }
  | { type: 'turn_aborted'; timestamp?: string }
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
  private registeredSessions: Map<string, CodexSession> = new Map();
  private historyCache: Map<string, { messages: HistoryMessage[]; mtime: number }> = new Map();
  private readonly seqAllocators: SessionSeqAllocatorManager;

  constructor(codexDir?: string, seqAllocators?: SessionSeqAllocatorManager) {
    this.codexDir = codexDir ?? path.join(os.homedir(), '.codex');
    this.seqAllocators = seqAllocators ?? new SessionSeqAllocatorManager();
  }

  getSeqAllocators(): SessionSeqAllocatorManager {
    return this.seqAllocators;
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

      this.cachedSessions = this.mergeRegisteredSessions(sessions);
      return this.cachedSessions;
    } catch (err) {
      logger.warn('codex-discovery', `Codex discovery failed: ${(err as Error).message}`);
      return [];
    }
  }

  getCachedSessions(): CodexSession[] | null {
    return this.cachedSessions;
  }

  registerSessionFromRollout(input: { sessionId?: string; threadId?: string; rolloutPath: string; cwd?: string; cliVersion?: string; title?: string }): CodexSession | undefined {
    const rolloutPath = normalizePath(input.rolloutPath);
    if (!fs.existsSync(rolloutPath)) return undefined;

    const threadId = extractThreadIdFromRolloutPath(rolloutPath)
      ?? (input.threadId ? codexThreadIdFromSessionId(input.threadId) : undefined)
      ?? (input.sessionId ? codexThreadIdFromSessionId(input.sessionId) : undefined);
    if (!threadId) return undefined;

    const stat = fs.statSync(rolloutPath);
    const existing = this.registeredSessions.get(threadId);
    const session: CodexSession = {
      threadId,
      sessionId: codexExternalSessionId(threadId),
      rolloutPath,
      cwd: input.cwd || existing?.cwd || path.dirname(rolloutPath),
      title: input.title ?? existing?.title,
      createdAtMs: existing?.createdAtMs ?? stat.birthtimeMs,
      updatedAtMs: Math.max(existing?.updatedAtMs ?? 0, stat.mtimeMs),
      cliVersion: input.cliVersion ?? existing?.cliVersion,
      model: existing?.model,
    };

    this.registeredSessions.set(threadId, session);
    this.cachedSessions = this.mergeRegisteredSessions(this.cachedSessions ?? []);
    return session;
  }

  getSession(threadOrSessionId: string): CodexSession | undefined {
    const threadId = codexThreadIdFromSessionId(threadOrSessionId);
    const registered = this.registeredSessions.get(threadId);
    if (registered && fs.existsSync(registered.rolloutPath)) return registered;

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

  getSessionHistory(sessionId: string, options?: { offset?: number; limit?: number; since?: string; sinceSeq?: number; sinceMs?: number }): HistoryPage {
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
        // Collapse consecutive task_started → codex_collaboration_mode rows
        // with the same mode. Every Codex turn writes a task_started, so
        // without this every turn would render its own banner. Only mode
        // *transitions* should surface a banner.
        {
          const compacted: typeof allMessages = [];
          let lastMode: string | undefined;
          for (const msg of allMessages) {
            const ev = (msg as { codexMetaEvent?: { type?: string; mode?: string } }).codexMetaEvent;
            if (msg.role === 'codex_meta' && ev?.type === 'codex_collaboration_mode') {
              if (ev.mode === lastMode) continue;
              lastMode = ev.mode;
            }
            compacted.push(msg);
          }
          allMessages = compacted;
        }
        for (const msg of allMessages) {
          let seq: number;
          if (msg.sdkUuid) {
            seq = this.seqAllocators.for(session.threadId).getOrAssign(msg.sdkUuid, msg.sdkBlockIndex);
          } else {
            seq = this.seqAllocators.for(session.threadId).allocAnonymous();
          }
          msg.seq = seq;
          msg.session_seq = seq;
        }
        // Re-sort by seq so array order matches canonical seq order. See
        // session-discovery.ts for the full rationale — same reasoning here:
        // late-arriving rows on JSONL re-parse get fresh high seq, breaking
        // chronological array order vs seq order otherwise.
        allMessages.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

        // HISTORY_CURSOR_MS: assign tsMs + parseIndex, then re-sort by
        // (tsMs ASC, parseIndex ASC). See session-discovery.ts for the
        // full rationale.
        let prevTs = 0;
        for (let i = 0; i < allMessages.length; i++) {
          const msg = allMessages[i];
          msg.parseIndex = i;
          const srcMs = msg.timestamp ? Date.parse(msg.timestamp) : NaN;
          if (Number.isFinite(srcMs)) {
            msg.tsMs = srcMs;
            prevTs = srcMs;
          } else {
            msg.tsMs = (prevTs > 0 ? prevTs : 0) + 1;
            prevTs = msg.tsMs;
          }
        }
        allMessages.sort((a, b) => {
          const da = (a.tsMs ?? 0) - (b.tsMs ?? 0);
          if (da !== 0) return da;
          return (a.parseIndex ?? 0) - (b.parseIndex ?? 0);
        });
        for (let i = 0; i < allMessages.length; i++) allMessages[i].parseIndex = i;
        let cursorTs = 0;
        for (const msg of allMessages) {
          const ts = msg.tsMs ?? 0;
          cursorTs = Math.max(ts, cursorTs + 1);
          msg.tsMs = cursorTs;
        }
        for (const msg of allMessages) {
          if (msg.tsMs !== undefined) {
            msg.timestamp = new Date(msg.tsMs).toISOString();
          }
        }

        this.historyCache.set(session.threadId, { messages: allMessages, mtime: stat.mtimeMs });
      }

      let filtered = allMessages;
      if (options?.sinceMs !== undefined) {
        filtered = allMessages.filter((m) => (m.tsMs ?? 0) > options.sinceMs!);
      } else if (options?.sinceSeq !== undefined) {
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
      const pageMessages = filtered.slice(start, end);
      return {
        messages: pageMessages,
        totalCount: total,
        offset,
        hasMore: start > 0,
        tailSeq: this.seqAllocators.for(session.threadId).tail() || undefined,
        // tailMs is the FILTERED-SET tail (not page tail) — see
        // session-discovery.ts for the rationale. Verify/divergence cursors
        // must reflect "everything we can deliver", independent of paging.
        tailMs: filtered.length > 0 ? filtered[filtered.length - 1].tsMs : undefined,
      };
    } catch (err) {
      logger.warn('codex-discovery', `Codex history read failed: ${(err as Error).message}`, { sessionId });
      return { messages: [], totalCount: 0, offset, hasMore: false };
    }
  }

  getLastAssistantMessage(sessionId: string): string | undefined {
    const history = this.getSessionHistory(sessionId, { limit: 100 });
    for (let i = history.messages.length - 1; i >= 0; i--) {
      const message = history.messages[i];
      if (message.role === 'assistant' && message.content.trim().length > 0) {
        return message.content.trim();
      }
    }
    return undefined;
  }

  private mergeRegisteredSessions(sessions: CodexSession[]): CodexSession[] {
    const merged = new Map<string, CodexSession>();
    for (const session of sessions) {
      merged.set(session.threadId, session);
      this.registeredSessions.delete(session.threadId);
    }
    for (const [threadId, session] of this.registeredSessions) {
      if (!fs.existsSync(session.rolloutPath)) {
        this.registeredSessions.delete(threadId);
        continue;
      }
      merged.set(threadId, session);
    }
    return Array.from(merged.values()).sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
  }
}

export function codexLiveSessionsFromOpenedRollouts(
  pid: number,
  openedPaths: string[],
  byRolloutPath: Map<string, CodexSession>,
): CodexLiveSession[] {
  let current: CodexLiveSession | undefined;
  for (const openedPath of openedPaths) {
    const session = byRolloutPath.get(normalizePath(openedPath));
    if (!session) continue;
    const lastActivityMs = getCodexRolloutMtimeMs(session.rolloutPath);
    if (lastActivityMs === undefined) continue;
    const candidate = {
      sessionId: session.sessionId,
      threadId: session.threadId,
      pid,
      rolloutPath: session.rolloutPath,
      lastActivityMs,
    };
    if (!current || candidate.lastActivityMs > current.lastActivityMs) current = candidate;
  }
  return current ? [current] : [];
}

export function extractThreadIdFromRolloutPath(rolloutPath: string): string | undefined {
  const base = path.basename(rolloutPath);
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1];
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
    // `<collaboration_mode>` developer-message blocks are template payloads
    // re-injected every turn; the authoritative mode signal lives in
    // `task_started.collaboration_mode_kind` (lowercase, e.g. "default" /
    // "plan"). Emit a codex_meta row per task_started so the phone always
    // sees the current mode without parsing markdown out of the block body.
    if (payloadType === 'task_started') {
      const kind = typeof payload.collaboration_mode_kind === 'string'
        ? payload.collaboration_mode_kind
        : undefined;
      if (kind) {
        const mode = kind.charAt(0).toUpperCase() + kind.slice(1);
        const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
        // Pin sdkUuid to turn_id so seq-allocator hands out the same seq on
        // re-parse — without it allocAnonymous() bumps the seq on every
        // rollout mtime change, breaking phone-side dedupe of the banner.
        const sdkUuid = turnId ? `codex_collaboration_mode:${turnId}` : undefined;
        return [{
          role: 'codex_meta',
          content: '',
          codexMetaEvent: { type: 'codex_collaboration_mode', mode, body: '', ...(timestamp ? { timestamp } : {}) },
          timestamp,
          ...(sdkUuid ? { sdkUuid } : {}),
        }];
      }
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
    if (payloadType === 'turn_aborted' || payloadType === 'turn.abort' || payloadType === 'turn.aborted') {
      return { type: 'turn_aborted', timestamp };
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
    const rawRole = typeof payload.role === 'string' ? payload.role : undefined;
    const content = extractCodexContentText(payload.content);
    if (!content) return [];

    // Developer-role frames are pure meta-channel: environment_context,
    // collaboration_mode, skills_instructions, plugins_instructions, …
    // Pre-CODEX_TAG_EXTRACTION we collapsed them into assistant messages and
    // leaked the raw `<tag>` literals into chat. Now we extract every
    // recognised tag and drop anything left over (developer prose without
    // tags is internal scaffolding the user shouldn't see).
    if (rawRole === 'developer') {
      const { events } = extractCodexMetaEvents(content, { timestamp });
      return events.map((event) => ({
        role: 'codex_meta',
        content: '',
        codexMetaEvent: event,
        timestamp,
      }));
    }

    const role = rawRole === 'user' ? 'user' : 'assistant';
    if (role === 'user') {
      if (isCodexRuntimeWarningMessage(content)) return [];
      const interruptReason = detectInterruptText(content);
      if (interruptReason || isCodexTurnAbortedMessage(content)) {
        return [{ role: 'system', content: interruptMessageText(interruptReason ?? 'streaming'), timestamp }];
      }
    }

    // user/assistant content may carry inline `<system-reminder>` or
    // `<oai-mem-citation>` blocks. Extract them as separate codex_meta
    // rows ahead of the cleaned text so the phone renders the chip / card
    // before the bubble. If stripping leaves no prose, the text row is
    // dropped (a reply that was *only* a citation block is rare but valid).
    const { events: metaEvents, stripped } = extractCodexMetaEvents(content, { timestamp });
    const messages: HistoryMessage[] = metaEvents.map((event) => ({
      role: 'codex_meta',
      content: '',
      codexMetaEvent: event,
      timestamp,
    }));
    if (stripped.length > 0) {
      // Pin a stable pseudo-sdkUuid derived from (role, timestamp, content
      // prefix) so live emit and history re-parse produce the same key. Codex
      // JSONL has no native message id; without this the live observer ships
      // rows with no sdk_uuid, the phone fingerprints them as random local
      // ids, and the history-replay copy on reconnect lands as a duplicate.
      const sdkUuid = stableCodexMessageUuid(role, timestamp, stripped);
      messages.push({ role, content: stripped, timestamp, sdkUuid });
    }
    return messages;
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
    case 'codex_meta':
      return message.codexMetaEvent ?? null;
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

function isCodexTurnAbortedMessage(text: string): boolean {
  return /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(text.trim());
}

function isCodexRuntimeWarningMessage(text: string): boolean {
  return text.trim() === 'Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead of exec_command.';
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

function stableCodexMessageUuid(role: string, timestamp: string | undefined, content: string): string {
  const h = crypto.createHash('sha1');
  h.update(role);
  h.update('\0');
  h.update(timestamp ?? '');
  h.update('\0');
  h.update(content.slice(0, 256));
  return `codex_msg:${h.digest('hex').slice(0, 24)}`;
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
