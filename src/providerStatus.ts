import path from "node:path";

import { z } from "zod";

import {
  type AiCoworkerPaths,
  type ConnectionStore,
  getAiCoworkerPaths,
  maskApiKey,
  readConnectionStore,
} from "./connect";
import {
  maskBedrockFieldValues,
  readBedrockCatalogSnapshot,
  refreshBedrockDiscoveryCache,
} from "./providers/bedrockShared";
import {
  type CodexAppServerRateLimits,
  readCodexAppServerAccount,
  readCodexAppServerRateLimits,
} from "./providers/codexAppServerAuth";
import { listLmStudioLlms } from "./providers/lmstudio/catalog";
import {
  isLmStudioError,
  listLmStudioModels,
  resolveLmStudioProviderOptions,
} from "./providers/lmstudio/client";
import { PROVIDER_NAMES, type ProviderName } from "./types";
import { resolveAuthHomeDir } from "./utils/authHome";

export type ProviderStatusMode =
  | "missing"
  | "error"
  | "api_key"
  | "oauth"
  | "oauth_pending"
  | "local"
  | "credentials";

export type ProviderAccount = {
  email?: string;
  name?: string;
};

export type ProviderRateLimitWindow = {
  usedPercent: number;
  windowSeconds: number;
  resetAfterSeconds?: number;
  resetAt?: string;
};

export type ProviderCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

export type ProviderRateLimitSnapshot = {
  limitId?: string;
  limitName?: string;
  allowed?: boolean;
  limitReached?: boolean;
  primaryWindow?: ProviderRateLimitWindow | null;
  secondaryWindow?: ProviderRateLimitWindow | null;
  credits?: ProviderCredits | null;
};

export type ProviderUsageStatus = {
  accountId?: string;
  email?: string;
  planType?: string;
  rateLimits: ProviderRateLimitSnapshot[];
};

export type ProviderStatus = {
  provider: ProviderName;
  authorized: boolean;
  verified: boolean;
  mode: ProviderStatusMode;
  account: ProviderAccount | null;
  message: string;
  checkedAt: string;
  methodId?: string;
  savedApiKeyMasks?: Partial<Record<string, string>>;
  savedFieldMasks?: Partial<Record<string, string>>;
  usage?: ProviderUsageStatus;
  /** True when the token is expired but a refresh token exists (i.e. recovery is possible). */
  tokenRecoverable?: boolean;
};

const providerStatusModeSchema = z.enum([
  "api_key",
  "oauth",
  "oauth_pending",
  "local",
  "credentials",
]);

function normalizeProviderStatusMode(mode: unknown): ProviderStatusMode {
  const parsed = providerStatusModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : "missing";
}

function buildSavedApiKeyMasks(opts: {
  provider: ProviderName;
  store: ConnectionStore;
}): Partial<Record<string, string>> | undefined {
  const out: Partial<Record<string, string>> = {};

  const providerEntry = opts.store.services[opts.provider];
  const providerApiKey = providerEntry?.mode === "api_key" ? providerEntry.apiKey?.trim() : "";
  if (providerApiKey) {
    out.api_key = maskApiKey(providerApiKey);
  }

  if (opts.provider === "google") {
    const exa = opts.store.toolApiKeys?.exa?.trim();
    if (exa) out.exa_api_key = maskApiKey(exa);
    const parallel = opts.store.toolApiKeys?.parallel?.trim();
    if (parallel) out.parallel_api_key = maskApiKey(parallel);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function buildSavedFieldMasks(opts: {
  provider: ProviderName;
  store: ConnectionStore;
}): Partial<Record<string, string>> | undefined {
  if (opts.provider !== "bedrock") return undefined;
  const entry = opts.store.services[opts.provider];
  if (entry?.mode !== "credentials" || !entry.values) return undefined;
  const out = maskBedrockFieldValues(entry.values);
  return Object.keys(out).length > 0 ? out : undefined;
}

function storedProviderApiKey(store: ConnectionStore, provider: ProviderName): string | undefined {
  const entry = store.services[provider];
  const apiKey = entry?.mode === "api_key" ? entry.apiKey?.trim() : "";
  return apiKey || undefined;
}

function statusFromConnectionStore(opts: {
  provider: ProviderName;
  store: ConnectionStore;
  checkedAt: string;
}): ProviderStatus {
  const entry = opts.store.services[opts.provider];
  const savedApiKeyMasks = buildSavedApiKeyMasks({ provider: opts.provider, store: opts.store });
  const savedFieldMasks = buildSavedFieldMasks({ provider: opts.provider, store: opts.store });
  if (!entry) {
    return {
      provider: opts.provider,
      authorized: false,
      verified: false,
      mode: "missing",
      account: null,
      message: "Not connected.",
      checkedAt: opts.checkedAt,
      ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
      ...(savedFieldMasks ? { savedFieldMasks } : {}),
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
      ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
      ...(savedFieldMasks ? { savedFieldMasks } : {}),
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
      ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
      ...(savedFieldMasks ? { savedFieldMasks } : {}),
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
      ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
      ...(savedFieldMasks ? { savedFieldMasks } : {}),
    };
  }

  if (entry.mode === "credentials") {
    return {
      provider: opts.provider,
      authorized: true,
      verified: false,
      mode: "credentials",
      account: null,
      message: "Credentials saved.",
      checkedAt: opts.checkedAt,
      ...(entry.methodId ? { methodId: entry.methodId } : {}),
      ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
      ...(savedFieldMasks ? { savedFieldMasks } : {}),
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
    ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
    ...(savedFieldMasks ? { savedFieldMasks } : {}),
  };
}

async function getBedrockStatus(opts: {
  paths: AiCoworkerPaths;
  store: ConnectionStore;
  checkedAt: string;
  env?: NodeJS.ProcessEnv;
  refreshDiscovery?: boolean;
}): Promise<ProviderStatus> {
  const base = statusFromConnectionStore({
    provider: "bedrock",
    store: opts.store,
    checkedAt: opts.checkedAt,
  });
  const discovery = opts.refreshDiscovery
    ? await refreshBedrockDiscoveryCache({
        paths: opts.paths,
        env: opts.env,
      })
    : await readBedrockCatalogSnapshot({
        paths: opts.paths,
        env: opts.env,
      });

  if (!discovery.auth) {
    return base;
  }

  const verified =
    opts.refreshDiscovery && "ok" in discovery ? discovery.ok && !discovery.usedCache : false;
  const message =
    discovery.message ??
    (base.mode === "missing" ? "Amazon Bedrock credentials detected." : base.message);

  return {
    provider: "bedrock",
    authorized: true,
    verified,
    mode: base.mode === "missing" ? "credentials" : base.mode,
    account: null,
    message,
    checkedAt: opts.checkedAt,
    methodId: base.methodId ?? discovery.auth.methodId,
    ...(base.savedApiKeyMasks ? { savedApiKeyMasks: base.savedApiKeyMasks } : {}),
    ...(base.savedFieldMasks ? { savedFieldMasks: base.savedFieldMasks } : {}),
  };
}

function epochSecondsToIso(value: number | undefined): string | undefined {
  if (!Number.isFinite(value ?? NaN)) return undefined;
  return new Date((value as number) * 1000).toISOString();
}

function mapCodexRateLimitWindow(
  window: NonNullable<CodexAppServerRateLimits["primary"]> | null | undefined,
): ProviderRateLimitWindow | null | undefined {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    windowSeconds: window.windowDurationMins * 60,
    ...(Number.isFinite(window.resetsAt) ? { resetAt: epochSecondsToIso(window.resetsAt) } : {}),
  };
}

function mapCodexCredits(credits: CodexAppServerRateLimits["credits"]): ProviderCredits | null {
  if (!credits) return null;
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    ...(credits.balance !== undefined ? { balance: String(credits.balance) } : {}),
  };
}

function codexHomeFromPaths(paths: AiCoworkerPaths): string {
  return path.join(paths.authDir, "codex-cli");
}

function isCodexAppServerAuthExpiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("token_expired") ||
    message.includes("Provided authentication token is expired") ||
    message.includes("could not be refreshed") ||
    message.includes("Please sign in again") ||
    message.includes("401 Unauthorized")
  );
}

async function getCodexCliStatus(opts: {
  paths: AiCoworkerPaths;
  store: ConnectionStore;
  checkedAt: string;
}): Promise<ProviderStatus> {
  const base = statusFromConnectionStore({
    provider: "codex-cli",
    store: opts.store,
    checkedAt: opts.checkedAt,
  });

  // Respect an explicitly saved API key, but never surface it.
  const entry = opts.store.services["codex-cli"];
  if (entry?.mode === "api_key" && entry.apiKey) {
    return {
      ...base,
      provider: "codex-cli",
      authorized: true,
      mode: "api_key",
      verified: false,
      account: null,
    };
  }

  try {
    const codexHome = codexHomeFromPaths(opts.paths);
    const accountResult = await readCodexAppServerAccount({ refreshToken: true, codexHome });
    if (!accountResult.account) {
      return {
        ...base,
        provider: "codex-cli",
        authorized: false,
        verified: false,
        mode: base.mode === "oauth_pending" ? "oauth_pending" : "missing",
        account: null,
        message: accountResult.requiresOpenaiAuth
          ? "Not logged in to Codex. Use /connect codex-cli."
          : "Codex app-server does not require OpenAI auth for the active config.",
      };
    }

    let rateLimits: CodexAppServerRateLimits | null = null;
    try {
      rateLimits = await readCodexAppServerRateLimits({ codexHome });
    } catch (error) {
      if (isCodexAppServerAuthExpiredError(error)) {
        return {
          ...base,
          provider: "codex-cli",
          authorized: false,
          verified: false,
          mode: "missing",
          account: null,
          message: "Codex app-server auth expired. Sign in again to refresh ChatGPT access.",
        };
      }
    }
    const usage: ProviderUsageStatus | undefined = rateLimits
      ? {
          ...(accountResult.account.email ? { email: accountResult.account.email } : {}),
          ...(accountResult.account.planType ? { planType: accountResult.account.planType } : {}),
          rateLimits: [
            {
              limitId: "codex",
              primaryWindow: mapCodexRateLimitWindow(rateLimits.primary),
              secondaryWindow: mapCodexRateLimitWindow(rateLimits.secondary),
              credits: mapCodexCredits(rateLimits.credits),
            },
          ],
        }
      : undefined;

    return {
      provider: "codex-cli",
      authorized: true,
      verified: true,
      mode: accountResult.account.type === "apiKey" ? "api_key" : "oauth",
      account: accountResult.account.email ? { email: accountResult.account.email } : null,
      message:
        accountResult.account.type === "apiKey"
          ? "Verified via codex app-server API key account."
          : `Verified via codex app-server ChatGPT account${
              accountResult.account.planType ? ` (${accountResult.account.planType})` : ""
            }.`,
      checkedAt: opts.checkedAt,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    return {
      ...base,
      provider: "codex-cli",
      authorized: false,
      verified: false,
      mode: "error",
      account: null,
      message: `Codex app-server status failed: ${String(error)}`,
    };
  }
}

async function getLmStudioStatus(opts: {
  store: ConnectionStore;
  checkedAt: string;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<ProviderStatus> {
  const providerConfig = resolveLmStudioProviderOptions(opts.providerOptions, opts.env);
  const savedApiKeyMasks = buildSavedApiKeyMasks({ provider: "lmstudio", store: opts.store });

  try {
    const models = (
      await listLmStudioModels({
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey ?? storedProviderApiKey(opts.store, "lmstudio"),
        fetchImpl: opts.fetchImpl,
      })
    ).models;
    const llmCount = listLmStudioLlms(models).length;
    return {
      provider: "lmstudio",
      authorized: true,
      verified: true,
      mode: "local",
      account: null,
      message:
        llmCount > 0
          ? `LM Studio server reachable at ${providerConfig.baseUrl}.`
          : `LM Studio server reachable at ${providerConfig.baseUrl}, but no LLMs are available.`,
      checkedAt: opts.checkedAt,
      ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
    };
  } catch (error) {
    const message = isLmStudioError(error)
      ? error.message
      : `Failed to query LM Studio at ${providerConfig.baseUrl}: ${String(error)}`;
    return {
      provider: "lmstudio",
      authorized: false,
      verified: false,
      mode: "error",
      account: null,
      message,
      checkedAt: opts.checkedAt,
      ...(savedApiKeyMasks ? { savedApiKeyMasks } : {}),
    };
  }
}

export async function getProviderStatuses(
  opts: {
    homedir?: string;
    paths?: AiCoworkerPaths;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    providerOptions?: unknown;
    env?: NodeJS.ProcessEnv;
    refreshBedrockDiscovery?: boolean;
  } = {},
): Promise<ProviderStatus[]> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());

  const checkedAt = now().toISOString();
  const store = await readConnectionStore(paths);

  const out: ProviderStatus[] = [];
  for (const provider of PROVIDER_NAMES) {
    if (provider === "codex-cli") {
      out.push(await getCodexCliStatus({ paths, store, checkedAt }));
      continue;
    }
    if (provider === "bedrock") {
      out.push(
        await getBedrockStatus({
          paths,
          store,
          checkedAt,
          env: opts.env,
          refreshDiscovery: opts.refreshBedrockDiscovery,
        }),
      );
      continue;
    }
    if (provider === "lmstudio") {
      out.push(
        await getLmStudioStatus({
          store,
          checkedAt,
          providerOptions: opts.providerOptions,
          env: opts.env,
          fetchImpl,
        }),
      );
      continue;
    }
    if (provider === "antigravity") {
      const base = statusFromConnectionStore({ provider, store, checkedAt });
      const googleEntry = store.services.google;
      const googleKey = googleEntry?.mode === "api_key" ? googleEntry.apiKey?.trim() : "";
      const envKey = (opts.env ?? process.env).GEMINI_API_KEY?.trim();
      const fallbackKey = googleKey || envKey;

      if (!base.authorized && fallbackKey) {
        base.authorized = true;
        base.mode = "api_key";
        base.message = googleKey
          ? "Using saved Google API key."
          : "Using GEMINI_API_KEY environment variable.";
        base.savedApiKeyMasks = {
          api_key: maskApiKey(fallbackKey),
        };
      }
      out.push(base);
      continue;
    }
    out.push(statusFromConnectionStore({ provider, store, checkedAt }));
  }

  return out;
}
