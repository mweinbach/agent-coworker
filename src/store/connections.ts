import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProviderName } from "../types";

export type ConnectService = ProviderName;
export const TOOL_API_KEY_NAMES = ["exa"] as const;
export type ToolApiKeyName = (typeof TOOL_API_KEY_NAMES)[number];

export type ConnectionMode = "api_key" | "oauth" | "oauth_pending";

export type StoredConnection = {
  service: ConnectService;
  mode: ConnectionMode;
  apiKey?: string;
  updatedAt: string;
};

export type ConnectionStore = {
  version: 1;
  updatedAt: string;
  services: Partial<Record<ConnectService, StoredConnection>>;
  toolApiKeys?: Partial<Record<ToolApiKeyName, string>>;
};

export type AiCoworkerPaths = {
  rootDir: string;
  authDir: string;
  configDir: string;
  sessionsDir: string;
  logsDir: string;
  connectionsFile: string;
};

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isToolApiKeyName(value: string): value is ToolApiKeyName {
  return (TOOL_API_KEY_NAMES as readonly string[]).includes(value);
}

function normalizeToolApiKeys(value: unknown): Partial<Record<ToolApiKeyName, string>> | undefined {
  if (!isObjectLike(value)) return undefined;
  const out: Partial<Record<ToolApiKeyName, string>> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!isToolApiKeyName(rawKey)) continue;
    if (typeof rawValue !== "string") continue;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    out[rawKey] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function getAiCoworkerPaths(opts: { homedir?: string } = {}): AiCoworkerPaths {
  const home = opts.homedir ?? os.homedir();
  const rootDir = path.join(home, ".cowork");
  const authDir = path.join(rootDir, "auth");
  const configDir = path.join(rootDir, "config");
  const sessionsDir = path.join(rootDir, "sessions");
  const logsDir = path.join(rootDir, "logs");
  const connectionsFile = path.join(authDir, "connections.json");
  return { rootDir, authDir, configDir, sessionsDir, logsDir, connectionsFile };
}

export async function ensureAiCoworkerHome(paths: AiCoworkerPaths): Promise<void> {
  await fs.mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.authDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.sessionsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.logsDir, { recursive: true, mode: 0o700 });

  // Best-effort hardening for secret-bearing dirs.
  for (const dir of [paths.rootDir, paths.authDir, paths.configDir, paths.sessionsDir, paths.logsDir]) {
    try {
      await fs.chmod(dir, 0o700);
    } catch {
      // best effort only
    }
  }
}

export async function readConnectionStore(paths: AiCoworkerPaths): Promise<ConnectionStore> {
  await ensureAiCoworkerHome(paths);

  const loadFrom = async (filePath: string): Promise<ConnectionStore | null> => {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (
        isObjectLike(parsed) &&
        parsed.version === 1 &&
        isObjectLike(parsed.services) &&
        (typeof parsed.updatedAt === "string" || parsed.updatedAt === undefined)
      ) {
        const toolApiKeys = normalizeToolApiKeys(parsed.toolApiKeys);
        return {
          version: 1,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
          services: parsed.services as ConnectionStore["services"],
          ...(toolApiKeys ? { toolApiKeys } : {}),
        };
      }
    } catch {
      // ignore
    }
    return null;
  };

  // Primary location: ~/.cowork/auth/connections.json
  const primary = await loadFrom(paths.connectionsFile);
  if (primary) return primary;

  // Backward-compatible fallback: ~/.ai-coworker/config/connections.json
  const homeDir = path.dirname(paths.rootDir);
  const legacyFile = path.join(homeDir, ".ai-coworker", "config", "connections.json");
  const legacy = await loadFrom(legacyFile);
  if (legacy) {
    // Best-effort migration to the new location.
    try {
      await writeConnectionStore(paths, legacy);
    } catch {
      // ignore migration failures; still return legacy view
    }
    return legacy;
  }

  return { version: 1, updatedAt: new Date().toISOString(), services: {} };
}

export async function writeConnectionStore(paths: AiCoworkerPaths, store: ConnectionStore): Promise<void> {
  await ensureAiCoworkerHome(paths);
  await fs.writeFile(paths.connectionsFile, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    await fs.chmod(paths.connectionsFile, 0o600);
  } catch {
    // best effort only
  }
}
