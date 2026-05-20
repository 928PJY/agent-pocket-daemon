// Codex transcript meta-tag extractor.
//
// Codex injects several XML-style blocks into developer / assistant message
// bodies. Under PEER_CAPABILITIES.CODEX_TAG_EXTRACTION the daemon parses
// these out and emits dedicated ClaudeEvent variants so the phone can
// render each with its own UI (status chip, mode badge, footnote card, …)
// instead of leaking raw `<tag>` literals into chat bubbles.
//
// This module is pure: input text + per-call context (timestamp / sdkUuid)
// in, list of extracted events + stripped text out. No state, no I/O.

import type {
  ClaudeEvent,
  CodexCollaborationModeEvent,
  CodexEnvironmentContextEvent,
  CodexMemCitationEntry,
  CodexMemCitationEvent,
  CodexSkillInfo,
  CodexSkillsListingEvent,
  CodexSystemReminderEvent,
} from 'agent-pocket-protocol';

export type CodexMetaEvent =
  | CodexEnvironmentContextEvent
  | CodexCollaborationModeEvent
  | CodexSkillsListingEvent
  | CodexSystemReminderEvent
  | CodexMemCitationEvent;

export interface ExtractContext {
  /** ISO 8601 — copied verbatim onto every extracted event. */
  timestamp?: string;
  /** Source row uuid — copied verbatim onto every extracted event. */
  sdkUuid?: string;
}

export interface ExtractResult {
  /** Events produced from the recognised tags, in document order. */
  events: CodexMetaEvent[];
  /** Original text with recognised tags removed. Surrounding whitespace
   *  collapsed so a message that was *only* tags becomes an empty string. */
  stripped: string;
}

// Tags this extractor handles. Order doesn't matter — extraction walks each
// independently and the final `stripped` strips all of them.
// NOTE: `collaboration_mode` is intentionally NOT here. The block body is
// just a templated markdown instruction re-injected every turn; the
// authoritative mode signal is `event_msg.task_started.collaboration_mode_kind`
// (handled in parseCodexHistoryEntry). Parsing the tag would just produce a
// duplicate event with a misleading body.
const TAG_NAMES = [
  'environment_context',
  'skills_instructions',
  'system-reminder',
  'oai-mem-citation',
] as const;

type TagName = (typeof TAG_NAMES)[number];

interface TagMatch {
  tag: TagName;
  /** Inner content between opening and closing tag (not trimmed). */
  inner: string;
  /** Absolute start index of the opening `<` in the input string. */
  start: number;
  /** Absolute end index (exclusive) of the closing `>` in the input string. */
  end: number;
}

/**
 * Extract every recognised Codex meta-tag from `text`. Tags appear in document
 * order in the result. Stripped text has the tag substrings removed and
 * collapsed whitespace.
 *
 * Unrecognised XML-style tags are left in place — only the five tags listed
 * in TAG_NAMES are parsed. This matches the "no data loss" contract documented
 * on PEER_CAPABILITIES.CODEX_TAG_EXTRACTION.
 */
export function extractCodexMetaEvents(text: string, ctx: ExtractContext = {}): ExtractResult {
  if (!text || text.length === 0) {
    return { events: [], stripped: text ?? '' };
  }

  const matches = findTagMatches(text);
  if (matches.length === 0) {
    return { events: [], stripped: text };
  }

  const events: CodexMetaEvent[] = [];
  for (const m of matches) {
    const ev = matchToEvent(m, ctx);
    if (ev) events.push(ev);
  }

  return { events, stripped: stripMatches(text, matches) };
}

function findTagMatches(text: string): TagMatch[] {
  const matches: TagMatch[] = [];
  for (const tag of TAG_NAMES) {
    const openTag = `<${tag}`;
    const closeTag = `</${tag}>`;
    let cursor = 0;
    while (cursor < text.length) {
      const openIdx = text.indexOf(openTag, cursor);
      if (openIdx < 0) break;
      // Skip false positives where the next char is part of a longer tag
      // name (e.g. `<environment_context_x>` shouldn't match `environment_context`).
      const nextChar = text.charAt(openIdx + openTag.length);
      if (nextChar !== '' && nextChar !== '>' && nextChar !== ' ' && nextChar !== '\t' && nextChar !== '\n') {
        cursor = openIdx + openTag.length;
        continue;
      }
      const openEndIdx = text.indexOf('>', openIdx + openTag.length);
      if (openEndIdx < 0) break;
      const closeIdx = text.indexOf(closeTag, openEndIdx + 1);
      if (closeIdx < 0) {
        // Unclosed tag — bail on this one rather than swallowing the rest of
        // the message. Leave it inline as-is.
        cursor = openEndIdx + 1;
        continue;
      }
      matches.push({
        tag,
        inner: text.slice(openEndIdx + 1, closeIdx),
        start: openIdx,
        end: closeIdx + closeTag.length,
      });
      cursor = closeIdx + closeTag.length;
    }
  }
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function stripMatches(text: string, matches: TagMatch[]): string {
  if (matches.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    cursor = m.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join('').replace(/[ \t]*\n[ \t]*\n[ \t]*\n+/g, '\n\n').trim();
}

function matchToEvent(m: TagMatch, ctx: ExtractContext): CodexMetaEvent | null {
  switch (m.tag) {
    case 'environment_context':
      return parseEnvironmentContext(m.inner, ctx);
    case 'skills_instructions':
      return parseSkillsListing(m.inner, ctx);
    case 'system-reminder':
      return parseSystemReminder(m.inner, ctx);
    case 'oai-mem-citation':
      return parseMemCitation(m.inner, ctx);
  }
}

// ---------------------------------------------------------------------------
// Per-tag parsers
// ---------------------------------------------------------------------------

function parseEnvironmentContext(inner: string, ctx: ExtractContext): CodexEnvironmentContextEvent {
  const ev: CodexEnvironmentContextEvent = { type: 'codex_environment_context' };
  const cwd = innerText(inner, 'cwd');
  const shell = innerText(inner, 'shell');
  const currentDate = innerText(inner, 'current_date');
  const timezone = innerText(inner, 'timezone');
  if (cwd) ev.cwd = cwd;
  if (shell) ev.shell = shell;
  if (currentDate) ev.current_date = currentDate;
  if (timezone) ev.timezone = timezone;
  if (ctx.timestamp) ev.timestamp = ctx.timestamp;
  if (ctx.sdkUuid) ev.sdkUuid = ctx.sdkUuid;
  return ev;
}

function parseSkillsListing(inner: string, ctx: ExtractContext): CodexSkillsListingEvent {
  // Lines look like `- name: description (file: /abs/path/SKILL.md)`.
  const skills: CodexSkillInfo[] = [];
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;
    const stripped = line.replace(/^-\s*/, '');
    const colonIdx = stripped.indexOf(':');
    if (colonIdx < 0) continue;
    const name = stripped.slice(0, colonIdx).trim();
    let remainder = stripped.slice(colonIdx + 1).trim();
    let path: string | undefined;
    const fileMatch = remainder.match(/\(file:\s*([^)]+)\)\s*$/);
    if (fileMatch) {
      path = fileMatch[1].trim();
      remainder = remainder.slice(0, fileMatch.index).trim();
    }
    if (!name) continue;
    const skill: CodexSkillInfo = { name, description: remainder };
    if (path) skill.path = path;
    skills.push(skill);
  }
  const ev: CodexSkillsListingEvent = { type: 'codex_skills_listing', skills };
  if (ctx.timestamp) ev.timestamp = ctx.timestamp;
  if (ctx.sdkUuid) ev.sdkUuid = ctx.sdkUuid;
  return ev;
}

function parseSystemReminder(inner: string, ctx: ExtractContext): CodexSystemReminderEvent {
  const ev: CodexSystemReminderEvent = {
    type: 'codex_system_reminder',
    text: inner.trim(),
  };
  if (ctx.timestamp) ev.timestamp = ctx.timestamp;
  if (ctx.sdkUuid) ev.sdkUuid = ctx.sdkUuid;
  return ev;
}

function parseMemCitation(inner: string, ctx: ExtractContext): CodexMemCitationEvent {
  const entries: CodexMemCitationEntry[] = [];
  const entriesInner = sliceChildTag(inner, 'citation_entries');
  if (entriesInner !== undefined) {
    for (const rawLine of entriesInner.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const noteIdx = line.indexOf('|note=');
      const pathRange = noteIdx >= 0 ? line.slice(0, noteIdx) : line;
      const note = noteIdx >= 0 ? line.slice(noteIdx + '|note='.length).replace(/^\[|\]$/g, '').trim() : undefined;
      const m = pathRange.match(/^(.+):(\d+)-(\d+)$/);
      if (!m) continue;
      const entry: CodexMemCitationEntry = {
        path: m[1],
        line_start: Number.parseInt(m[2], 10),
        line_end: Number.parseInt(m[3], 10),
      };
      if (note) entry.note = note;
      entries.push(entry);
    }
  }

  const rolloutIds: string[] = [];
  const idsInner = sliceChildTag(inner, 'rollout_ids');
  if (idsInner !== undefined) {
    for (const rawLine of idsInner.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      rolloutIds.push(line);
    }
  }

  const ev: CodexMemCitationEvent = { type: 'codex_mem_citation', entries, rollout_ids: rolloutIds };
  if (ctx.timestamp) ev.timestamp = ctx.timestamp;
  if (ctx.sdkUuid) ev.sdkUuid = ctx.sdkUuid;
  return ev;
}

// ---------------------------------------------------------------------------
// Tiny XML helpers (no deps, deliberately permissive)
// ---------------------------------------------------------------------------

function innerText(haystack: string, child: string): string | undefined {
  const open = `<${child}>`;
  const close = `</${child}>`;
  const openIdx = haystack.indexOf(open);
  if (openIdx < 0) return undefined;
  const start = openIdx + open.length;
  const closeIdx = haystack.indexOf(close, start);
  if (closeIdx < 0) return undefined;
  const value = haystack.slice(start, closeIdx).trim();
  return value.length > 0 ? value : undefined;
}

function sliceChildTag(haystack: string, child: string): string | undefined {
  const open = `<${child}>`;
  const close = `</${child}>`;
  const openIdx = haystack.indexOf(open);
  if (openIdx < 0) return undefined;
  const closeIdx = haystack.indexOf(close, openIdx + open.length);
  if (closeIdx < 0) return undefined;
  return haystack.slice(openIdx + open.length, closeIdx);
}

/** Event types this extractor produces — exported for serializer cap-gating. */
export const CODEX_TAG_EVENT_TYPES: ReadonlySet<ClaudeEvent['type']> = new Set([
  'codex_environment_context',
  'codex_collaboration_mode',
  'codex_skills_listing',
  'codex_system_reminder',
  'codex_mem_citation',
] as const);
