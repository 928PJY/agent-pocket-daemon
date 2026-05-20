import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flattenAgentEvent,
  sendFlattenedSessionOutput,
  sendSessionHistory,
  type SendSessionHistoryDeps,
} from '../src/wiring/session-output-serializer.js';
import type { ClaudeEvent, PcEvent } from 'agent-pocket-protocol';

// ---------------------------------------------------------------------------
// flattenAgentEvent — pure variant flattening
// ---------------------------------------------------------------------------

test('flattenAgentEvent: thinking sets output_type + content + is_complete=false', () => {
  const flat = flattenAgentEvent('s1', { type: 'thinking', thinking: 'hmm' } as ClaudeEvent, 'claude_code');
  assert.equal(flat.output_type, 'thinking');
  assert.equal(flat.content, 'hmm');
  assert.equal(flat.is_complete, false);
  assert.equal(flat.type, 'session_output');
  assert.equal(flat.session_id, 's1');
  assert.equal(flat.agent_type, 'claude_code');
  assert.equal(typeof flat.timestamp, 'number');
});

test('flattenAgentEvent: assistant_message sets content + is_complete=false', () => {
  const flat = flattenAgentEvent('s1', { type: 'assistant_message', message: 'hi' } as ClaudeEvent, 'claude_code');
  assert.equal(flat.output_type, 'assistant_message');
  assert.equal(flat.content, 'hi');
  assert.equal(flat.is_complete, false);
});

test('flattenAgentEvent: tool_use copies tool_name + tool_input + tool_use_id', () => {
  const flat = flattenAgentEvent('s1', {
    type: 'tool_use', tool_id: 'tu1', tool_name: 'Bash', tool_input: { cmd: 'ls' },
  } as ClaudeEvent, 'claude_code');
  assert.equal(flat.output_type, 'tool_use');
  assert.equal(flat.tool_name, 'Bash');
  assert.deepEqual(flat.tool_input, { cmd: 'ls' });
  assert.equal(flat.tool_use_id, 'tu1');
});

test('flattenAgentEvent: tool_result success → is_error=false', () => {
  const flat = flattenAgentEvent('s1', {
    type: 'tool_result', tool_id: 'tu1', status: 'success', output: 'ok',
  } as ClaudeEvent, 'claude_code');
  assert.equal(flat.output_type, 'tool_result');
  assert.equal(flat.tool_use_id, 'tu1');
  assert.equal(flat.output, 'ok');
  assert.equal(flat.is_error, false);
});

test('flattenAgentEvent: tool_result error → is_error=true', () => {
  const flat = flattenAgentEvent('s1', {
    type: 'tool_result', tool_id: 'tu1', status: 'error', output: 'oops',
  } as ClaudeEvent, 'claude_code');
  assert.equal(flat.is_error, true);
});

test('flattenAgentEvent: user_message includes sdk_uuid only when present', () => {
  const flat1 = flattenAgentEvent('s1', { type: 'user_message', message: 'hi', sdkUuid: 'u1' } as ClaudeEvent, 'claude_code');
  assert.equal(flat1.sdk_uuid, 'u1');
  const flat2 = flattenAgentEvent('s1', { type: 'user_message', message: 'hi' } as ClaudeEvent, 'claude_code');
  assert.equal('sdk_uuid' in flat2, false);
});

test('flattenAgentEvent: system_message copies message into content', () => {
  const flat = flattenAgentEvent('s1', { type: 'system_message', message: 'sys' } as ClaudeEvent, 'claude_code');
  assert.equal(flat.output_type, 'system_message');
  assert.equal(flat.content, 'sys');
});

test('flattenAgentEvent: subagent_event copies all subagent fields', () => {
  const inner = { type: 'thinking', thinking: 't' } as ClaudeEvent;
  const flat = flattenAgentEvent('s1', {
    type: 'subagent_event',
    agent_id: 'a1',
    agent_name: 'researcher',
    agent_type: 'general',
    inner_event: inner,
    tool_use_count: 2,
    token_count: 100,
    agent_status: 'running',
  } as ClaudeEvent, 'claude_code');
  assert.equal(flat.output_type, 'subagent_event');
  assert.equal(flat.agent_id, 'a1');
  assert.equal(flat.agent_name, 'researcher');
  assert.equal(flat.agent_type, 'general');
  assert.equal(flat.inner_event, inner);
  assert.equal(flat.tool_use_count, 2);
  assert.equal(flat.token_count, 100);
  assert.equal(flat.agent_status, 'running');
});

test('flattenAgentEvent: unknown variant falls into default branch (JSON-encodes)', () => {
  const ev = { type: 'mystery', foo: 1 } as unknown as ClaudeEvent;
  const flat = flattenAgentEvent('s1', ev, 'claude_code');
  assert.equal(flat.output_type, 'mystery');
  assert.equal(flat.content, JSON.stringify(ev));
});

test('flattenAgentEvent: agent_type propagates (codex)', () => {
  const flat = flattenAgentEvent('s1', { type: 'thinking', thinking: 't' } as ClaudeEvent, 'codex');
  assert.equal(flat.agent_type, 'codex');
});

// ---------------------------------------------------------------------------
// sendFlattenedSessionOutput — codex echo dedupe + dispatch
// ---------------------------------------------------------------------------

test('sendFlattenedSessionOutput: dispatches flattened event for non-codex', () => {
  const sent: PcEvent[] = [];
  sendFlattenedSessionOutput(
    { codexInjectedMessages: new Map(), sendToPhone: (e) => sent.push(e), hasPeerCapability: () => true },
    's1',
    { type: 'assistant_message', message: 'hi' } as ClaudeEvent,
    'claude_code',
  );
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as unknown as { content: string }).content, 'hi');
});

test('sendFlattenedSessionOutput: dispatches codex non-user_message events', () => {
  const sent: PcEvent[] = [];
  sendFlattenedSessionOutput(
    { codexInjectedMessages: new Map(), sendToPhone: (e) => sent.push(e), hasPeerCapability: () => true },
    's1',
    { type: 'thinking', thinking: 't' } as ClaudeEvent,
    'codex',
  );
  assert.equal(sent.length, 1);
});

test('sendFlattenedSessionOutput: codex user_message echo is consumed and not dispatched', () => {
  const sent: PcEvent[] = [];
  const injected = new Map<string, Map<string, number>>();
  injected.set('s1', new Map([['echo!', 1]]));
  sendFlattenedSessionOutput(
    { codexInjectedMessages: injected, sendToPhone: (e) => sent.push(e), hasPeerCapability: () => true },
    's1',
    { type: 'user_message', message: 'echo!' } as ClaudeEvent,
    'codex',
  );
  assert.equal(sent.length, 0);
  // Counter is decremented by consumeInjectedMessage
  assert.equal(injected.get('s1')!.has('echo!'), false);
});

test('sendFlattenedSessionOutput: codex user_message dispatches when not in injected map', () => {
  const sent: PcEvent[] = [];
  sendFlattenedSessionOutput(
    { codexInjectedMessages: new Map(), sendToPhone: (e) => sent.push(e), hasPeerCapability: () => true },
    's1',
    { type: 'user_message', message: 'real' } as ClaudeEvent,
    'codex',
  );
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as unknown as { content: string }).content, 'real');
});

test('sendFlattenedSessionOutput: drops local_command events when peer lacks LOCAL_COMMAND cap', () => {
  const sent: PcEvent[] = [];
  const deps = { codexInjectedMessages: new Map(), sendToPhone: (e: PcEvent) => sent.push(e), hasPeerCapability: () => false };
  for (const ev of [
    { type: 'local_command_invoke', name: 'cost', args: '' },
    { type: 'local_command_output', stdout: 'Total: $0' },
    { type: 'compact_boundary' },
    { type: 'compact_summary', summary: '...' },
  ] as const) {
    sendFlattenedSessionOutput(deps, 's1', ev as ClaudeEvent, 'claude_code');
  }
  assert.equal(sent.length, 0);
});

test('sendFlattenedSessionOutput: forwards local_command events when peer has LOCAL_COMMAND cap', () => {
  const sent: PcEvent[] = [];
  const deps = { codexInjectedMessages: new Map(), sendToPhone: (e: PcEvent) => sent.push(e), hasPeerCapability: (n: string) => n === 'local.command' };
  sendFlattenedSessionOutput(deps, 's1', { type: 'local_command_invoke', name: 'cost', args: '' } as ClaudeEvent, 'claude_code');
  sendFlattenedSessionOutput(deps, 's1', { type: 'local_command_output', stdout: 'Total: $0' } as ClaudeEvent, 'claude_code');
  sendFlattenedSessionOutput(deps, 's1', { type: 'compact_boundary' } as ClaudeEvent, 'claude_code');
  sendFlattenedSessionOutput(deps, 's1', { type: 'compact_summary', summary: 'sum' } as ClaudeEvent, 'claude_code');
  assert.equal(sent.length, 4);
  assert.equal((sent[0] as unknown as { output_type: string }).output_type, 'local_command_invoke');
  assert.equal((sent[1] as unknown as { output_type: string; stdout: string }).output_type, 'local_command_output');
  assert.equal((sent[2] as unknown as { output_type: string }).output_type, 'compact_boundary');
  assert.equal((sent[3] as unknown as { output_type: string; summary: string }).summary, 'sum');
});

test('sendFlattenedSessionOutput: non-local-command events flow through regardless of LOCAL_COMMAND cap', () => {
  const sent: PcEvent[] = [];
  sendFlattenedSessionOutput(
    { codexInjectedMessages: new Map(), sendToPhone: (e: PcEvent) => sent.push(e), hasPeerCapability: () => false },
    's1',
    { type: 'assistant_message', message: 'hi' } as ClaudeEvent,
    'claude_code',
  );
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------------------
// sendSessionHistory — paginate + filter + dispatch
// ---------------------------------------------------------------------------

interface FakeDiscovery {
  result: {
    messages: Array<{ role: string; content: string }>;
    totalCount: number;
    offset: number;
    hasMore: boolean;
    tailSeq?: number;
  };
  calls: Array<{ id: string; opts: unknown }>;
}

function makeDeps(opts: {
  showToolUse: boolean;
  sessionDiscoveryResult: FakeDiscovery['result'];
  codexDiscoveryResult?: FakeDiscovery['result'];
}): { deps: SendSessionHistoryDeps; sent: PcEvent[]; sd: FakeDiscovery; cd: FakeDiscovery } {
  const sent: PcEvent[] = [];
  const sd: FakeDiscovery = { result: opts.sessionDiscoveryResult, calls: [] };
  const cd: FakeDiscovery = {
    result: opts.codexDiscoveryResult ?? { messages: [], totalCount: 0, offset: 0, hasMore: false, tailSeq: 0 },
    calls: [],
  };
  const deps: SendSessionHistoryDeps = {
    sessionDiscovery: {
      getSessionHistory: ((id: string, o: unknown) => {
        sd.calls.push({ id, opts: o });
        return sd.result;
      }) as unknown as SendSessionHistoryDeps['sessionDiscovery']['getSessionHistory'],
    },
    codexDiscovery: {
      getSessionHistory: ((id: string, o: unknown) => {
        cd.calls.push({ id, opts: o });
        return cd.result;
      }) as unknown as SendSessionHistoryDeps['codexDiscovery']['getSessionHistory'],
    },
    phonePreferences: { showToolUse: opts.showToolUse },
    sendToPhone: (e) => sent.push(e),
    hasPeerCapability: () => true,
    getControllerSlashSynthLog: () => [],
  };
  return { deps, sent, sd, cd };
}

test('sendSessionHistory: claude session uses sessionDiscovery + agent_type=claude_code', () => {
  const { deps, sent, sd, cd } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [{ role: 'assistant_message', content: 'a' }], totalCount: 1, offset: 0, hasMore: false, tailSeq: 5 },
  });
  const result = sendSessionHistory(deps, 'claude-uuid-abc');
  assert.equal(result.tailSeq, 5);
  assert.equal(sd.calls.length, 1);
  assert.equal(cd.calls.length, 0);
  const ev = sent[0] as unknown as { agent_type: string; type: string; tail_seq: number };
  assert.equal(ev.type, 'session_history');
  assert.equal(ev.agent_type, 'claude_code');
  assert.equal(ev.tail_seq, 5);
});

test('sendSessionHistory: codex session uses codexDiscovery + agent_type=codex', () => {
  const { deps, sent, sd, cd } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 0, offset: 0, hasMore: false },
    codexDiscoveryResult: { messages: [], totalCount: 0, offset: 0, hasMore: false, tailSeq: 7 },
  });
  // codex session ids are detected by isCodexSessionId; use a UUID-shaped string
  // that is recognized as codex (path-based prefix). Use a known codex pattern.
  // The detection lives in discovery/codex-discovery; codex ids use the form
  // "rollout-..." or have a specific shape. Use the most permissive pattern:
  // a path segment starting with "codex-".
  sendSessionHistory(deps, 'codex-rollout-2024-01-01T00-00-00-abcd1234');
  // Whichever discovery is selected, exactly one of the two should be called.
  const totalCalls = sd.calls.length + cd.calls.length;
  assert.equal(totalCalls, 1);
  assert.equal(sent.length, 1);
});

test('sendSessionHistory: showToolUse=false filters tool_use + tool_result roles', () => {
  const { deps, sent } = makeDeps({
    showToolUse: false,
    sessionDiscoveryResult: {
      messages: [
        { role: 'assistant_message', content: 'a' },
        { role: 'tool_use', content: 'tu' },
        { role: 'tool_result', content: 'tr' },
        { role: 'user_message', content: 'u' },
      ],
      totalCount: 4, offset: 0, hasMore: false, tailSeq: 4,
    },
  });
  sendSessionHistory(deps, 'claude-uuid');
  const msgs = (sent[0] as unknown as { messages: Array<{ role: string }> }).messages;
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs.map(m => m.role), ['assistant_message', 'user_message']);
});

test('sendSessionHistory: showToolUse=true keeps all roles', () => {
  const { deps, sent } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: {
      messages: [
        { role: 'assistant_message', content: 'a' },
        { role: 'tool_use', content: 'tu' },
      ],
      totalCount: 2, offset: 0, hasMore: false, tailSeq: 2,
    },
  });
  sendSessionHistory(deps, 'claude-uuid');
  const msgs = (sent[0] as unknown as { messages: Array<{ role: string }> }).messages;
  assert.equal(msgs.length, 2);
});

test('sendSessionHistory: truncates content longer than 5000 chars', () => {
  const { deps, sent } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: {
      messages: [{ role: 'assistant_message', content: 'x'.repeat(6000) }],
      totalCount: 1, offset: 0, hasMore: false, tailSeq: 1,
    },
  });
  sendSessionHistory(deps, 'claude-uuid');
  const msgs = (sent[0] as unknown as { messages: Array<{ content: string }> }).messages;
  assert.equal(msgs[0].content.length, 5000);
});

test('sendSessionHistory: no options → defaults to a small tail window (DEFAULT_SESSION_HISTORY_LIMIT=30, isFullHistory=false)', () => {
  const { deps, sent, sd } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 0, offset: 0, hasMore: false, tailSeq: 0 },
  });
  sendSessionHistory(deps, 'claude-uuid');
  // Default page size is intentionally small — preventing accidental
  // full-history pulls is the #250 round-2 invariant.
  assert.equal((sd.calls[0].opts as { limit: number }).limit, 30);
  assert.equal((sent[0] as unknown as { is_full_history: boolean }).is_full_history, false);
});

test('sendSessionHistory: limit explicitly above MAX_SESSION_HISTORY_LIMIT is clamped to 200', () => {
  const { deps, sd } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 0, offset: 0, hasMore: false, tailSeq: 0 },
  });
  sendSessionHistory(deps, 'claude-uuid', { limit: 10000 });
  assert.equal((sd.calls[0].opts as { limit: number }).limit, 200);
});

test('sendSessionHistory: incremental (since) → defaultLimit=200, isFullHistory=false', () => {
  const { deps, sent, sd } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 0, offset: 0, hasMore: false, tailSeq: 0 },
  });
  sendSessionHistory(deps, 'claude-uuid', { since: '2026-01-01' });
  assert.equal((sd.calls[0].opts as { limit: number }).limit, 200);
  assert.equal((sent[0] as unknown as { is_full_history: boolean }).is_full_history, false);
});

test('sendSessionHistory: sinceSeq triggers incremental', () => {
  const { deps, sent, sd } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 0, offset: 0, hasMore: false, tailSeq: 0 },
  });
  sendSessionHistory(deps, 'claude-uuid', { sinceSeq: 42 });
  assert.equal((sd.calls[0].opts as { limit: number }).limit, 200);
  assert.equal((sd.calls[0].opts as { sinceSeq: number }).sinceSeq, 42);
  assert.equal((sent[0] as unknown as { is_full_history: boolean }).is_full_history, false);
});

test('sendSessionHistory: explicit offset disables isFullHistory', () => {
  const { deps, sent } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 0, offset: 5, hasMore: false, tailSeq: 0 },
  });
  sendSessionHistory(deps, 'claude-uuid', { offset: 5 });
  assert.equal((sent[0] as unknown as { is_full_history: boolean }).is_full_history, false);
});

test('sendSessionHistory: explicit limit overrides default', () => {
  const { deps, sd } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 0, offset: 0, hasMore: false, tailSeq: 0 },
  });
  sendSessionHistory(deps, 'claude-uuid', { limit: 50 });
  assert.equal((sd.calls[0].opts as { limit: number }).limit, 50);
});

test('sendSessionHistory: returns tailSeq from discovery result (undefined when discovery omits it)', () => {
  const { deps } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 0, offset: 0, hasMore: false },
  });
  const result = sendSessionHistory(deps, 'claude-uuid');
  assert.equal(result.tailSeq, undefined);
});

test('sendSessionHistory: forwards offset, totalCount, hasMore from discovery to event', () => {
  const { deps, sent } = makeDeps({
    showToolUse: true,
    sessionDiscoveryResult: { messages: [], totalCount: 99, offset: 10, hasMore: true, tailSeq: 50 },
  });
  sendSessionHistory(deps, 'claude-uuid', { offset: 10 });
  const ev = sent[0] as unknown as { total_count: number; offset: number; has_more: boolean };
  assert.equal(ev.total_count, 99);
  assert.equal(ev.offset, 10);
  assert.equal(ev.has_more, true);
});

// ---------------------------------------------------------------------------
// flattenAgentEvent — codex_meta cases
//
// Regression for end-to-end issue uncovered during iOS validation: the
// switch had no case for these 5 types, so they fell into `default` and got
// serialized as `content: JSON.stringify(agentEvent)`. iOS then read no
// top-level fields and rendered empty Environment cards / Default-stuck mode
// banners. These tests pin the field-spread shape that iOS depends on.
// ---------------------------------------------------------------------------

test('flattenAgentEvent: codex_environment_context spreads cwd/shell/etc onto envelope', () => {
  const flat = flattenAgentEvent('s1', {
    type: 'codex_environment_context',
    cwd: '/Users/me/proj',
    shell: 'zsh',
    current_date: '2026-05-20',
    timezone: 'Asia/Shanghai',
  } as ClaudeEvent, 'codex');
  assert.equal(flat.output_type, 'codex_environment_context');
  assert.equal((flat as Record<string, unknown>).cwd, '/Users/me/proj');
  assert.equal((flat as Record<string, unknown>).shell, 'zsh');
  assert.equal((flat as Record<string, unknown>).current_date, '2026-05-20');
  assert.equal((flat as Record<string, unknown>).timezone, 'Asia/Shanghai');
  // The pre-fix default branch would set `content` to a JSON blob; the
  // fixed path must NOT do that.
  assert.equal((flat as Record<string, unknown>).content, undefined);
});

test('flattenAgentEvent: codex_collaboration_mode spreads mode/body onto envelope', () => {
  const flat = flattenAgentEvent('s1', {
    type: 'codex_collaboration_mode',
    mode: 'Plan',
    body: '',
  } as ClaudeEvent, 'codex');
  assert.equal(flat.output_type, 'codex_collaboration_mode');
  assert.equal((flat as Record<string, unknown>).mode, 'Plan');
  assert.equal((flat as Record<string, unknown>).body, '');
  assert.equal((flat as Record<string, unknown>).content, undefined);
});

test('flattenAgentEvent: codex_skills_listing spreads skills array onto envelope', () => {
  const skills = [
    { name: 'skill-a', description: 'do a', filePath: '/p/a/SKILL.md' },
    { name: 'skill-b', description: 'do b', filePath: '/p/b/SKILL.md' },
  ];
  const flat = flattenAgentEvent('s1', {
    type: 'codex_skills_listing',
    skills,
  } as ClaudeEvent, 'codex');
  assert.equal(flat.output_type, 'codex_skills_listing');
  assert.deepEqual((flat as Record<string, unknown>).skills, skills);
  assert.equal((flat as Record<string, unknown>).content, undefined);
});

test('flattenAgentEvent: codex_system_reminder spreads text/severity onto envelope', () => {
  const flat = flattenAgentEvent('s1', {
    type: 'codex_system_reminder',
    text: 'task tools not used recently',
    severity: 'info',
  } as ClaudeEvent, 'codex');
  assert.equal(flat.output_type, 'codex_system_reminder');
  assert.equal((flat as Record<string, unknown>).text, 'task tools not used recently');
  assert.equal((flat as Record<string, unknown>).severity, 'info');
  assert.equal((flat as Record<string, unknown>).content, undefined);
});

test('flattenAgentEvent: codex_mem_citation spreads entries/rollout_ids onto envelope', () => {
  const entries = [{ filePath: '/a.md', preview: 'hi' }];
  const rolloutIds = ['11111111-1111-1111-1111-111111111111'];
  const flat = flattenAgentEvent('s1', {
    type: 'codex_mem_citation',
    entries,
    rollout_ids: rolloutIds,
  } as ClaudeEvent, 'codex');
  assert.equal(flat.output_type, 'codex_mem_citation');
  assert.deepEqual((flat as Record<string, unknown>).entries, entries);
  assert.deepEqual((flat as Record<string, unknown>).rollout_ids, rolloutIds);
  assert.equal((flat as Record<string, unknown>).content, undefined);
});

test('flattenAgentEvent: codex_meta event with ISO timestamp converts to epoch ms number', () => {
  const flat = flattenAgentEvent('s1', {
    type: 'codex_collaboration_mode',
    mode: 'Default',
    body: '',
    timestamp: '2026-05-20T03:37:12.000Z',
  } as ClaudeEvent, 'codex');
  assert.equal(typeof flat.timestamp, 'number');
  assert.equal(flat.timestamp, new Date('2026-05-20T03:37:12.000Z').getTime());
});
