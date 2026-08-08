import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { generateDeviceId } from "./device-id";

export interface CollectorConfig {
  device_id?: string;
  api_base_url: string;
  app_base_url: string;
}

const DEFAULT_API_URL = "https://agentboard.cloud/api/proxy";
const DEFAULT_APP_URL = "https://agentboard.cloud";

// agentboard.kro.kr was the original host and no longer serves the API. A saved
// config always wins over the default, so installs from before the move would
// keep uploading to a dead host forever — rewrite the host whenever a config is
// read. Keep in sync with plugin/hooks/lib/config.mjs.
const LEGACY_HOSTS = new Set(["agentboard.kro.kr", "www.agentboard.kro.kr"]);
const CURRENT_HOST = "agentboard.cloud";

function migrateLegacyHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (!LEGACY_HOSTS.has(parsed.hostname)) return url;
    parsed.protocol = "https:";
    parsed.host = CURRENT_HOST;
    return parsed.toString();
  } catch {
    return url;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function getDefaultApiBaseUrl(): string {
  return stripTrailingSlash(process.env.AGENTBOARD_API_URL ?? DEFAULT_API_URL);
}

function getDefaultAppBaseUrl(apiBaseUrl = getDefaultApiBaseUrl()): string {
  if (process.env.AGENTBOARD_APP_URL) {
    return stripTrailingSlash(process.env.AGENTBOARD_APP_URL);
  }

  try {
    return stripTrailingSlash(new URL(apiBaseUrl).origin);
  } catch {
    return DEFAULT_APP_URL;
  }
}

const DEFAULT_CONFIG: CollectorConfig = {
  api_base_url: getDefaultApiBaseUrl(),
  app_base_url: getDefaultAppBaseUrl(),
};

function normalizeConfig(config: Partial<CollectorConfig>): CollectorConfig {
  const apiBaseUrl = stripTrailingSlash(
    migrateLegacyHost(config.api_base_url ?? getDefaultApiBaseUrl())
  );
  const appBaseUrl = stripTrailingSlash(
    migrateLegacyHost(config.app_base_url ?? getDefaultAppBaseUrl(apiBaseUrl))
  );

  return {
    ...config,
    api_base_url: apiBaseUrl,
    app_base_url: appBaseUrl,
  };
}

export function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "agentboard");
  }
  return path.join(os.homedir(), ".agentboard");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function getTokenPath(): string {
  return path.join(getConfigDir(), ".token");
}

export function getHookSentPath(): string {
  return path.join(getConfigDir(), "hook-sent.json");
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): CollectorConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CollectorConfig>;
    return normalizeConfig(parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Partial<CollectorConfig>): void {
  ensureConfigDir();
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function getOrCreateDeviceId(): string {
  const config = loadConfig();
  if (config.device_id) return config.device_id;

  const deviceId = generateDeviceId();
  saveConfig({ device_id: deviceId });
  return deviceId;
}
