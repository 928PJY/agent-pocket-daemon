// Agent Pocket -- Hook Server
// HTTP server that receives Claude Code hook POSTs (PermissionRequest, PostToolUse).
// Holds the HTTP connection open for PermissionRequest until the phone responds,
// bridging async permission approval from the mobile app to Claude's blocking hook.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { formatTimestamp, logger } from '../logger.js';
import { HOOK_HOLD_TIMEOUT_MS } from 'agent-pocket-protocol';
import { PreToolUseCorrelator } from './pre-tool-use-correlator.js';
import { parseCodexHookRequest, type CodexHookRequest } from './codex-hook-parser.js';

export type { CodexHookRequest } from './codex-hook-parser.js';

const DEBUG_LOG = path.join(os.homedir(), '.agent-pocket', 'hook-debug.log');

function debugLog(msg: string): void {
  const line = `[${formatTimestamp()}] ${msg}\n`;
  try { fs.appendFileSync(DEBUG_LOG, line); } catch { /* ignore */ }
}

// ============================================================================
// Types
// ============================================================================

export interface HookPermissionRequest {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  transcriptPath: string;
  permissionSuggestions?: unknown[];
}

export interface HookToolResult {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse: unknown;
  cwd: string;
}

interface PendingPermission {
  resolve: (body: string) => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
  sessionId: string;
  toolInput?: Record<string, unknown>;
  permissionSuggestions?: unknown[];
}

export interface HookPermissionPrompt {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  permissionSuggestions?: unknown[];
}

export interface HookPermissionExpired {
  sessionId: string;
  toolUseId: string;
  toolName: string;
}

export interface HookServerEvents {
  permission_request: [request: HookPermissionRequest];
  permission_prompt: [request: HookPermissionPrompt];
  permission_expired: [expired: HookPermissionExpired];
  permission_dismissed: [toolUseId: string, toolName: string, sessionId: string, toolResponse?: unknown];
  tool_result: [result: HookToolResult];
  session_start: [sessionId: string, source: string, cwd: string, transcriptPath: string];
  session_end: [sessionId: string, reason: string, cwd: string, transcriptPath: string];
  subagent_start: [sessionId: string, agentId: string, agentType: string, transcriptPath: string];
  subagent_stop: [sessionId: string, agentId: string, agentType: string, transcriptPath: string];
  codex_session_start: [request: CodexHookRequest];
  codex_user_prompt_submit: [request: CodexHookRequest];
  codex_permission_request: [request: CodexHookRequest];
  codex_stop: [request: CodexHookRequest];
  error: [error: Error];
}

// ============================================================================
// HookServer
// ============================================================================

export class HookServer extends EventEmitter {
  private server: http.Server | null = null;
  private port: number;
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  // Map PreToolUse tool_use_id → PermissionRequest hook_id for correlation
  private toolUseToHookId: Map<string, string> = new Map();
  // FIFO PreToolUse tool_use_id queue per session+toolName (for PermissionRequest correlation)
  private preToolUseCorrelator = new PreToolUseCorrelator({ ttlMs: HOOK_HOLD_TIMEOUT_MS });
  private hookCounter: number = 0;
  private readonly DEFAULT_TIMEOUT_MS = HOOK_HOLD_TIMEOUT_MS;
  // When set, returns true if the given Claude session id is daemon-controlled
  // (SDK canUseTool is the authoritative permission path). Hook-driven
  // PreToolUse/PermissionRequest must short-circuit for these sessions —
  // otherwise the same AskUserQuestion / permission shows up twice on the
  // phone (once from SDK, once from the hook) under different request_ids.
  private isControllerSession?: (claudeSessionId: string) => boolean;

  constructor(port: number = 0) {
    super();
    this.port = port;
  }

  /**
   * Inject a predicate that identifies controller-mode (SDK-driven) sessions.
   * Hook-channel permission events are dropped for matching sessions.
   */
  setControllerSessionPredicate(fn: (claudeSessionId: string) => boolean): void {
    this.isControllerSession = fn;
  }

  /**
   * Start the HTTP server. Returns the actual port (useful when port=0).
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        logger.error('hook', `Server error: ${err.message}`);
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        logger.info('hook', `Listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  /**
   * Stop the HTTP server and deny all pending permissions.
   */
  async stop(): Promise<void> {
    // Return no-op for all pending permissions so Claude falls back to normal flow
    for (const [id, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve('{}');
    }
    this.pendingPermissions.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the port the server is listening on.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Resolve a pending permission request with empty response (fall through).
   * Used when we want a PreToolUse hook to not interfere with the normal flow.
   */
  resolvePermissionEmpty(toolUseId: string): boolean {
    const pending = this.pendingPermissions.get(toolUseId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(toolUseId);

    pending.resolve('{}');
    return true;
  }

  /**
   * Resolve a pending permission request (called when phone responds).
   */
  resolvePermission(
    toolUseId: string,
    decision: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
  ): boolean {
    const pending = this.pendingPermissions.get(toolUseId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(toolUseId);

    let response: string;
    if (decision === 'allow') {
      response = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          ...(updatedInput ? { updatedInput } : {}),
        },
      });
    } else {
      response = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Denied by phone',
        },
      });
    }

    logger.debug('hook', `resolvePermission ${toolUseId}: decision=${decision}, tool=${pending.toolName}, hasUpdatedInput=${!!updatedInput}, response=${response.substring(0, 500)}`);
    logger.info('hook', `Permission resolved`, { toolUseId, tool: pending.toolName, decision });
    pending.resolve(response);
    return true;
  }

  /**
   * Resolve a pending AskUserQuestion with user-selected answers.
   * Returns updatedInput with the answers field so Claude Code skips the interactive prompt.
   */
  resolveQuestion(
    toolUseId: string,
    originalInput: Record<string, unknown>,
    answers: Record<string, string>,
  ): boolean {
    const pending = this.pendingPermissions.get(toolUseId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(toolUseId);

    const response = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...originalInput,
          answers,
        },
      },
    });

    pending.resolve(response);
    return true;
  }

  /**
   * Resolve a pending PermissionRequest hook with allow/deny and optional updatedPermissions.
   * Used for ExitPlanMode to set permission mode to acceptEdits.
   */
  resolvePermissionPrompt(
    toolUseId: string,
    decision: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: Array<Record<string, unknown>>,
  ): boolean {
    const pending = this.pendingPermissions.get(toolUseId);
    debugLog(`resolvePermissionPrompt called: toolUseId=${toolUseId}, decision=${decision}, hasPending=${!!pending}`);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(toolUseId);

    let response: string;
    if (decision === 'allow') {
      response = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            ...(updatedInput ? { updatedInput } : {}),
            ...(updatedPermissions ? { updatedPermissions } : {}),
          },
        },
      });
    } else {
      response = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: 'Denied by phone',
          },
        },
      });
    }

    logger.debug('hook', `resolvePermissionPrompt ${toolUseId}: decision=${decision}, response=${response.substring(0, 500)}`);
    logger.info('hook', 'PermissionPrompt resolved', { toolUseId, tool: pending.toolName, decision });
    pending.resolve(response);
    return true;
  }

  /**
   * Check if a permission request is pending for a given tool use ID.
   */
  hasPendingPermission(toolUseId: string): boolean {
    return this.pendingPermissions.has(toolUseId);
  }

  /**
   * Get the stored tool input for a pending request (used for AskUserQuestion answers).
   */
  getPendingToolInput(toolUseId: string): Record<string, unknown> | undefined {
    return this.pendingPermissions.get(toolUseId)?.toolInput;
  }

  /**
   * Get the tool name for a pending request.
   */
  getPendingToolName(toolUseId: string): string | undefined {
    return this.pendingPermissions.get(toolUseId)?.toolName;
  }

  /**
   * Get the permission suggestions for a pending request (for "Always Allow").
   */
  getPendingPermissionSuggestions(toolUseId: string): unknown[] | undefined {
    return this.pendingPermissions.get(toolUseId)?.permissionSuggestions;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    const method = req.method ?? '';

    debugLog(`Incoming ${method} ${url}`);
    logger.trace('hook', `RX ${method} ${url}`);

    // GET endpoints (local API for CLI commands)
    if (method === 'GET' && url === '/api/sessions') {
      this.emit('api_sessions', (sessions: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessions));
      });
      return;
    }

    if (method === 'GET' && url === '/api/status') {
      this.emit('api_status', (status: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      });
      return;
    }

    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        debugLog(`${url} body: ${body.substring(0, 500)}`);
        const json = JSON.parse(body) as Record<string, unknown>;

        if (url === '/hooks/permission-request') {
          this.handlePermissionRequestHook(json, res);
        } else if (url === '/hooks/permission-prompt') {
          debugLog(`Routing to handlePermissionPromptHook, tool_name=${json.tool_name}`);
          this.handlePermissionPromptHook(json, res);
        } else if (url === '/hooks/post-tool-use') {
          this.handlePostToolUseHook(json, res);
        } else if (url === '/hooks/stop') {
          this.handleStopHook(json, res);
        } else if (url === '/hooks/stop-failure') {
          this.handleStopFailureHook(json, res);
        } else if (url === '/hooks/session-start') {
          this.handleSessionStartHook(json, res);
        } else if (url === '/hooks/session-end') {
          this.handleSessionEndHook(json, res);
        } else if (url === '/hooks/subagent-stop') {
          this.handleSubagentStopHook(json, res);
        } else if (url === '/hooks/subagent-start') {
          this.handleSubagentStartHook(json, res);
        } else if (url === '/hooks/codex/session-start') {
          this.handleCodexInformationalHook(json, res, 'codex_session_start');
        } else if (url === '/hooks/codex/user-prompt-submit') {
          this.handleCodexInformationalHook(json, res, 'codex_user_prompt_submit');
        } else if (url === '/hooks/codex/stop') {
          this.handleCodexInformationalHook(json, res, 'codex_stop');
        } else if (url === '/hooks/codex/permission-request') {
          this.handleCodexPermissionRequestHook(json, res);
        } else {
          debugLog(`Unknown URL: ${url}`);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      } catch (err) {
        debugLog(`Parse error: ${err}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handlePermissionRequestHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const toolUseId = json.tool_use_id as string ?? `hook_${Date.now()}`;
    const sessionId = json.session_id as string ?? '';
    const toolName = json.tool_name as string ?? 'unknown';

    // Controller-mode (SDK-driven) sessions handle permissions through the
    // SDK canUseTool channel. The hook still fires because Claude loads user
    // settings.local.json regardless — drop it here so we don't double-forward
    // the same request to the phone under a different request_id.
    if (sessionId && this.isControllerSession?.(sessionId)) {
      debugLog(`PreToolUse hook dropped (controller-mode session ${sessionId}, tool ${toolName})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    // Store correlation: PreToolUse tool_use_id for later PermissionRequest matching
    if (json.tool_use_id) {
      const key = `${sessionId}:${toolName}`;
      this.preToolUseCorrelator.enqueue(key, toolUseId, (json.tool_input as Record<string, unknown>) ?? {});
    }

    const request: HookPermissionRequest = {
      sessionId,
      toolUseId,
      toolName,
      toolInput: (json.tool_input as Record<string, unknown>) ?? {},
      cwd: json.cwd as string ?? '',
      transcriptPath: json.transcript_path as string ?? '',
      permissionSuggestions: json.permission_suggestions as unknown[] | undefined,
    };

    // AskUserQuestion: hold the connection open so the phone can provide answers
    // via updatedInput. Emit the event so the daemon forwards the question to the phone.
    if (request.toolName === 'AskUserQuestion') {
      const timer = setTimeout(() => {
        // Timeout — let Claude show the question in the terminal instead
        const expired = this.pendingPermissions.get(toolUseId);
        this.pendingPermissions.delete(toolUseId);
        if (expired) {
          this.emit('permission_expired', {
            sessionId: request.sessionId,
            toolUseId,
            toolName: request.toolName,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }, this.DEFAULT_TIMEOUT_MS);

      this.pendingPermissions.set(toolUseId, {
        resolve: (responseBody: string) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(responseBody);
        },
        timer,
        toolName: request.toolName,
        sessionId: request.sessionId,
        toolInput: request.toolInput,
        });

      const onCloseAsk = (): void => {
        if (this.pendingPermissions.has(toolUseId)) {
          clearTimeout(timer);
          this.pendingPermissions.delete(toolUseId);
          logger.warn('hook', 'AskUserQuestion connection closed before phone response', { toolUseId });
          this.emit('permission_expired', {
            sessionId: request.sessionId,
            toolUseId,
            toolName: request.toolName,
          });
        }
      };
      res.on('close', onCloseAsk);

      this.emit('permission_request', request);
      return;
    }

    // Hold the HTTP connection open until the phone responds
    const permTimer = setTimeout(() => {
      // No phone response — emit expiry event and return empty JSON
      const expired = this.pendingPermissions.get(toolUseId);
      this.pendingPermissions.delete(toolUseId);
      if (expired) {
        this.emit('permission_expired', {
          sessionId: request.sessionId,
          toolUseId,
          toolName: request.toolName,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }, this.DEFAULT_TIMEOUT_MS);

    this.pendingPermissions.set(toolUseId, {
      resolve: (responseBody: string) => {
        logger.debug('hook', `Sending HTTP response for ${toolUseId} (${request.toolName}): ${responseBody.substring(0, 300)}`);
        logger.trace('hook', 'TX permission response', { toolUseId, tool: request.toolName });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      },
      timer: permTimer,
      toolName: request.toolName,
      sessionId: request.sessionId,
      toolInput: request.toolInput,
    });

    // If Claude Code aborts the HTTP connection before the phone responds,
    // keep the phone card as expired instead of dismissing it silently.
    // PostToolUse remains the authoritative signal that terminal-side action
    // actually completed and should remove the card.
    const onClose = (): void => {
      if (this.pendingPermissions.has(toolUseId)) {
        clearTimeout(permTimer);
        this.pendingPermissions.delete(toolUseId);
        logger.warn('hook', 'PreToolUse connection closed before phone response', { toolUseId, tool: request.toolName });
        this.emit('permission_expired', {
          sessionId: request.sessionId,
          toolUseId,
          toolName: request.toolName,
        });
      }
    };
    res.on('close', onClose);

    logger.debug('hook', `Stored pending permission: ${toolUseId} (${request.toolName}), toolInput keys: ${Object.keys(request.toolInput).join(', ')}`);
    logger.debug('hook', 'Pending permission request', { toolUseId, tool: request.toolName, sessionId: request.sessionId });

    // Emit event for the daemon to forward to phone
    this.emit('permission_request', request);
  }

  private handlePermissionPromptHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const hookId = `hook_${Date.now()}_${++this.hookCounter}`;
    const sessionId = json.session_id as string ?? '';
    const toolName = json.tool_name as string ?? 'unknown';

    // Controller-mode (SDK-driven) sessions: SDK canUseTool already routed
    // this same permission to the phone. Drop the hook copy so iOS doesn't
    // see the question/permission card twice under different request_ids.
    if (sessionId && this.isControllerSession?.(sessionId)) {
      debugLog(`PermissionRequest hook dropped (controller-mode session ${sessionId}, tool ${toolName})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    // Correlate with the PreToolUse tool_use_id that fired just before this
    const preToolKey = `${sessionId}:${toolName}`;
    const preToolUseId = typeof json.tool_use_id === 'string'
      ? this.preToolUseCorrelator.remove(preToolKey, json.tool_use_id) ?? json.tool_use_id
      : this.preToolUseCorrelator.shift(preToolKey, (json.tool_input as Record<string, unknown>) ?? {});
    // Prefer the Claude tool_use_id as the wire request_id so live events and
    // JSONL history replay carry the same identity — otherwise iOS sees the
    // same logical card under two different ids and renders it twice.
    const requestId = preToolUseId ?? hookId;
    if (preToolUseId) {
      this.toolUseToHookId.set(preToolUseId, requestId);
    }

    const request: HookPermissionPrompt = {
      sessionId,
      toolUseId: requestId,
      toolName,
      toolInput: (json.tool_input as Record<string, unknown>) ?? {},
      cwd: json.cwd as string ?? '',
      permissionSuggestions: json.permission_suggestions as unknown[] | undefined,
    };

    debugLog(`PermissionRequest hook for ${request.toolName} (${requestId})${preToolUseId ? '' : ' [no PreToolUse correlation]'}`);
    logger.debug('hook', `PermissionRequest hook for ${request.toolName} (${requestId})`);
    logger.debug('hook', 'PermissionRequest hook received', { requestId, tool: request.toolName, sessionId, preToolUseId });

    // Hold the HTTP connection open until the daemon resolves it
    const timer = setTimeout(() => {
      const expired = this.pendingPermissions.get(requestId);
      this.pendingPermissions.delete(requestId);
      if (expired) {
        this.emit('permission_expired', {
          sessionId: request.sessionId,
          toolUseId: requestId,
          toolName: request.toolName,
        });
      }
      debugLog(`PermissionRequest timeout for ${requestId} (${request.toolName})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      // Don't emit permission_dismissed here — wait for PostToolUse when terminal user acts.
    }, this.DEFAULT_TIMEOUT_MS);

    this.pendingPermissions.set(requestId, {
      resolve: (responseBody: string) => {
        debugLog(`Sending PermissionRequest response for ${requestId}: ${responseBody.substring(0, 300)}`);
        logger.debug('hook', `Sending PermissionRequest response for ${requestId}: ${responseBody.substring(0, 300)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      },
      timer,
      toolName: request.toolName,
      sessionId: request.sessionId,
      toolInput: request.toolInput,
      permissionSuggestions: request.permissionSuggestions,
    });

    // Detect when Claude Code aborts the HTTP connection before the phone
    // responds. Do not dismiss the phone card here: close can race with APNs
    // wake and app launch, so PostToolUse is the reliable terminal-completed
    // signal that should remove the request.
    const onClose = (): void => {
      if (this.pendingPermissions.has(requestId)) {
        clearTimeout(timer);
        this.pendingPermissions.delete(requestId);
        debugLog(`Connection closed for ${requestId} (${request.toolName}) before phone response`);
        logger.debug('hook', `Connection closed for ${requestId} (${request.toolName}) before phone response`);
        logger.warn('hook', 'PermissionRequest connection closed before phone response', { requestId, tool: request.toolName });
        this.emit('permission_expired', {
          sessionId: request.sessionId,
          toolUseId: requestId,
          toolName: request.toolName,
        });
      }
    };
    res.on('close', onClose);

    this.emit('permission_prompt', request);
  }

  private handlePostToolUseHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const result: HookToolResult = {
      sessionId: json.session_id as string ?? '',
      toolUseId: json.tool_use_id as string ?? '',
      toolName: json.tool_name as string ?? 'unknown',
      toolInput: (json.tool_input as Record<string, unknown>) ?? {},
      toolResponse: json.tool_response,
      cwd: json.cwd as string ?? '',
    };

    // PostToolUse means the tool already executed — the permission was resolved
    // (either by terminal or phone). Dismiss any stale pending permissions for this tool.
    // We match by tool_use_id via the correlation map set in PreToolUse.
    const requestId = this.toolUseToHookId.get(result.toolUseId);
    if (requestId) {
      const pending = this.pendingPermissions.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPermissions.delete(requestId);
        try { pending.resolve('{}'); } catch { /* connection may already be closed */ }
      }
      this.toolUseToHookId.delete(result.toolUseId);
      const sessionId = pending?.sessionId ?? result.sessionId;
      debugLog(`PostToolUse dismissed ${requestId} (${result.toolName}), pending=${!!pending}`);
      this.emit('permission_dismissed', requestId, result.toolName, sessionId, result.toolResponse);
    }

    // Emit and respond immediately (PostToolUse is informational)
    this.emit('tool_result', result);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private handleStopHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const sessionId = json.session_id as string ?? '';
    const transcriptPath = (json.transcript_path as string) ?? '';
    debugLog(`Stop hook fired for session ${sessionId}`);
    this.emit('session_stop', sessionId, transcriptPath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private handleStopFailureHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const sessionId = json.session_id as string ?? '';
    const error = (json.error as string) ?? (json.error_details as string) ?? 'unknown';
    debugLog(`StopFailure hook fired for session ${sessionId}: ${error}`);
    logger.warn('hook', 'StopFailure', { sessionId, error });
    this.emit('session_stop_failure', sessionId, error);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private handleSessionStartHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const sessionId = json.session_id as string ?? '';
    const source = json.source as string ?? '';
    const cwd = json.cwd as string ?? '';
    const transcriptPath = json.transcript_path as string ?? '';
    debugLog(`SessionStart hook fired: session=${sessionId}, source=${source}`);
    logger.debug('hook', `SessionStart: session=${sessionId}, source=${source}`);
    logger.info('hook', 'SessionStart hook', { sessionId, source });
    this.emit('session_start', sessionId, source, cwd, transcriptPath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private handleSessionEndHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const sessionId = json.session_id as string ?? '';
    const reason = json.reason as string ?? '';
    const cwd = json.cwd as string ?? '';
    const transcriptPath = json.transcript_path as string ?? '';
    debugLog(`SessionEnd hook fired: session=${sessionId}, reason=${reason}`);
    logger.debug('hook', `SessionEnd: session=${sessionId}, reason=${reason}`);
    logger.info('hook', 'SessionEnd hook', { sessionId, reason });
    this.emit('session_end', sessionId, reason, cwd, transcriptPath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private handleSubagentStopHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const sessionId = (json.session_id as string) ?? '';
    const agentId = (json.agent_id as string) ?? '';
    const agentType = (json.agent_type as string) ?? '';
    const transcriptPath = (json.transcript_path as string) ?? '';
    debugLog(`SubagentStop hook fired: session=${sessionId}, agent=${agentId}`);
    this.emit('subagent_stop', sessionId, agentId, agentType, transcriptPath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private handleSubagentStartHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const sessionId = (json.session_id as string) ?? '';
    const agentId = (json.agent_id as string) ?? '';
    const agentType = (json.agent_type as string) ?? '';
    const transcriptPath = (json.transcript_path as string) ?? '';
    debugLog(`SubagentStart hook fired: session=${sessionId}, agent=${agentId} (${agentType})`);
    this.emit('subagent_start', sessionId, agentId, agentType, transcriptPath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private handleCodexInformationalHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
    eventName: 'codex_session_start' | 'codex_user_prompt_submit' | 'codex_stop',
  ): void {
    const request = parseCodexHookRequest(json);
    if (!request.sessionId) {
      logger.warn('hook', 'Rejected Codex hook without session id', { eventName, hookEventName: request.hookEventName });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"missing session id"}');
      return;
    }
    debugLog(`Codex ${request.hookEventName} hook fired: session=${request.sessionId}`);
    logger.debug('hook', 'Codex hook', { eventName, sessionId: request.sessionId, hookEventName: request.hookEventName });
    this.emit(eventName, request);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private handleCodexPermissionRequestHook(
    json: Record<string, unknown>,
    res: http.ServerResponse,
  ): void {
    const request = parseCodexHookRequest(json);
    if (!request.sessionId) {
      logger.warn('hook', 'Rejected Codex PermissionRequest without session id', { hookEventName: request.hookEventName });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"missing session id"}');
      return;
    }
    const toolUseId = request.toolUseId ?? `codex_hook_${Date.now()}`;
    const toolName = request.toolName ?? 'unknown';

    const timer = setTimeout(() => {
      const expired = this.pendingPermissions.get(toolUseId);
      this.pendingPermissions.delete(toolUseId);
      if (expired) {
        this.emit('permission_expired', {
          sessionId: request.sessionId,
          toolUseId,
          toolName,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }, this.DEFAULT_TIMEOUT_MS);

    this.pendingPermissions.set(toolUseId, {
      resolve: (responseBody: string) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      },
      timer,
      toolName,
      sessionId: request.sessionId,
      toolInput: request.toolInput ?? {},
    });

    res.on('close', () => {
      if (!this.pendingPermissions.has(toolUseId)) return;
      clearTimeout(timer);
      this.pendingPermissions.delete(toolUseId);
      logger.warn('hook', 'Codex PermissionRequest connection closed', { toolUseId, tool: toolName });
      this.emit('permission_dismissed', toolUseId, toolName, request.sessionId);
    });

    this.emit('codex_permission_request', { ...request, toolUseId, toolName });
  }
}
