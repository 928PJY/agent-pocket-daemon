import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractCodexMetaEvents,
  CODEX_TAG_EVENT_TYPES,
} from '../src/utils/codex-tag-extract.js';
import type {
  CodexEnvironmentContextEvent,
  CodexMemCitationEvent,
  CodexSkillsListingEvent,
  CodexSystemReminderEvent,
} from 'agent-pocket-protocol';

test('returns empty events + unchanged text when input has no recognised tags', () => {
  const r = extractCodexMetaEvents('hello world');
  assert.deepEqual(r.events, []);
  assert.equal(r.stripped, 'hello world');
});

test('returns empty result for empty / undefined input', () => {
  assert.deepEqual(extractCodexMetaEvents('').events, []);
  assert.deepEqual(extractCodexMetaEvents('').stripped, '');
});

test('extracts <environment_context> with all four child fields', () => {
  const text = `<environment_context>
  <cwd>/Users/peijiayin/workspace/agent-pocket</cwd>
  <shell>zsh</shell>
  <current_date>2026-05-16</current_date>
  <timezone>Asia/Shanghai</timezone>
</environment_context>`;
  const r = extractCodexMetaEvents(text, { timestamp: '2026-05-16T06:30:37.000Z', sdkUuid: 'row-1' });
  assert.equal(r.events.length, 1);
  const ev = r.events[0] as CodexEnvironmentContextEvent;
  assert.equal(ev.type, 'codex_environment_context');
  assert.equal(ev.cwd, '/Users/peijiayin/workspace/agent-pocket');
  assert.equal(ev.shell, 'zsh');
  assert.equal(ev.current_date, '2026-05-16');
  assert.equal(ev.timezone, 'Asia/Shanghai');
  assert.equal(ev.timestamp, '2026-05-16T06:30:37.000Z');
  assert.equal(ev.sdkUuid, 'row-1');
  assert.equal(r.stripped, '');
});

test('<environment_context> with partial fields omits absent ones', () => {
  const r = extractCodexMetaEvents('<environment_context><cwd>/tmp</cwd></environment_context>');
  const ev = r.events[0] as CodexEnvironmentContextEvent;
  assert.equal(ev.cwd, '/tmp');
  assert.equal(ev.shell, undefined);
});

test('extracts <skills_instructions> into structured skill list', () => {
  const text = `<skills_instructions>
## Skills
### Available skills
- imagegen: Generate or edit raster images (file: /Users/foo/.codex/skills/imagegen/SKILL.md)
- openai-docs: Use when the user asks about OpenAI products (file: /Users/foo/.codex/skills/openai-docs/SKILL.md)
</skills_instructions>`;
  const r = extractCodexMetaEvents(text);
  const ev = r.events[0] as CodexSkillsListingEvent;
  assert.equal(ev.type, 'codex_skills_listing');
  assert.equal(ev.skills.length, 2);
  assert.equal(ev.skills[0].name, 'imagegen');
  assert.ok(ev.skills[0].description.startsWith('Generate or edit raster images'));
  assert.equal(ev.skills[0].path, '/Users/foo/.codex/skills/imagegen/SKILL.md');
  assert.equal(ev.skills[1].name, 'openai-docs');
});

test('extracts <system-reminder> text and trims', () => {
  const text = `<system-reminder>
The task tools haven't been used recently. Consider using TaskCreate.
</system-reminder>`;
  const r = extractCodexMetaEvents(text);
  const ev = r.events[0] as CodexSystemReminderEvent;
  assert.equal(ev.type, 'codex_system_reminder');
  assert.ok(ev.text.startsWith('The task tools'));
  assert.ok(!ev.text.endsWith('\n'));
});

test('extracts <oai-mem-citation> with entries + rollout_ids', () => {
  const text = `<oai-mem-citation>
<citation_entries>
MEMORY.md:234-236|note=[responsesapi citation extraction]
rollout_summaries/2026-02-17-weekly.md:10-12|note=[weekly report format]
</citation_entries>
<rollout_ids>
019c6e27-e55b-73d1-87d8-4e01f1f75043
019c7714-3b77-74d1-9866-e1f484aae2ab
</rollout_ids>
</oai-mem-citation>`;
  const r = extractCodexMetaEvents(text);
  const ev = r.events[0] as CodexMemCitationEvent;
  assert.equal(ev.type, 'codex_mem_citation');
  assert.equal(ev.entries.length, 2);
  assert.equal(ev.entries[0].path, 'MEMORY.md');
  assert.equal(ev.entries[0].line_start, 234);
  assert.equal(ev.entries[0].line_end, 236);
  assert.equal(ev.entries[0].note, 'responsesapi citation extraction');
  assert.deepEqual(ev.rollout_ids, [
    '019c6e27-e55b-73d1-87d8-4e01f1f75043',
    '019c7714-3b77-74d1-9866-e1f484aae2ab',
  ]);
});

test('<oai-mem-citation> tolerates missing note suffix on an entry', () => {
  const text = `<oai-mem-citation>
<citation_entries>
MEMORY.md:100-101
</citation_entries>
<rollout_ids>
</rollout_ids>
</oai-mem-citation>`;
  const r = extractCodexMetaEvents(text);
  const ev = r.events[0] as CodexMemCitationEvent;
  assert.equal(ev.entries.length, 1);
  assert.equal(ev.entries[0].note, undefined);
  assert.deepEqual(ev.rollout_ids, []);
});

test('multiple tags preserve document order in the events array', () => {
  const text = `prelude
<system-reminder>first</system-reminder>
middle
<environment_context><cwd>/tmp</cwd></environment_context>
trailer`;
  const r = extractCodexMetaEvents(text);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].type, 'codex_system_reminder');
  assert.equal(r.events[1].type, 'codex_environment_context');
});

test('strips recognised tags from the surrounding text and trims', () => {
  const text = `Answer prose.

<oai-mem-citation>
<citation_entries>
MEMORY.md:1-2
</citation_entries>
<rollout_ids>
abc
</rollout_ids>
</oai-mem-citation>`;
  const r = extractCodexMetaEvents(text);
  assert.equal(r.stripped, 'Answer prose.');
});

test('leaves unrecognised XML-style tags inline (no data loss)', () => {
  const text = 'before <unknown_tag>payload</unknown_tag> after';
  const r = extractCodexMetaEvents(text);
  assert.deepEqual(r.events, []);
  assert.equal(r.stripped, text);
});

test('unclosed recognised tag is left inline rather than swallowing rest of message', () => {
  const text = 'before <system-reminder>oops no close after';
  const r = extractCodexMetaEvents(text);
  assert.deepEqual(r.events, []);
  assert.equal(r.stripped, text);
});

test('similar-prefix tag (environment_context_x) is not matched as environment_context', () => {
  const text = '<environment_context_x>nope</environment_context_x>';
  const r = extractCodexMetaEvents(text);
  assert.deepEqual(r.events, []);
});

test('CODEX_TAG_EVENT_TYPES contains exactly the five extracted event types', () => {
  assert.equal(CODEX_TAG_EVENT_TYPES.size, 5);
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_environment_context'));
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_collaboration_mode'));
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_skills_listing'));
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_system_reminder'));
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_mem_citation'));
});
