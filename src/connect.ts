import fs from "node:fs/promises";
import path from "node:path";

import { loginCodexAppServerChatGpt, logoutCodexAppServer } from "./providers/codexAppServerAuth";
import {
  type AiCoworkerPaths,
  type ConnectionMode,
  type ConnectionStore,
  type ConnectService,
  ensureAiCoworkerHome,
  getAiCoworkerPaths,
  readConnectionStore,
  type StoredConnection,
  TOOL_API_KEY_NAMES,
  type ToolApiKeyName,
  writeConnectionStore,
} from "./store/connections";
import { maskApiKey, readToolApiKey, writeToolApiKey } from "./tools/api-keys";
import { resolveAuthHomeDir } from "./utils/authHome";
import type { UrlOpener } from "./utils/browser";

export type {
  AiCoworkerPaths,
  ConnectionMode,
  ConnectionStore,
  ConnectService,
  StoredConnection,
  ToolApiKeyName,
  UrlOpener,
};
export {
  ensureAiCoworkerHome,
  getAiCoworkerPaths,
  isOauthCliProvider,
  maskApiKey,
  readConnectionStore,
  readToolApiKey,
  TOOL_API_KEY_NAMES,
  writeConnectionStore,
  writeToolApiKey,
};

function isOauthCliProvider(service: ConnectService): service is "codex-cli" {
  return service === "codex-cli";
}

const connectOauthDepsDefaults = {
  isOauthCliProvider,
  runCodexLogin: loginCodexAppServerChatGpt,
  runCodexLogout: logoutCodexAppServer,
};

const connectOauthDeps = {
  ...connectOauthDepsDefaults,
};

function codexHomeFromPaths(paths: AiCoworkerPaths): string {
  return path.join(paths.authDir, "codex-cli");
}

export const __internal = {
  setOauthDepsForTests(overrides: Partial<typeof connectOauthDepsDefaults>): void {
    Object.assign(connectOauthDeps, overrides);
  },
  resetOauthDepsForTests(): void {
    Object.assign(connectOauthDeps, connectOauthDepsDefaults);
  },
};

export type OauthStdioMode = "pipe" | "inherit";

export type ConnectProviderResult =
  | {
      ok: true;
      provider: ConnectService;
      mode: ConnectionMode;
      storageFile: string;
      message: string;
      maskedApiKey?: string;
      maskedFieldValues?: Record<string, string>;
      oauthCommand?: string;
      oauthCredentialsFile?: string;
    }
  | { ok: false; provider: ConnectService; message: string };

export type DisconnectProviderResult =
  | {
      ok: true;
      provider: ConnectService;
      storageFile: string;
      message: string;
      oauthCredentialsFile?: string;
    }
  | { ok: false; provider: ConnectService; message: string };

function normalizeCredentialValues(values: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    normalized[trimmedKey] = value;
  }
  return normalized;
}

function maskCredentialValue(value: string): string {
  return maskApiKey(value);
}

export async function saveProviderConnectionConfig(opts: {
  provider: ConnectService;
  methodId: string;
  values: Record<string, string>;
  paths?: AiCoworkerPaths;
}): Promise<ConnectProviderResult> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  const store = await readConnectionStore(paths);
  const now = new Date().toISOString();
  const methodId = opts.methodId.trim();
  if (!methodId) {
    return { ok: false, provider: opts.provider, message: "Auth method id is required." };
  }

  const values = normalizeCredentialValues(opts.values);
  store.services[opts.provider] = {
    service: opts.provider,
    mode: "credentials",
    methodId,
    values,
    updatedAt: now,
  };
  store.updatedAt = now;
  await writeConnectionStore(paths, store);

  const maskedFieldValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    maskedFieldValues[key] = maskCredentialValue(value);
  }

  return {
    ok: true,
    provider: opts.provider,
    mode: "credentials",
    storageFile: paths.connectionsFile,
    message: "Provider credentials saved.",
    ...(Object.keys(maskedFieldValues).length > 0 ? { maskedFieldValues } : {}),
  };
}

export async function connectProvider(opts: {
  provider: ConnectService;
  methodId?: string;
  code?: string;
  apiKey?: string;
  cwd?: string;
  paths?: AiCoworkerPaths;
  oauthStdioMode?: OauthStdioMode;
  onOauthLine?: (line: string) => void;
  fetchImpl?: typeof fetch;
  openUrl?: UrlOpener;
}): Promise<ConnectProviderResult> {
  const provider = opts.provider;
  const apiKey = (opts.apiKey ?? "").trim();
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });

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

  if (!connectOauthDeps.isOauthCliProvider(provider)) {
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

  const methodId = (opts.methodId ?? "oauth_cli").trim() || "oauth_cli";

  try {
    if (methodId !== "oauth_cli") {
      opts.onOauthLine?.(
        `[auth] deprecated Codex auth method "${methodId}" requested; using codex app-server ChatGPT login.`,
      );
    }
    if (opts.code?.trim()) {
      throw new Error(
        "Codex app-server ChatGPT login is browser-managed. Start sign-in without a pasted authorization code.",
      );
    }
    const login = await connectOauthDeps.runCodexLogin({
      codexHome: codexHomeFromPaths(paths),
      log: opts.onOauthLine,
      openUrl: opts.openUrl,
    });

    return {
      ok: true,
      provider,
      mode: "oauth",
      storageFile: paths.connectionsFile,
      message: login.account?.email
        ? `Codex app-server ChatGPT sign-in completed for ${login.account.email}.`
        : "Codex app-server ChatGPT sign-in completed.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      provider,
      message: `Codex app-server sign-in failed: ${message}`,
    };
  }
}

export async function disconnectProvider(opts: {
  provider: ConnectService;
  paths?: AiCoworkerPaths;
}): Promise<DisconnectProviderResult> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  const store = await readConnectionStore(paths);
  const now = new Date().toISOString();

  if (opts.provider === "codex-cli") {
    if (store.services["codex-cli"]) {
      delete store.services["codex-cli"];
    }
    store.updatedAt = now;
    await writeConnectionStore(paths, store);
    let logoutMessage = "";
    const codexHome = codexHomeFromPaths(paths);
    try {
      const logoutResult = await connectOauthDeps.runCodexLogout({ codexHome });
      logoutMessage = logoutResult.message;
    } catch {
      // Best-effort logout; do not fail disconnect if app-server is unreachable.
    } finally {
      try {
        await fs.rm(path.join(codexHome, "auth.json"), { force: true });
      } catch {
        // ignore
      }
    }
    return {
      ok: true,
      provider: opts.provider,
      storageFile: paths.connectionsFile,
      message: `Codex connection cleared from Cowork. ${logoutMessage || "The app-server retains its own auth state; use the Codex CLI directly to fully revoke access."}`,
    };
  }

  if (store.services[opts.provider]) {
    delete store.services[opts.provider];
  }
  store.updatedAt = now;
  await writeConnectionStore(paths, store);
  return {
    ok: true,
    provider: opts.provider,
    storageFile: paths.connectionsFile,
    message: `${opts.provider} connection cleared.`,
  };
}
