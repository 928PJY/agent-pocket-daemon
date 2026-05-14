// Agent Pocket — deterministic stable id derivation for synthesized events.
//
// Most ClaudeEvents stream straight from a JSONL row whose top-level `uuid`
// is the natural primary key (`event.sdkUuid`). A handful of events have no
// source row — synthesized interrupt notices, queue-operation enqueues,
// internally generated tool_results — so the daemon falls back to a
// deterministic hash of stable-per-row inputs. Same inputs → same id, which
// keeps live emit and history replay producing identical keys so the phone's
// id-based dedup collapses them.
//
// 16 hex chars (= 64 bits sha1 prefix) is wide enough to stay collision-free
// across a session's lifetime and short enough to keep wire payloads compact.

import { createHash } from 'node:crypto';

export function stableEventId(parts: ReadonlyArray<string | number | undefined>): string {
  const joined = parts.map((p) => p === undefined ? '' : String(p)).join('|');
  return createHash('sha1').update(joined).digest('hex').slice(0, 16);
}
