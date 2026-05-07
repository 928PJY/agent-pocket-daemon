// Agent Pocket — phone-response command handlers
//
// Handlers that route the phone's reply to a blocking request back to either
// the in-process HookServer (when the request originated from a hook on an
// observed terminal session) or to the SessionManager (when it came from the
// SDK).
//
// Extracted from AgentPocketDaemon as part of Step 1.4f.
//
// HookServer access is narrowed to the small `HookGateway` interface so tests
// don't have to instantiate a real hook server. Cross-cutting cleanup
// (untracking the blocking request, cancelling pending APNs deliveries) is
// passed in as `ResponseDeps` callbacks rather than inlined here, since the
// daemon owns that bookkeeping.

import type {
  PermissionResponseCommand,
  QuestionResponseCommand,
} from 'agent-pocket-protocol';
import { PermissionDecision } from 'agent-pocket-protocol';
import type { CommandContext } from '../command-context.js';
import type { CryptoVerifier } from './acks.js';
import { logger } from '../../logger.js';

/** Subset of HookServer the response handlers actually use. */
export interface HookGateway {
  hasPendingPermission(toolUseId: string): boolean;
  getPendingToolInput(toolUseId: string): Record<string, unknown> | undefined;
  getPendingToolName(toolUseId: string): string | undefined;
  getPendingPermissionSuggestions(toolUseId: string): unknown[] | undefined;
  resolvePermissionPrompt(
    toolUseId: string,
    decision: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: Array<Record<string, unknown>>,
  ): void;
}

/**
 * Cross-cutting cleanup the daemon performs when a blocking request resolves.
 * Passed in so the handler module doesn't need to know about
 * `pendingBlockingRequests` or `pendingNotificationDeliveries` directly.
 */
export interface ResponseDeps {
  untrackBlockingRequest(requestId: string): void;
  clearNotificationDelivery(eventType: string, sessionId: string, requestId: string): void;
}

// ---------------------------------------------------------------------------
// permission_response
// ---------------------------------------------------------------------------

export function handlePermissionResponse(
  ctx: Pick<CommandContext, 'sessionManager' | 'resolveInternalSessionId' | 'sendError'>,
  hooks: HookGateway,
  crypto: CryptoVerifier,
  deps: ResponseDeps,
  command: PermissionResponseCommand,
): void {
  logger.debug(
    'daemon',
    `handlePermissionResponse: request_id=${command.request_id}, decision=${command.decision}, hasPending=${hooks.hasPendingPermission(command.request_id)}`,
  );
  deps.untrackBlockingRequest(command.request_id);
  deps.clearNotificationDelivery('permission_request', command.session_id, command.request_id);
  deps.clearNotificationDelivery('plan_review', command.session_id, command.request_id);
  try {
    if (command.phone_signature && crypto.hasSessionKeys()) {
      const signaturePayload = JSON.stringify({
        session_id: command.session_id,
        request_id: command.request_id,
        decision: command.decision,
        seq: command.seq,
        timestamp: command.timestamp,
      });
      const valid = crypto.verifyPeer(signaturePayload, command.phone_signature);
      if (!valid) {
        ctx.sendError(command.request_id, 'Invalid permission response signature', 'SIGNATURE_INVALID');
        return;
      }
    }

    if (hooks.hasPendingPermission(command.request_id)) {
      const isManual = command.decision === PermissionDecision.APPROVE_MANUAL;
      const allowed = command.decision === PermissionDecision.APPROVE
        || command.decision === PermissionDecision.ALWAYS_ALLOW
        || isManual;

      const pendingToolInput = hooks.getPendingToolInput(command.request_id);
      const pendingToolName = hooks.getPendingToolName(command.request_id);

      logger.debug(
        'daemon',
        `Hook permission response for ${command.request_id}: tool=${pendingToolName}, decision=${command.decision}, isManual=${isManual}, allowed=${allowed}`,
      );

      if (pendingToolName === 'ExitPlanMode') {
        // ExitPlanMode is now handled at PermissionRequest stage, so we use
        // resolvePermissionPrompt which supports updatedPermissions.
        if (allowed) {
          const updatedPermissions = isManual ? undefined : [
            { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
          ];
          const planInput = pendingToolInput ?? {};
          const exitInput = isManual
            ? { ...planInput, allowedPrompts: [] }
            : planInput;

          hooks.resolvePermissionPrompt(command.request_id, 'allow', exitInput, updatedPermissions);
          logger.debug('daemon', `Resolved ExitPlanMode via PermissionRequest hook: ${isManual ? 'manual' : 'acceptEdits'}`);
        } else {
          hooks.resolvePermissionPrompt(command.request_id, 'deny');
          logger.debug('daemon', `Denied ExitPlanMode via PermissionRequest hook`);
        }
        return;
      }

      // All other tools: resolve via PermissionRequest hook format
      if (allowed && command.decision === PermissionDecision.ALWAYS_ALLOW) {
        // "Always Allow" — pass the permission suggestions so Claude Code
        // adds the rule.
        const suggestions = hooks.getPendingPermissionSuggestions(command.request_id);
        const updatedPermissions = Array.isArray(suggestions)
          ? suggestions as Array<Record<string, unknown>>
          : undefined;
        hooks.resolvePermissionPrompt(command.request_id, 'allow', undefined, updatedPermissions);
        logger.debug(
          'daemon',
          `Resolved PermissionRequest hook ${command.request_id} (${pendingToolName}): always_allow, updatedPermissions=${!!updatedPermissions}`,
        );
      } else {
        hooks.resolvePermissionPrompt(command.request_id, allowed ? 'allow' : 'deny');
        logger.debug(
          'daemon',
          `Resolved PermissionRequest hook ${command.request_id} (${pendingToolName}): ${allowed ? 'allow' : 'deny'}`,
        );
      }
      return;
    }

    // Otherwise, it's an SDK-based permission
    const internalId = ctx.resolveInternalSessionId(command.session_id) ?? command.session_id;

    if (command.decision === PermissionDecision.APPROVE_MANUAL) {
      // For approve_manual: approve but override allowedPrompts to empty
      ctx.sessionManager.respondPermission(
        internalId,
        command.request_id,
        PermissionDecision.APPROVE,
        { allowedPrompts: [] },
      );
    } else {
      ctx.sessionManager.respondPermission(internalId, command.request_id, command.decision);
    }
  } catch (err) {
    ctx.sendError(
      command.request_id,
      `Failed to respond to permission: ${(err as Error).message}`,
      'PERMISSION_RESPONSE_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// question_response
// ---------------------------------------------------------------------------

export function handleQuestionResponse(
  ctx: Pick<CommandContext, 'sessionManager' | 'resolveInternalSessionId' | 'sendError'>,
  hooks: HookGateway,
  deps: ResponseDeps,
  command: QuestionResponseCommand,
): void {
  deps.untrackBlockingRequest(command.request_id);
  deps.clearNotificationDelivery('user_question', command.session_id, command.request_id);
  try {
    // AskUserQuestion answers come back through the PermissionRequest hook system
    if (hooks.hasPendingPermission(command.request_id)) {
      const originalInput = hooks.getPendingToolInput(command.request_id) ?? {};
      hooks.resolvePermissionPrompt(
        command.request_id,
        'allow',
        { ...originalInput, answers: command.answers },
      );
      logger.debug(
        'daemon',
        `Resolved AskUserQuestion ${command.request_id} via PermissionRequest hook with answers: ${JSON.stringify(command.answers)}`,
      );
      return;
    }

    // For SDK-based sessions, approve with updatedInput containing answers
    const internalId = ctx.resolveInternalSessionId(command.session_id) ?? command.session_id;
    const session = ctx.sessionManager.getSession(internalId);
    const pending = session?.pendingPermissions.get(command.request_id);
    const originalInput = pending?.toolInput ?? {};
    ctx.sessionManager.respondPermission(
      internalId,
      command.request_id,
      PermissionDecision.APPROVE,
      { ...originalInput, answers: command.answers },
    );
    logger.debug('daemon', `Resolved SDK AskUserQuestion ${command.request_id}`);
  } catch (err) {
    ctx.sendError(
      command.request_id,
      `Failed to respond to question: ${(err as Error).message}`,
      'QUESTION_RESPONSE_ERROR',
    );
  }
}
