import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { PROVIDER_NAMES, resolveProviderName, type ProviderName } from "../types";

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

const isoTimestampSchema = z.string().datetime({ offset: true });

const storedConnectionSchema = z.object({
  service: z.string().trim().min(1),
  mode: z.enum(["api_key", "oauth", "oauth_pending"]),
  apiKey: z.string().trim().min(1).optional(),
  updatedAt: isoTimestampSchema,
}).strict();

const toolApiKeysSchema = z.object({
  exa: z.string().trim().min(1).optional(),
}).strict();

const connectionStoreSchema = z.object({
  version: z.literal(1),
  updatedAt: isoTimestampSchema,
  services: z.record(z.string().trim().min(1), storedConnectionSchema).transform((rawServices, ctx) => {
    const normalized: ConnectionStore["services"] = {};

    for (const [serviceRaw, connection] of Object.entries(rawServices) as Array<[string, StoredConnection]>) {
      const service = resolveProviderName(serviceRaw);
      if (!service) {
        // Skip unknown service keys.
        continue;
      }
      const connectionService = resolveProviderName(connection.service);
      if (connectionService !== service) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["services", serviceRaw, "service"],
          message: `Connection service mismatch for key ${serviceRaw}`,
        });
        continue;
      }
      normalized[service] = { ...connection, service } as StoredConnection;
    }

    return normalized;
  }),
  toolApiKeys: toolApiKeysSchema.optional(),
}).strict();
const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

class ConnectionStoreParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionStoreParseError";
  }
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "validation_failed";
  return issue.message;
}

export function parseConnectionStore(raw: unknown): ConnectionStore {
  const storeParsed = connectionStoreSchema.safeParse(raw);
  if (!storeParsed.success) {
    throw new ConnectionStoreParseError(`Invalid connection store schema: ${formatZodError(storeParsed.error)}`);
  }

  return {
    version: 1,
    updatedAt: storeParsed.data.updatedAt,
    services: storeParsed.data.services,
    ...(storeParsed.data.toolApiKeys ? { toolApiKeys: storeParsed.data.toolApiKeys } : {}),
  };
}

export function parseConnectionStoreJson(raw: string, filePath: string): ConnectionStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConnectionStoreParseError(`Invalid JSON in connection store at ${filePath}: ${String(error)}`);
  }
  return parseConnectionStore(parsed);
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
      return parseConnectionStoreJson(raw, filePath);
    } catch (error) {
      const parsedCode = errorWithCodeSchema.safeParse(error);
      const code = parsedCode.success ? parsedCode.data.code : undefined;
      if (code === "ENOENT") return null;
      if (error instanceof ConnectionStoreParseError) return null;
      throw new Error(`Failed to read connection store at ${filePath}: ${String(error)}`);
    }
  };

  // Primary location: ~/.cowork/auth/connections.json
  const primary = await loadFrom(paths.connectionsFile);
  if (primary) return primary;

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
