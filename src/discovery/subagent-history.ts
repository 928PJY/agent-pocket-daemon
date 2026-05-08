// Agent Pocket — subagent history parser (Step 2.1b)
//
// Extracted from session-discovery.ts. Reads a session's subagent JSONL files
// (and their companion .meta.json + .archive.json sidecars) and produces a
// flat HistoryMessage[] sorted by timestamp.
//
//   getSubagentHistory(sessionFilePath, deps?) → HistoryMessage[]
//
// Sidecar archive files capture final lifecycle / token / tool counts when a
// subagent finishes. When archive is missing, the function replays the JSONL
// once to derive metrics; if the run ended cleanly (assistant stop_reason
// === 'end_turn'), it ALSO writes a fresh archive sidecar so future calls
// hit the fast path.
//
// All filesystem access goes through deps.fsImpl, and the archive timestamp
// goes through deps.nowFn — both for testability.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { truncateToolInput } from './jsonl-parser.js';

// Same shape as session-discovery's HistoryMessage; redeclared to avoid an
// import cycle.
type HistoryMessage = {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'subagent' | 'system';
  content: string;
  sdkUuid?: string;
  toolName?: string;
  toolId?: string;
  toolStatus?: 'success' | 'error';
  toolInput?: Record<string, unknown>;
  toolResultContent?: string;
  timestamp?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  innerEventType?: string;
  agentStatus?: string;
  subagentToolUseCount?: number;
  subagentTokenCount?: number;
  seq?: number;
};

const MAX_READ_BYTES = 20 * 1024 * 1024;

export interface GetSubagentHistoryDeps {
  fsImpl?: Pick<
    typeof fs,
    'existsSync' | 'readdirSync' | 'readFileSync' | 'statSync' | 'openSync' | 'readSync' | 'closeSync' | 'writeFileSync'
  >;
  nowFn?: () => number;
}

export function getSubagentHistory(
  sessionFilePath: string,
  deps: GetSubagentHistoryDeps = {},
): HistoryMessage[] {
  const fsImpl = deps.fsImpl ?? fs;
  const now = deps.nowFn ?? (() => Date.now());

  const jsonlDir = path.dirname(sessionFilePath);
  const jsonlBasename = path.basename(sessionFilePath, '.jsonl');
  const subagentsDir = path.join(jsonlDir, jsonlBasename, 'subagents');

  if (!fsImpl.existsSync(subagentsDir)) return [];

  let entries: string[];
  try {
    entries = fsImpl.readdirSync(subagentsDir) as string[];
  } catch {
    return [];
  }

  const results: HistoryMessage[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;

    const agentId = entry.replace('agent-', '').replace('.jsonl', '');
    const agentJsonlPath = path.join(subagentsDir, entry);
    const metaPath = path.join(subagentsDir, entry.replace('.jsonl', '.meta.json'));
    const archivePath = path.join(subagentsDir, entry.replace('.jsonl', '.archive.json'));

    let agentName = 'Subagent';
    let agentType = 'unknown';
    try {
      if (fsImpl.existsSync(metaPath)) {
        const meta = JSON.parse(fsImpl.readFileSync(metaPath, 'utf-8') as string);
        agentType = meta.agentType ?? 'unknown';
        agentName = meta.description ?? 'Subagent';
      }
    } catch {
      // defaults
    }

    let archivedStatus: string | undefined;
    let archivedTools: number | undefined;
    let archivedTokens: number | undefined;
    try {
      if (fsImpl.existsSync(archivePath)) {
        const a = JSON.parse(fsImpl.readFileSync(archivePath, 'utf-8') as string) as {
          status?: string; toolUseCount?: number; tokenCount?: number;
        };
        archivedStatus = a.status;
        archivedTools = a.toolUseCount;
        archivedTokens = a.tokenCount;
      }
    } catch {
      // ignore corrupt archive
    }

    let raw: string;
    try {
      const stat = fsImpl.statSync(agentJsonlPath);
      if (stat.size > MAX_READ_BYTES) {
        const fd = fsImpl.openSync(agentJsonlPath, 'r');
        const buf = Buffer.alloc(MAX_READ_BYTES);
        fsImpl.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
        fsImpl.closeSync(fd);
        raw = buf.toString('utf-8');
        const firstNewline = raw.indexOf('\n');
        if (firstNewline >= 0) raw = raw.slice(firstNewline + 1);
      } else {
        raw = fsImpl.readFileSync(agentJsonlPath, 'utf-8') as string;
      }
    } catch {
      continue;
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    if (archivedTools === undefined || archivedTokens === undefined) {
      let tools = 0;
      let tokens = 0;
      let firstTs: number | null = null;
      let lastTs: number | null = null;
      let endedWithEndTurn = false;
      const seenTools = new Set<string>();
      for (const line of lines) {
        try {
          const je = JSON.parse(line) as Record<string, unknown>;
          const tsStr = je.timestamp as string | undefined;
          if (tsStr) {
            const ms = Date.parse(tsStr);
            if (!Number.isNaN(ms)) {
              if (firstTs === null || ms < firstTs) firstTs = ms;
              if (lastTs === null || ms > lastTs) lastTs = ms;
            }
          }
          if (je.type !== 'assistant') continue;
          const m = je.message as {
            usage?: { input_tokens?: number; output_tokens?: number;
              cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
            stop_reason?: string;
            content?: Array<{ type: string; id?: string }>;
          } | undefined;
          if (m?.usage) {
            const u = m.usage;
            tokens =
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.input_tokens ?? 0) +
              (u.output_tokens ?? 0);
          }
          endedWithEndTurn = m?.stop_reason === 'end_turn';
          if (Array.isArray(m?.content)) {
            for (const b of m!.content) {
              if (b.type === 'tool_use') {
                const id = b.id ?? '';
                if (!seenTools.has(id)) { seenTools.add(id); tools++; }
              }
            }
          }
        } catch { /* skip */ }
      }
      if (archivedTools === undefined) archivedTools = tools;
      if (archivedTokens === undefined) archivedTokens = tokens;

      if (archivedStatus === undefined && endedWithEndTurn) {
        archivedStatus = 'done';
        if (!fsImpl.existsSync(archivePath)) {
          try {
            fsImpl.writeFileSync(archivePath, JSON.stringify({
              agentId,
              agentType,
              agentName,
              status: 'done',
              toolUseCount: tools,
              tokenCount: tokens,
              firstEventAt: firstTs,
              lastEventAt: lastTs,
              archivedAt: now(),
            }, null, 2));
          } catch {
            // non-fatal
          }
        }
      }
    }

    for (const line of lines) {
      try {
        const jsonEntry = JSON.parse(line) as Record<string, unknown>;
        const type = jsonEntry.type as string | undefined;
        const timestamp = jsonEntry.timestamp as string | undefined;

        if (type !== 'assistant') continue;

        const message = jsonEntry.message as {
          content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }>;
        } | undefined;
        if (!message?.content || !Array.isArray(message.content)) continue;

        const textParts: string[] = [];
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }
        if (textParts.length > 0) {
          results.push({
            role: 'subagent',
            content: textParts.join('\n'),
            timestamp,
            agentId,
            agentName,
            agentType,
            innerEventType: 'assistant_message',
            agentStatus: archivedStatus,
            subagentToolUseCount: archivedTools,
            subagentTokenCount: archivedTokens,
          });
        }

        for (const block of message.content) {
          if (block.type === 'tool_use') {
            results.push({
              role: 'subagent',
              content: '',
              toolName: block.name,
              toolId: block.id,
              toolInput: truncateToolInput(block.input as Record<string, unknown> | undefined),
              timestamp,
              agentId,
              agentName,
              agentType,
              innerEventType: 'tool_use',
              agentStatus: archivedStatus,
              subagentToolUseCount: archivedTools,
              subagentTokenCount: archivedTokens,
            });
          }
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  results.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  return results;
}
