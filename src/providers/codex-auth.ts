import fs from "node:fs/promises";
import path from "node:path";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";

export type CodexAuthPaths = {
  authDir: string;
  rootDir: string;
};

export type CodexOAuthTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  [key: string]: unknown;
};

export type CodexAuthMaterial = {
  file: string;
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAtMs?: number;
  accountId?: string;
  email?: string;
  planType?: string;
  updatedAt?: string;
};

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toEpochMs(value: unknown): number | undefined {
  const parsed = toNumber(value);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) return undefined;
  return parsed < 1e12 ? Math.floor(parsed * 1000) : Math.floor(parsed);
}

function readStringAt(root: unknown, keys: string[]): string | undefined {
  let cur: unknown = root;
  for (const key of keys) {
    if (!isObjectLike(cur)) return undefined;
    cur = cur[key];
  }
  if (typeof cur !== "string") return undefined;
  const trimmed = cur.trim();
  return trimmed ? trimmed : undefined;
}

function readNumberAt(root: unknown, keys: string[]): number | undefined {
  let cur: unknown = root;
  for (const key of keys) {
    if (!isObjectLike(cur)) return undefined;
    cur = cur[key];
  }
  return toNumber(cur);
}

function base64UrlDecodeToString(value: string): string | null {
  try {
    const pad = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + pad).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payloadRaw = base64UrlDecodeToString(parts[1] ?? "");
  if (!payloadRaw) return null;
  try {
    const parsed = JSON.parse(payloadRaw);
    return isObjectLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractJwtExpiryMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  const exp = toNumber(payload?.exp);
  if (!exp || exp <= 0) return undefined;
  return Math.floor(exp * 1000);
}

export function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = typeof claims.chatgpt_account_id === "string" ? claims.chatgpt_account_id : undefined;
  if (direct) return direct;

  const nestedAuth = isObjectLike(claims["https://api.openai.com/auth"])
    ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
    : null;
  const nested = nestedAuth && typeof nestedAuth.chatgpt_account_id === "string" ? nestedAuth.chatgpt_account_id : undefined;
  if (nested) return nested;

  if (Array.isArray(claims.organizations)) {
    for (const item of claims.organizations) {
      if (!isObjectLike(item)) continue;
      if (typeof item.id === "string" && item.id.trim()) return item.id;
    }
  }

  const orgId = typeof claims.organization_id === "string" ? claims.organization_id : undefined;
  if (orgId) return orgId;

  const account = typeof claims.account_id === "string" ? claims.account_id : undefined;
  if (account) return account;

  return undefined;
}

export function extractEmailFromClaims(claims: Record<string, unknown>): string | undefined {
  if (typeof claims.email === "string" && claims.email.trim()) return claims.email;
  const profile = isObjectLike(claims["https://api.openai.com/profile"])
    ? (claims["https://api.openai.com/profile"] as Record<string, unknown>)
    : null;
  if (profile && typeof profile.email === "string" && profile.email.trim()) return profile.email;
  return undefined;
}

export function extractPlanTypeFromClaims(claims: Record<string, unknown>): string | undefined {
  const nestedAuth = isObjectLike(claims["https://api.openai.com/auth"])
    ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
    : null;
  if (nestedAuth && typeof nestedAuth.chatgpt_plan_type === "string" && nestedAuth.chatgpt_plan_type.trim()) {
    return nestedAuth.chatgpt_plan_type;
  }
  if (typeof claims.chatgpt_plan_type === "string" && claims.chatgpt_plan_type.trim()) {
    return claims.chatgpt_plan_type;
  }
  return undefined;
}

export function codexAuthFilePath(paths: Pick<CodexAuthPaths, "authDir">): string {
  return path.join(paths.authDir, "codex-cli", "auth.json");
}

export function legacyCodexAuthFilePath(paths: Pick<CodexAuthPaths, "rootDir">): string {
  const homeDir = path.dirname(paths.rootDir);
  return path.join(homeDir, ".codex", "auth.json");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseCodexAuthJson(file: string, json: unknown): CodexAuthMaterial | null {
  if (!isObjectLike(json)) return null;

  const accessToken =
    readStringAt(json, ["tokens", "access_token"]) ??
    readStringAt(json, ["access_token"]) ??
    readStringAt(json, ["auth", "access_token"]);
  if (!accessToken) return null;

  const refreshToken =
    readStringAt(json, ["tokens", "refresh_token"]) ??
    readStringAt(json, ["refresh_token"]) ??
    readStringAt(json, ["auth", "refresh_token"]);
  const idToken =
    readStringAt(json, ["tokens", "id_token"]) ??
    readStringAt(json, ["id_token"]) ??
    readStringAt(json, ["auth", "id_token"]);

  const expiresAtMs =
    toEpochMs(readNumberAt(json, ["tokens", "expires_at"])) ??
    toEpochMs(readNumberAt(json, ["expires_at"])) ??
    extractJwtExpiryMs(accessToken);

  const idClaims = idToken ? decodeJwtPayload(idToken) : null;
  const accessClaims = decodeJwtPayload(accessToken);

  const accountId =
    readStringAt(json, ["account", "account_id"]) ??
    readStringAt(json, ["chatgpt_account_id"]) ??
    (idClaims ? extractAccountIdFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractAccountIdFromClaims(accessClaims) : undefined);

  const email =
    readStringAt(json, ["account", "email"]) ??
    (idClaims ? extractEmailFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractEmailFromClaims(accessClaims) : undefined);

  const planType =
    readStringAt(json, ["account", "plan_type"]) ??
    (idClaims ? extractPlanTypeFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractPlanTypeFromClaims(accessClaims) : undefined);

  const issuer = readStringAt(json, ["issuer"]) ?? CODEX_OAUTH_ISSUER;
  const clientId = readStringAt(json, ["client_id"]) ?? CODEX_OAUTH_CLIENT_ID;
  const updatedAt = readStringAt(json, ["updated_at"]) ?? readStringAt(json, ["last_refresh"]);

  return {
    file,
    issuer,
    clientId,
    accessToken,
    refreshToken,
    idToken,
    expiresAtMs,
    accountId,
    email,
    planType,
    updatedAt,
  };
}

function formatAuthJson(material: CodexAuthMaterial): Record<string, unknown> {
  const now = new Date().toISOString();
  const tokens: Record<string, unknown> = {
    access_token: material.accessToken,
  };
  if (material.refreshToken) tokens.refresh_token = material.refreshToken;
  if (material.idToken) tokens.id_token = material.idToken;
  if (material.expiresAtMs) tokens.expires_at = material.expiresAtMs;

  const account: Record<string, unknown> = {};
  if (material.accountId) account.account_id = material.accountId;
  if (material.email) account.email = material.email;
  if (material.planType) account.plan_type = material.planType;

  return {
    version: 1,
    auth_mode: "chatgpt",
    issuer: material.issuer || CODEX_OAUTH_ISSUER,
    client_id: material.clientId || CODEX_OAUTH_CLIENT_ID,
    tokens,
    ...(Object.keys(account).length ? { account } : {}),
    updated_at: now,
    last_refresh: now,
  };
}

export async function writeCodexAuthMaterial(
  paths: Pick<CodexAuthPaths, "authDir">,
  material: Omit<CodexAuthMaterial, "file"> & { file?: string }
): Promise<CodexAuthMaterial> {
  const file = material.file ?? codexAuthFilePath(paths);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // best effort only
  }

  const normalized: CodexAuthMaterial = {
    file,
    issuer: material.issuer || CODEX_OAUTH_ISSUER,
    clientId: material.clientId || CODEX_OAUTH_CLIENT_ID,
    accessToken: material.accessToken,
    refreshToken: material.refreshToken,
    idToken: material.idToken,
    expiresAtMs: material.expiresAtMs ?? extractJwtExpiryMs(material.accessToken),
    accountId: material.accountId,
    email: material.email,
    planType: material.planType,
    updatedAt: new Date().toISOString(),
  };

  const json = formatAuthJson(normalized);
  await fs.writeFile(file, JSON.stringify(json, null, 2), { encoding: "utf-8", mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // best effort only
  }
  return normalized;
}

export async function readCodexAuthMaterial(
  paths: CodexAuthPaths,
  opts: { migrateLegacy?: boolean; onLine?: (line: string) => void } = {}
): Promise<CodexAuthMaterial | null> {
  const coworkFile = codexAuthFilePath(paths);
  const coworkJson = await readJsonFile(coworkFile);
  const coworkParsed = parseCodexAuthJson(coworkFile, coworkJson);
  if (coworkParsed) return coworkParsed;

  if (!opts.migrateLegacy) return null;

  const legacyFile = legacyCodexAuthFilePath(paths);
  if (!(await fileExists(legacyFile))) return null;

  const legacyJson = await readJsonFile(legacyFile);
  const legacyParsed = parseCodexAuthJson(legacyFile, legacyJson);
  if (!legacyParsed) return null;

  const migrated = await writeCodexAuthMaterial(paths, {
    ...legacyParsed,
    file: coworkFile,
  });
  opts.onLine?.(`[auth] migrated legacy Codex credentials from ${legacyFile}`);
  return migrated;
}

function expiresInMsFromResponse(payload: CodexOAuthTokenResponse): number | undefined {
  const expiresIn = toNumber(payload.expires_in);
  if (!expiresIn || expiresIn <= 0) return undefined;
  return Math.floor(expiresIn * 1000);
}

export function codexMaterialFromTokenResponse(
  file: string,
  payload: CodexOAuthTokenResponse,
  opts: {
    issuer?: string;
    clientId?: string;
    fallbackRefreshToken?: string;
    fallbackIdToken?: string;
    fallbackAccountId?: string;
    fallbackEmail?: string;
    fallbackPlanType?: string;
  } = {}
): CodexAuthMaterial {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken.trim()) throw new Error("Token response missing access_token.");

  const refreshToken =
    (typeof payload.refresh_token === "string" ? payload.refresh_token : undefined) ?? opts.fallbackRefreshToken;
  const idToken = (typeof payload.id_token === "string" ? payload.id_token : undefined) ?? opts.fallbackIdToken;

  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = idToken ? decodeJwtPayload(idToken) : null;
  const accountId =
    (idClaims ? extractAccountIdFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractAccountIdFromClaims(accessClaims) : undefined) ??
    opts.fallbackAccountId;
  const email =
    (idClaims ? extractEmailFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractEmailFromClaims(accessClaims) : undefined) ??
    opts.fallbackEmail;
  const planType =
    (idClaims ? extractPlanTypeFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractPlanTypeFromClaims(accessClaims) : undefined) ??
    opts.fallbackPlanType;

  const expiresAtMs =
    (() => {
      const delta = expiresInMsFromResponse(payload);
      if (delta !== undefined) return Date.now() + delta;
      return extractJwtExpiryMs(accessToken);
    })();

  return {
    file,
    issuer: opts.issuer ?? CODEX_OAUTH_ISSUER,
    clientId: opts.clientId ?? CODEX_OAUTH_CLIENT_ID,
    accessToken,
    refreshToken,
    idToken,
    expiresAtMs,
    accountId,
    email,
    planType,
    updatedAt: new Date().toISOString(),
  };
}

export async function persistCodexAuthFromTokenResponse(
  paths: Pick<CodexAuthPaths, "authDir">,
  payload: CodexOAuthTokenResponse,
  opts: {
    issuer?: string;
    clientId?: string;
    fallbackRefreshToken?: string;
    fallbackIdToken?: string;
    fallbackAccountId?: string;
    fallbackEmail?: string;
    fallbackPlanType?: string;
  } = {}
): Promise<CodexAuthMaterial> {
  const file = codexAuthFilePath(paths);
  const material = codexMaterialFromTokenResponse(file, payload, opts);
  return await writeCodexAuthMaterial(paths, material);
}

export async function refreshCodexAuthMaterial(opts: {
  paths: Pick<CodexAuthPaths, "authDir">;
  material: CodexAuthMaterial;
  fetchImpl?: typeof fetch;
}): Promise<CodexAuthMaterial> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!opts.material.refreshToken) {
    throw new Error("Codex credentials missing refresh token. Re-authenticate.");
  }

  const endpoint = `${(opts.material.issuer || CODEX_OAUTH_ISSUER).replace(/\/$/, "")}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.material.refreshToken,
    client_id: opts.material.clientId || CODEX_OAUTH_CLIENT_ID,
  }).toString();

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${response.status}): ${text.slice(0, 500)}`.trim());
  }

  const payload = (await response.json()) as CodexOAuthTokenResponse;
  return await persistCodexAuthFromTokenResponse(opts.paths, payload, {
    issuer: opts.material.issuer,
    clientId: opts.material.clientId,
    fallbackRefreshToken: opts.material.refreshToken,
    fallbackIdToken: opts.material.idToken,
    fallbackAccountId: opts.material.accountId,
    fallbackEmail: opts.material.email,
    fallbackPlanType: opts.material.planType,
  });
}

export function isTokenExpiring(material: CodexAuthMaterial, marginMs = 60_000): boolean {
  const expiresAtMs = material.expiresAtMs ?? extractJwtExpiryMs(material.accessToken);
  if (!expiresAtMs) return false;
  return expiresAtMs - marginMs <= Date.now();
}
