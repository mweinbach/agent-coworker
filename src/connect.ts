import {
  clearCodexAuthMaterial,
  codexAuthFilePath,
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterial,
  type CodexAuthMaterial,
  writeCodexAuthMaterial,
} from "./providers/codex-auth";
import {
  isOauthCliProvider,
  runCodexBrowserOAuth,
} from "./providers/codex-oauth-flows";
import {
  getAiCoworkerPaths,
  ensureAiCoworkerHome,
  readConnectionStore,
  writeConnectionStore,
  TOOL_API_KEY_NAMES,
  type AiCoworkerPaths,
  type ConnectionMode,
  type ConnectionStore,
  type ConnectService,
  type StoredConnection,
  type ToolApiKeyName,
} from "./store/connections";
import { maskApiKey, readToolApiKey, writeToolApiKey } from "./tools/api-keys";
import { openExternalUrl, type UrlOpener } from "./utils/browser";
import { resolveAuthHomeDir } from "./utils/authHome";

export {
  getAiCoworkerPaths,
  ensureAiCoworkerHome,
  readConnectionStore,
  writeConnectionStore,
  TOOL_API_KEY_NAMES,
  maskApiKey,
  readToolApiKey,
  writeToolApiKey,
  isOauthCliProvider,
};

export type {
  AiCoworkerPaths,
  ConnectionMode,
  ConnectionStore,
  ConnectService,
  StoredConnection,
  ToolApiKeyName,
  UrlOpener,
};

const connectOauthDepsDefaults = {
  isOauthCliProvider,
  runCodexLogin: runCoworkCodexLogin,
};

const connectOauthDeps = {
  ...connectOauthDepsDefaults,
};

export const __internal = {
  setOauthDepsForTests(
    overrides: Partial<typeof connectOauthDepsDefaults>,
  ): void {
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

async function runCoworkCodexLogin(opts: {
  paths: AiCoworkerPaths;
  onOauthLine?: (line: string) => void;
  openUrl?: UrlOpener;
  fetchImpl?: typeof fetch;
}): Promise<CodexAuthMaterial> {
  opts.onOauthLine?.("[auth] starting Cowork-owned Codex browser login.");
  return await runCodexBrowserOAuth({
    paths: opts.paths,
    fetchImpl: opts.fetchImpl ?? fetch,
    onLine: opts.onOauthLine,
    openUrl: opts.openUrl ?? openExternalUrl,
  });
}

async function persistCoworkCodexAuth(
  paths: AiCoworkerPaths,
  material: CodexAuthMaterial,
): Promise<CodexAuthMaterial> {
  const persisted = await writeCodexAuthMaterial(paths, {
    ...material,
    file: codexAuthFilePath(paths),
  });
  const reloaded = await readCodexAuthMaterial(paths);
  if (!reloaded?.accessToken) {
    throw new Error(`Codex auth was not persisted to ${persisted.file}.`);
  }
  if (reloaded.accessToken !== persisted.accessToken) {
    throw new Error(`Codex auth at ${persisted.file} did not round-trip after write.`);
  }
  return reloaded;
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

  const fetchImpl = opts.fetchImpl ?? fetch;
  const methodId = (opts.methodId ?? "oauth_cli").trim() || "oauth_cli";

  let existing = await readCodexAuthMaterial(paths);
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
    if (methodId !== "oauth_cli") {
      opts.onOauthLine?.(`[auth] deprecated Codex auth method "${methodId}" requested; using Codex-native browser login.`);
    }
    if (opts.code?.trim()) {
      throw new Error("Codex OAuth is browser-managed by Cowork. Start sign-in without a pasted authorization code.");
    }
    const oauthCredentials = await connectOauthDeps.runCodexLogin({
      paths,
      onOauthLine: opts.onOauthLine,
      openUrl: opts.openUrl,
      fetchImpl,
    });
    const persistedAuth = await persistCoworkCodexAuth(paths, oauthCredentials);

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
      oauthCredentialsFile: persistedAuth.file,
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

export async function disconnectProvider(opts: {
  provider: ConnectService;
  paths?: AiCoworkerPaths;
}): Promise<DisconnectProviderResult> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  const store = await readConnectionStore(paths);
  const now = new Date().toISOString();

  if (opts.provider === "codex-cli") {
    const cleared = await clearCodexAuthMaterial(paths);
    if (store.services["codex-cli"]) {
      delete store.services["codex-cli"];
    }
    store.updatedAt = now;
    await writeConnectionStore(paths, store);
    return {
      ok: true,
      provider: opts.provider,
      storageFile: paths.connectionsFile,
      message: cleared.removed ? "Codex OAuth credentials cleared." : "Codex connection cleared.",
      oauthCredentialsFile: cleared.file,
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
