import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { listenOnLocalhost, OAUTH_FAILURE_HTML, OAUTH_LOOPBACK_HOST, OAUTH_SUCCESS_HTML } from "../auth/oauth-server";
import type { AiCoworkerPaths, ConnectService } from "../store/connections";
import type { UrlOpener } from "../utils/browser";
import { openExternalUrl } from "../utils/browser";
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_ISSUER, persistCodexAuthFromTokenResponse } from "./codex-auth";

const finiteNumberFromUnknownSchema = z.preprocess((value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}, z.number().finite());

const tokenExchangeResponseSchema = z.record(z.string(), z.unknown());

const deviceAuthStartResponseSchema = z.object({
  device_auth_id: z.string().trim().min(1),
  user_code: z.string().trim().min(1),
  interval: finiteNumberFromUnknownSchema.optional(),
}).passthrough();

const deviceAuthTokenPollResponseSchema = z.object({
  authorization_code: z.string().trim().min(1),
  code_verifier: z.string().trim().min(1),
}).passthrough();

export function isOauthCliProvider(service: ConnectService): service is "codex-cli" {
  return service === "codex-cli";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const json = await response.json();
  const parsed = tokenExchangeResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error("Token exchange returned an invalid response.");
  return parsed.data;
}

export async function runCodexBrowserOAuth(opts: {
  paths: AiCoworkerPaths;
  fetchImpl: typeof fetch;
  onLine?: (line: string) => void;
  openUrl?: UrlOpener;
}): Promise<string> {
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

  opts.onLine?.("[auth] opening browser for Codex login");
  const opened = await opener(authUrl);
  if (!opened) {
    opts.onLine?.(`[auth] open this URL to continue: ${authUrl}`);
  }

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
    listener.close();
  }
}

export async function runCodexDeviceOAuth(opts: {
  paths: AiCoworkerPaths;
  fetchImpl: typeof fetch;
  onLine?: (line: string) => void;
  openUrl?: UrlOpener;
}): Promise<string> {
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
  const userCodeData = deviceAuthStartResponseSchema.safeParse(await userCodeResponse.json());
  if (!userCodeData.success) throw new Error("Device-code auth response was missing required fields.");
  const deviceAuthId = userCodeData.data.device_auth_id;
  const userCode = userCodeData.data.user_code;
  const intervalSec = Math.max(1, Math.floor(userCodeData.data.interval ?? 5));

  opts.onLine?.(`[auth] open ${verificationUrl} and enter code: ${userCode}`);
  await opener(verificationUrl);

  while (true) {
    const pollResponse = await opts.fetchImpl(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "agent-coworker" },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });

    if (pollResponse.ok) {
      const pollData = deviceAuthTokenPollResponseSchema.safeParse(await pollResponse.json());
      if (!pollData.success) {
        throw new Error("Device-code token poll returned an invalid payload.");
      }
      const authorizationCode = pollData.data.authorization_code;
      const codeVerifier = pollData.data.code_verifier;

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
}
