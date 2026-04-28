// Agent Pocket — Shared Constants

export const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const HOOK_HOLD_TIMEOUT_MS = 595_000; // 595s — just under Claude Code's 10min hook max
export const HOOK_HOLD_TIMEOUT_SECONDS = HOOK_HOLD_TIMEOUT_MS / 1000;
export const PERMISSION_TIME_WINDOW_SECONDS = 30;

export const SESSION_TOKEN_EXPIRY_HOURS = 24;
export const DEVICE_TOKEN_EXPIRY_DAYS = 90;
export const PAIRING_EXPIRY_SECONDS = 120; // 2 minutes

export const OFFLINE_MESSAGE_TTL_HOURS = 24;
export const OFFLINE_MESSAGE_MAX_COUNT = 100;

export const REKEY_INTERVAL_MESSAGES = 500;
export const REKEY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30000;
export const RECONNECT_MULTIPLIER = 2;

export const RELAY_DEFAULT_PORT = 8765;
export const DAEMON_DEFAULT_PORT = 8766;
export const HOOK_SERVER_PORT = 18767;

export const BONJOUR_SERVICE_TYPE = '_agentpocket._tcp';
export const LAN_AUTH_TIMEOUT_MS = 10_000; // 10 seconds for auth handshake

export const BLOCKING_RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
export const BLOCKING_RETRY_CHECK_INTERVAL_MS = 60 * 1000; // check every 60 seconds

// Wire protocol version range. Kept in sync with @agent-pocket/shared.
export const WIRE_VERSION_MIN = 1;
export const WIRE_VERSION_CURRENT = 1;

export const VERSION = '0.1.0';
