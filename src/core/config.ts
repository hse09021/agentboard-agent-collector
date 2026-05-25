import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { generateDeviceId } from "./device-id";

export interface CollectorConfig {
  device_id?: string;
  api_base_url: string;
}

const DEFAULT_API_URL = "https://agentboard.kro.kr/api/proxy";

const DEFAULT_CONFIG: CollectorConfig = {
  api_base_url: process.env.AGENTBOARD_API_URL ?? DEFAULT_API_URL,
};

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

export function getSyncedIdsPath(): string {
  return path.join(getConfigDir(), "synced.json");
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
    return { ...DEFAULT_CONFIG, ...parsed };
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
