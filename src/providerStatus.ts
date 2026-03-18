import { z } from "zod";

import { getAiCoworkerPaths, maskApiKey, readConnectionStore, type AiCoworkerPaths, type ConnectionStore } from "./connect";
import { CODEX_BACKEND_BASE_URL, decodeJwtPayload, isTokenExpiring, readCodexAuthMaterial, refreshCodexAuthMaterial } from "./providers/codex-auth";
import { listLmStudioLlms } from "./providers/lmstudio/catalog";
import { isLmStudioError, listLmStudioModels, resolveLmStudioProviderOptions } from "./providers/lmstudio/client";
import { PROVIDER_NAMES, type ProviderName } from "./types";
import { resolveAuthHomeDir } from "./utils/authHome";

export type ProviderStatusMode = "missing" | "error" | "api_key" | "oauth" | "oauth_pending" | "local";

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
  savedApiKeyMasks?: Partial<Record<string, string>>;
  usage?: ProviderUsageStatus;
  /** True when the token is expired but a refresh token exists (i.e. recovery is possible). */
  tokenRecoverable?: boolean;
};

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const finiteNumberSchema = z.number().finite();
const providerStatusModeSchema = z.enum(["api_key", "oauth", "oauth_pending", "local"]);

function normalizeProviderStatusMode(mode: unknown): ProviderStatusMode {
  const parsed = providerStatusModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : "missing";
}

function asNonEmptyString(value: unknown): string | undefined {
  const parsed = nonEmptyTrimmedStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  }

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
  };
}

const codexRateLimitWindowSchema = z.object({
  used_percent: finiteNumberSchema,
  limit_window_seconds: finiteNumberSchema,
  reset_after_seconds: finiteNumberSchema.optional(),
  reset_at: finiteNumberSchema.optional(),
}).passthrough();

const codexRateLimitDetailsSchema = z.object({
  allowed: z.boolean().optional(),
  limit_reached: z.boolean().optional(),
  primary_window: codexRateLimitWindowSchema.nullish(),
  secondary_window: codexRateLimitWindowSchema.nullish(),
}).passthrough();

const codexCreditsSchema = z.object({
  has_credits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.union([z.string(), finiteNumberSchema]).optional(),
}).passthrough();

const codexAdditionalRateLimitSchema = z.object({
  limit_name: nonEmptyTrimmedStringSchema.optional(),
  metered_feature: nonEmptyTrimmedStringSchema.optional(),
  rate_limit: codexRateLimitDetailsSchema.nullish(),
}).passthrough();

const codexUsageStatusSchema = z.object({
  account_id: nonEmptyTrimmedStringSchema.optional(),
  email: nonEmptyTrimmedStringSchema.optional(),
  plan_type: z.string().trim().min(1).optional(),
  rate_limit: codexRateLimitDetailsSchema.nullish(),
  code_review_rate_limit: codexRateLimitDetailsSchema.nullish(),
  additional_rate_limits: z.array(codexAdditionalRateLimitSchema).nullish(),
  credits: codexCreditsSchema.nullish(),
}).passthrough();

function codexUsageEndpoint(): string {
  return CODEX_BACKEND_BASE_URL.replace(/\/codex$/, "/wham/usage");
}

function epochSecondsToIso(value: number | undefined): string | undefined {
  if (!Number.isFinite(value ?? NaN)) return undefined;
  return new Date((value as number) * 1000).toISOString();
}

function mapCodexRateLimitWindow(
  window: z.infer<typeof codexRateLimitWindowSchema> | null | undefined,
): ProviderRateLimitWindow | null | undefined {
  if (!window) return null;
  return {
    usedPercent: window.used_percent,
    windowSeconds: window.limit_window_seconds,
    ...(Number.isFinite(window.reset_after_seconds) ? { resetAfterSeconds: window.reset_after_seconds } : {}),
    ...(Number.isFinite(window.reset_at) ? { resetAt: epochSecondsToIso(window.reset_at) } : {}),
  };
}

function mapCodexCredits(
  credits: z.infer<typeof codexCreditsSchema> | null | undefined,
): ProviderCredits | null | undefined {
  if (!credits) return null;
  return {
    hasCredits: credits.has_credits,
    unlimited: credits.unlimited,
    ...(credits.balance !== undefined ? { balance: String(credits.balance) } : {}),
  };
}

function mapCodexRateLimitSnapshot(opts: {
  limitId?: string;
  limitName?: string;
  details?: z.infer<typeof codexRateLimitDetailsSchema> | null;
  credits?: z.infer<typeof codexCreditsSchema> | null;
}): ProviderRateLimitSnapshot {
  return {
    ...(opts.limitId ? { limitId: opts.limitId } : {}),
    ...(opts.limitName ? { limitName: opts.limitName } : {}),
    ...(opts.details?.allowed !== undefined ? { allowed: opts.details.allowed } : {}),
    ...(opts.details?.limit_reached !== undefined ? { limitReached: opts.details.limit_reached } : {}),
    ...(opts.details !== undefined ? { primaryWindow: mapCodexRateLimitWindow(opts.details?.primary_window) } : {}),
    ...(opts.details !== undefined ? { secondaryWindow: mapCodexRateLimitWindow(opts.details?.secondary_window) } : {}),
    ...(opts.credits !== undefined ? { credits: mapCodexCredits(opts.credits) } : {}),
  };
}

function mapCodexUsageStatus(
  payload: z.infer<typeof codexUsageStatusSchema>,
): ProviderUsageStatus {
  const rateLimits: ProviderRateLimitSnapshot[] = [
    mapCodexRateLimitSnapshot({
      limitId: "codex",
      details: payload.rate_limit ?? undefined,
      credits: payload.credits ?? undefined,
    }),
  ];

  if (payload.code_review_rate_limit) {
    rateLimits.push(
      mapCodexRateLimitSnapshot({
        limitId: "code_review",
        limitName: "Code Review",
        details: payload.code_review_rate_limit,
      }),
    );
  }

  for (const additional of payload.additional_rate_limits ?? []) {
    rateLimits.push(
      mapCodexRateLimitSnapshot({
        limitId: additional.metered_feature,
        limitName: additional.limit_name,
        details: additional.rate_limit ?? undefined,
      }),
    );
  }

  return {
    ...(payload.account_id ? { accountId: payload.account_id } : {}),
    ...(payload.email ? { email: payload.email } : {}),
    ...(payload.plan_type ? { planType: payload.plan_type } : {}),
    rateLimits,
  };
}

async function codexBackendVerification(opts: {
  idToken?: string;
  accessToken: string;
  accountId?: string;
  fetchImpl: typeof fetch;
}): Promise<{ email?: string; name?: string; message: string; ok: boolean; usage?: ProviderUsageStatus }> {
  const idPayload = opts.idToken ? decodeJwtPayload(opts.idToken) : null;
  const accessPayload = decodeJwtPayload(opts.accessToken);
  const email = asNonEmptyString(idPayload?.email) ?? asNonEmptyString(accessPayload?.email);
  const accountId =
    asNonEmptyString(opts.accountId) ??
    asNonEmptyString(idPayload?.chatgpt_account_id) ??
    asNonEmptyString(accessPayload?.chatgpt_account_id) ??
    asNonEmptyString((idPayload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined)?.chatgpt_account_id) ??
    asNonEmptyString((accessPayload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined)?.chatgpt_account_id);
  if (!accountId) {
    return { email, ok: false, message: "Codex token missing ChatGPT account id; cannot verify backend access." };
  }

  try {
    const usageRes = await opts.fetchImpl(codexUsageEndpoint(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${opts.accessToken}`,
        "chatgpt-account-id": accountId,
      },
    });
    if (!usageRes.ok) {
      return { email, ok: false, message: `Codex usage endpoint failed (${usageRes.status}).` };
    }

    const usageJson = await usageRes.json();
    const parsedUsage = codexUsageStatusSchema.safeParse(usageJson);
    if (!parsedUsage.success) {
      return { email, ok: false, message: "Codex usage endpoint returned an invalid payload." };
    }
    const planType = asNonEmptyString(parsedUsage.data.plan_type);
    const planSuffix = planType ? ` (${planType})` : "";
    const usage = mapCodexUsageStatus(parsedUsage.data);
    const usageEmail = usage?.email ?? email;
    return { email: usageEmail, ok: true, message: `Verified via Codex usage endpoint${planSuffix}.`, usage };
  } catch (err) {
    return { email, ok: false, message: `Codex usage endpoint error: ${String(err)}` };
  }
}

async function getCodexCliStatus(opts: {
  paths: AiCoworkerPaths;
  store: ConnectionStore;
  checkedAt: string;
  fetchImpl: typeof fetch;
}): Promise<ProviderStatus> {
  const base = statusFromConnectionStore({ provider: "codex-cli", store: opts.store, checkedAt: opts.checkedAt });

  // Respect an explicitly saved API key, but never surface it.
  const entry = opts.store.services["codex-cli"];
  if (entry?.mode === "api_key" && entry.apiKey) {
    return { ...base, provider: "codex-cli", authorized: true, mode: "api_key", verified: false, account: null };
  }

  let material = await readCodexAuthMaterial(opts.paths);
  if (!material?.accessToken) {
    return {
      ...base,
      provider: "codex-cli",
      authorized: false,
      verified: false,
      mode: base.mode === "oauth_pending" ? "oauth_pending" : "missing",
      account: null,
      message: "Not logged in to Codex. Run /connect codex-cli.",
    };
  }

  let refreshMessage = "";
  if (isTokenExpiring(material)) {
    const maxAttempts = 3;
    const delays = [500, 1000, 2000];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.warn(`[codex-auth] Token expiring, refresh attempt ${attempt}/${maxAttempts}...`);
        material = await refreshCodexAuthMaterial({
          paths: opts.paths,
          material,
          fetchImpl: opts.fetchImpl,
        });
        refreshMessage = " Token refreshed.";
        console.warn("[codex-auth] Token refresh succeeded.");
        break;
      } catch (err) {
        const errMsg = String(err);
        console.warn(`[codex-auth] Token refresh attempt ${attempt} failed: ${errMsg}`);
        refreshMessage = ` Token refresh failed: ${errMsg}`;
        // Don't retry on permanent errors
        if (
          errMsg.includes("missing refresh token") ||
          errMsg.includes("(400)") ||
          errMsg.includes("(401)")
        ) {
          break;
        }
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, delays[attempt - 1]));
        }
      }
    }
  }

  if (isTokenExpiring(material, 0)) {
    const recoverable = Boolean(material.refreshToken);
    console.warn(`[codex-auth] Token still expired after refresh attempts. recoverable=${recoverable}`);
    return {
      provider: "codex-cli",
      authorized: false,
      verified: false,
      mode: "oauth",
      account: material.email ? { email: material.email } : null,
      message: `Codex token expired.${refreshMessage || " Reconnect codex-cli."}`.trim(),
      checkedAt: opts.checkedAt,
      tokenRecoverable: recoverable,
    };
  }

  const ui = await codexBackendVerification({
    idToken: material.idToken,
    accessToken: material.accessToken,
    accountId: material.accountId,
    fetchImpl: opts.fetchImpl,
  });
  const account: ProviderAccount | null =
    ui.email || ui.name || material.email ? { email: ui.email ?? material.email, name: ui.name } : null;

  if (ui.ok) {
    return {
      provider: "codex-cli",
      authorized: true,
      verified: true,
      mode: "oauth",
      account,
      message: `${ui.message}${refreshMessage}`.trim(),
      checkedAt: opts.checkedAt,
      ...(ui.usage ? { usage: ui.usage } : {}),
    };
  }

  return {
    provider: "codex-cli",
    authorized: true,
    verified: false,
    mode: "oauth",
    account,
    message: `Codex credentials present, but verification failed. ${ui.message}${refreshMessage}`,
    checkedAt: opts.checkedAt,
    ...(ui.usage ? { usage: ui.usage } : {}),
  };
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
    const models = (await listLmStudioModels({
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey ?? storedProviderApiKey(opts.store, "lmstudio"),
      fetchImpl: opts.fetchImpl,
    })).models;
    const llmCount = listLmStudioLlms(models).length;
    return {
      provider: "lmstudio",
      authorized: true,
      verified: true,
      mode: "local",
      account: null,
      message: llmCount > 0
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

export async function getProviderStatuses(opts: {
  homedir?: string;
  paths?: AiCoworkerPaths;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ProviderStatus[]> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());

  const checkedAt = now().toISOString();
  const store = await readConnectionStore(paths);

  const out: ProviderStatus[] = [];
  for (const provider of PROVIDER_NAMES) {
    if (provider === "codex-cli") {
      out.push(await getCodexCliStatus({ paths, store, checkedAt, fetchImpl }));
      continue;
    }
    if (provider === "lmstudio") {
      out.push(await getLmStudioStatus({
        store,
        checkedAt,
        providerOptions: opts.providerOptions,
        env: opts.env,
        fetchImpl,
      }));
      continue;
    }
    out.push(statusFromConnectionStore({ provider, store, checkedAt }));
  }

  return out;
}
