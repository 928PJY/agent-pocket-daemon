/**
 * Observer-mode `/command` autocomplete data source.
 *
 * Observer sessions don't have an SDK queryHandle, so `supportedCommands()`
 * isn't available. We assemble the list from two sources:
 *   - A hardcoded snapshot of CLI built-in commands (everything Claude Code's
 *     terminal exposes that the SDK API doesn't return — `/help`, `/model`,
 *     `/agents`, `/clear`, etc.). These reach terminal Claude via PTY keystroke
 *     injection (`pty/tmux-injector.ts`), so they behave the same as if the
 *     user typed them directly.
 *   - A lazy global cache of `query.supportedCommands()`, which contributes
 *     bundled skills (`/simplify`, `/debug`, etc.), plugin commands
 *     (`superpowers:*`), and user-defined `~/.claude/commands/*.md`.
 *
 * Hidden commands (`/copy`, `/desktop`, `/setup-bedrock`, ...) are filtered
 * out of the autocomplete list because they don't make sense from the phone
 * (clipboard-bound, OAuth flows, local terminal config, etc.). The user can
 * still type them by hand if they really want to.
 */

import { query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../logger.js';

/**
 * Daemon-private cwd for the SDK prefetch query. Routing the noop session
 * here (instead of /tmp) keeps `~/.claude/projects/-private-tmp/` clean and
 * lets `SessionDiscovery.parseSessionFile` filter out the prefetch session
 * by directory comparison so it never surfaces to the phone as a real
 * session. Resolved through realpath to match the encoded form the SDK
 * writes into `~/.claude/projects/<encoded-cwd>/`.
 */
export const PREFETCH_CWD: string = (() => {
  const dir = path.join(os.homedir(), '.agent-pocket', 'sdk-prefetch');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
})();

/**
 * CLI built-in commands — coded into the terminal binary, never exposed via
 * the SDK supportedCommands() API. Snapshot from
 * https://code.claude.com/docs/en/commands at the time of writing.
 *
 * Update when Claude Code adds a notable new built-in. Stale entries are
 * harmless (terminal will respond "unknown command") but missing entries
 * means observer-mode users won't see them in autocomplete.
 */
export const BUILTIN_TERMINAL_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: 'add-dir', description: 'Add a working directory for file access during the current session', argumentHint: '<path>' },
  { name: 'agents', description: 'Manage agent configurations', argumentHint: '' },
  { name: 'autofix-pr', description: 'Spawn a Claude Code on the web session that watches the PR and pushes fixes', argumentHint: '[prompt]' },
  { name: 'branch', description: 'Create a branch of the current conversation at this point', argumentHint: '[name]', aliases: ['fork'] },
  { name: 'btw', description: 'Ask a quick side question without adding to the conversation', argumentHint: '<question>' },
  { name: 'chrome', description: 'Configure Claude in Chrome settings', argumentHint: '' },
  { name: 'clear', description: 'Start a new conversation with empty context', argumentHint: '', aliases: ['reset', 'new'] },
  { name: 'color', description: 'Set the prompt bar color for the current session', argumentHint: '[color|default]' },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '[instructions]' },
  { name: 'config', description: 'Open the Settings interface', argumentHint: '', aliases: ['settings'] },
  { name: 'context', description: 'Visualize current context usage as a colored grid', argumentHint: '', aliases: ['usage'] },
  { name: 'diff', description: 'Open an interactive diff viewer showing uncommitted and per-turn changes', argumentHint: '' },
  { name: 'effort', description: 'Set the model effort level (low, medium, high, xhigh, max)', argumentHint: '[level|auto]' },
  { name: 'exit', description: 'Exit the CLI', argumentHint: '', aliases: ['quit'] },
  { name: 'export', description: 'Export the current conversation as plain text', argumentHint: '[filename]' },
  { name: 'fast', description: 'Toggle fast mode on or off', argumentHint: '[on|off]' },
  { name: 'feedback', description: 'Submit feedback about Claude Code', argumentHint: '[report]', aliases: ['bug'] },
  { name: 'help', description: 'Show help and available commands', argumentHint: '' },
  { name: 'hooks', description: 'View hook configurations for tool events', argumentHint: '' },
  { name: 'ide', description: 'Manage IDE integrations and show status', argumentHint: '' },
  { name: 'insights', description: 'Generate a report analyzing your Claude Code sessions', argumentHint: '' },
  { name: 'login', description: 'Sign in to your Anthropic account', argumentHint: '' },
  { name: 'logout', description: 'Sign out from your Anthropic account', argumentHint: '' },
  { name: 'mcp', description: 'Manage MCP server connections and OAuth authentication', argumentHint: '' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files and manage auto-memory', argumentHint: '' },
  { name: 'mobile', description: 'Show QR code to download the Claude mobile app', argumentHint: '', aliases: ['ios', 'android'] },
  { name: 'model', description: 'Select or change the AI model', argumentHint: '[model]' },
  { name: 'permissions', description: 'Manage allow, ask, and deny rules for tool permissions', argumentHint: '', aliases: ['allowed-tools'] },
  { name: 'plan', description: 'Enter plan mode directly from the prompt', argumentHint: '[description]' },
  { name: 'plugin', description: 'Manage Claude Code plugins', argumentHint: '' },
  { name: 'powerup', description: 'Discover Claude Code features through quick interactive lessons', argumentHint: '' },
  { name: 'recap', description: 'Generate a one-line summary of the current session', argumentHint: '' },
  { name: 'reload-plugins', description: 'Reload all active plugins to apply pending changes', argumentHint: '' },
  { name: 'remote-control', description: 'Make this session available for remote control from claude.ai', argumentHint: '', aliases: ['rc'] },
  { name: 'remote-env', description: 'Configure the default remote environment for web sessions', argumentHint: '' },
  { name: 'rename', description: 'Rename the current session', argumentHint: '[name]' },
  { name: 'resume', description: 'Resume a conversation by ID or name', argumentHint: '[session]', aliases: ['continue'] },
  { name: 'rewind', description: 'Rewind the conversation and/or code to a previous point', argumentHint: '', aliases: ['checkpoint', 'undo'] },
  { name: 'sandbox', description: 'Toggle sandbox mode (where supported)', argumentHint: '' },
  { name: 'schedule', description: 'Create, update, list, or run routines', argumentHint: '[description]', aliases: ['routines'] },
  { name: 'skills', description: 'List available skills and toggle visibility', argumentHint: '' },
  { name: 'stats', description: 'Show session cost, plan usage, and activity stats', argumentHint: '' },
  { name: 'status', description: 'Open the Settings (Status tab): version, model, account, connectivity', argumentHint: '' },
  { name: 'statusline', description: "Configure Claude Code's status line", argumentHint: '' },
  { name: 'stickers', description: 'Order Claude Code stickers', argumentHint: '' },
  { name: 'tasks', description: 'List and manage background tasks', argumentHint: '', aliases: ['bashes'] },
  { name: 'team-onboarding', description: 'Generate a team onboarding guide from your usage history', argumentHint: '' },
  { name: 'theme', description: 'Change the color theme', argumentHint: '' },
  { name: 'tui', description: 'Set the terminal UI renderer (default or fullscreen)', argumentHint: '[default|fullscreen]' },
  { name: 'ultraplan', description: 'Draft a plan in an ultraplan session, review in browser, then execute', argumentHint: '<prompt>' },
  { name: 'ultrareview', description: 'Run a deep, multi-agent code review in a cloud sandbox', argumentHint: '[PR]' },
  { name: 'voice', description: 'Toggle voice dictation', argumentHint: '[hold|tap|off]' },
];

/**
 * Commands hidden from observer-mode autocomplete because they don't make
 * sense when invoked remotely from the phone. The user can still type the
 * command by hand if they really want to — this only filters the dropdown.
 *
 * Categories:
 *   - Local-only side effects: clipboard, native desktop app, terminal config
 *   - Cloud provider setup: Bedrock / Vertex auth wizards
 *   - Account / subscription / OAuth flows that open browsers
 *   - Local diagnostic dumps to ~/Desktop or interactive doctor flows
 *   - TUI-only modal commands: open a full-screen dialog whose content never
 *     reaches the JSONL stream — from the phone we'd only ever see "<X
 *     dialog dismissed>" after the daemon's PTY-injection ESC. Verified
 *     empirically on Claude Code 2.1.112 against ttys003 / b1d728bc.
 */
export const OBSERVER_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  // Local-only side effects
  'copy',
  'desktop', 'app',                   // /desktop alias /app
  'keybindings',
  'terminal-setup',

  // Cloud provider local setup
  'setup-bedrock',
  'setup-vertex',

  // Account / subscription / OAuth
  'passes',
  'upgrade',
  'extra-usage',
  'privacy-settings',
  'install-github-app',
  'install-slack-app',
  'web-setup',
  'teleport', 'tp',                   // /teleport alias /tp

  // Diagnostic / debug local dumps
  'heapdump',
  'doctor',
  'release-notes',

  // TUI-only modal commands (no JSONL payload, only "dialog dismissed")
  'help',
  'stats',
  'status',
  'memory',
  'diff',
  'skills',
  'hooks',
  'tasks', 'bashes',                  // /tasks alias /bashes
  'ide',
  'insights',
  'mobile', 'ios', 'android',         // /mobile aliases
]);

let cachedSdkCommands: SlashCommand[] | null = null;
let inflightFetch: Promise<SlashCommand[]> | null = null;

/**
 * Fetch the SDK's supportedCommands list, cached for the lifetime of the
 * daemon. Concurrent callers share a single in-flight promise so we only
 * spin up one ephemeral SDK query even if the first phone request fans out.
 *
 * Stale-cache risk: if the user installs a new plugin / writes a new
 * `~/.claude/commands/*.md` after this is cached, observer-mode autocomplete
 * won't show it until daemon restart. Acceptable trade-off vs. spinning up
 * an SDK subprocess on every observer `/` press.
 */
async function fetchSdkCommandsCached(): Promise<SlashCommand[]> {
  if (cachedSdkCommands) return cachedSdkCommands;
  if (inflightFetch) return inflightFetch;

  inflightFetch = (async () => {
    try {
      const q = query({
        prompt: (async function* () {
          yield { type: 'user' as const, message: { role: 'user' as const, content: 'noop' }, parent_tool_use_id: null };
        })(),
        options: { cwd: PREFETCH_CWD },
      });
      const list = await q.supportedCommands();
      cachedSdkCommands = list;
      logger.debug('observer-commands', `Cached ${list.length} SDK commands`);
      return list;
    } catch (err) {
      logger.warn('observer-commands', `Failed to fetch SDK supportedCommands: ${(err as Error).message}`);
      // Cache empty so we don't spin up a query on every retry — if the
      // SDK is broken the built-in list alone is still useful.
      cachedSdkCommands = [];
      return cachedSdkCommands;
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

/**
 * Assemble the observer-mode `/command` list: union of CLI built-ins and the
 * SDK-reported list (skills + plugins + user commands), with hidden commands
 * filtered out. Built-ins win on name conflict.
 */
export async function getObserverCommands(): Promise<SlashCommand[]> {
  const sdk = await fetchSdkCommandsCached();
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  const isHidden = (cmd: SlashCommand) =>
    OBSERVER_HIDDEN_COMMANDS.has(cmd.name) ||
    (cmd.aliases?.some(a => OBSERVER_HIDDEN_COMMANDS.has(a)) ?? false);
  for (const cmd of BUILTIN_TERMINAL_COMMANDS) {
    if (isHidden(cmd)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  for (const cmd of sdk) {
    if (seen.has(cmd.name)) continue;
    if (isHidden(cmd)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  return out;
}

/** Test hook: drop the cached list so the next call refetches. */
export function _resetObserverCommandsCacheForTest(): void {
  cachedSdkCommands = null;
  inflightFetch = null;
}

/** Test hook: seed the SDK cache so getObserverCommands() skips the real query. */
export function _seedSdkCommandsCacheForTest(commands: SlashCommand[]): void {
  cachedSdkCommands = commands;
  inflightFetch = null;
}
