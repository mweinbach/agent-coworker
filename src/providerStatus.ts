import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAiCoworkerPaths, readConnectionStore, type AiCoworkerPaths, type ConnectionStore } from "./connect";
import { PROVIDER_NAMES, type ProviderName } from "./types";

export type ProviderStatusMode = "missing" | "error" | "api_key" | "oauth" | "oauth_pending";

export type ProviderAccount = {
  email?: string;
  name?: string;
};

export type ProviderStatus = {
  provider: ProviderName;
  authorized: boolean;
  verified: boolean;
  mode: ProviderStatusMode;
  account: ProviderAccount | null;
  message: string;
  checkedAt: string;
};

export type CommandRunner = (opts: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;

const defaultCommandRunner: CommandRunner = async ({ command, args, cwd, env, timeoutMs }) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const onData = (buf: Buffer, which: "stdout" | "stderr") => {
      const str = buf.toString("utf-8");
      if (which === "stdout") stdout += str;
      else stderr += str;
    };

    child.stdout?.on("data", (b) => onData(b as Buffer, "stdout"));
    child.stderr?.on("data", (b) => onData(b as Buffer, "stderr"));

    let timeout: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    child.once("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.once("close", (exitCode, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
};

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function readJsonFile<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function base64UrlDecodeToString(s: string): string | null {
  try {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = base64UrlDecodeToString(parts[1] ?? "");
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return isObjectLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function joinUrl(base: string, suffix: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${b}${s}`;
}

function normalizeProviderStatusMode(mode: unknown): ProviderStatusMode {
  return mode === "api_key" || mode === "oauth" || mode === "oauth_pending" ? mode : "missing";
}

function statusFromConnectionStore(opts: {
  provider: ProviderName;
  store: ConnectionStore;
  checkedAt: string;
}): ProviderStatus {
  const entry = opts.store.services[opts.provider];
  if (!entry) {
    return {
      provider: opts.provider,
      authorized: false,
      verified: false,
      mode: "missing",
      account: null,
      message: "Not connected.",
      checkedAt: opts.checkedAt,
    };
  }

  if (entry.mode === "api_key") {
    return {
      provider: opts.provider,
      authorized: Boolean(entry.apiKey),
      verified: false,
      mode: "api_key",
      account: null,
      message: entry.apiKey ? "API key saved." : "API key missing.",
      checkedAt: opts.checkedAt,
    };
  }

  if (entry.mode === "oauth_pending") {
    return {
      provider: opts.provider,
      authorized: false,
      verified: false,
      mode: "oauth_pending",
      account: null,
      message: "Pending connection (no credentials).",
      checkedAt: opts.checkedAt,
    };
  }

  if (entry.mode === "oauth") {
    return {
      provider: opts.provider,
      authorized: true,
      verified: false,
      mode: "oauth",
      account: null,
      message: "OAuth connected.",
      checkedAt: opts.checkedAt,
    };
  }

  return {
    provider: opts.provider,
    authorized: true,
    verified: false,
    mode: normalizeProviderStatusMode(entry.mode),
    account: null,
    message: "Configured.",
    checkedAt: opts.checkedAt,
  };
}

type CodexAuthFile = {
  tokens?: {
    id_token?: string;
    access_token?: string;
  };
};

async function loadCodexAuthFile(paths: AiCoworkerPaths): Promise<{ file: string; auth: CodexAuthFile } | null> {
  const homeDir = path.dirname(paths.rootDir);
  const upstream = path.join(homeDir, ".codex", "auth.json");
  const persisted = path.join(paths.authDir, "codex-cli", "auth.json");

  for (const candidate of [upstream, persisted]) {
    if (!(await fileExists(candidate))) continue;
    const auth = await readJsonFile<CodexAuthFile>(candidate);
    if (!auth || !isObjectLike(auth)) continue;
    return { file: candidate, auth };
  }

  return null;
}

async function codexOidcUserInfo(opts: {
  idToken: string;
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<{ email?: string; name?: string; message: string; ok: boolean }> {
  const payload = decodeJwtPayload(opts.idToken);
  const email = typeof payload?.email === "string" ? payload.email : undefined;
  const iss = typeof payload?.iss === "string" ? payload.iss : null;
  if (!iss) {
    return { email, ok: false, message: "Codex id_token missing issuer; cannot resolve userinfo endpoint." };
  }

  try {
    const wellKnownUrl = joinUrl(iss, "/.well-known/openid-configuration");
    const wkRes = await opts.fetchImpl(wellKnownUrl, { method: "GET" });
    if (!wkRes.ok) {
      return { email, ok: false, message: `Failed to fetch OIDC discovery (${wkRes.status}).` };
    }
    const wkJson = (await wkRes.json()) as any;
    const userinfo = typeof wkJson?.userinfo_endpoint === "string" ? wkJson.userinfo_endpoint : null;
    if (!userinfo) {
      return { email, ok: false, message: "OIDC discovery missing userinfo_endpoint." };
    }

    const uiRes = await opts.fetchImpl(userinfo, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.accessToken}` },
    });
    if (!uiRes.ok) {
      return { email, ok: false, message: `OIDC userinfo failed (${uiRes.status}).` };
    }

    const uiJson = (await uiRes.json()) as any;
    const name = typeof uiJson?.name === "string" ? uiJson.name : undefined;
    const uiEmail = typeof uiJson?.email === "string" ? uiJson.email : undefined;
    return { email: uiEmail ?? email, name, ok: true, message: "Verified via OIDC userinfo." };
  } catch (err) {
    return { email, ok: false, message: `OIDC userinfo error: ${String(err)}` };
  }
}

async function getCodexCliStatus(opts: {
  paths: AiCoworkerPaths;
  store: ConnectionStore;
  checkedAt: string;
  runner: CommandRunner;
  fetchImpl: typeof fetch;
}): Promise<ProviderStatus> {
  const base = statusFromConnectionStore({ provider: "codex-cli", store: opts.store, checkedAt: opts.checkedAt });

  // Respect an explicitly saved API key, but never surface it.
  const entry = opts.store.services["codex-cli"];
  if (entry?.mode === "api_key" && entry.apiKey) {
    return { ...base, provider: "codex-cli", authorized: true, mode: "api_key", verified: false, account: null };
  }

  const authFile = await loadCodexAuthFile(opts.paths);
  const idToken = authFile?.auth?.tokens?.id_token;
  const accessToken = authFile?.auth?.tokens?.access_token;

  if (!idToken || !accessToken) {
    return {
      ...base,
      provider: "codex-cli",
      authorized: false,
      verified: false,
      mode: base.mode === "oauth_pending" ? "oauth_pending" : "missing",
      account: null,
      message: "Not logged in to Codex CLI. Run codex login.",
    };
  }

  const jwtPayload = decodeJwtPayload(idToken);
  const jwtEmail = typeof jwtPayload?.email === "string" ? jwtPayload.email : undefined;

  let codexStatusOk = false;
  try {
    const res = await opts.runner({ command: "codex", args: ["login", "status"], timeoutMs: 10_000 });
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    codexStatusOk = res.exitCode === 0 && /logged in/i.test(combined);
  } catch {
    codexStatusOk = false;
  }

  const ui = await codexOidcUserInfo({ idToken, accessToken, fetchImpl: opts.fetchImpl });
  const account: ProviderAccount | null =
    ui.email || ui.name || jwtEmail ? { email: ui.email ?? jwtEmail, name: ui.name } : null;

  if (ui.ok) {
    return {
      provider: "codex-cli",
      authorized: true,
      verified: true,
      mode: "oauth",
      account,
      message: ui.message,
      checkedAt: opts.checkedAt,
    };
  }

  if (codexStatusOk) {
    return {
      provider: "codex-cli",
      authorized: true,
      verified: true,
      mode: "oauth",
      account,
      message: `Codex CLI logged in. ${ui.message}`,
      checkedAt: opts.checkedAt,
    };
  }

  return {
    provider: "codex-cli",
    authorized: true,
    verified: false,
    mode: "oauth",
    account,
    message: `Codex credentials present, but verification failed. ${ui.message}`,
    checkedAt: opts.checkedAt,
  };
}

type ClaudeCreds = Record<string, unknown>;

function extractClaudeAccount(creds: ClaudeCreds): ProviderAccount | null {
  const tryGet = (obj: unknown, keys: string[]): unknown => {
    let cur: any = obj;
    for (const k of keys) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[k];
    }
    return cur;
  };

  const email =
    (typeof creds.email === "string" && creds.email) ||
    (typeof tryGet(creds, ["user", "email"]) === "string" ? (tryGet(creds, ["user", "email"]) as string) : "") ||
    (typeof tryGet(creds, ["account", "email"]) === "string" ? (tryGet(creds, ["account", "email"]) as string) : "") ||
    (typeof tryGet(creds, ["profile", "email"]) === "string" ? (tryGet(creds, ["profile", "email"]) as string) : "");

  const name =
    (typeof creds.name === "string" && creds.name) ||
    (typeof tryGet(creds, ["user", "name"]) === "string" ? (tryGet(creds, ["user", "name"]) as string) : "") ||
    (typeof tryGet(creds, ["account", "name"]) === "string" ? (tryGet(creds, ["account", "name"]) as string) : "") ||
    (typeof tryGet(creds, ["profile", "name"]) === "string" ? (tryGet(creds, ["profile", "name"]) as string) : "");

  const out: ProviderAccount = {};
  if (email) out.email = email;
  if (name) out.name = name;
  return out.email || out.name ? out : null;
}

type ClaudeAuthMaterial = {
  source: string;
  account: ProviderAccount | null;
  accessToken?: string;
  idToken?: string;
};

function getClaudeCodeConfigDir(paths: AiCoworkerPaths): string {
  const homeDir = path.dirname(paths.rootDir);
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, ".claude");
}

function getClaudeCodeKeychainAccountName(): string {
  const envUser = (process.env.USER ?? "").trim();
  if (envUser) return envUser;
  try {
    return os.userInfo().username;
  } catch {
    return "claude-code-user";
  }
}

function claudeCodeServiceNameCandidates(configDir: string): string[] {
  const base = "Claude Code";
  const oauthSuffixes = ["", "-custom-oauth", "-local-oauth", "-staging-oauth"];

  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  const hashSuffixes = ["", `-${hash}`];

  const out: string[] = [];
  for (const oauthSuffix of oauthSuffixes) {
    for (const hashSuffix of hashSuffixes) {
      out.push(`${base}${oauthSuffix}-credentials${hashSuffix}`);
    }
  }
  // De-dupe while preserving order.
  return out.filter((s, i) => out.indexOf(s) === i);
}

function extractClaudeTokens(creds: ClaudeCreds): { accessToken?: string; idToken?: string } {
  const tryGet = (obj: unknown, keys: string[]): unknown => {
    let cur: any = obj;
    for (const k of keys) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[k];
    }
    return cur;
  };

  const accessTokenCandidates: unknown[] = [
    creds.accessToken,
    creds.access_token,
    tryGet(creds, ["claudeAiOauth", "accessToken"]),
    tryGet(creds, ["claudeAiOauth", "access_token"]),
    tryGet(creds, ["consoleOauth", "accessToken"]),
    tryGet(creds, ["consoleOauth", "access_token"]),
    tryGet(creds, ["tokens", "accessToken"]),
    tryGet(creds, ["tokens", "access_token"]),
    tryGet(creds, ["token", "accessToken"]),
    tryGet(creds, ["token", "access_token"]),
    tryGet(creds, ["auth", "accessToken"]),
    tryGet(creds, ["auth", "access_token"]),
  ];

  const idTokenCandidates: unknown[] = [
    creds.idToken,
    creds.id_token,
    tryGet(creds, ["claudeAiOauth", "idToken"]),
    tryGet(creds, ["claudeAiOauth", "id_token"]),
    tryGet(creds, ["consoleOauth", "idToken"]),
    tryGet(creds, ["consoleOauth", "id_token"]),
    tryGet(creds, ["tokens", "idToken"]),
    tryGet(creds, ["tokens", "id_token"]),
    tryGet(creds, ["token", "idToken"]),
    tryGet(creds, ["token", "id_token"]),
    tryGet(creds, ["auth", "idToken"]),
    tryGet(creds, ["auth", "id_token"]),
  ];

  const pick = (candidates: unknown[]): string | undefined => {
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return undefined;
  };

  return { accessToken: pick(accessTokenCandidates), idToken: pick(idTokenCandidates) };
}

function accountFromClaudeIdToken(idToken: string | undefined): ProviderAccount | null {
  if (!idToken) return null;
  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;

  const email =
    typeof payload.email === "string"
      ? payload.email
      : typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : undefined;
  const name =
    typeof payload.name === "string"
      ? payload.name
      : typeof payload.given_name === "string" || typeof payload.family_name === "string"
        ? `${typeof payload.given_name === "string" ? payload.given_name : ""} ${typeof payload.family_name === "string" ? payload.family_name : ""}`.trim()
        : undefined;

  const out: ProviderAccount = {};
  if (email) out.email = email;
  if (name) out.name = name;
  return out.email || out.name ? out : null;
}

async function loadClaudeCredentialsFromFile(filePath: string): Promise<ClaudeAuthMaterial | null> {
  if (!(await fileExists(filePath))) return null;
  const creds = await readJsonFile<ClaudeCreds>(filePath);
  if (!creds || !isObjectLike(creds)) return null;

  const tokens = extractClaudeTokens(creds);
  const fromCreds = extractClaudeAccount(creds);
  const fromIdToken = accountFromClaudeIdToken(tokens.idToken);
  const account = fromCreds ?? fromIdToken;

  return { source: filePath, account, accessToken: tokens.accessToken, idToken: tokens.idToken };
}

async function loadClaudeCredentialsFromKeychain(opts: {
  paths: AiCoworkerPaths;
  runner: CommandRunner;
}): Promise<ClaudeAuthMaterial | null> {
  if (process.platform !== "darwin") return null;
  const configDir = getClaudeCodeConfigDir(opts.paths);
  const accountName = getClaudeCodeKeychainAccountName();
  const serviceCandidates = claudeCodeServiceNameCandidates(configDir);

  for (const serviceName of serviceCandidates) {
    try {
      const res = await opts.runner({
        command: "security",
        args: ["find-generic-password", "-a", accountName, "-w", "-s", serviceName],
        timeoutMs: 5_000,
      });
      if (res.exitCode !== 0) continue;
      const secret = (res.stdout || "").trim();
      if (!secret) continue;

      let credsObj: ClaudeCreds | null = null;
      try {
        const parsed = JSON.parse(secret) as unknown;
        if (isObjectLike(parsed)) credsObj = parsed as ClaudeCreds;
      } catch {
        credsObj = null;
      }
      if (!credsObj) {
        // Some installs may store a raw token string.
        credsObj = { accessToken: secret };
      }

      const tokens = extractClaudeTokens(credsObj);
      const fromCreds = extractClaudeAccount(credsObj);
      const fromIdToken = accountFromClaudeIdToken(tokens.idToken);
      const account = fromCreds ?? fromIdToken;

      return {
        source: `keychain:${serviceName}`,
        account,
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
      };
    } catch {
      // ignore and continue
    }
  }

  return null;
}

async function loadClaudeAuthMaterial(opts: {
  paths: AiCoworkerPaths;
  runner: CommandRunner;
}): Promise<ClaudeAuthMaterial | null> {
  const homeDir = path.dirname(opts.paths.rootDir);
  const configDir = getClaudeCodeConfigDir(opts.paths);
  const fileCandidates = [
    // Persisted copies under ~/.cowork/auth
    path.join(opts.paths.authDir, "claude-code", "credentials.json"),
    path.join(opts.paths.authDir, "claude-code", ".credentials.json"),

    // Upstream Claude Code plaintext fallback
    path.join(configDir, ".credentials.json"),

    // Legacy / alternate locations (best-effort)
    path.join(homeDir, ".claude", "credentials.json"),
    path.join(homeDir, ".config", "claude", "credentials.json"),
  ];

  for (const candidate of fileCandidates) {
    const file = await loadClaudeCredentialsFromFile(candidate);
    if (file) return file;
  }

  return await loadClaudeCredentialsFromKeychain({ paths: opts.paths, runner: opts.runner });
}

function mergeAccounts(a: ProviderAccount | null, b: ProviderAccount | null): ProviderAccount | null {
  if (!a && !b) return null;
  return { email: b?.email ?? a?.email, name: b?.name ?? a?.name };
}

async function claudeOauthProfile(opts: {
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<{ ok: boolean; message: string; account: ProviderAccount | null }> {
  const base = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL?.replace(/\/$/, "") || "https://api.anthropic.com";
  const url = joinUrl(base, "/api/oauth/profile");
  try {
    const res = await opts.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.accessToken}`, "content-type": "application/json" },
    });
    if (!res.ok) {
      return { ok: false, message: `OAuth profile request failed (${res.status}).`, account: null };
    }
    const json = (await res.json()) as any;
    const accountObj = isObjectLike(json?.account) ? json.account : null;
    const email =
      (typeof accountObj?.email === "string" ? accountObj.email : undefined) ??
      (typeof accountObj?.email_address === "string" ? accountObj.email_address : undefined) ??
      (typeof accountObj?.emailAddress === "string" ? accountObj.emailAddress : undefined);
    const name =
      (typeof accountObj?.display_name === "string" ? accountObj.display_name : undefined) ??
      (typeof accountObj?.displayName === "string" ? accountObj.displayName : undefined) ??
      (typeof accountObj?.name === "string" ? accountObj.name : undefined);

    const out: ProviderAccount = {};
    if (email && email.trim()) out.email = email.trim();
    if (name && name.trim()) out.name = name.trim();
    return { ok: true, message: "Loaded Claude account profile.", account: out.email || out.name ? out : null };
  } catch (err) {
    return { ok: false, message: `OAuth profile error: ${String(err)}`, account: null };
  }
}

async function verifyClaudeCli(opts: { runner: CommandRunner }): Promise<{ ok: boolean; message: string }> {
  const systemPrompt = "You are a health check. Reply with exactly: ok";
  try {
    const res = await opts.runner({
      command: "claude",
      args: [
        "-p",
        "--output-format=json",
        "--model",
        "haiku",
        "--tools",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--system-prompt",
        systemPrompt,
        "hi",
      ],
      timeoutMs: 20_000,
    });

    const raw = (res.stdout || "").trim();
    if (res.exitCode !== 0) {
      const err = `${raw}\n${res.stderr || ""}`.trim();
      return { ok: false, message: err || `claude exited with code ${String(res.exitCode)}` };
    }

    const parsed = JSON.parse(raw) as any;
    const isOk = parsed && parsed.type === "result" && parsed.subtype === "success" && parsed.is_error === false;
    if (!isOk) {
      return { ok: false, message: "Claude CLI returned unexpected output." };
    }
    return { ok: true, message: "Verified via Claude CLI." };
  } catch (err) {
    return { ok: false, message: `Claude CLI verify failed: ${String(err)}` };
  }
}

async function getClaudeCodeStatus(opts: {
  paths: AiCoworkerPaths;
  store: ConnectionStore;
  checkedAt: string;
  runner: CommandRunner;
  fetchImpl: typeof fetch;
}): Promise<ProviderStatus> {
  const base = statusFromConnectionStore({ provider: "claude-code", store: opts.store, checkedAt: opts.checkedAt });

  // Respect an explicitly saved API key, but never surface it.
  const entry = opts.store.services["claude-code"];
  if (entry?.mode === "api_key" && entry.apiKey) {
    return { ...base, provider: "claude-code", authorized: true, mode: "api_key", verified: false, account: null };
  }

  const verify = await verifyClaudeCli({ runner: opts.runner });
  const material = verify.ok ? await loadClaudeAuthMaterial({ paths: opts.paths, runner: opts.runner }) : null;
  let account = material?.account ?? null;

  // If we can, fetch the OAuth profile to get a stable name/email.
  if (verify.ok && material?.accessToken && (!account?.email || !account?.name)) {
    const profile = await claudeOauthProfile({ accessToken: material.accessToken, fetchImpl: opts.fetchImpl });
    if (profile.ok) account = mergeAccounts(account, profile.account);
  }

  return {
    provider: "claude-code",
    authorized: verify.ok,
    verified: verify.ok,
    mode: verify.ok ? "oauth" : base.mode === "oauth_pending" ? "oauth_pending" : "missing",
    account,
    message: verify.ok ? verify.message : `Not authorized. ${verify.message}`.trim(),
    checkedAt: opts.checkedAt,
  };
}

export async function getProviderStatuses(opts: {
  homedir?: string;
  paths?: AiCoworkerPaths;
  runner?: CommandRunner;
  fetchImpl?: typeof fetch;
  now?: () => Date;
} = {}): Promise<ProviderStatus[]> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
  const runner = opts.runner ?? defaultCommandRunner;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());

  const checkedAt = now().toISOString();
  const store = await readConnectionStore(paths);

  const out: ProviderStatus[] = [];
  for (const provider of PROVIDER_NAMES) {
    if (provider === "codex-cli") {
      out.push(await getCodexCliStatus({ paths, store, checkedAt, runner, fetchImpl }));
      continue;
    }
    if (provider === "claude-code") {
      out.push(await getClaudeCodeStatus({ paths, store, checkedAt, runner, fetchImpl }));
      continue;
    }
    out.push(statusFromConnectionStore({ provider, store, checkedAt }));
  }

  return out;
}
