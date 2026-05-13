// Agent Pocket — hook-server event-handler registrars
//
// First slice (Step 1.6a-i) of the wireHookServerEvents extraction: the
// self-contained handlers that don't touch the messageSeq counter, the
// blocking-request maps, or the async transcript reader. Each `register*`
// function takes the HookServer (narrowed to the surface it touches) plus
// just the deps it needs and registers a single `.on()` listener.
//
// Keeping the listeners as separate registrars (instead of one big
// `wireAll`) makes them individually unit-testable: a test can synthesise
// a tiny EventEmitter, call the registrar, emit one payload, and assert
// on the dep stubs without spinning up a real HookServer.
//
// The remaining handlers (codex_*, permission_expired, session_*,
// permission_dismissed, permission_prompt) stay inline in index.ts for
// now — they will follow in Steps 1.6a-ii / 1.6a-iii.

import type {
  HookServer,
  HookPermissionRequest,
  HookToolResult,
} from '../hooks/hook-server.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { RelayClient } from '../relay/relay-client.js';
import type { PcEvent } from 'agent-pocket-protocol';
import { logger } from '../logger.js';

/** Narrowed surface used by these handlers. */
export type HookGateway = Pick<
  HookServer,
  'on' | 'resolvePermissionEmpty'
>;

// ---------------------------------------------------------------------------
// permission_request — passthrough
// ---------------------------------------------------------------------------
//
// PreToolUse hooks exist only so PermissionRequest matching has a tool_use_id
// to correlate against. Resolve immediately with an empty body — actual
// permission decisions flow through the `permission_prompt` event.
export function registerPermissionRequestPassthrough(hooks: HookGateway): void {
  hooks.on('permission_request', (request: HookPermissionRequest) => {
    hooks.resolvePermissionEmpty(request.toolUseId);
  });
}

// ---------------------------------------------------------------------------
// tool_result
// ---------------------------------------------------------------------------

export interface ToolResultDeps {
  /** Phone preferences — read live so a toggle takes effect on the next event. */
  prefs: { showToolUse: boolean };
  sessionManager: Pick<SessionManager, 'findByClaudeSessionId'>;
  resolveExternalSessionId(internalId: string): string;
  sendToPhone(event: PcEvent): void;
}

export function registerToolResultHandler(
  hooks: HookGateway,
  deps: ToolResultDeps,
): void {
  hooks.on('tool_result', (result: HookToolResult) => {
    if (!deps.prefs.showToolUse) return;

    const session = deps.sessionManager.findByClaudeSessionId(result.sessionId);
    const externalId = session
      ? deps.resolveExternalSessionId(session.sessionId)
      : result.sessionId;

    const flat: Record<string, unknown> = {
      type: 'session_output',
      session_id: externalId,
      timestamp: Date.now(),
      output_type: 'tool_result',
      tool_use_id: result.toolUseId,
      output: typeof result.toolResponse === 'string'
        ? result.toolResponse
        : JSON.stringify(result.toolResponse ?? ''),
      is_error: false,
    };

    deps.sendToPhone(flat as unknown as PcEvent);
  });
}

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

export interface ErrorHandlerDeps {
  restartHookServer(): void;
}

export function registerErrorHandler(
  hooks: HookGateway,
  deps: ErrorHandlerDeps,
): void {
  hooks.on('error', (err: Error) => {
    logger.error('daemon', `Hook server error: ${err.message}`);
    deps.restartHookServer();
  });
}

// ---------------------------------------------------------------------------
// subagent_stop
// ---------------------------------------------------------------------------

export interface SubagentDeps {
  sessionManager: Pick<SessionManager, 'findByClaudeSessionId' | 'getAllSessions'>;
}

export function registerSubagentStopHandler(
  hooks: HookGateway,
  deps: SubagentDeps,
): void {
  hooks.on('subagent_stop', (claudeSessionId: string, agentId: string, agentType: string) => {
    logger.debug('daemon', `SubagentStop hook: session=${claudeSessionId}, agent=${agentId} (${agentType})`);
    const session = deps.sessionManager.findByClaudeSessionId(claudeSessionId);
    if (!session) {
      logger.warn('daemon', `SubagentStop: no session found for ${claudeSessionId} — falling back to broadcast`);
      // Parent session may not yet be tracked when subagent finishes very
      // fast; fan out to every observer so whoever owns this agent picks it up.
      for (const s of deps.sessionManager.getAllSessions()) {
        s.observer?.markSubagentDone(agentId);
      }
      return;
    }
    if (!session.observer) {
      logger.warn('daemon', `SubagentStop: session ${claudeSessionId} has no observer`);
      return;
    }
    session.observer.markSubagentDone(agentId);
  });
}

// ---------------------------------------------------------------------------
// subagent_start
// ---------------------------------------------------------------------------

export function registerSubagentStartHandler(
  hooks: HookGateway,
  deps: SubagentDeps,
): void {
  hooks.on('subagent_start', (claudeSessionId: string, agentId: string, agentType: string) => {
    logger.debug('daemon', `SubagentStart hook: session=${claudeSessionId}, agent=${agentId} (${agentType})`);
    const session = deps.sessionManager.findByClaudeSessionId(claudeSessionId);
    session?.observer?.markSubagentStart(agentId, agentType);
  });
}

// ---------------------------------------------------------------------------
// api_sessions / api_status — local CLI introspection
// ---------------------------------------------------------------------------

export interface ApiInspectionDeps {
  sessionManager: Pick<SessionManager, 'getAllSessions'>;
  /**
   * Read live each time the event fires — the relay client is constructed
   * after the daemon initialises but can also be torn down/replaced via the
   * connection-mode toggle, so we don't want to capture a snapshot here.
   */
  getRelayClient(): Pick<RelayClient, 'getConnectionState' | 'getPhonePeerOnline' | 'getOfflineQueueSize'> | null;
  /**
   * Build the unified merged session view (Phase 1+2+3+Codex+overlay).
   * `api_sessions` projects from this so that local CLI introspection
   * agrees with what the phone gets via `session_list`. Fallback path
   * when omitted: the legacy flat `sessionManager.getAllSessions()` map
   * (kept for tests + bring-up; production should always wire this).
   */
  getMergedSessionView?: () => Promise<ReadonlyArray<{ entry: Record<string, unknown> }>>;
}

export function registerApiSessionsHandler(
  hooks: HookGateway,
  deps: Pick<ApiInspectionDeps, 'sessionManager' | 'getMergedSessionView'>,
): void {
  hooks.on('api_sessions', async (respond: (sessions: unknown) => void) => {
    if (deps.getMergedSessionView) {
      try {
        const merged = await deps.getMergedSessionView();
        const sessions = merged.map(({ entry }) => ({
          sessionId: entry.session_id,
          status: entry.status,
          pid: entry.pid,
          cwd: entry.working_directory,
          isObserved: entry.is_observed ?? false,
          customTitle: entry.project_name,
          entrypoint: entry.entrypoint,
          lastActivity: entry.last_activity,
        }));
        respond(sessions);
        return;
      } catch (err) {
        logger.warn('daemon', `api_sessions: merged view failed, falling back to flat map: ${(err as Error).message}`);
      }
    }
    const sessions = deps.sessionManager.getAllSessions().map(s => ({
      sessionId: s.claudeSessionId ?? s.sessionId,
      status: s.status,
      pid: s.terminalPid,
      cwd: s.workingDirectory,
      isObserved: s.isObserved,
      customTitle: s.customTitle,
      entrypoint: s.entrypoint,
      lastActivity: s.lastActivity,
    }));
    respond(sessions);
  });
}

export function registerApiStatusHandler(
  hooks: HookGateway,
  deps: ApiInspectionDeps,
): void {
  hooks.on('api_status', (respond: (status: unknown) => void) => {
    const relay = deps.getRelayClient();
    respond({
      relay: relay?.getConnectionState() ?? 'not configured',
      phone: relay?.getPhonePeerOnline() ?? false,
      offlineQueue: relay?.getOfflineQueueSize() ?? 0,
      sessions: deps.sessionManager.getAllSessions().length,
    });
  });
}
