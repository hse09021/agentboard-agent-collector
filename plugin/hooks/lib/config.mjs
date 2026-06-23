/**
 * agentboard hook config loader
 *
 * Reads ~/.agentboard/config.json and ~/.agentboard/.token
 * Used by hook scripts that run outside the compiled TypeScript context.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const COLLECTOR_VERSION = '0.3.0';
export const DEFAULT_API_URL = process.env.AGENTBOARD_API_URL ?? 'https://agentboard.kro.kr/api/proxy';

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function getConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'agentboard');
  }
  return join(homedir(), '.agentboard');
}

export const CONFIG_DIR = getConfigDir();
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const TOKEN_PATH = join(CONFIG_DIR, '.token');
export const HOOK_SENT_PATH = join(CONFIG_DIR, 'hook-sent.json');

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (config?.api_base_url) {
      config.api_base_url = stripTrailingSlash(config.api_base_url);
    }
    return config;
  } catch {
    return null;
  }
}

export function getApiBaseUrl(config) {
  return stripTrailingSlash(config?.api_base_url ?? DEFAULT_API_URL);
}

export function loadToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return readFileSync(TOKEN_PATH, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

// ─── Session-sent tracking ────────────────────────────────────────────────────

export function loadHookSent() {
  if (!existsSync(HOOK_SENT_PATH)) return {};
  try {
    return JSON.parse(readFileSync(HOOK_SENT_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveHookSent(sent) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(HOOK_SENT_PATH, JSON.stringify(sent, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // best-effort
  }
}

function hookSentKey(source, sessionId) {
  return `${source}:${sessionId}`;
}

export function isSessionSent(source, sessionId) {
  const sent = loadHookSent();
  return !!sent[hookSentKey(source, sessionId)];
}

export function markSessionSent(source, sessionId) {
  const sent = loadHookSent();
  sent[hookSentKey(source, sessionId)] = { sentAt: new Date().toISOString() };
  saveHookSent(sent);
}

// ─── ID generation ────────────────────────────────────────────────────────────

export function generateEventId() {
  return `evt_${randomUUID().replace(/-/g, '')}`;
}
