// Agent Pocket — runtime-config command handlers
//
// Per-session knobs the phone can twiddle: permission mode and active model.
// Extracted from AgentPocketDaemon as part of Step 1.4d.
//
// Both handlers share the same shape:
//   1. Reject Codex sessions with NOT_SUPPORTED.
//   2. Resolve external -> internal id.
//   3. Call sessionManager.
//   4. Emit `command_ack` on success; map a `not_supported` error message
//      prefix to NOT_SUPPORTED, anything else to a handler-specific code.

import type {
  PcEvent,
  SetPermissionModeCommand,
  SetModelCommand,
} from 'agent-pocket-protocol';
import type { CommandContext } from '../command-context.js';
import { isCodexSessionId } from '../../discovery/codex-discovery.js';

type SetCtx = Pick<
  CommandContext,
  'sessionManager' | 'resolveInternalSessionId' | 'sendToPhone' | 'sendError'
>;

export async function handleSetPermissionMode(
  ctx: SetCtx,
  command: SetPermissionModeCommand,
): Promise<void> {
  if (isCodexSessionId(command.session_id)) {
    ctx.sendError(command.request_id, 'set_permission_mode is not supported for Codex sessions', 'NOT_SUPPORTED');
    return;
  }
  try {
    const internalId = ctx.resolveInternalSessionId(command.session_id) ?? command.session_id;
    await ctx.sessionManager.setPermissionMode(internalId, command.mode);
    ctx.sendToPhone({
      type: 'command_ack',
      request_id: command.request_id,
      session_id: command.session_id,
      command: 'set_permission_mode',
    } as unknown as PcEvent);
  } catch (err) {
    const message = (err as Error).message;
    const code = message.startsWith('not_supported') ? 'NOT_SUPPORTED' : 'SET_PERMISSION_MODE_ERROR';
    ctx.sendError(command.request_id, message, code);
  }
}

export async function handleSetModel(
  ctx: SetCtx,
  command: SetModelCommand,
): Promise<void> {
  if (isCodexSessionId(command.session_id)) {
    ctx.sendError(command.request_id, 'set_model is not supported for Codex sessions', 'NOT_SUPPORTED');
    return;
  }
  try {
    const internalId = ctx.resolveInternalSessionId(command.session_id) ?? command.session_id;
    await ctx.sessionManager.setModel(internalId, command.model);
    ctx.sendToPhone({
      type: 'command_ack',
      request_id: command.request_id,
      session_id: command.session_id,
      command: 'set_model',
    } as unknown as PcEvent);
  } catch (err) {
    const message = (err as Error).message;
    const code = message.startsWith('not_supported') ? 'NOT_SUPPORTED' : 'SET_MODEL_ERROR';
    ctx.sendError(command.request_id, message, code);
  }
}
