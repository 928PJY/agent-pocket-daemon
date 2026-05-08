// Agent Pocket — top-level hook-server event wiring (Step 1.10)
//
// Extracted from wireHookServerEvents + wirePermissionPromptEvents in
// src/index.ts. Both methods only call the per-handler register* factories
// already defined in hook-handlers*.ts. Co-locating their wiring in one
// place keeps the daemon constructor short and gives a single test seam
// (registrarsFn) for asserting the full registration set.
//
// The deps interface is the union of every per-registrar deps interface,
// so callers can pass a single bag instead of 12 nested ones. Tests can
// override `registrars` to swap any subset of registrar functions.

import type { HookServer } from '../hooks/hook-server.js';
import {
  registerPermissionRequestPassthrough,
  registerToolResultHandler,
  registerErrorHandler,
  registerSubagentStartHandler,
  registerSubagentStopHandler,
  registerApiSessionsHandler,
  registerApiStatusHandler,
  type ToolResultDeps,
  type ErrorHandlerDeps,
  type SubagentDeps,
  type ApiInspectionDeps,
} from './hook-handlers.js';
import {
  registerPermissionExpiredHandler,
  registerCodexSessionStartHandler,
  registerCodexUserPromptSubmitHandler,
  registerCodexStopHandler,
  registerCodexPermissionRequestHandler,
  type PermissionExpiredDeps,
  type CodexSessionStartDeps,
  type CodexHandlerDeps,
  type CodexStopDeps,
  type CodexPermissionRequestDeps,
} from './hook-handlers-codex.js';
import {
  registerSessionStopHandler,
  registerSessionStopFailureHandler,
  registerSessionEndHandler,
  registerSessionStartHandler,
  registerPermissionDismissedHandler,
  registerPermissionPromptHandler,
  type SessionStopDeps,
  type SessionStopFailureDeps,
  type SessionEndDeps,
  type SessionStartDeps,
  type PermissionDismissedDeps,
  type PermissionPromptDeps,
} from './hook-handlers-lifecycle.js';

/**
 * Bundle of every dep needed by the registrars `wireHookServer` invokes.
 * Splitting into per-handler interfaces here would force callers to
 * reconstruct the same closures 12 times — instead the daemon passes one
 * bag and we hand each registrar the slice it needs.
 */
export interface WireHookServerDeps {
  toolResult: ToolResultDeps;
  error: ErrorHandlerDeps;
  permissionExpired: PermissionExpiredDeps;
  codexSessionStart: CodexSessionStartDeps;
  codexUserPromptSubmit: CodexHandlerDeps;
  codexStop: CodexStopDeps;
  codexPermissionRequest: CodexPermissionRequestDeps;
  apiSessions: ApiInspectionDeps;
  apiStatus: ApiInspectionDeps;
  sessionStop: SessionStopDeps;
  sessionStopFailure: SessionStopFailureDeps;
  sessionEnd: SessionEndDeps;
  subagent: SubagentDeps;
  sessionStart: SessionStartDeps;
  permissionDismissed: PermissionDismissedDeps;
  permissionPrompt: PermissionPromptDeps;
}

/**
 * Optional registrar overrides — tests inject stubs to assert each
 * registrar receives the right `(hookServer, deps)` pair without standing
 * up real handler wiring.
 */
export interface WireHookServerRegistrars {
  registerPermissionRequestPassthrough: typeof registerPermissionRequestPassthrough;
  registerToolResultHandler: typeof registerToolResultHandler;
  registerErrorHandler: typeof registerErrorHandler;
  registerPermissionExpiredHandler: typeof registerPermissionExpiredHandler;
  registerCodexSessionStartHandler: typeof registerCodexSessionStartHandler;
  registerCodexUserPromptSubmitHandler: typeof registerCodexUserPromptSubmitHandler;
  registerCodexStopHandler: typeof registerCodexStopHandler;
  registerCodexPermissionRequestHandler: typeof registerCodexPermissionRequestHandler;
  registerApiSessionsHandler: typeof registerApiSessionsHandler;
  registerApiStatusHandler: typeof registerApiStatusHandler;
  registerSessionStopHandler: typeof registerSessionStopHandler;
  registerSessionStopFailureHandler: typeof registerSessionStopFailureHandler;
  registerSessionEndHandler: typeof registerSessionEndHandler;
  registerSubagentStopHandler: typeof registerSubagentStopHandler;
  registerSubagentStartHandler: typeof registerSubagentStartHandler;
  registerSessionStartHandler: typeof registerSessionStartHandler;
  registerPermissionDismissedHandler: typeof registerPermissionDismissedHandler;
  registerPermissionPromptHandler: typeof registerPermissionPromptHandler;
}

const DEFAULT_REGISTRARS: WireHookServerRegistrars = {
  registerPermissionRequestPassthrough,
  registerToolResultHandler,
  registerErrorHandler,
  registerPermissionExpiredHandler,
  registerCodexSessionStartHandler,
  registerCodexUserPromptSubmitHandler,
  registerCodexStopHandler,
  registerCodexPermissionRequestHandler,
  registerApiSessionsHandler,
  registerApiStatusHandler,
  registerSessionStopHandler,
  registerSessionStopFailureHandler,
  registerSessionEndHandler,
  registerSubagentStopHandler,
  registerSubagentStartHandler,
  registerSessionStartHandler,
  registerPermissionDismissedHandler,
  registerPermissionPromptHandler,
};

export function wireHookServer(
  hookServer: HookServer,
  deps: WireHookServerDeps,
  registrars: Partial<WireHookServerRegistrars> = {},
): void {
  const r = { ...DEFAULT_REGISTRARS, ...registrars };

  r.registerPermissionRequestPassthrough(hookServer);
  r.registerToolResultHandler(hookServer, deps.toolResult);
  r.registerErrorHandler(hookServer, deps.error);
  r.registerPermissionExpiredHandler(hookServer, deps.permissionExpired);
  r.registerCodexSessionStartHandler(hookServer, deps.codexSessionStart);
  r.registerCodexUserPromptSubmitHandler(hookServer, deps.codexUserPromptSubmit);
  r.registerCodexStopHandler(hookServer, deps.codexStop);
  r.registerCodexPermissionRequestHandler(hookServer, deps.codexPermissionRequest);
  r.registerApiSessionsHandler(hookServer, deps.apiSessions);
  r.registerApiStatusHandler(hookServer, deps.apiStatus);
  r.registerSessionStopHandler(hookServer, deps.sessionStop);
  r.registerSessionStopFailureHandler(hookServer, deps.sessionStopFailure);
  r.registerSessionEndHandler(hookServer, deps.sessionEnd);
  r.registerSubagentStopHandler(hookServer, deps.subagent);
  r.registerSubagentStartHandler(hookServer, deps.subagent);
  r.registerSessionStartHandler(hookServer, deps.sessionStart);
  r.registerPermissionDismissedHandler(hookServer, deps.permissionDismissed);
  r.registerPermissionPromptHandler(hookServer, deps.permissionPrompt);
}
