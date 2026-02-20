import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import type { MCPRegistryServer } from "./configRegistry";
import type { MCPServerOAuthPending, MCPServerOAuthTokens } from "./authStore";

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

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateOpaqueValue(bytes: number): string {
  return toBase64Url(randomBytes(bytes));
}

function generatePkceChallenge(verifier: string): string {
  const digest = createHash("sha256").update(verifier, "utf-8").digest();
  return toBase64Url(digest);
}

function isHttpLikeServer(server: MCPRegistryServer): boolean {
  return server.transport.type === "http" || server.transport.type === "sse";
}

function buildAuthorizationUrl(opts: {
  server: MCPRegistryServer;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}): string {
  if (!isHttpLikeServer(opts.server)) {
    throw new Error("OAuth is only supported for HTTP/SSE MCP transports.");
  }
  if (!opts.server.auth || opts.server.auth.type !== "oauth") {
    throw new Error(`Server \"${opts.server.name}\" does not use OAuth auth.`);
  }

  const url = new URL(opts.server.transport.url);
  const codeChallenge = generatePkceChallenge(opts.codeVerifier);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "agent-coworker-desktop");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.server.auth.scope) {
    url.searchParams.set("scope", opts.server.auth.scope);
  }
  if (opts.server.auth.resource) {
    url.searchParams.set("resource", opts.server.auth.resource);
  }

  return url.toString();
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

export async function authorizeMCPServerOAuth(server: MCPRegistryServer): Promise<MCPOAuthAuthorizeResult> {
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
  const codeVerifier = generateOpaqueValue(64);
  const challengeId = randomUUID();

  let redirectUri = "urn:ietf:wg:oauth:2.0:oob";
  if (method === "auto") {
    const capture = await createCallbackCapture(challengeId, state, expiresAt);
    redirectUri = capture.redirectUri;
  }

  const url = buildAuthorizationUrl({
    server,
    redirectUri,
    state,
    codeVerifier,
  });

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
}): Promise<{ tokens: MCPServerOAuthTokens; message: string }> {
  const code = opts.code.trim();
  if (!code) {
    throw new Error("OAuth code is required.");
  }
  if (!opts.server.auth || opts.server.auth.type !== "oauth") {
    throw new Error(`Server \"${opts.server.name}\" is not configured for OAuth.`);
  }

  // Generic adapter fallback: treat exchanged code as bearer token material.
  // Servers that require full OAuth token exchange can still use manual API key mode.
  const expiresAt = addMinutesIso(60 * 8);
  const tokens: MCPServerOAuthTokens = {
    accessToken: code,
    tokenType: "Bearer",
    expiresAt,
    ...(opts.server.auth.scope ? { scope: opts.server.auth.scope } : {}),
    ...(opts.server.auth.resource ? { resource: opts.server.auth.resource } : {}),
    updatedAt: nowIso(),
  };

  return {
    tokens,
    message: "OAuth authorization code saved as bearer credentials.",
  };
}
