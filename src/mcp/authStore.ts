import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { maskApiKey } from "../connect";
import type { AgentConfig, MCPServerAuthConfig } from "../types";
import { nowIso } from "../utils/typeGuards";
import type { MCPRegistryServer, MCPServerSource } from "./configRegistry";
import { resolveMcpConfigPaths } from "./configRegistry";

export type MCPAuthMode = "none" | "missing" | "api_key" | "oauth" | "oauth_pending" | "error";
export type MCPAuthScope = "workspace" | "user";

export interface MCPServerOAuthPending {
  challengeId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
  /** Authorization server URL resolved during the authorize phase (RFC 9728 / RFC 8414). */
  authorizationServerUrl?: string;
}

export interface MCPServerOAuthTokens {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  resource?: string;
  updatedAt: string;
}

export interface MCPServerOAuthClientInfo {
  clientId: string;
  clientSecret?: string;
  updatedAt: string;
}

export interface MCPServerCredentialRecord {
  apiKey?: {
    value: string;
    keyId?: string;
    updatedAt: string;
  };
  oauth?: {
    pending?: MCPServerOAuthPending;
    tokens?: MCPServerOAuthTokens;
    clientInformation?: MCPServerOAuthClientInfo;
  };
}

export interface MCPServerCredentialsDocument {
  version: 1;
  updatedAt: string;
  servers: Record<string, MCPServerCredentialRecord>;
}

export interface MCPAuthFileState {
  scope: MCPAuthScope;
  filePath: string;
  doc: MCPServerCredentialsDocument;
}

export interface MCPResolvedServerAuth {
  mode: MCPAuthMode;
  scope: MCPAuthScope;
  authType: MCPServerAuthConfig["type"];
  message: string;
  headers?: Record<string, string>;
  apiKey?: string;
  oauthTokens?: MCPServerOAuthTokens;
  oauthPending?: MCPServerOAuthPending;
  oauthClientInfo?: MCPServerOAuthClientInfo;
}

const DEFAULT_DOC: MCPServerCredentialsDocument = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  servers: {},
};

const nonEmptyStringSchema = z.string().trim().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });

const oauthPendingSchema = z.object({
  challengeId: nonEmptyStringSchema,
  state: nonEmptyStringSchema,
  codeVerifier: nonEmptyStringSchema,
  redirectUri: nonEmptyStringSchema,
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  authorizationServerUrl: nonEmptyStringSchema.optional(),
});

const oauthTokensSchema = z.object({
  accessToken: nonEmptyStringSchema,
  tokenType: nonEmptyStringSchema.optional(),
  refreshToken: nonEmptyStringSchema.optional(),
  expiresAt: isoTimestampSchema.optional(),
  scope: nonEmptyStringSchema.optional(),
  resource: nonEmptyStringSchema.optional(),
  updatedAt: isoTimestampSchema,
});

const oauthClientInfoSchema = z.object({
  clientId: nonEmptyStringSchema,
  clientSecret: nonEmptyStringSchema.optional(),
  updatedAt: isoTimestampSchema,
});

const apiKeyCredentialSchema = z.object({
  value: nonEmptyStringSchema,
  keyId: nonEmptyStringSchema.optional(),
  updatedAt: isoTimestampSchema,
});

const oauthCredentialSchema = z.object({
  pending: oauthPendingSchema.optional(),
  tokens: oauthTokensSchema.optional(),
  clientInformation: oauthClientInfoSchema.optional(),
}).strict();

const credentialRecordSchema = z.object({
  apiKey: apiKeyCredentialSchema.optional(),
  oauth: oauthCredentialSchema.optional(),
}).strict();

const credentialsDocSchema = z.object({
  version: z.literal(1),
  updatedAt: isoTimestampSchema,
  servers: z.record(z.string().min(1), credentialRecordSchema),
}).strict();


function ensureScopeDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const parent = path.dirname(dir);
  return (async () => {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const candidate of [parent, dir]) {
      try {
        await fs.chmod(candidate, 0o700);
      } catch {
        // best effort
      }
    }
  })();
}

async function atomicWrite(filePath: string, payload: string): Promise<void> {
  await ensureScopeDir(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tempPath, payload, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort
  }
}

function normalizeCredentialsDoc(raw: unknown): MCPServerCredentialsDocument {
  const parsed = credentialsDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid credential store schema: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }
  return parsed.data;
}

async function readDoc(filePath: string): Promise<MCPServerCredentialsDocument> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return normalizeCredentialsDoc(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { ...DEFAULT_DOC, updatedAt: nowIso(), servers: {} };
    throw new Error(`Failed to read MCP credential store at ${filePath}: ${String(error)}`);
  }
}

async function writeDoc(filePath: string, doc: MCPServerCredentialsDocument): Promise<void> {
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  await atomicWrite(filePath, payload);
}

function resolvePrimaryScope(source: MCPServerSource): MCPAuthScope {
  if (source === "workspace" || source === "workspace_legacy") return "workspace";
  return "user";
}

function resolveScopeReadOrder(source: MCPServerSource): MCPAuthScope[] {
  // Keep credential resolution scoped to the originating config layer.
  // Workspace-defined servers must never fall back to user credentials.
  if (source === "workspace" || source === "workspace_legacy") {
    return ["workspace"];
  }
  return ["user"];
}

function isPendingValid(pending: MCPServerOAuthPending): boolean {
  const expiresAt = Date.parse(pending.expiresAt);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function isTokenValid(tokens: MCPServerOAuthTokens): boolean {
  if (!tokens.expiresAt) return true;
  const expiresAt = Date.parse(tokens.expiresAt);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function joinAuthHeader(prefix: string | undefined, value: string): string {
  const trimmedPrefix = prefix?.trim();
  if (!trimmedPrefix) return value;
  return `${trimmedPrefix} ${value}`;
}

function resolveApiKeyHeader(auth: Extract<MCPServerAuthConfig, { type: "api_key" }>, apiKey: string): Record<string, string> {
  const headerName = auth.headerName?.trim() || "Authorization";
  const prefix = auth.prefix?.trim() ?? (headerName.toLowerCase() === "authorization" ? "Bearer" : "");
  return {
    [headerName]: joinAuthHeader(prefix, apiKey),
  };
}

export async function readMCPAuthFiles(config: AgentConfig): Promise<{ workspace: MCPAuthFileState; user: MCPAuthFileState }> {
  const paths = resolveMcpConfigPaths(config);
  const [workspaceDoc, userDoc] = await Promise.all([readDoc(paths.workspaceAuthFile), readDoc(paths.userAuthFile)]);
  return {
    workspace: {
      scope: "workspace",
      filePath: paths.workspaceAuthFile,
      doc: workspaceDoc,
    },
    user: {
      scope: "user",
      filePath: paths.userAuthFile,
      doc: userDoc,
    },
  };
}

async function readMCPAuthFileByScope(config: AgentConfig, scope: MCPAuthScope): Promise<MCPAuthFileState> {
  const paths = resolveMcpConfigPaths(config);
  const filePath = scope === "workspace" ? paths.workspaceAuthFile : paths.userAuthFile;
  const doc = await readDoc(filePath);
  return { scope, filePath, doc };
}

function selectCredentialRecord(opts: {
  byScope: { workspace: MCPAuthFileState; user: MCPAuthFileState };
  source: MCPServerSource;
  serverName: string;
}): { scope: MCPAuthScope; record: MCPServerCredentialRecord | undefined } {
  const readOrder = resolveScopeReadOrder(opts.source);
  for (const scope of readOrder) {
    const record = opts.byScope[scope].doc.servers[opts.serverName];
    if (record) {
      return { scope, record };
    }
  }

  return {
    scope: resolvePrimaryScope(opts.source),
    record: undefined,
  };
}

export async function resolveMCPServerAuthState(
  config: AgentConfig,
  server: MCPRegistryServer,
): Promise<MCPResolvedServerAuth> {
  const auth = server.auth ?? { type: "none" as const };
  const files = await readMCPAuthFiles(config);
  const selected = selectCredentialRecord({
    byScope: files,
    source: server.source,
    serverName: server.name,
  });

  if (auth.type === "none") {
    return {
      mode: "none",
      scope: selected.scope,
      authType: "none",
      message: "No authentication required.",
    };
  }

  if (auth.type === "api_key") {
    const apiKeyValue = selected.record?.apiKey?.value;
    if (!apiKeyValue) {
      return {
        mode: "missing",
        scope: selected.scope,
        authType: "api_key",
        message: "API key required.",
      };
    }
    return {
      mode: "api_key",
      scope: selected.scope,
      authType: "api_key",
      message: `API key available (${maskApiKey(apiKeyValue)}).`,
      headers: resolveApiKeyHeader(auth, apiKeyValue),
      apiKey: apiKeyValue,
    };
  }

  const pending = selected.record?.oauth?.pending;
  const tokens = selected.record?.oauth?.tokens;
  const clientInfo = selected.record?.oauth?.clientInformation;
  const hasAccessToken = Boolean(tokens?.accessToken);
  const hasRefreshToken = Boolean(tokens?.refreshToken && tokens.refreshToken.trim().length > 0);
  const tokenValid = tokens ? isTokenValid(tokens) : false;

  if (hasAccessToken && tokenValid && tokens) {
    return {
      mode: "oauth",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth token available.",
      headers: {
        Authorization: joinAuthHeader(tokens.tokenType ?? "Bearer", tokens.accessToken),
      },
      oauthTokens: tokens,
      ...(pending ? { oauthPending: pending } : {}),
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  if (hasAccessToken && !tokenValid && hasRefreshToken && tokens) {
    return {
      mode: "oauth",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth access token expired; refresh token available.",
      headers: {
        Authorization: joinAuthHeader(tokens.tokenType ?? "Bearer", tokens.accessToken),
      },
      oauthTokens: tokens,
      ...(pending ? { oauthPending: pending } : {}),
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  if (pending && isPendingValid(pending)) {
    return {
      mode: "oauth_pending",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth flow is waiting for callback.",
      oauthPending: pending,
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  if (hasAccessToken && !tokenValid && tokens) {
    return {
      mode: "error",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth token expired. Re-authorize this server.",
      oauthTokens: tokens,
      ...(pending ? { oauthPending: pending } : {}),
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  if (pending && !isPendingValid(pending)) {
    return {
      mode: "error",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth authorization expired. Re-authorize this server.",
      oauthPending: pending,
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  return {
    mode: "missing",
    scope: selected.scope,
    authType: "oauth",
    message: "OAuth authorization required.",
  };
}

async function mutateScopeDoc(
  config: AgentConfig,
  scope: MCPAuthScope,
  mutate: (doc: MCPServerCredentialsDocument, filePath: string) => void,
): Promise<string> {
  const current = await readMCPAuthFileByScope(config, scope);
  const next: MCPServerCredentialsDocument = {
    ...current.doc,
    updatedAt: nowIso(),
    servers: { ...current.doc.servers },
  };
  mutate(next, current.filePath);
  await writeDoc(current.filePath, next);
  return current.filePath;
}

function normalizeServerName(nameRaw: string): string {
  const name = nameRaw.trim();
  if (!name) throw new Error("Server name is required.");
  return name;
}

export async function setMCPServerApiKeyCredential(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  apiKey: string;
  keyId?: string;
}): Promise<{ mode: "api_key"; storageFile: string; maskedApiKey: string; scope: MCPAuthScope }> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new Error("API key is required.");

  const scope = resolvePrimaryScope(opts.server.source);
  const filePath = await mutateScopeDoc(opts.config, scope, (doc) => {
    const name = normalizeServerName(opts.server.name);
    const existing = doc.servers[name] ?? {};
    const oauth = existing.oauth;
    doc.servers[name] = {
      ...existing,
      apiKey: {
        value: apiKey,
        ...(opts.keyId?.trim() ? { keyId: opts.keyId.trim() } : {}),
        updatedAt: nowIso(),
      },
      ...(oauth ? { oauth } : {}),
    };
  });

  return {
    mode: "api_key",
    storageFile: filePath,
    maskedApiKey: maskApiKey(apiKey),
    scope,
  };
}

export async function renameMCPServerCredentials(opts: {
  config: AgentConfig;
  source: MCPServerSource;
  previousName: string;
  nextName: string;
}): Promise<{ moved: boolean; scope: MCPAuthScope; storageFile?: string }> {
  const previousName = normalizeServerName(opts.previousName);
  const nextName = normalizeServerName(opts.nextName);
  const defaultScope = resolvePrimaryScope(opts.source);
  if (previousName === nextName) {
    return { moved: false, scope: defaultScope };
  }

  const files = await readMCPAuthFiles(opts.config);
  const scope = resolveScopeReadOrder(opts.source).find((candidate) => files[candidate].doc.servers[previousName] !== undefined);
  if (!scope) {
    return { moved: false, scope: defaultScope };
  }

  const storageFile = await mutateScopeDoc(opts.config, scope, (doc) => {
    const existing = doc.servers[previousName];
    if (!existing) return;
    doc.servers[nextName] = existing;
    delete doc.servers[previousName];
  });
  return { moved: true, scope, storageFile };
}

export async function setMCPServerOAuthPending(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  pending: MCPServerOAuthPending;
}): Promise<{ storageFile: string; scope: MCPAuthScope }> {
  const scope = resolvePrimaryScope(opts.server.source);
  const filePath = await mutateScopeDoc(opts.config, scope, (doc) => {
    const name = normalizeServerName(opts.server.name);
    const existing = doc.servers[name] ?? {};
    doc.servers[name] = {
      ...existing,
      oauth: {
        ...(existing.oauth ?? {}),
        pending: opts.pending,
      },
    };
  });
  return { storageFile: filePath, scope };
}

export async function readMCPServerOAuthPending(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
}): Promise<{ pending?: MCPServerOAuthPending; scope: MCPAuthScope }> {
  const files = await readMCPAuthFiles(opts.config);
  const selected = selectCredentialRecord({
    byScope: files,
    source: opts.server.source,
    serverName: opts.server.name,
  });
  return {
    scope: selected.scope,
    pending: selected.record?.oauth?.pending,
  };
}

export async function completeMCPServerOAuth(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  tokens: Omit<MCPServerOAuthTokens, "updatedAt">;
  clearPending?: boolean;
}): Promise<{ storageFile: string; scope: MCPAuthScope }> {
  const scope = resolvePrimaryScope(opts.server.source);
  const filePath = await mutateScopeDoc(opts.config, scope, (doc) => {
    const name = normalizeServerName(opts.server.name);
    const existing = doc.servers[name] ?? {};
    const nextTokens: MCPServerOAuthTokens = {
      accessToken: opts.tokens.accessToken,
      ...(opts.tokens.tokenType ? { tokenType: opts.tokens.tokenType } : {}),
      ...(opts.tokens.refreshToken ? { refreshToken: opts.tokens.refreshToken } : {}),
      ...(opts.tokens.expiresAt ? { expiresAt: opts.tokens.expiresAt } : {}),
      ...(opts.tokens.scope ? { scope: opts.tokens.scope } : {}),
      ...(opts.tokens.resource ? { resource: opts.tokens.resource } : {}),
      updatedAt: nowIso(),
    };
    const pending = opts.clearPending === false ? existing.oauth?.pending : undefined;
    doc.servers[name] = {
      ...existing,
      oauth: {
        ...(pending ? { pending } : {}),
        tokens: nextTokens,
      },
    };
  });
  return { storageFile: filePath, scope };
}

export async function readMCPServerOAuthClientInformation(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
}): Promise<{ clientInformation?: MCPServerOAuthClientInfo; scope: MCPAuthScope }> {
  const files = await readMCPAuthFiles(opts.config);
  const selected = selectCredentialRecord({
    byScope: files,
    source: opts.server.source,
    serverName: opts.server.name,
  });
  return {
    scope: selected.scope,
    clientInformation: selected.record?.oauth?.clientInformation,
  };
}

export async function setMCPServerOAuthClientInformation(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  clientInformation: Omit<MCPServerOAuthClientInfo, "updatedAt">;
}): Promise<{ storageFile: string; scope: MCPAuthScope }> {
  const scope = resolvePrimaryScope(opts.server.source);
  const filePath = await mutateScopeDoc(opts.config, scope, (doc) => {
    const name = normalizeServerName(opts.server.name);
    const existing = doc.servers[name] ?? {};
    doc.servers[name] = {
      ...existing,
      oauth: {
        ...(existing.oauth ?? {}),
        clientInformation: {
          clientId: opts.clientInformation.clientId,
          ...(opts.clientInformation.clientSecret
            ? { clientSecret: opts.clientInformation.clientSecret }
            : {}),
          updatedAt: nowIso(),
        },
      },
    };
  });
  return { storageFile: filePath, scope };
}

