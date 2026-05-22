import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractCodexMetaEvents,
  CODEX_TAG_EVENT_TYPES,
} from '../src/utils/codex-tag-extract.js';
import type {
  CodexEnvironmentContextEvent,
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

test('<oai-mem-citation> is stripped from text but emits no event (UI not ready)', () => {
  const text = `<oai-mem-citation>
<citation_entries>
MEMORY.md:234-236|note=[responsesapi citation extraction]
</citation_entries>
<rollout_ids>
019c6e27-e55b-73d1-87d8-4e01f1f75043
</rollout_ids>
</oai-mem-citation>`;
  const r = extractCodexMetaEvents(text);
  assert.deepEqual(r.events, [],
    'mem-citation event emission is currently suppressed in the extractor');
  assert.equal(r.stripped, '',
    'tag must still be stripped so raw XML never reaches chat bubbles');
});

test('<oai-mem-citation> mixed with prose: prose preserved, no event', () => {
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
  assert.deepEqual(r.events, []);
  assert.equal(r.stripped, 'Answer prose.');
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

<system-reminder>note</system-reminder>`;
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

test('CODEX_TAG_EVENT_TYPES contains exactly the four currently-emitted event types', () => {
  assert.equal(CODEX_TAG_EVENT_TYPES.size, 4);
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_environment_context'));
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_collaboration_mode'));
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_skills_listing'));
  assert.ok(CODEX_TAG_EVENT_TYPES.has('codex_system_reminder'));
  // codex_mem_citation is intentionally absent — tag is still stripped from
  // text, but no dedicated event is emitted while the iOS card is unfinished.
  assert.ok(!CODEX_TAG_EVENT_TYPES.has('codex_mem_citation'));
});
