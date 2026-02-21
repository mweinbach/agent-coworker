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

function joinUrl(base: string, suffix: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${b}${s}`;
}

function normalizeProviderStatusMode(mode: unknown): ProviderStatusMode {
  return mode === "api_key" || mode === "oauth" || mode === "oauth_pending" ? mode : "missing";
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
  const email =
    (typeof idPayload?.email === "string" ? idPayload.email : undefined) ??
    (typeof accessPayload?.email === "string" ? accessPayload.email : undefined);
  const iss =
    (typeof idPayload?.iss === "string" ? idPayload.iss : undefined) ??
    (typeof accessPayload?.iss === "string" ? accessPayload.iss : undefined) ??
    opts.issuer;
  if (!iss) {
    return { email, ok: false, message: "Codex token missing issuer; cannot resolve userinfo endpoint." };
  }

  try {
    const wellKnownUrl = joinUrl(iss, "/.well-known/openid-configuration");
    const wkRes = await opts.fetchImpl(wellKnownUrl, { method: "GET" });
    if (!wkRes.ok) {
      return { email, ok: false, message: `Failed to fetch OIDC discovery (${wkRes.status}).` };
    }
    const wkJson = (await wkRes.json()) as any;
    const userinfo = typeof wkJson?.userinfo_endpoint === "string" ? wkJson.userinfo_endpoint : null;
    if (!userinfo) {
      return { email, ok: false, message: "OIDC discovery missing userinfo_endpoint." };
    }

    const uiRes = await opts.fetchImpl(userinfo, {
      method: "GET",
      headers: { authorization: `Bearer ${opts.accessToken}` },
    });
    if (!uiRes.ok) {
      return { email, ok: false, message: `OIDC userinfo failed (${uiRes.status}).` };
    }

    const uiJson = (await uiRes.json()) as any;
    const name = typeof uiJson?.name === "string" ? uiJson.name : undefined;
    const uiEmail = typeof uiJson?.email === "string" ? uiJson.email : undefined;
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

  let material = await readCodexAuthMaterial(opts.paths, { migrateLegacy: true });
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
