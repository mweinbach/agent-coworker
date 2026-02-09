import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProviderName } from "./types";

export type ConnectService = ProviderName;

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
};

export type AiCoworkerPaths = {
  rootDir: string;
  authDir: string;
  configDir: string;
  sessionsDir: string;
  logsDir: string;
  connectionsFile: string;
};

export type OauthStdioMode = "pipe" | "inherit";

export type OauthCommandRunner = (opts: {
  command: string;
  args: string[];
  cwd?: string;
  stdioMode: OauthStdioMode;
  onLine?: (line: string) => void;
}) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;

function appendChunkedLines(
  source: AsyncIterable<Uint8Array> | null | undefined,
  onLine: (line: string) => void
): Promise<void> {
  if (!source) return Promise.resolve();
  return (async () => {
    let buf = "";
    for await (const chunk of source) {
      buf += Buffer.from(chunk).toString("utf-8");
      while (true) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    }
    const tail = buf.trim();
    if (tail) onLine(tail);
  })();
}

const defaultOauthRunner: OauthCommandRunner = async ({ command, args, cwd, stdioMode, onLine }) => {
  if (stdioMode === "inherit") {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("error", reject);

    const stdoutPromise = appendChunkedLines(child.stdout, (line) => onLine?.(line));
    const stderrPromise = appendChunkedLines(child.stderr, (line) => onLine?.(line));

    child.once("close", async (exitCode, signal) => {
      try {
        await Promise.all([stdoutPromise, stderrPromise]);
      } catch {
        // ignore stream processing failures and still report process exit
      }
      resolve({ exitCode, signal });
    });
  });
};

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
        return {
          version: 1,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
          services: parsed.services as ConnectionStore["services"],
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

export function maskApiKey(value: string): string {
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function isOauthCliProvider(service: ConnectService): service is "gemini-cli" | "codex-cli" | "claude-code" {
  return service === "gemini-cli" || service === "codex-cli" || service === "claude-code";
}

function oauthCredentialCandidates(service: ConnectService, paths: AiCoworkerPaths): readonly string[] {
  const homeDir = path.dirname(paths.rootDir);
  switch (service) {
    case "gemini-cli":
      return [
        path.join(paths.authDir, "gemini-cli", "oauth_creds.json"),
        path.join(homeDir, ".gemini", "oauth_creds.json"),
      ];
    case "codex-cli":
      return [path.join(paths.authDir, "codex-cli", "auth.json"), path.join(homeDir, ".codex", "auth.json")];
    case "claude-code":
      return [
        path.join(paths.authDir, "claude-code", "credentials.json"),
        path.join(homeDir, ".claude", "credentials.json"),
        path.join(homeDir, ".config", "claude", "credentials.json"),
      ];
    default:
      return [];
  }
}

async function hasExistingOauthCredentials(service: ConnectService, paths: AiCoworkerPaths): Promise<boolean> {
  const files = oauthCredentialCandidates(service, paths);
  for (const file of files) {
    try {
      const st = await fs.stat(file);
      if (st.isFile()) return true;
    } catch {
      // continue
    }
  }
  return false;
}

function oauthCredentialSourceCandidates(service: ConnectService, paths: AiCoworkerPaths): readonly string[] {
  // Prefer the upstream CLI's canonical location as the source of truth.
  const homeDir = path.dirname(paths.rootDir);
  switch (service) {
    case "gemini-cli":
      return [path.join(homeDir, ".gemini", "oauth_creds.json")];
    case "codex-cli":
      return [path.join(homeDir, ".codex", "auth.json")];
    case "claude-code":
      return [
        path.join(homeDir, ".claude", "credentials.json"),
        path.join(homeDir, ".config", "claude", "credentials.json"),
      ];
    default:
      return [];
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function persistOauthCredentials(service: ConnectService, paths: AiCoworkerPaths): Promise<string | null> {
  if (!isOauthCliProvider(service)) return null;

  // Try to copy from the canonical upstream location into ~/.cowork/auth/{provider}/...
  const sources = oauthCredentialSourceCandidates(service, paths);
  let sourcePath: string | null = null;
  for (const candidate of sources) {
    if (await fileExists(candidate)) {
      sourcePath = candidate;
      break;
    }
  }

  const destDir = path.join(paths.authDir, service);
  const destFileFrom = (src: string) => path.join(destDir, path.basename(src));

  // If we can't find an upstream source file, return the existing persisted copy (if any).
  if (!sourcePath) {
    for (const candidate of oauthCredentialCandidates(service, paths)) {
      if (!candidate.startsWith(destDir + path.sep)) continue;
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  }

  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(destDir, 0o700);
  } catch {
    // best effort only
  }

  const destPath = destFileFrom(sourcePath);
  const raw = await fs.readFile(sourcePath);
  await fs.writeFile(destPath, raw, { mode: 0o600 });
  try {
    await fs.chmod(destPath, 0o600);
  } catch {
    // best effort only
  }
  return destPath;
}

function oauthCommandCandidates(
  service: ConnectService
): readonly Array<{ command: string; args: string[]; display: string }> {
  switch (service) {
    case "gemini-cli":
      // Gemini CLI does not expose `gemini auth login`; run `gemini` for interactive auth setup.
      return [{ command: "gemini", args: [], display: "gemini" }];
    case "codex-cli":
      return [{ command: "codex", args: ["login"], display: "codex login" }];
    case "claude-code":
      return [{ command: "claude", args: ["login"], display: "claude login" }];
    default:
      return [];
  }
}

export type ConnectProviderResult =
  | {
      ok: true;
      provider: ConnectService;
      mode: ConnectionMode;
      storageFile: string;
      message: string;
      maskedApiKey?: string;
      oauthCommand?: string;
      oauthCredentialsFile?: string;
    }
  | { ok: false; provider: ConnectService; message: string };

export async function connectProvider(opts: {
  provider: ConnectService;
  apiKey?: string;
  cwd?: string;
  paths?: AiCoworkerPaths;
  oauthStdioMode?: OauthStdioMode;
  onOauthLine?: (line: string) => void;
  oauthRunner?: OauthCommandRunner;
}): Promise<ConnectProviderResult> {
  const provider = opts.provider;
  const apiKey = (opts.apiKey ?? "").trim();
  const paths = opts.paths ?? getAiCoworkerPaths();

  const store = await readConnectionStore(paths);
  const now = new Date().toISOString();

  if (apiKey) {
    store.services[provider] = {
      service: provider,
      mode: "api_key",
      apiKey,
      updatedAt: now,
    };
    store.updatedAt = now;
    await writeConnectionStore(paths, store);
    return {
      ok: true,
      provider,
      mode: "api_key",
      storageFile: paths.connectionsFile,
      message: "Provider key saved.",
      maskedApiKey: maskApiKey(apiKey),
    };
  }

  if (!isOauthCliProvider(provider)) {
    store.services[provider] = {
      service: provider,
      mode: "oauth_pending",
      updatedAt: now,
    };
    store.updatedAt = now;
    await writeConnectionStore(paths, store);
    return {
      ok: true,
      provider,
      mode: "oauth_pending",
      storageFile: paths.connectionsFile,
      message: "No API key provided. Saved as pending connection.",
    };
  }

  const runner = opts.oauthRunner ?? defaultOauthRunner;
  const stdioMode = opts.oauthStdioMode ?? "pipe";
  const hasOauthCreds = await hasExistingOauthCredentials(provider, paths);
  if (hasOauthCreds) {
    store.services[provider] = {
      service: provider,
      mode: "oauth",
      updatedAt: now,
    };
    store.updatedAt = now;
    await writeConnectionStore(paths, store);
    const oauthCredentialsFile = await persistOauthCredentials(provider, paths);
    return {
      ok: true,
      provider,
      mode: "oauth",
      storageFile: paths.connectionsFile,
      message: "Existing OAuth credentials detected.",
      oauthCredentialsFile: oauthCredentialsFile ?? undefined,
    };
  }

  if (provider === "gemini-cli" && stdioMode !== "inherit") {
    return {
      ok: false,
      provider,
      message:
        "Gemini CLI OAuth is interactive and requires a TTY. Run `gemini` in a terminal to complete login, then retry /connect.",
    };
  }

  const candidates = oauthCommandCandidates(provider);
  let lastError = "OAuth command failed";

  for (let i = 0; i < candidates.length; i++) {
    const attempt = candidates[i];
    try {
      opts.onOauthLine?.(`[auth] running: ${attempt.display}`);
      const result = await runner({
        command: attempt.command,
        args: attempt.args,
        cwd: opts.cwd,
        stdioMode,
        onLine: opts.onOauthLine,
      });
      if (result.exitCode === 0) {
        store.services[provider] = {
          service: provider,
          mode: "oauth",
          updatedAt: now,
        };
        store.updatedAt = now;
        await writeConnectionStore(paths, store);
        const oauthCredentialsFile = await persistOauthCredentials(provider, paths);
        return {
          ok: true,
          provider,
          mode: "oauth",
          storageFile: paths.connectionsFile,
          message: "OAuth sign-in completed.",
          oauthCommand: attempt.display,
          oauthCredentialsFile: oauthCredentialsFile ?? undefined,
        };
      }
      lastError =
        result.signal !== null
          ? `OAuth command terminated by signal ${String(result.signal)}`
          : `OAuth command exited with code ${String(result.exitCode)}`;
      opts.onOauthLine?.(`[auth] ${lastError}`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      opts.onOauthLine?.(`[auth] ${lastError}`);
    }

    if (i < candidates.length - 1) {
      opts.onOauthLine?.("[auth] trying fallback command...");
    }
  }

  return {
    ok: false,
    provider,
    message: `OAuth sign-in failed: ${lastError}`,
  };
}
