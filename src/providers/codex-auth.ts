import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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

const nonEmptyStringSchema = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });
const codexAuthDocumentSchema = z.object({
  version: z.literal(1),
  auth_mode: z.literal("chatgpt"),
  issuer: nonEmptyStringSchema.optional(),
  client_id: nonEmptyStringSchema.optional(),
  tokens: z.object({
    access_token: nonEmptyStringSchema,
    refresh_token: nonEmptyStringSchema.optional(),
    id_token: nonEmptyStringSchema.optional(),
    expires_at: z.union([z.number().finite(), nonEmptyStringSchema]).optional(),
  }).strict(),
  account: z.object({
    account_id: nonEmptyStringSchema.optional(),
    email: nonEmptyStringSchema.optional(),
    plan_type: nonEmptyStringSchema.optional(),
  }).strict().optional(),
  updated_at: isoTimestampSchema.optional(),
  last_refresh: isoTimestampSchema.optional(),
}).strict();

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
async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON in Codex auth file ${filePath}: ${String(error)}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function parseCodexAuthJson(file: string, json: unknown): CodexAuthMaterial {
  const parsed = codexAuthDocumentSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid Codex auth schema at ${file}: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }

  const doc = parsed.data;
  const accessToken = doc.tokens.access_token;
  const refreshToken = doc.tokens.refresh_token;
  const idToken = doc.tokens.id_token;
  const expiresAtMs = toEpochMs(doc.tokens.expires_at) ?? extractJwtExpiryMs(accessToken);

  const idClaims = idToken ? decodeJwtPayload(idToken) : null;
  const accessClaims = decodeJwtPayload(accessToken);

  const accountId =
    doc.account?.account_id ??
    (idClaims ? extractAccountIdFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractAccountIdFromClaims(accessClaims) : undefined);

  const email =
    doc.account?.email ??
    (idClaims ? extractEmailFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractEmailFromClaims(accessClaims) : undefined);

  const planType =
    doc.account?.plan_type ??
    (idClaims ? extractPlanTypeFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractPlanTypeFromClaims(accessClaims) : undefined);

  return {
    file,
    issuer: doc.issuer ?? CODEX_OAUTH_ISSUER,
    clientId: doc.client_id ?? CODEX_OAUTH_CLIENT_ID,
    accessToken,
    refreshToken,
    idToken,
    expiresAtMs,
    accountId,
    email,
    planType,
    updatedAt: doc.updated_at ?? doc.last_refresh,
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
  _opts: { onLine?: (line: string) => void } = {}
): Promise<CodexAuthMaterial | null> {
  const coworkFile = codexAuthFilePath(paths);
  const coworkJson = await readJsonFile(coworkFile);
  if (!coworkJson) return null;
  return parseCodexAuthJson(coworkFile, coworkJson);
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
