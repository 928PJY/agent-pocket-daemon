// Agent Pocket — Claude + Codex hooks manager (Step 2.2)
//
// Extracted from src/cli.ts. Owns the install/remove lifecycle for the
// HTTP/command hooks the daemon registers in Claude's settings.json,
// Codex's hooks.json, and Codex's config.toml [features] section.
//
// Public surface (consumed by cli.ts):
//
//   installClaudeHooks(hookPort, paths)
//   installCodexHooks (hookPort, paths)
//   removeClaudeHooks (paths)
//   removeCodexHooks  (paths)
//
// All filesystem paths come in via a HooksManagerPaths object so tests can
// point at a tmpdir.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../logger.js';

export const MANAGED_BY_TAG = 'agent-pocket';

export interface HooksManagerPaths {
  hooksDir: string;
  claudeSettingsFile: string;
  codexConfigFile: string;
  codexHooksFile: string;
  hookDebugLogFile: string;
}

export interface ManagedHookEntry {
  _managedBy: string;
  hooks: Array<{ type: string; url?: string; command?: string; timeout: number }>;
}

function sessionStartScriptPath(paths: HooksManagerPaths): string {
  return path.join(paths.hooksDir, 'session-start.sh');
}

function codexHookScriptPath(paths: HooksManagerPaths): string {
  return path.join(paths.hooksDir, 'codex-hook.sh');
}

// ---------------------------------------------------------------------------
// Entry constructors
// ---------------------------------------------------------------------------

export function managedEntry(hookPort: number, endpoint: string, timeout: number): ManagedHookEntry {
  return {
    _managedBy: MANAGED_BY_TAG,
    hooks: [{ type: 'http', url: `http://127.0.0.1:${hookPort}/hooks/${endpoint}`, timeout }],
  };
}

export function persistentCommandEntry(scriptPath: string, timeout: number): ManagedHookEntry {
  return {
    _managedBy: MANAGED_BY_TAG,
    hooks: [{ type: 'command', command: scriptPath, timeout }],
  };
}

export function codexManagedGroup(command: string, timeout: number, statusMessage?: string): Record<string, unknown> {
  return {
    matcher: '*',
    _managedBy: MANAGED_BY_TAG,
    hooks: [{
      type: 'command',
      command,
      timeout,
      ...(statusMessage ? { statusMessage } : {}),
      _managedBy: MANAGED_BY_TAG,
    }],
  };
}

// ---------------------------------------------------------------------------
// Managed-entry detection
// ---------------------------------------------------------------------------

export function isCodexManagedGroup(entry: unknown, codexHookScript: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e._managedBy === MANAGED_BY_TAG) return true;
  const hooks = e.hooks as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(h => h._managedBy === MANAGED_BY_TAG
    || (typeof h.command === 'string' && h.command.includes(codexHookScript)));
}

export function isHttpManagedEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e._managedBy === MANAGED_BY_TAG) {
    const hooks = e.hooks as Array<Record<string, unknown>> | undefined;
    if (hooks?.[0]?.type === 'command') return false;
    return true;
  }
  const hooks = e.hooks as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  const hook = hooks[0];
  if (typeof hook?.url === 'string' && hook.url.includes('/hooks/')) return true;
  return false;
}

export function isManagedEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e._managedBy === MANAGED_BY_TAG) return true;
  const hooks = e.hooks as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  const hook = hooks[0];
  if (typeof hook?.url === 'string' && hook.url.includes('/hooks/')) return true;
  if (typeof hook?.command === 'string' && (hook.command.includes('/hooks/') || hook.command.includes('agent-pocket') || hook.command.includes('pocket-agent'))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Script emitters
// ---------------------------------------------------------------------------

export function installSessionStartScript(hookPort: number, paths: HooksManagerPaths): void {
  fs.mkdirSync(paths.hooksDir, { recursive: true });

  const script = `#!/bin/bash
# Agent Pocket — SessionStart hook
# Persists session ID changes to disk and forwards to daemon (best effort).
# This script runs even when the daemon is stopped.

INPUT=$(cat)

# Resolve Claude Code PID by walking up the process tree until we find
# a PID that has a session file in ~/.claude/sessions/<PID>.json
CLAUDE_PID=0
WALK_PID=$$
while [ "$WALK_PID" -gt 1 ]; do
  WALK_PID=$(ps -p $WALK_PID -o ppid= 2>/dev/null | tr -d ' ')
  [ -z "$WALK_PID" ] && break
  if [ -f "$HOME/.claude/sessions/\${WALK_PID}.json" ]; then
    CLAUDE_PID=$WALK_PID
    break
  fi
done

MAP_FILE="$HOME/.agent-pocket/session-map.json"
mkdir -p "$(dirname "$MAP_FILE")"

# Use python3 to parse JSON safely and update the session map
python3 -c "
import sys, json, os, time

input_json = json.loads(sys.argv[1])
claude_pid = sys.argv[2]
session_id = input_json.get('session_id', '')
source = input_json.get('source', '')
cwd = input_json.get('cwd', '')
transcript_path = input_json.get('transcript_path', '')
agent_id = input_json.get('agent_id', '')

if not session_id or not source:
    sys.exit(0)

# Skip subagent SessionStart events: they share the parent Claude PID but
# refer to a transient subagent session, which would clobber the parent's
# real session-id mapping. Detect via agent_id or subagent transcript path.
if agent_id or '/subagents/' in transcript_path:
    sys.exit(0)

# Without a real PID we can't later look this entry up by process; writing
# pid=0 just leaves dead weight in the map. The hook walked the process
# tree and found nothing — drop the event.
if not claude_pid.isdigit() or int(claude_pid) == 0:
    sys.exit(0)

map_file = os.path.expanduser('~/.agent-pocket/session-map.json')
try:
    with open(map_file) as f:
        m = json.load(f)
except:
    m = {}

now = int(time.time())
m[session_id] = {
    'source': source,
    'cwd': cwd,
    'transcript_path': transcript_path,
    'pid': int(claude_pid),
    'timestamp': now,
}

# Prune entries whose recorded PID is no longer alive. We used to prune by
# a 1-hour cutoff, but that lost evidence of /clear events that happened
# while the daemon was down — the next SessionStart fired more than 1h
# later would silently delete the older entry, leaving the daemon unable
# to learn the real session id when it eventually started.
def _alive(p):
    try:
        os.kill(int(p), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False
m = {k: v for k, v in m.items() if _alive(v.get('pid'))}

with open(map_file, 'w') as f:
    json.dump(m, f)
" "$INPUT" "$CLAUDE_PID" 2>/dev/null

# Forward to daemon HTTP endpoint (best effort — daemon may not be running)
curl -s -X POST -H 'Content-Type: application/json' \\
  -d "$INPUT" \\
  "http://127.0.0.1:${hookPort}/hooks/session-start" \\
  --connect-timeout 1 --max-time 3 >/dev/null 2>&1 || true
`;

  fs.writeFileSync(sessionStartScriptPath(paths), script, { mode: 0o755 });
}

export function installCodexHookScript(hookPort: number, paths: HooksManagerPaths): void {
  fs.mkdirSync(paths.hooksDir, { recursive: true });

  const script = `#!/bin/bash
# Agent Pocket — Codex hook bridge
# Adds process-correlation metadata and forwards Codex hook JSON to the daemon.

ENDPOINT="$1"
INPUT=$(cat)
DEBUG_LOG="${paths.hookDebugLogFile}"

CODEX_PID=0
WALK_PID=$$
while [ "$WALK_PID" -gt 1 ]; do
  WALK_PID=$(ps -p "$WALK_PID" -o ppid= 2>/dev/null | tr -d ' ')
  [ -z "$WALK_PID" ] && break
  COMM=$(ps -p "$WALK_PID" -o comm= 2>/dev/null | awk '{print $1}')
  BASE=$(basename "$COMM" 2>/dev/null)
  if [ "$BASE" = "codex" ]; then
    CODEX_PID=$WALK_PID
    break
  fi
done

python3 -c '
import json, os, sys
payload = json.loads(sys.argv[1] or "{}")
payload["agent_pocket_hook_pid"] = int(sys.argv[2])
try:
    codex_pid = int(sys.argv[3])
except Exception:
    codex_pid = 0
if codex_pid:
    payload["agent_pocket_codex_pid"] = codex_pid
print(json.dumps(payload, separators=(",", ":")))
' "$INPUT" "$$" "$CODEX_PID" | curl -s -X POST -H 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${hookPort}/hooks/codex/$ENDPOINT" \
  --connect-timeout 1 --max-time 600
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  mkdir -p "$(dirname "$DEBUG_LOG")"
  printf '%s Codex hook bridge failed endpoint=%s status=%s port=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$ENDPOINT" "$STATUS" "${hookPort}" >> "$DEBUG_LOG" 2>/dev/null || true
fi
exit 0
`;

  fs.writeFileSync(codexHookScriptPath(paths), script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// TOML helper
// ---------------------------------------------------------------------------

export function findTomlSection(content: string, sectionName: string): { bodyStart: number; bodyEnd: number } | null {
  const headerRe = /^\[([^\]]+)\]\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(content)) !== null) {
    if (match[1].trim() !== sectionName) continue;
    const bodyStart = match.index + match[0].length + (content[match.index + match[0].length] === '\n' ? 1 : 0);
    const nextHeaderRe = /^\[[^\]]+\]\s*$/gm;
    nextHeaderRe.lastIndex = bodyStart;
    const next = nextHeaderRe.exec(content);
    return { bodyStart, bodyEnd: next?.index ?? content.length };
  }
  return null;
}

export function enableCodexHooksFeature(paths: HooksManagerPaths): void {
  fs.mkdirSync(path.dirname(paths.codexConfigFile), { recursive: true });
  let content = '';
  try {
    if (fs.existsSync(paths.codexConfigFile)) {
      content = fs.readFileSync(paths.codexConfigFile, 'utf-8');
    }
  } catch {
    content = '';
  }

  const features = findTomlSection(content, 'features');
  if (features) {
    const section = content.slice(features.bodyStart, features.bodyEnd);
    if (/^codex_hooks\s*=\s*true\s*$/m.test(section)) return;
    if (/^codex_hooks\s*=\s*false\s*$/m.test(section)) {
      const updatedSection = section.replace(/^codex_hooks\s*=\s*false\s*$/m, 'codex_hooks = true');
      fs.writeFileSync(paths.codexConfigFile, `${content.slice(0, features.bodyStart)}${updatedSection}${content.slice(features.bodyEnd)}`, 'utf-8');
      return;
    }

    const needsNewline = section.length > 0 && !section.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(paths.codexConfigFile, `${content.slice(0, features.bodyEnd)}${needsNewline}codex_hooks = true\n${content.slice(features.bodyEnd)}`, 'utf-8');
    return;
  }

  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n\n' : content.length > 0 ? '\n' : '';
  fs.writeFileSync(paths.codexConfigFile, `${content}${prefix}[features]\ncodex_hooks = true\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Top-level install / remove
// ---------------------------------------------------------------------------

export function installClaudeHooks(hookPort: number, paths: HooksManagerPaths): void {
  installSessionStartScript(hookPort, paths);

  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(paths.claudeSettingsFile)) {
      settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf-8'));
    }
  } catch {
    // Start fresh if unreadable
  }

  const hooks: Record<string, unknown> = (settings.hooks as Record<string, unknown>) ?? {};

  const sessionStartScript = sessionStartScriptPath(paths);
  const managed: Record<string, ManagedHookEntry> = {
    PreToolUse: managedEntry(hookPort, 'permission-request', 600),
    PermissionRequest: managedEntry(hookPort, 'permission-prompt', 600),
    PostToolUse: managedEntry(hookPort, 'post-tool-use', 10),
    Stop: managedEntry(hookPort, 'stop', 10),
    SubagentStart: managedEntry(hookPort, 'subagent-start', 10),
    SubagentStop: managedEntry(hookPort, 'subagent-stop', 10),
    SessionStart: persistentCommandEntry(sessionStartScript, 5),
    SessionEnd: managedEntry(hookPort, 'session-end', 5),
  };

  for (const [event, entry] of Object.entries(managed)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const preserved = existing.filter(e => !isManagedEntry(e));
    hooks[event] = [...preserved, entry];
  }

  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify(settings, null, 2), 'utf-8');
  logger.info('cli', `Installed Claude hooks pointing to port ${hookPort}`);
}

export function installCodexHooks(hookPort: number, paths: HooksManagerPaths): void {
  installCodexHookScript(hookPort, paths);
  enableCodexHooksFeature(paths);

  let config: Record<string, unknown> = {};
  try {
    if (fs.existsSync(paths.codexHooksFile)) {
      config = JSON.parse(fs.readFileSync(paths.codexHooksFile, 'utf-8')) as Record<string, unknown>;
    }
  } catch {
    config = {};
  }

  const hooks: Record<string, unknown[]> = (config.hooks && typeof config.hooks === 'object')
    ? config.hooks as Record<string, unknown[]>
    : {};
  const codexHookScript = codexHookScriptPath(paths);
  const managed: Record<string, Record<string, unknown>> = {
    SessionStart: codexManagedGroup(`${codexHookScript} session-start`, 5),
    UserPromptSubmit: codexManagedGroup(`${codexHookScript} user-prompt-submit`, 5),
    PermissionRequest: codexManagedGroup(`${codexHookScript} permission-request`, 600, 'Waiting for Agent Pocket approval'),
    Stop: codexManagedGroup(`${codexHookScript} stop`, 10),
  };

  for (const [event, entry] of Object.entries(managed)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...existing.filter(e => !isCodexManagedGroup(e, codexHookScript)), entry];
  }

  config.hooks = hooks;
  fs.mkdirSync(path.dirname(paths.codexHooksFile), { recursive: true });
  fs.writeFileSync(paths.codexHooksFile, JSON.stringify(config, null, 2), 'utf-8');
  logger.info('cli', `Installed Codex hooks pointing to port ${hookPort}`);
}

export function removeClaudeHooks(paths: HooksManagerPaths): void {
  try {
    if (!fs.existsSync(paths.claudeSettingsFile)) return;
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf-8'));
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (!hooks) return;

    for (const event of Object.keys(hooks)) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter(e => !isHttpManagedEntry(e));
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }

    if (Object.keys(hooks).length === 0) delete settings.hooks;
    fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify(settings, null, 2), 'utf-8');
    logger.info('cli', 'Removed Claude hooks from settings');
  } catch {
    // Best effort
  }
}

export function removeCodexHooks(paths: HooksManagerPaths): void {
  try {
    if (!fs.existsSync(paths.codexHooksFile)) return;
    const config = JSON.parse(fs.readFileSync(paths.codexHooksFile, 'utf-8')) as Record<string, unknown>;
    const hooks = config.hooks as Record<string, unknown[]> | undefined;
    if (!hooks || typeof hooks !== 'object') return;

    const codexHookScript = codexHookScriptPath(paths);
    for (const event of Object.keys(hooks)) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter(e => !isCodexManagedGroup(e, codexHookScript));
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }

    if (Object.keys(hooks).length === 0) delete config.hooks;
    fs.writeFileSync(paths.codexHooksFile, JSON.stringify(config, null, 2), 'utf-8');
    logger.info('cli', 'Removed Codex hooks from settings');
  } catch {
    // Best effort
  }
}
