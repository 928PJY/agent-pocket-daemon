// Agent Pocket — Path utilities for SessionManager (Step 2.4b)
//
// Extracted from session-manager.ts. Three pure-ish helpers:
//   - resolveClaudeExecutable: pick the `claude` binary the SDK should spawn
//   - expandPath: shell-style ~/$VAR/${VAR} expansion + normalization
//   - assertWorkingDirectoryExists: clear ENOENT before the SDK swallows it

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Decide which `claude` binary the SDK should spawn. Order:
 *   1. AGENT_POCKET_CLAUDE_PATH env override
 *   2. `claude` on PATH (typically the user's native installer at ~/.local/bin/claude)
 *   3. undefined — let the SDK fall back to its bundled platform binary
 *
 * PATH search walks $PATH directly (no shell exec) for safety + speed.
 */
export function resolveClaudeExecutable(): string | undefined {
  const override = process.env.AGENT_POCKET_CLAUDE_PATH;
  if (override && fs.existsSync(override)) return override;

  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ENOENT — keep searching.
    }
  }

  return undefined;
}

/**
 * Expand shell-style path tokens that the daemon (Node.js) does not handle
 * natively but users typing on the phone reasonably expect to work:
 *   - leading `~` or `~/...`  -> $HOME/...
 *   - `$VAR` and `${VAR}`     -> process.env.VAR (left as-is if unset)
 * Also normalizes the result so `..` segments collapse.
 */
export function expandPath(input: string): string {
  let out = input;
  if (out === '~') {
    out = os.homedir();
  } else if (out.startsWith('~/')) {
    out = path.join(os.homedir(), out.slice(2));
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? '';
    const value = process.env[name];
    return value ?? match;
  });
  return path.normalize(out);
}

/**
 * Verify a session's working directory exists and is a directory before we
 * hand it to the SDK as `cwd`. Without this check the SDK's `query()` spawn
 * fails with `ENOENT`, which the SDK reports as "Claude Code native binary
 * not found" — completely misleading. See agent-pocket#224.
 */
export function assertWorkingDirectoryExists(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`Working directory does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${dir}`);
  }
}
