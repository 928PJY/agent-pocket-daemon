#!/usr/bin/env node
// Agent Pocket — CLI Entry Point
// Subcommands: start, stop, restart, status, logs, pair, sessions, panic

import { DAEMON_DEFAULT_PORT, HOOK_SERVER_PORT } from 'agent-pocket-protocol';
import type { ConnectionMode } from 'agent-pocket-protocol';
import { VERSION } from './version.js';
import { AgentPocketDaemon } from './index.js';
import { SessionDiscovery } from './discovery/session-discovery.js';
import { CodexDiscovery } from './discovery/codex-discovery.js';
import type { CodexLiveSession, CodexSession } from './discovery/codex-discovery.js';
import { CryptoEngine } from './crypto/crypto-engine.js';
import { LanServer } from './lan/lan-server.js';
import { runLanPairing } from './lan/lan-pairing.js';
import { rawX25519ToSpki, rawEd25519ToSpki, spkiEd25519ToRaw } from './crypto/key-format.js';
import { RelayClient } from './relay/relay-client.js';
import { logger } from './logger.js';
import {
  installClaudeHooks as installClaudeHooksImpl,
  installCodexHooks as installCodexHooksImpl,
  removeClaudeHooks as removeClaudeHooksImpl,
  removeCodexHooks as removeCodexHooksImpl,
  type HooksManagerPaths,
} from './cli/hooks-manager.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import * as readline from 'node:readline';

// ============================================================================
// Paths
// ============================================================================

const CONFIG_DIR = path.join(os.homedir(), '.agent-pocket');
const OLD_CONFIG_DIR = path.join(os.homedir(), '.pocket-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
const SESSION_MAP_FILE = path.join(CONFIG_DIR, 'session-map.json');
const HOOKS_DIR = path.join(CONFIG_DIR, 'hooks');
const HOOK_DEBUG_LOG_FILE = path.join(CONFIG_DIR, 'hook-debug.log');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const CODEX_CONFIG_FILE = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_HOOKS_FILE = path.join(os.homedir(), '.codex', 'hooks.json');

const DEFAULT_RELAY_URL = 'wss://www.agent-pocket.com';

// ============================================================================
// Config persistence
// ============================================================================

interface SavedConfig {
  relay_url: string;
  pair_id: string;
  jwt_pc: string;
  pc_name: string;
  paired_at: string;
  connection_mode?: ConnectionMode;
  lan_port?: number;
  phone_identity_public_key?: string;
  session_send_key?: string;
  session_recv_key?: string;
  session_sas_key?: string;
}

/** Migrate ~/.pocket-agent → ~/.agent-pocket if needed. */
function migrateConfigDir(): void {
  if (fs.existsSync(OLD_CONFIG_DIR) && !fs.existsSync(CONFIG_DIR)) {
    try {
      fs.renameSync(OLD_CONFIG_DIR, CONFIG_DIR);
      console.log(`Migrated config from ${OLD_CONFIG_DIR} to ${CONFIG_DIR}`);
    } catch {
      // If rename fails (cross-device), copy instead
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      for (const file of fs.readdirSync(OLD_CONFIG_DIR)) {
        fs.copyFileSync(path.join(OLD_CONFIG_DIR, file), path.join(CONFIG_DIR, file));
      }
      console.log(`Copied config from ${OLD_CONFIG_DIR} to ${CONFIG_DIR}`);
    }
  }
}

function loadSavedConfig(): SavedConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(data) as SavedConfig;
  } catch {
    return null;
  }
}

function saveConfig(config: SavedConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// ============================================================================
// PID file management
// ============================================================================

function writePidFile(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
}

function removePidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function readDaemonPid(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

function isDaemonRunning(): { running: boolean; pid: number | null } {
  const pid = readDaemonPid();
  if (pid === null) return { running: false, pid: null };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Stale PID file
    removePidFile();
    return { running: false, pid: null };
  }
}

// ============================================================================
// Hooks (delegators to src/cli/hooks-manager.ts)
// ============================================================================

const HOOKS_PATHS: HooksManagerPaths = {
  hooksDir: HOOKS_DIR,
  claudeSettingsFile: CLAUDE_SETTINGS_FILE,
  codexConfigFile: CODEX_CONFIG_FILE,
  codexHooksFile: CODEX_HOOKS_FILE,
  hookDebugLogFile: HOOK_DEBUG_LOG_FILE,
};

function installClaudeHooks(hookPort: number): void {
  installClaudeHooksImpl(hookPort, HOOKS_PATHS);
}

function installCodexHooks(hookPort: number): void {
  installCodexHooksImpl(hookPort, HOOKS_PATHS);
}

function removeClaudeHooks(): void {
  removeClaudeHooksImpl(HOOKS_PATHS);
}

function removeCodexHooks(): void {
  removeCodexHooksImpl(HOOKS_PATHS);
}


// ============================================================================
// Argument Parsing
// ============================================================================

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args.length > 0 && !args[0].startsWith('-') ? args[0] : 'help';
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  const skipCommand = command !== 'help' || (args.length > 0 && !args[0].startsWith('-'));

  for (let i = skipCommand ? 1 : 0; i < args.length; i++) {
    if (args[i] === '-f') {
      flags['follow'] = 'true';
    } else if (args[i].startsWith('--')) {
      const key = args[i].replace(/^--/, '');
      const value = (i + 1 < args.length && !args[i + 1].startsWith('-'))
        ? args[++i]
        : 'true';
      flags[key] = value;
    } else {
      positional.push(args[i]);
    }
  }

  return { command, flags, positional };
}

// ============================================================================
// Help
// ============================================================================

function printHelp(): void {
  console.log(`
Agent Pocket v${VERSION}

Usage:
  agent-pocket <command> [options]

Commands:
  start                    Start the daemon (pairs if needed, runs in background)
  stop                     Stop the running daemon
  restart                  Restart the daemon
  status                   Show daemon status
  logs                     View daemon logs
  pair                     Generate QR code and pair with phone
  unpair                   Clear pairing and stop daemon
  sessions                 List discoverable Claude Code sessions
  panic                    Kill all Claude Code processes (emergency)

Start options:
  --foreground             Run in foreground (don't daemonize)
  --debug                  Show debug-level logs (between info and trace)
  --trace                  Enable verbose trace logging (writes to daemon-trace.log)
  --relay-url <url>        Relay server URL
  --lan                    Use LAN direct connection mode

Logs options:
  -f, --follow             Follow log output (like tail -f)
  --trace                  Show trace log instead of main log

Pair options:
  --relay-url <url>        Relay server URL (default: ${DEFAULT_RELAY_URL})
  --lan                    Use LAN direct connection mode
  --port <port>            LAN server port (default: ${DAEMON_DEFAULT_PORT})
`);
}

// ============================================================================
// Subcommand: start (smart start)
// ============================================================================

async function cmdStart(flags: Record<string, string>): Promise<void> {
  const isDaemonProcess = flags['daemon-process'] === 'true';
  const isForeground = flags['foreground'] === 'true';
  const isTrace = flags['trace'] === 'true';
  const isDebug = flags['debug'] === 'true';

  // Initialize logger. --trace implies trace level + trace file; --debug raises
  // threshold to DEBUG without enabling the per-line trace file.
  logger.init({
    level: isTrace ? 'TRACE' : isDebug ? 'DEBUG' : undefined,
    trace: isTrace,
    foreground: isDaemonProcess ? false : true,
  });

  // If this is the background daemon process, run the actual daemon
  if (isDaemonProcess) {
    await runDaemon(flags);
    return;
  }

  // Check if already running
  const { running, pid } = isDaemonRunning();
  if (running) {
    console.log(`Daemon is already running (PID ${pid}).`);
    console.log('Use "agent-pocket restart" to restart, or "agent-pocket stop" to stop.');
    return;
  }

  // Check if paired — if not, run pairing flow inline
  let saved = loadSavedConfig();
  let freshlyPaired = false;
  if (!saved) {
    console.log('No pairing found. Starting pairing flow...\n');
    await runPairingFlow(flags);
    saved = loadSavedConfig();
    if (!saved) {
      console.error('Pairing failed. Cannot start daemon.');
      process.exit(1);
    }
    freshlyPaired = true;
  }

  console.log(`Agent Pocket v${VERSION}`);
  console.log(`  Mode:       ${saved.connection_mode ?? 'relay'}`);
  if ((saved.connection_mode ?? 'relay') === 'relay') {
    console.log(`  Relay URL:  ${saved.relay_url}`);
  }
  console.log(`  Pair ID:    ${saved.pair_id}`);

  if (isForeground) {
    console.log('  Running in foreground...');
    await runDaemon(flags);
    return;
  }

  // Spawn background daemon process
  const scriptPath = new URL(import.meta.url).pathname;
  const args = [scriptPath, 'start', '--daemon-process'];
  if (isTrace) args.push('--trace');
  if (isDebug) args.push('--debug');

  // Pass through connection flags
  for (const key of ['relay-url', 'pair-id', 'auth-token', 'lan', 'port']) {
    if (flags[key]) args.push(`--${key}`, flags[key]);
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  console.log(`  Daemon started in background (PID ${child.pid}).`);
  console.log(`  Logs: ~/.agent-pocket/logs/daemon.log`);
  if (isTrace) console.log(`  Trace: ~/.agent-pocket/logs/daemon-trace.log`);
  console.log('  Use "agent-pocket status" to check, "agent-pocket stop" to stop.');

  // If freshly paired, wait for phone to confirm SAS and connect
  if (freshlyPaired && saved.session_send_key) {
    console.log('\n  Waiting for phone confirmation...');
    console.log('  (Tap "Codes match" on your phone to confirm)\n');
    const logPath = path.join(CONFIG_DIR, 'logs', 'daemon.log');
    const confirmed = await waitForPhoneOnlineInLog(logPath, 120_000);
    if (confirmed) {
      console.log('  Phone confirmed! E2E encryption active.');
    } else {
      console.log('  Timed out waiting for phone confirmation.');
      console.log('  The daemon is running — phone can still connect later.');
    }
  }
}

// ============================================================================
// Run actual daemon (foreground or --daemon-process)
// ============================================================================

async function runDaemon(flags: Record<string, string>): Promise<void> {
  let relayUrl = flags['relay-url'] ?? '';
  let pairId = flags['pair-id'] ?? '';
  let authToken = flags['auth-token'] ?? '';
  let connectionMode: ConnectionMode = 'relay';
  let lanPort: number | undefined;
  let phoneIdentityPublicKey: string | undefined;

  // Load saved config
  if (!pairId || !authToken) {
    const saved = loadSavedConfig();
    if (saved) {
      relayUrl = relayUrl || saved.relay_url;
      pairId = pairId || saved.pair_id;
      authToken = authToken || saved.jwt_pc;
      connectionMode = saved.connection_mode ?? 'relay';
      lanPort = saved.lan_port;
      phoneIdentityPublicKey = saved.phone_identity_public_key;
      logger.info('cli', `Loaded saved pairing (paired ${saved.paired_at})`);
    }
  }

  // Load session keys from config
  const saved = loadSavedConfig();
  const sessionSendKey = saved?.session_send_key;
  const sessionRecvKey = saved?.session_recv_key;
  const sessionSasKey = saved?.session_sas_key;

  if (connectionMode === 'relay') {
    if (!relayUrl) relayUrl = DEFAULT_RELAY_URL;
    if (!pairId || !authToken) {
      logger.error('cli', 'No saved pairing found. Run "agent-pocket pair" first.');
      process.exit(1);
    }
  } else if (!pairId) {
    logger.error('cli', 'No saved pairing found. Run "agent-pocket pair --lan" first.');
    process.exit(1);
  }

  // Write PID file
  writePidFile();

  // Clear trace log on startup
  const traceLogPath = path.join(CONFIG_DIR, 'logs', 'daemon-trace.log');
  try { fs.writeFileSync(traceLogPath, ''); } catch { /* ignore */ }

  logger.info('cli', `Daemon starting (PID ${process.pid})`);

  const daemon = new AgentPocketDaemon({
    relayUrl,
    pairId,
    authToken,
    connectionMode,
    lanPort,
    phoneIdentityPublicKey,
    sessionSendKey,
    sessionRecvKey,
    sessionSasKey,
  });

  const hookPort = await daemon.start();
  installClaudeHooks(hookPort);
  installCodexHooks(hookPort);

  // Prevent idle sleep
  const caffeinated = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
    stdio: 'ignore',
    detached: true,
  });
  caffeinated.unref();
  logger.info('cli', `Started caffeinate (PID ${caffeinated.pid})`);

  // Graceful shutdown
  let isShuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('cli', `Received ${signal}, shutting down...`);
    removeClaudeHooks();
    removeCodexHooks();
    await daemon.stop();
    removePidFile();
    logger.info('cli', 'Shutdown complete.');
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
  process.on('uncaughtException', (err: Error) => {
    logger.error('cli', `Uncaught exception: ${err.message}`, { stack: err.stack ?? '' });
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('cli', `Unhandled rejection: ${reason}`);
  });

  logger.info('cli', 'Daemon is running.');

  // Keep alive
  await new Promise<void>(() => {});
}

// ============================================================================
// Pairing flow (used by smart start and pair command)
// ============================================================================

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once('line', () => {
      rl.close();
      resolve();
    });
  });
}

async function waitForPhoneConfirmation(relayUrl: string, pairId: string, jwt: string): Promise<void> {
  const client = new RelayClient({
    relayUrl,
    pairId,
    authToken: jwt,
  });

  client.connect();

  // Wait for connection, then check peer status
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 120_000);

    const checkOnline = () => {
      if (client.getPhonePeerOnline()) {
        clearTimeout(timeout);
        resolve();
      }
    };

    client.on('phone_online', () => {
      clearTimeout(timeout);
      resolve();
    });

    // Check after connection is established (peer_status_query is sent automatically)
    client.on('connected', () => {
      setTimeout(checkOnline, 1000);
    });
  });

  client.disconnect();
}

function waitForPhoneOnlineInLog(logPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const startSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

    const interval = setInterval(() => {
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        resolve(false);
        return;
      }

      try {
        if (!fs.existsSync(logPath)) return;
        const stat = fs.statSync(logPath);
        if (stat.size <= startSize) return;

        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(stat.size - startSize);
        fs.readSync(fd, buf, 0, buf.length, startSize);
        fs.closeSync(fd);

        const newContent = buf.toString('utf-8');
        if (newContent.includes('Phone peer online')) {
          clearInterval(interval);
          resolve(true);
        }
      } catch {
        // File might be temporarily unavailable
      }
    }, 500);
  });
}

async function runPairingFlow(flags: Record<string, string>): Promise<void> {
  const isLan = flags['lan'] === 'true';
  if (isLan) {
    await runLanPairingFlow(flags);
    return;
  }

  const relayUrl = flags['relay-url'] ?? DEFAULT_RELAY_URL;

  console.log('Agent Pocket — Pairing Mode');
  console.log(`Relay URL: ${relayUrl}\n`);

  const cryptoEngine = new CryptoEngine();
  cryptoEngine.loadOrGenerateIdentityKeyPair();
  cryptoEngine.generateEphemeralKeyPair();

  const httpUrl = relayUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://');

  const hostname = os.hostname();
  const initiateResp = await fetch(`${httpUrl}/pair/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pc_public_key: cryptoEngine.getEphemeralPublicKeyBase64(),
      pc_identity_public_key: cryptoEngine.getIdentityPublicKeyBase64(),
      pc_name: hostname,
    }),
  });

  if (!initiateResp.ok) {
    const err = await initiateResp.text();
    console.error(`Failed to initiate pairing: ${initiateResp.status} ${err}`);
    process.exit(1);
  }

  const { pairing_token } = await initiateResp.json() as { pairing_token: string };

  const qrPayload = {
    relay_url: relayUrl,
    pairing_token,
    pc_ephemeral_pk: cryptoEngine.getEphemeralPublicKeyBase64(),
  };

  const qrData = Buffer.from(JSON.stringify(qrPayload)).toString('base64url');

  console.log('Scan this QR code with the Agent Pocket iOS app:\n');

  try {
    const qrTerminal = await import('qrcode-terminal');
    const mod = qrTerminal.default ?? qrTerminal;
    mod.generate(qrData, { small: true });
  } catch {
    console.log('[QR display unavailable]');
  }
  console.log(`Pairing data: ${qrData}`);
  console.log(`\nPairing token: ${pairing_token.slice(0, 8)}...`);
  console.log('\nWaiting for phone to scan QR code... (times out in 5 minutes)');

  const deadline = Date.now() + 300_000;
  let pairResult: { device_pair_id: string; jwt_pc: string; phone_public_key?: string; phone_identity_public_key?: string } | null = null;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const statusResp = await fetch(`${httpUrl}/pair/status/${pairing_token}`);
      if (!statusResp.ok) continue;
      const statusData = await statusResp.json() as Record<string, unknown>;
      if (statusData.status === 'pending') continue;
      if (statusData.device_pair_id && statusData.jwt_pc) {
        pairResult = {
          device_pair_id: statusData.device_pair_id as string,
          jwt_pc: statusData.jwt_pc as string,
          phone_public_key: statusData.phone_public_key as string | undefined,
          phone_identity_public_key: statusData.phone_identity_public_key as string | undefined,
        };
        break;
      }
    } catch {
      // Network error, retry
    }
  }

  if (!pairResult) {
    console.log('\nPairing timeout. Try again with: agent-pocket pair');
    process.exit(1);
  }

  console.log(`\nPairing successful!`);
  console.log(`  Pair ID: ${pairResult.device_pair_id}`);

  // Derive E2E session keys via ECDH if phone sent its ephemeral key
  if (pairResult.phone_public_key) {
    try {
      const phoneEphemeralSpki = rawX25519ToSpki(pairResult.phone_public_key);
      const sharedSecret = cryptoEngine.deriveSharedSecret(phoneEphemeralSpki);
      cryptoEngine.deriveSessionKeys(sharedSecret);

      const keys = cryptoEngine.getSessionKeys();
      if (keys) {
        console.log(`  [debug] send key: ${keys.sendKey.toString('base64').substring(0, 12)}...`);
        console.log(`  [debug] recv key: ${keys.recvKey.toString('base64').substring(0, 12)}...`);
        console.log(`  [debug] sas  key: ${keys.sasKey?.toString('base64').substring(0, 12)}...`);
      }

      const sasCode = cryptoEngine.computeSasCode();
      console.log('\n');
      console.log('  ┌─────────────────────────────────────┐');
      console.log('  │                                     │');
      console.log('  │       VERIFICATION CODE             │');
      console.log(`  │                                     │`);
      console.log(`  │          ${sasCode.split('').join('  ')}          │`);
      console.log('  │                                     │');
      console.log('  │  Confirm this matches your phone.   │');
      console.log('  │                                     │');
      console.log('  └─────────────────────────────────────┘');
      console.log('');
    } catch (err) {
      console.warn(`  Warning: E2E key exchange failed: ${(err as Error).message}`);
    }
  }

  const sessionKeys = cryptoEngine.hasSessionKeys() ? cryptoEngine.getSessionKeys() : undefined;

  saveConfig({
    relay_url: relayUrl,
    pair_id: pairResult.device_pair_id,
    jwt_pc: pairResult.jwt_pc,
    pc_name: hostname,
    paired_at: new Date().toISOString(),
    phone_identity_public_key: pairResult.phone_identity_public_key,
    ...(sessionKeys ? {
      session_send_key: sessionKeys.sendKey.toString('base64'),
      session_recv_key: sessionKeys.recvKey.toString('base64'),
      session_sas_key: sessionKeys.sasKey?.toString('base64'),
    } : {}),
  });
  console.log(`  Credentials saved to ${CONFIG_FILE}`);
}

async function runLanPairingFlow(flags: Record<string, string>): Promise<void> {
  const port = flags['port'] ? parseInt(flags['port'], 10) : DAEMON_DEFAULT_PORT;

  console.log('Agent Pocket — LAN Pairing Mode');
  console.log(`Port: ${port}\n`);

  const cryptoEngine = new CryptoEngine();
  cryptoEngine.loadOrGenerateIdentityKeyPair();

  const lanServer = new LanServer({
    port,
    cryptoEngine,
    pairId: '',
    phoneIdentityPublicKey: '',
  });

  await lanServer.start();

  try {
    const result = await runLanPairing(lanServer, cryptoEngine, port);

    console.log(`\nLAN pairing successful!`);
    console.log(`  Pair ID: ${result.pair_id}`);
    if (cryptoEngine.hasSessionKeys()) {
      const sasCode = cryptoEngine.computeSasCode();
      console.log('\n');
      console.log('  ┌─────────────────────────────────────┐');
      console.log('  │                                     │');
      console.log('  │       VERIFICATION CODE             │');
      console.log(`  │                                     │`);
      console.log(`  │          ${sasCode.split('').join('  ')}          │`);
      console.log('  │                                     │');
      console.log('  │  Confirm this matches your phone.   │');
      console.log('  │                                     │');
      console.log('  └─────────────────────────────────────┘');
      console.log('\n  Waiting for phone confirmation...');

      // Wait for phone to connect via WebSocket (user taps "Codes match")
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 120_000);
        lanServer.on('connected', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      console.log('  Phone confirmed! E2E encryption active.\n');
    }

    await lanServer.stop();

    const hostname = os.hostname();
    saveConfig({
      relay_url: '',
      pair_id: result.pair_id,
      jwt_pc: '',
      pc_name: hostname,
      paired_at: new Date().toISOString(),
      connection_mode: 'lan',
      lan_port: port,
      phone_identity_public_key: result.phone_identity_public_key,
      session_send_key: result.session_send_key,
      session_recv_key: result.session_recv_key,
      session_sas_key: result.session_sas_key,
    });
    console.log(`  Credentials saved to ${CONFIG_FILE}`);
  } catch (err) {
    await lanServer.stop();
    console.error(`\nLAN pairing failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ============================================================================
// Subcommand: stop
// ============================================================================

async function cmdStop(): Promise<void> {
  const { running, pid } = isDaemonRunning();
  if (!running || pid === null) {
    console.log('Daemon is not running.');
    return;
  }

  console.log(`Stopping daemon (PID ${pid})...`);
  process.kill(pid, 'SIGTERM');

  // Wait up to 5 seconds for the process to exit
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      console.log('Daemon stopped.');
      return;
    }
  }

  // Force kill if still running
  try {
    process.kill(pid, 'SIGKILL');
    removePidFile();
    console.log('Daemon force-killed.');
  } catch {
    console.log('Daemon stopped.');
  }
}

// ============================================================================
// Subcommand: restart
// ============================================================================

async function cmdRestart(flags: Record<string, string>): Promise<void> {
  const { running } = isDaemonRunning();
  if (running) {
    await cmdStop();
    // Small delay to ensure port is released
    await new Promise(r => setTimeout(r, 500));
  }
  await cmdStart(flags);
}

// ============================================================================
// Subcommand: status
// ============================================================================

async function cmdStatus(): Promise<void> {
  const { running, pid } = isDaemonRunning();
  const saved = loadSavedConfig();

  if (running) {
    console.log(`Daemon:   running (PID ${pid})`);
  } else {
    console.log('Daemon:   stopped');
  }

  if (saved) {
    console.log(`Mode:     ${saved.connection_mode ?? 'relay'}`);
    if ((saved.connection_mode ?? 'relay') === 'relay') {
      console.log(`Relay:    ${saved.relay_url}`);
    } else {
      console.log(`LAN port: ${saved.lan_port ?? DAEMON_DEFAULT_PORT}`);
    }
    console.log(`Pair ID:  ${saved.pair_id}`);
    console.log(`Paired:   ${saved.paired_at}`);
  } else {
    console.log('Pairing:  not paired');
  }

  if (running) {
    try {
      const res = await fetch(`http://127.0.0.1:${HOOK_SERVER_PORT}/api/status`);
      if (res.ok) {
        const status = await res.json() as { relay: string; phone: boolean; offlineQueue: number; sessions: number };
        console.log(`\nRelay:    ${status.relay}`);
        console.log(`Phone:    ${status.phone ? 'online' : 'offline'}`);
        if (status.offlineQueue > 0) {
          console.log(`Queued:   ${status.offlineQueue} messages`);
        }
        console.log(`Sessions: ${status.sessions}`);
      }
    } catch {
      // Daemon running but hook server not reachable yet
    }
  }

  console.log(`\nLog:      ~/.agent-pocket/logs/daemon.log`);
  console.log(`Trace:    ~/.agent-pocket/logs/daemon-trace.log`);
  console.log(`Config:   ${CONFIG_FILE}`);
  console.log(`PID file: ${PID_FILE}`);
}

// ============================================================================
// Subcommand: logs
// ============================================================================

async function cmdLogs(flags: Record<string, string>): Promise<void> {
  const isTrace = flags['trace'] === 'true';
  const isFollow = flags['follow'] === 'true';
  const logPath = isTrace
    ? path.join(CONFIG_DIR, 'logs', 'daemon-trace.log')
    : path.join(CONFIG_DIR, 'logs', 'daemon.log');

  if (!fs.existsSync(logPath)) {
    console.log(`No log file found at ${logPath}`);
    console.log('Start the daemon first: agent-pocket start');
    return;
  }

  // Read and display last 50 lines
  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n');
  const tail = lines.slice(-51, -1); // last 50 non-empty lines
  console.log(tail.join('\n'));

  if (!isFollow) return;

  // Follow mode: watch for new content
  let lastSize = fs.statSync(logPath).size;
  console.log('\n--- following log (Ctrl+C to stop) ---\n');

  const interval = setInterval(() => {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > lastSize) {
        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        process.stdout.write(buf.toString('utf-8'));
        lastSize = stat.size;
      } else if (stat.size < lastSize) {
        // File was rotated
        lastSize = 0;
      }
    } catch {
      // File might be temporarily unavailable during rotation
    }
  }, 500);

  // Keep alive until Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
    process.exit(0);
  });

  await new Promise<void>(() => {});
}

// ============================================================================
// Subcommand: pair
// ============================================================================

async function cmdPair(flags: Record<string, string>): Promise<void> {
  // --reset: clear saved pairing before starting new one
  if (flags['reset'] === 'true') {
    await cmdUnpair();
  }

  await runPairingFlow(flags);

  console.log('\n  Waiting for phone confirmation...');
  console.log('  (Tap "Codes match" on your phone to confirm)\n');

  // Save config is done in runPairingFlow. Restart daemon so it connects to relay.
  await cmdRestart(flags);

  // Tail daemon log waiting for phone to come online
  const logPath = path.join(CONFIG_DIR, 'logs', 'daemon.log');
  const confirmed = await waitForPhoneOnlineInLog(logPath, 120_000);
  if (confirmed) {
    console.log('\n  Phone confirmed! E2E encryption active.');
  } else {
    console.log('\n  Timed out waiting for phone confirmation.');
    console.log('  The daemon is running — phone can still connect later.');
  }
}

// ============================================================================
// Subcommand: sessions
// ============================================================================

function getTtyForPid(pid: number): string | null {
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'tty=']);
    if (result.status !== 0) return null;
    const tty = result.stdout.toString().trim();
    return tty && tty !== '??' ? tty : null;
  } catch {
    return null;
  }
}

function formatLocalLastActivity(timestampMs?: number): string {
  if (!timestampMs) return '-';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(timestampMs));
}

function formatSessionTitle(title?: string): string {
  if (!title) return '-';
  const maxLength = /\p{Script=Han}/u.test(title) ? 5 : 20;
  return Array.from(title).slice(0, maxLength).join('');
}

async function cmdSessions(): Promise<void> {
  const { running } = isDaemonRunning();
  if (!running) {
    console.log('Daemon is not running. Start it with: agent-pocket start');
    return;
  }

  // Query the daemon's tracked sessions via local API
  let sessions: Array<{
    sessionId: string;
    status: string;
    pid?: number;
    cwd: string;
    isObserved: boolean;
    customTitle?: string;
    entrypoint?: string;
    lastActivity?: number;
  }>;

  try {
    const res = await fetch(`http://127.0.0.1:${HOOK_SERVER_PORT}/api/sessions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sessions = await res.json() as typeof sessions;
  } catch (err) {
    console.log(`Failed to query daemon: ${(err as Error).message}`);
    return;
  }

  const codexDiscovery = new CodexDiscovery();
  const codexSessions = codexDiscovery.discoverSessions();
  const liveCodexSessions = Array.from(codexDiscovery.discoverLiveSessions(codexSessions).values())
    .map((live) => {
      const session = codexSessions.find(s => s.sessionId === live.sessionId);
      return session ? { live, session } : null;
    })
    .filter((entry): entry is { live: CodexLiveSession; session: CodexSession } => entry !== null);

  if (sessions.length === 0 && liveCodexSessions.length === 0) {
    console.log('No active sessions tracked by daemon.');
    return;
  }

  const claudeRows = sessions.map(s => ({
    Agent: 'Claude',
    PID: s.pid ?? '-',
    TTY: s.pid ? getTtyForPid(s.pid) ?? '-' : '-',
    'Session ID': s.sessionId.slice(0, 8) + '...',
    Status: s.status,
    Type: s.entrypoint ?? '-',
    Title: formatSessionTitle(s.customTitle),
    CWD: s.cwd.replace(os.homedir(), '~'),
    Mode: s.isObserved ? 'observer' : 'controller',
    'Last Activity': formatLocalLastActivity(s.lastActivity),
  }));

  const codexRows = liveCodexSessions.map(({ live, session }) => ({
    Agent: 'Codex',
    PID: live.pid,
    TTY: getTtyForPid(live.pid) ?? '-',
    'Session ID': session.sessionId.slice(0, 14) + '...',
    Status: 'ready',
    Type: 'codex-cli',
    Title: formatSessionTitle(session.title),
    CWD: session.cwd.replace(os.homedir(), '~'),
    Mode: 'observer',
    'Last Activity': formatLocalLastActivity(live.lastActivityMs),
  }));

  const rows = [...claudeRows, ...codexRows]
    .sort((a, b) => String(a.Agent).localeCompare(String(b.Agent)) || Number(a.PID) - Number(b.PID));

  console.log(`${rows.length} active session(s): ${claudeRows.length} Claude, ${codexRows.length} Codex\n`);
  console.table(rows);
}

// ============================================================================
// Subcommand: unpair
// ============================================================================

async function cmdUnpair(): Promise<void> {
  // Stop daemon if running
  const { running, pid } = isDaemonRunning();
  if (running && pid) {
    console.log(`Stopping daemon (PID ${pid})...`);
    process.kill(pid, 'SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
  }

  // Delete config and PID file
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
    console.log(`Deleted ${CONFIG_FILE}`);
  }
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }

  console.log('Pairing cleared. Run "agent-pocket pair" to pair again.');
}

// ============================================================================
// Subcommand: panic
// ============================================================================

async function cmdPanic(): Promise<void> {
  console.log('EMERGENCY ABORT — Killing all Claude Code sessions...\n');
  const discovery = new SessionDiscovery();
  await discovery.forceKillClaudeSessions();
  console.log('Emergency lockdown complete.');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  migrateConfigDir();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const { command, flags } = parseArgs(process.argv);

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  if (flags.version) {
    console.log(VERSION);
    process.exit(0);
  }

  switch (command) {
    case 'start':
      await cmdStart(flags);
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdRestart(flags);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'logs':
      await cmdLogs(flags);
      break;
    case 'pair':
      await cmdPair(flags);
      break;
    case 'sessions':
      await cmdSessions();
      break;
    case 'panic':
    case 'emergency-lockdown':
      await cmdPanic();
      break;
    case 'unpair':
      await cmdUnpair();
      break;
    case 'help':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
