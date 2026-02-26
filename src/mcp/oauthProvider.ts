import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  startAuthorization,
  exchangeAuthorization,
  registerClient,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { z } from "zod";

import type { MCPRegistryServer } from "./configRegistry";
import type { MCPServerOAuthClientInfo, MCPServerOAuthPending, MCPServerOAuthTokens } from "./authStore";
import { nowIso } from "../utils/typeGuards";

/** Default client_id used when no dynamic registration endpoint is available. */
const FALLBACK_CLIENT_ID = "agent-coworker-desktop";
const nonEmptyStringSchema = z.string().trim().min(1);
const nonEmptyStringArraySchema = z.array(nonEmptyStringSchema).min(1);
const positiveFiniteNumberSchema = z.number().finite().positive();
const authServerMetadataSchema = z.object({
  registration_endpoint: nonEmptyStringSchema.optional(),
}).passthrough();

export interface MCPOAuthChallenge {
  method: "auto" | "code";
  instructions: string;
  url?: string;
  expiresAt?: string;
}

export interface MCPOAuthAuthorizeResult {
  challenge: MCPOAuthChallenge;
  pending: MCPServerOAuthPending;
  openedBrowser: boolean;
  /** Client information obtained from dynamic registration or stored credentials. */
  clientInformation?: MCPServerOAuthClientInfo;
}

type CallbackCapture = {
  challengeId: string;
  state: string;
  redirectUri: string;
  expiresAt: string;
  server: ReturnType<typeof createServer>;
  code?: string;
  closed: boolean;
};

const callbackCaptures = new Map<string, CallbackCapture>();

function addMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateOpaqueValue(bytes: number): string {
  return toBase64Url(randomBytes(bytes));
}

function isHttpLikeServer(server: MCPRegistryServer): boolean {
  return server.transport.type === "http" || server.transport.type === "sse";
}

async function runCommand(command: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: false,
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function openUrlInBrowser(url: string): Promise<boolean> {
  if (process.platform === "darwin") {
    return await runCommand("open", [url]);
  }
  if (process.platform === "win32") {
    return await runCommand("cmd", ["/c", "start", "", url]);
  }
  return await runCommand("xdg-open", [url]);
}

function closeCapture(capture: CallbackCapture, opts: { keepEntry?: boolean } = {}): void {
  if (!opts.keepEntry) {
    callbackCaptures.delete(capture.challengeId);
  }
  if (capture.closed) return;
  capture.closed = true;
  try {
    capture.server.close();
  } catch {
    // best effort
  }
}

async function createCallbackCapture(challengeId: string, state: string, expiresAt: string): Promise<CallbackCapture> {
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/oauth/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const capture = callbackCaptures.get(challengeId);
    if (!capture) {
      res.statusCode = 410;
      res.end("Authorization flow expired");
      return;
    }

    const incomingState = requestUrl.searchParams.get("state") ?? "";
    const code = requestUrl.searchParams.get("code") ?? "";
    if (!incomingState || incomingState !== capture.state) {
      res.statusCode = 400;
      res.end("Invalid OAuth state");
      return;
    }
    if (!code) {
      res.statusCode = 400;
      res.end("Missing OAuth code");
      return;
    }

    capture.code = code;
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><body><h1>Authorization complete</h1><p>You can close this window.</p></body></html>");
    closeCapture(capture, { keepEntry: true });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    try {
      server.close();
    } catch {
      // ignore
    }
    throw new Error("Failed to allocate OAuth callback listener.");
  }

  const capture: CallbackCapture = {
    challengeId,
    state,
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    expiresAt,
    server,
    closed: false,
  };
  callbackCaptures.set(challengeId, capture);

  const timeoutMs = Math.max(1, Date.parse(expiresAt) - Date.now());
  setTimeout(() => {
    const existing = callbackCaptures.get(challengeId);
    if (!existing) return;
    closeCapture(existing);
  }, timeoutMs);

  return capture;
}

/**
 * Discover the authorization server URL for an MCP server via RFC 9728 protected
 * resource metadata. Falls back to the server's origin when discovery is unavailable.
 */
async function resolveAuthorizationServerUrl(serverUrl: string): Promise<string> {
  try {
    const resourceMeta = await discoverOAuthProtectedResourceMetadata(serverUrl);
    const authServers = nonEmptyStringArraySchema.safeParse(resourceMeta.authorization_servers);
    if (authServers.success) return authServers.data[0]!;
  } catch {
    // Discovery unavailable — fall through to default.
  }
  return new URL(serverUrl).origin;
}

/**
 * Discover OAuth/OIDC authorization server metadata (RFC 8414 / OIDC Discovery).
 * Returns undefined when the server doesn't publish metadata.
 */
async function resolveAuthServerMetadata(
  authServerUrl: string,
): Promise<AuthorizationServerMetadata | undefined> {
  try {
    return await discoverAuthorizationServerMetadata(authServerUrl);
  } catch {
    return undefined;
  }
}

/**
 * Ensure we have client credentials for this server.
 * If storedClientInfo is provided, use it. Otherwise attempt RFC 7591 dynamic
 * client registration. Falls back to a hardcoded client_id when the server
 * doesn't support dynamic registration.
 */
async function ensureClientInformation(opts: {
  authServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  redirectUri: string;
  storedClientInfo?: MCPServerOAuthClientInfo;
  scope?: string;
}): Promise<{ clientInfo: OAuthClientInformationMixed; registered?: MCPServerOAuthClientInfo }> {
  // Use stored credentials if available.
  if (opts.storedClientInfo) {
    const info: OAuthClientInformationMixed = {
      client_id: opts.storedClientInfo.clientId,
      ...(opts.storedClientInfo.clientSecret
        ? { client_secret: opts.storedClientInfo.clientSecret }
        : {}),
    };
    return { clientInfo: info };
  }

  // Attempt dynamic client registration (RFC 7591).
  const metadata = authServerMetadataSchema.safeParse(opts.metadata);
  const registrationEndpoint = metadata.success ? metadata.data.registration_endpoint : undefined;
  if (registrationEndpoint) {
    try {
      const registered = await registerClient(opts.authServerUrl, {
        metadata: opts.metadata,
        clientMetadata: {
          redirect_uris: [opts.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          client_name: "Agent Coworker",
          ...(opts.scope ? { scope: opts.scope } : {}),
        },
      });

      const clientInfo: MCPServerOAuthClientInfo = {
        clientId: registered.client_id,
        ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
        updatedAt: nowIso(),
      };

      return {
        clientInfo: registered,
        registered: clientInfo,
      };
    } catch {
      // Registration failed — fall through to hardcoded client_id.
    }
  }

  // Fallback: hardcoded client_id (no registration endpoint or registration failed).
  return { clientInfo: { client_id: FALLBACK_CLIENT_ID } };
}

export async function authorizeMCPServerOAuth(
  server: MCPRegistryServer,
  storedClientInfo?: MCPServerOAuthClientInfo,
): Promise<MCPOAuthAuthorizeResult> {
  if (!isHttpLikeServer(server)) {
    throw new Error("OAuth is only supported for HTTP/SSE MCP transports.");
  }
  if (!server.auth || server.auth.type !== "oauth") {
    throw new Error(`Server \"${server.name}\" is not configured for OAuth.`);
  }

  const method: "auto" | "code" = server.auth.oauthMode === "code" ? "code" : "auto";
  const createdAt = nowIso();
  const expiresAt = addMinutesIso(10);
  const state = generateOpaqueValue(24);
  const challengeId = randomUUID();

  // 1. Set up redirect URI (callback server or OOB).
  let redirectUri = "urn:ietf:wg:oauth:2.0:oob";
  if (method === "auto") {
    const capture = await createCallbackCapture(challengeId, state, expiresAt);
    redirectUri = capture.redirectUri;
  }

  // 2. Discover authorization server via RFC 9728 + RFC 8414.
  const authServerUrl = await resolveAuthorizationServerUrl(server.transport.url);
  const metadata = await resolveAuthServerMetadata(authServerUrl);

  // 3. Ensure we have client credentials (stored, registered, or fallback).
  const { clientInfo, registered } = await ensureClientInformation({
    authServerUrl,
    metadata,
    redirectUri,
    storedClientInfo,
    scope: server.auth.scope,
  });

  // 4. Build the authorization URL using the SDK (handles PKCE internally).
  const { authorizationUrl, codeVerifier } = await startAuthorization(authServerUrl, {
    metadata,
    clientInformation: clientInfo,
    redirectUrl: redirectUri,
    scope: server.auth.scope,
    state,
    ...(server.auth.resource ? { resource: new URL(server.auth.resource) } : {}),
  });

  const url = authorizationUrl.toString();

  let openedBrowser = false;
  if (method === "auto") {
    openedBrowser = await openUrlInBrowser(url);
  }

  const pending: MCPServerOAuthPending = {
    challengeId,
    state,
    codeVerifier,
    redirectUri,
    createdAt,
    expiresAt,
    authorizationServerUrl: authServerUrl,
  };

  const instructions = method === "auto"
    ? openedBrowser
      ? "Complete sign-in in your browser. If redirect fails, paste the OAuth code manually."
      : "Open the OAuth URL in a browser, then paste the OAuth code manually."
    : "Open the OAuth URL in a browser and paste the OAuth code.";

  return {
    challenge: {
      method,
      instructions,
      url,
      expiresAt,
    },
    pending,
    openedBrowser,
    ...(registered ? { clientInformation: registered } : {}),
  };
}

export async function consumeCapturedOAuthCode(challengeId: string): Promise<string | undefined> {
  const capture = callbackCaptures.get(challengeId);
  if (!capture) return undefined;

  if (capture.code) {
    const code = capture.code;
    closeCapture(capture);
    return code;
  }

  const expires = Date.parse(capture.expiresAt);
  if (Number.isFinite(expires) && Date.now() >= expires) {
    closeCapture(capture);
  }
  return undefined;
}

export async function exchangeMCPServerOAuthCode(opts: {
  server: MCPRegistryServer;
  code: string;
  pending: MCPServerOAuthPending;
  storedClientInfo?: MCPServerOAuthClientInfo;
}): Promise<{ tokens: MCPServerOAuthTokens; message: string }> {
  const code = opts.code.trim();
  if (!code) {
    throw new Error("OAuth code is required.");
  }
  if (!opts.server.auth || opts.server.auth.type !== "oauth") {
    throw new Error(`Server \"${opts.server.name}\" is not configured for OAuth.`);
  }
  if (!isHttpLikeServer(opts.server)) {
    throw new Error("OAuth is only supported for HTTP/SSE MCP transports.");
  }

  // Resolve authorization server URL — use stored value from pending, or re-discover.
  const authServerUrl = opts.pending.authorizationServerUrl
    ?? await resolveAuthorizationServerUrl(opts.server.transport.url);

  // Discover metadata for the token endpoint.
  const metadata = await resolveAuthServerMetadata(authServerUrl);

  // Resolve client credentials.
  const clientInfo: OAuthClientInformationMixed = opts.storedClientInfo
    ? {
        client_id: opts.storedClientInfo.clientId,
        ...(opts.storedClientInfo.clientSecret
          ? { client_secret: opts.storedClientInfo.clientSecret }
          : {}),
      }
    : { client_id: FALLBACK_CLIENT_ID };

  // Exchange the authorization code for tokens using the SDK.
  const sdkTokens = await exchangeAuthorization(authServerUrl, {
    metadata,
    clientInformation: clientInfo,
    authorizationCode: code,
    codeVerifier: opts.pending.codeVerifier,
    redirectUri: opts.pending.redirectUri,
    ...(opts.server.auth.resource ? { resource: new URL(opts.server.auth.resource) } : {}),
  });

  const expiresAt = (() => {
    const expiresIn = positiveFiniteNumberSchema.safeParse(sdkTokens.expires_in);
    if (expiresIn.success) return new Date(Date.now() + expiresIn.data * 1000).toISOString();
    return undefined;
  })();

  const tokens: MCPServerOAuthTokens = {
    accessToken: sdkTokens.access_token,
    tokenType: sdkTokens.token_type ?? "Bearer",
    updatedAt: nowIso(),
    ...(sdkTokens.refresh_token ? { refreshToken: sdkTokens.refresh_token } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(sdkTokens.scope ? { scope: sdkTokens.scope } : {}),
    ...(opts.server.auth.resource ? { resource: opts.server.auth.resource } : {}),
  };

  return {
    tokens,
    message: "OAuth token exchange successful.",
  };
}
