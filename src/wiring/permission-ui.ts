// Agent Pocket — permission UI helpers (Step 1.12)
//
// Extracted from buildPermissionContext + findWorkingDirForSession +
// isPlanModeTool + sendPlanForReview in src/index.ts. The four are the
// "permission-UI plumbing" the daemon needs when a Claude permission
// prompt fires:
//
//   buildPermissionContext   pure: format toolName+toolInput into the
//                            single-line context shown on the phone.
//   isPlanModeTool           pure: predicate for the special-cased
//                            ExitPlanMode / .claude/plans/ edits.
//   findWorkingDirForSession one read of cached discovery; falls back
//                            to the daemon's defaultWorkingDirectory.
//   sendPlanForReview        I/O: locate + read the latest plan markdown
//                            (cwd-local, then global ~/.claude/plans/),
//                            push a session_output:plan_review event,
//                            and register a blocking-request entry so
//                            the phone's response unblocks the hook.
//
// All four were previously private methods; only sendPlanForReview has
// non-trivial logic worth a deps interface. The other three are
// exported as pure functions.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOOK_HOLD_TIMEOUT_SECONDS,
  type PcEvent,
  type WakeBlobPayload,
} from 'agent-pocket-protocol';
import type { SessionDiscovery } from '../discovery/session-discovery.js';
import type { NotificationDeliveryEventType } from '../relay/phone-transport.js';
import { truncateUtf8 } from '../utils/truncate-utf8.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// buildPermissionContext — pure formatter
// ---------------------------------------------------------------------------

export function buildPermissionContext(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const parts: string[] = [`Tool: ${toolName}`];

  if (toolInput.command) {
    parts.push(`Command: ${String(toolInput.command)}`);
  }
  if (toolInput.description && toolName === 'Bash') {
    parts.push(`Description: ${String(toolInput.description)}`);
  }
  if (toolInput.file_path) {
    parts.push(`File: ${String(toolInput.file_path)}`);
  }
  if (toolInput.path) {
    parts.push(`Path: ${String(toolInput.path)}`);
  }
  if (toolInput.url) {
    parts.push(`URL: ${String(toolInput.url)}`);
  }
  if (toolInput.pattern) {
    parts.push(`Pattern: ${String(toolInput.pattern)}`);
  }
  if (toolInput.subject && (toolName === 'TaskCreate' || toolName === 'TaskUpdate')) {
    parts.push(`Subject: ${String(toolInput.subject)}`);
  }
  if (toolInput.taskId) {
    parts.push(`Task: #${String(toolInput.taskId)}`);
  }
  if (toolInput.status) {
    parts.push(`Status: ${String(toolInput.status)}`);
  }

  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// isPlanModeTool — pure predicate
// ---------------------------------------------------------------------------

export function isPlanModeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') return true;
  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = (toolInput.file_path as string) ?? '';
    if (filePath.includes('.claude/plans/')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// findWorkingDirForSession
// ---------------------------------------------------------------------------

export interface FindWorkingDirDeps {
  sessionDiscovery: Pick<SessionDiscovery, 'getCachedSessions'>;
  defaultWorkingDirectory: string | undefined;
  cwdFn?: () => string;
}

export function findWorkingDirForSession(
  deps: FindWorkingDirDeps,
  claudeSessionId: string,
): string {
  const cwd = deps.cwdFn ?? (() => process.cwd());
  const discovered = deps.sessionDiscovery.getCachedSessions();
  if (discovered) {
    const match = discovered.find((s) => s.sessionId === claudeSessionId);
    if (match) return match.projectDir;
  }
  return deps.defaultWorkingDirectory ?? cwd();
}

// ---------------------------------------------------------------------------
// sendPlanForReview
// ---------------------------------------------------------------------------

export interface SendPlanForReviewDeps {
  getSessionName(sessionId: string): string;
  sendNotificationEventToPhone(
    event: PcEvent,
    eventType: NotificationDeliveryEventType,
    sessionId: string,
    requestId: string,
    wakePayload: WakeBlobPayload,
  ): void;
  trackBlockingRequest(
    requestId: string,
    sessionId: string,
    event: PcEvent,
    type: 'permission_request' | 'user_question' | 'plan_review',
  ): void;

  // ----- test seams -----
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'statSync' | 'readFileSync'>;
  homedirFn?: () => string;
  nowIso?: () => string;
}

export function sendPlanForReview(
  deps: SendPlanForReviewDeps,
  sessionId: string,
  requestId: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): void {
  const fsImpl = deps.fsImpl ?? fs;
  const homedir = deps.homedirFn ?? os.homedir;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  let planContent = '';

  // Project-local plans: .claude/plans/*.md under cwd
  const plansDir = path.join(cwd, '.claude', 'plans');
  try {
    if (fsImpl.existsSync(plansDir)) {
      const files = fsImpl.readdirSync(plansDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => ({
          name: f,
          mtime: fsImpl.statSync(path.join(plansDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        const planPath = path.join(plansDir, files[0].name);
        planContent = fsImpl.readFileSync(planPath, 'utf-8');
      }
    }
  } catch (err) {
    logger.warn('daemon', `Error reading plan file: ${(err as Error).message}`);
  }

  // Global plans: ~/.claude/plans/*.md
  if (!planContent) {
    const globalPlansDir = path.join(homedir(), '.claude', 'plans');
    try {
      if (fsImpl.existsSync(globalPlansDir)) {
        const files = fsImpl.readdirSync(globalPlansDir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => ({
            name: f,
            mtime: fsImpl.statSync(path.join(globalPlansDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          const planPath = path.join(globalPlansDir, files[0].name);
          planContent = fsImpl.readFileSync(planPath, 'utf-8');
        }
      }
    } catch (err) {
      logger.warn('daemon', `Error reading global plan file: ${(err as Error).message}`);
    }
  }

  const flat: Record<string, unknown> = {
    type: 'session_output',
    session_id: sessionId,
    output_type: 'plan_review',
    plan_content: planContent || '(Could not read plan file)',
    request_id: requestId,
    allowed_prompts: toolInput.allowedPrompts ?? [],
    timestamp: nowIso(),
    ttl: HOOK_HOLD_TIMEOUT_SECONDS,
  };

  deps.sendNotificationEventToPhone(flat as unknown as PcEvent, 'plan_review', sessionId, requestId, {
    type: 'plan_review',
    session_name: deps.getSessionName(sessionId),
    body: truncateUtf8(planContent || 'A plan is ready for your review', 256),
    sound: 'default',
    category: 'PLAN_REVIEW',
    session_id: sessionId,
    request_id: requestId,
  });
  deps.trackBlockingRequest(requestId, sessionId, flat as unknown as PcEvent, 'plan_review');
}
