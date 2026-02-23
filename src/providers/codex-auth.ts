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
const recordSchema = z.record(z.string(), z.unknown());
const organizationsSchema = z.array(z.object({
  id: nonEmptyStringSchema.optional(),
}).passthrough());
const finiteNumberFromUnknownSchema = z.preprocess((value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}, z.number().finite());
const codexOAuthTokenResponseSchema = z.object({
  access_token: nonEmptyStringSchema,
  refresh_token: nonEmptyStringSchema.optional(),
  id_token: nonEmptyStringSchema.optional(),
  expires_in: finiteNumberFromUnknownSchema.optional(),
}).passthrough();
const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();
const jsonStringSchema = z.string();

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

const oauthNamespaceClaimsSchema = z.object({
  chatgpt_account_id: nonEmptyStringSchema.optional(),
  chatgpt_plan_type: nonEmptyStringSchema.optional(),
}).passthrough();

const profileNamespaceClaimsSchema = z.object({
  email: nonEmptyStringSchema.optional(),
}).passthrough();

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseTokenResponse(
  payload: unknown,
  errorMessage = "Token response missing access_token."
): z.infer<typeof codexOAuthTokenResponseSchema> {
  const parsedPayload = codexOAuthTokenResponseSchema.safeParse(payload);
  if (!parsedPayload.success) throw new Error(errorMessage);
  return parsedPayload.data;
}

function toEpochMs(value: unknown): number | undefined {
  const parsed = parseWithSchema(finiteNumberFromUnknownSchema, value);
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
    return parseWithSchema(recordSchema, parsed) ?? null;
  } catch {
    return null;
  }
}

export function extractJwtExpiryMs(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  const exp = parseWithSchema(finiteNumberFromUnknownSchema, payload?.exp);
  if (!exp || exp <= 0) return undefined;
  return Math.floor(exp * 1000);
}

export function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = parseWithSchema(nonEmptyStringSchema, claims.chatgpt_account_id);
  if (direct) return direct;

  const nestedAuth = parseWithSchema(oauthNamespaceClaimsSchema, claims["https://api.openai.com/auth"]);
  const nested = nestedAuth?.chatgpt_account_id;
  if (nested) return nested;

  const organizations = parseWithSchema(organizationsSchema, claims.organizations);
  if (organizations) {
    for (const organization of organizations) {
      if (organization.id) return organization.id;
    }
  }

  const orgId = parseWithSchema(nonEmptyStringSchema, claims.organization_id);
  if (orgId) return orgId;

  const account = parseWithSchema(nonEmptyStringSchema, claims.account_id);
  if (account) return account;

  return undefined;
}

export function extractEmailFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = parseWithSchema(nonEmptyStringSchema, claims.email);
  if (direct) return direct;
  const profile = parseWithSchema(profileNamespaceClaimsSchema, claims["https://api.openai.com/profile"]);
  const nested = profile?.email;
  if (nested) return nested;
  return undefined;
}

export function extractPlanTypeFromClaims(claims: Record<string, unknown>): string | undefined {
  const nestedAuth = parseWithSchema(oauthNamespaceClaimsSchema, claims["https://api.openai.com/auth"]);
  return nestedAuth?.chatgpt_plan_type ?? parseWithSchema(nonEmptyStringSchema, claims.chatgpt_plan_type);
}

export function codexAuthFilePath(paths: Pick<CodexAuthPaths, "authDir">): string {
  return path.join(paths.authDir, "codex-cli", "auth.json");
}
async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsedRaw = jsonStringSchema.safeParse(raw);
    if (!parsedRaw.success) {
      throw new Error(`Invalid JSON in Codex auth file ${filePath}: failed to read UTF-8 text`);
    }
    try {
      return JSON.parse(parsedRaw.data);
    } catch (error) {
      throw new Error(`Invalid JSON in Codex auth file ${filePath}: ${String(error)}`);
    }
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
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
  const expiresIn = parseWithSchema(finiteNumberFromUnknownSchema, payload.expires_in);
  if (!expiresIn || expiresIn <= 0) return undefined;
  return Math.floor(expiresIn * 1000);
}

export function codexMaterialFromTokenResponse(
  file: string,
  payload: CodexOAuthTokenResponse,
  opts: {
    issuer?: string;
    clientId?: string;
  } = {}
): CodexAuthMaterial {
  const parsedPayload = parseTokenResponse(payload);

  const accessToken = parsedPayload.access_token;
  const refreshToken = parsedPayload.refresh_token;
  const idToken = parsedPayload.id_token;

  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = idToken ? decodeJwtPayload(idToken) : null;
  const accountId =
    (idClaims ? extractAccountIdFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractAccountIdFromClaims(accessClaims) : undefined);
  const email =
    (idClaims ? extractEmailFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractEmailFromClaims(accessClaims) : undefined);
  const planType =
    (idClaims ? extractPlanTypeFromClaims(idClaims) : undefined) ??
    (accessClaims ? extractPlanTypeFromClaims(accessClaims) : undefined);

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

  const payload = parseTokenResponse(
    await response.json(),
    "Codex token refresh response missing access_token.",
  );
  return await persistCodexAuthFromTokenResponse(opts.paths, payload, {
    issuer: opts.material.issuer,
    clientId: opts.material.clientId,
  });
}

export function isTokenExpiring(material: CodexAuthMaterial, marginMs = 60_000): boolean {
  const expiresAtMs = material.expiresAtMs ?? extractJwtExpiryMs(material.accessToken);
  if (!expiresAtMs) return false;
  return expiresAtMs - marginMs <= Date.now();
}
