import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ISSUER,
  isTokenExpiring,
  persistCodexAuthFromTokenResponse,
  readCodexAuthMaterial,
  refreshCodexAuthMaterial,
} from "./providers/codex-auth";
import type { ProviderName } from "./types";

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

export type OauthStdioMode = "pipe" | "inherit";

export type OauthCommandRunner = (opts: {
  command: string;
  args: string[];
  cwd?: string;
  stdioMode: OauthStdioMode;
  onLine?: (line: string) => void;
}) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;

export type UrlOpener = (url: string) => Promise<boolean>;

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

export async function readToolApiKey(opts: {
  name: ToolApiKeyName;
  paths?: AiCoworkerPaths;
  homedir?: string;
  readStore?: typeof readConnectionStore;
}): Promise<string | undefined> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
  const readStore = opts.readStore ?? readConnectionStore;
  const store = await readStore(paths);
  const value = store.toolApiKeys?.[opts.name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function writeToolApiKey(opts: {
  name: ToolApiKeyName;
  apiKey: string;
  paths?: AiCoworkerPaths;
  homedir?: string;
  readStore?: typeof readConnectionStore;
  writeStore?: typeof writeConnectionStore;
}): Promise<{ storageFile: string; maskedApiKey: string; message: string }> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
  const readStore = opts.readStore ?? readConnectionStore;
  const writeStore = opts.writeStore ?? writeConnectionStore;
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new Error("API key is required.");

  const store = await readStore(paths);
  store.toolApiKeys = {
    ...(store.toolApiKeys ?? {}),
    [opts.name]: apiKey,
  };
  store.updatedAt = new Date().toISOString();
  await writeStore(paths, store);

  return {
    storageFile: paths.connectionsFile,
    maskedApiKey: maskApiKey(apiKey),
    message: `${opts.name.toUpperCase()} API key saved.`,
  };
}

export function maskApiKey(value: string): string {
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function isOauthCliProvider(service: ConnectService): service is "codex-cli" {
  return service === "codex-cli";
}

function oauthCredentialCandidates(service: ConnectService, paths: AiCoworkerPaths): readonly string[] {
  const homeDir = path.dirname(paths.rootDir);
  switch (service) {
    case "codex-cli":
      return [path.join(paths.authDir, "codex-cli", "auth.json")];
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
    case "codex-cli":
      return [];
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
): readonly { command: string; args: string[]; display: string }[] {
  switch (service) {
    default:
      return [];
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkceVerifier(): string {
  return toBase64Url(randomBytes(64));
}

function generatePkceChallenge(verifier: string): string {
  const digest = createHash("sha256").update(verifier, "utf-8").digest();
  return toBase64Url(digest);
}

function generateOauthState(): string {
  return toBase64Url(randomBytes(32));
}

function buildCodexAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "agent-coworker",
  });
  return `${CODEX_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

const OAUTH_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Auth complete</title></head><body><h1>Authorization complete</h1><p>You can close this tab.</p></body></html>`;

const OAUTH_FAILURE_HTML = (message: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Auth failed</title></head><body><h1>Authorization failed</h1><p>${message}</p></body></html>`;

async function openExternalUrl(url: string): Promise<boolean> {
  try {
    const command =
      process.platform === "darwin"
        ? { cmd: "open", args: [url] }
        : process.platform === "win32"
          ? { cmd: "cmd", args: ["/c", "start", "", url] }
          : { cmd: "xdg-open", args: [url] };

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command.cmd, command.args, {
        stdio: ["ignore", "ignore", "ignore"],
        detached: process.platform !== "win32",
      });
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
      if (process.platform !== "win32") child.unref();
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function exchangeCodexAuthorizationCode(opts: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl: typeof fetch;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: opts.codeVerifier,
  }).toString();

  const response = await opts.fetchImpl(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 500)}`.trim());
  }

  const json = (await response.json()) as unknown;
  if (!isObjectLike(json)) throw new Error("Token exchange returned an invalid response.");
  return json;
}

const OAUTH_LOOPBACK_HOST = "127.0.0.1";

async function listenOnLocalhost(
  preferredPort: number,
  onRequest: Parameters<typeof createServer>[0]
): Promise<{ port: number; close: () => void }> {
  const isAddrInUse = (err: unknown): boolean => {
    return (err as { code?: string } | undefined)?.code === "EADDRINUSE";
  };

  const listen = async (port: number): Promise<{ port: number; close: () => void }> => {
    const server = createServer(onRequest);
    const resolvedPort = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error & { code?: string }) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Unable to determine local callback port."));
          return;
        }
        resolve(addr.port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, OAUTH_LOOPBACK_HOST);
    });
    return { port: resolvedPort, close: () => server.close() };
  };

  let lastErr: unknown;
  const tryListen = async (port: number): Promise<{ port: number; close: () => void } | null> => {
    try {
      return await listen(port);
    } catch (err) {
      lastErr = err;
      if (isAddrInUse(err)) return null;
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const preferred = await tryListen(preferredPort);
  if (preferred) return preferred;

  if (preferredPort !== 0) {
    const ephemeral = await tryListen(0);
    if (ephemeral) return ephemeral;
  }

  const min = 49152;
  const max = 65535;
  const attempts = 50;
  for (let i = 0; i < attempts; i++) {
    const candidate = min + Math.floor(Math.random() * (max - min + 1));
    const resolved = await tryListen(candidate);
    if (resolved) return resolved;
  }

  throw lastErr instanceof Error ? lastErr : new Error("Unable to bind localhost callback port.");
}

async function runCodexBrowserOAuth(opts: {
  paths: AiCoworkerPaths;
  fetchImpl: typeof fetch;
  onLine?: (line: string) => void;
  openUrl?: UrlOpener;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const codeVerifier = generatePkceVerifier();
  const codeChallenge = generatePkceChallenge(codeVerifier);
  const state = generateOauthState();
  const opener = opts.openUrl ?? openExternalUrl;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  let settled = false;
  const settle = (result: { code?: string; error?: Error }) => {
    if (settled) return;
    settled = true;
    if (result.error) rejectCode(result.error);
    else resolveCode(result.code ?? "");
  };

  const listener = await listenOnLocalhost(1455, (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/auth/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    const errorDescription = requestUrl.searchParams.get("error_description");
    if (error) {
      const message = errorDescription || error;
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(OAUTH_FAILURE_HTML(message));
      settle({ error: new Error(message) });
      return;
    }

    const receivedState = requestUrl.searchParams.get("state");
    if (receivedState !== state) {
      const message = "Invalid OAuth state.";
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(OAUTH_FAILURE_HTML(message));
      settle({ error: new Error(message) });
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      const message = "Missing authorization code.";
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(OAUTH_FAILURE_HTML(message));
      settle({ error: new Error(message) });
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(OAUTH_SUCCESS_HTML);
    settle({ code });
  });

  const redirectUri = `http://${OAUTH_LOOPBACK_HOST}:${listener.port}/auth/callback`;
  const authUrl = buildCodexAuthorizeUrl(redirectUri, codeChallenge, state);

  opts.onLine?.(`[auth] opening browser for Codex login`);
  const opened = await opener(authUrl);
  if (!opened) {
    opts.onLine?.(`[auth] open this URL to continue: ${authUrl}`);
  }

  const timeout = setTimeout(() => {
    settle({ error: new Error("OAuth callback timeout.") });
  }, timeoutMs);

  try {
    const code = await codePromise;
    const tokens = await exchangeCodexAuthorizationCode({
      code,
      redirectUri,
      codeVerifier,
      fetchImpl: opts.fetchImpl,
    });
    const material = await persistCodexAuthFromTokenResponse(opts.paths, tokens, {
      issuer: CODEX_OAUTH_ISSUER,
      clientId: CODEX_OAUTH_CLIENT_ID,
    });
    return material.file;
  } finally {
    clearTimeout(timeout);
    listener.close();
  }
}

async function runCodexDeviceOAuth(opts: {
  paths: AiCoworkerPaths;
  fetchImpl: typeof fetch;
  onLine?: (line: string) => void;
  openUrl?: UrlOpener;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const opener = opts.openUrl ?? openExternalUrl;
  const verificationUrl = `${CODEX_OAUTH_ISSUER}/codex/device`;

  const userCodeResponse = await opts.fetchImpl(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "agent-coworker" },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
  });
  if (!userCodeResponse.ok) {
    const text = await userCodeResponse.text().catch(() => "");
    throw new Error(`Failed to start device-code auth (${userCodeResponse.status}): ${text.slice(0, 500)}`.trim());
  }
  const userCodeData = (await userCodeResponse.json()) as Record<string, unknown>;
  const deviceAuthId = typeof userCodeData.device_auth_id === "string" ? userCodeData.device_auth_id : "";
  const userCode = typeof userCodeData.user_code === "string" ? userCodeData.user_code : "";
  const intervalSec = Math.max(1, Math.floor(toNumber(userCodeData.interval) ?? 5));
  if (!deviceAuthId || !userCode) throw new Error("Device-code auth response was missing required fields.");

  opts.onLine?.(`[auth] open ${verificationUrl} and enter code: ${userCode}`);
  await opener(verificationUrl);

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pollResponse = await opts.fetchImpl(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "agent-coworker" },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });

    if (pollResponse.ok) {
      const pollData = (await pollResponse.json()) as Record<string, unknown>;
      const authorizationCode = typeof pollData.authorization_code === "string" ? pollData.authorization_code : "";
      const codeVerifier = typeof pollData.code_verifier === "string" ? pollData.code_verifier : "";
      if (!authorizationCode || !codeVerifier) {
        throw new Error("Device-code token poll returned an invalid payload.");
      }

      const tokens = await exchangeCodexAuthorizationCode({
        code: authorizationCode,
        redirectUri: `${CODEX_OAUTH_ISSUER}/deviceauth/callback`,
        codeVerifier,
        fetchImpl: opts.fetchImpl,
      });
      const material = await persistCodexAuthFromTokenResponse(opts.paths, tokens, {
        issuer: CODEX_OAUTH_ISSUER,
        clientId: CODEX_OAUTH_CLIENT_ID,
      });
      return material.file;
    }

    if (pollResponse.status !== 403 && pollResponse.status !== 404) {
      const text = await pollResponse.text().catch(() => "");
      throw new Error(`Device-code auth failed (${pollResponse.status}): ${text.slice(0, 500)}`.trim());
    }

    await wait(intervalSec * 1000 + 3000);
  }

  throw new Error("Device-code auth timed out.");
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
  methodId?: string;
  code?: string;
  apiKey?: string;
  cwd?: string;
  paths?: AiCoworkerPaths;
  oauthStdioMode?: OauthStdioMode;
  onOauthLine?: (line: string) => void;
  oauthRunner?: OauthCommandRunner;
  fetchImpl?: typeof fetch;
  openUrl?: UrlOpener;
  oauthTimeoutMs?: number;
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

  if (provider === "codex-cli") {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const methodId = (opts.methodId ?? "oauth_cli").trim() || "oauth_cli";

    let existing = await readCodexAuthMaterial(paths, {
      migrateLegacy: true,
      onLine: opts.onOauthLine,
    });
    if (existing?.accessToken && isTokenExpiring(existing)) {
      if (existing.refreshToken) {
        try {
          existing = await refreshCodexAuthMaterial({
            paths,
            material: existing,
            fetchImpl,
          });
          opts.onOauthLine?.("[auth] refreshed existing Codex credentials.");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          opts.onOauthLine?.(`[auth] existing Codex credentials are stale: ${message}`);
        }
      } else {
        opts.onOauthLine?.("[auth] existing Codex credentials are expired and missing refresh token.");
      }
    }
    if (existing?.accessToken && !isTokenExpiring(existing, 0)) {
      store.services[provider] = {
        service: provider,
        mode: "oauth",
        updatedAt: now,
      };
      store.updatedAt = now;
      await writeConnectionStore(paths, store);
      return {
        ok: true,
        provider,
        mode: "oauth",
        storageFile: paths.connectionsFile,
        message: "Existing Codex OAuth credentials detected.",
        oauthCredentialsFile: existing.file,
      };
    }

    try {
      const oauthCredentialsFile =
        methodId === "oauth_device"
          ? await runCodexDeviceOAuth({
              paths,
              fetchImpl,
              onLine: opts.onOauthLine,
              openUrl: opts.openUrl,
              timeoutMs: opts.oauthTimeoutMs,
            })
          : await runCodexBrowserOAuth({
              paths,
              fetchImpl,
              onLine: opts.onOauthLine,
              openUrl: opts.openUrl,
              timeoutMs: opts.oauthTimeoutMs,
            });

      store.services[provider] = {
        service: provider,
        mode: "oauth",
        updatedAt: now,
      };
      store.updatedAt = now;
      await writeConnectionStore(paths, store);
      return {
        ok: true,
        provider,
        mode: "oauth",
        storageFile: paths.connectionsFile,
        message: "Codex OAuth sign-in completed.",
        oauthCredentialsFile,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        provider,
        message: `Codex OAuth sign-in failed: ${message}`,
      };
    }
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
