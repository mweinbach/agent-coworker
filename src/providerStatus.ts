import { z } from "zod";

import { getAiCoworkerPaths, maskApiKey, readConnectionStore, type AiCoworkerPaths, type ConnectionStore } from "./connect";
import { decodeJwtPayload, isTokenExpiring, readCodexAuthMaterial, refreshCodexAuthMaterial } from "./providers/codex-auth";
import { PROVIDER_NAMES, type ProviderName } from "./types";

export type ProviderStatusMode = "missing" | "error" | "api_key" | "oauth" | "oauth_pending";

export type ProviderAccount = {
  email?: string;
  name?: string;
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
};

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const providerStatusModeSchema = z.enum(["api_key", "oauth", "oauth_pending"]);
const oidcDiscoverySchema = z.object({
  userinfo_endpoint: nonEmptyTrimmedStringSchema,
}).passthrough();
const oidcUserInfoSchema = z.record(z.string(), z.unknown());

function joinUrl(base: string, suffix: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${b}${s}`;
}

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

async function codexOidcUserInfo(opts: {
  issuer?: string;
  idToken?: string;
  accessToken: string;
  fetchImpl: typeof fetch;
}): Promise<{ email?: string; name?: string; message: string; ok: boolean }> {
  const idPayload = opts.idToken ? decodeJwtPayload(opts.idToken) : null;
  const accessPayload = decodeJwtPayload(opts.accessToken);
  const email = asNonEmptyString(idPayload?.email) ?? asNonEmptyString(accessPayload?.email);
  const iss = asNonEmptyString(idPayload?.iss) ?? asNonEmptyString(accessPayload?.iss) ?? asNonEmptyString(opts.issuer);
  if (!iss) {
    return { email, ok: false, message: "Codex token missing issuer; cannot resolve userinfo endpoint." };
  }

  try {
    const wellKnownUrl = joinUrl(iss, "/.well-known/openid-configuration");
    const wkRes = await opts.fetchImpl(wellKnownUrl, { method: "GET" });
    if (!wkRes.ok) {
      return { email, ok: false, message: `Failed to fetch OIDC discovery (${wkRes.status}).` };
    }
    const wkJson = await wkRes.json();
    const discovery = oidcDiscoverySchema.safeParse(wkJson);
    if (!discovery.success) {
      return { email, ok: false, message: "OIDC discovery missing userinfo_endpoint." };
    }

    const uiRes = await opts.fetchImpl(discovery.data.userinfo_endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.accessToken}` },
    });
    if (!uiRes.ok) {
      return { email, ok: false, message: `OIDC userinfo failed (${uiRes.status}).` };
    }

    const uiJson = await uiRes.json();
    const parsedUserInfo = oidcUserInfoSchema.safeParse(uiJson);
    const name = parsedUserInfo.success ? asNonEmptyString(parsedUserInfo.data.name) : undefined;
    const uiEmail = parsedUserInfo.success ? asNonEmptyString(parsedUserInfo.data.email) : undefined;
    return { email: uiEmail ?? email, name, ok: true, message: "Verified via OIDC userinfo." };
  } catch (err) {
    return { email, ok: false, message: `OIDC userinfo error: ${String(err)}` };
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
    try {
      material = await refreshCodexAuthMaterial({
        paths: opts.paths,
        material,
        fetchImpl: opts.fetchImpl,
      });
      refreshMessage = " Token refreshed.";
    } catch (err) {
      refreshMessage = ` Token refresh failed: ${String(err)}`;
    }
  }

  if (isTokenExpiring(material, 0)) {
    return {
      provider: "codex-cli",
      authorized: false,
      verified: false,
      mode: "oauth",
      account: material.email ? { email: material.email } : null,
      message: `Codex token expired.${refreshMessage || " Reconnect codex-cli."}`.trim(),
      checkedAt: opts.checkedAt,
    };
  }

  const ui = await codexOidcUserInfo({
    issuer: material.issuer,
    idToken: material.idToken,
    accessToken: material.accessToken,
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
  };
}

export async function getProviderStatuses(opts: {
  homedir?: string;
  paths?: AiCoworkerPaths;
  fetchImpl?: typeof fetch;
  now?: () => Date;
} = {}): Promise<ProviderStatus[]> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir });
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
    out.push(statusFromConnectionStore({ provider, store, checkedAt }));
  }

  return out;
}
