import { asRecord, asString } from "../runtime/piRuntimeOptions";
import { openExternalUrl, type UrlOpener } from "../utils/browser";
import { type CodexAppServerClient, withCodexAppServerClient } from "./codexAppServerClient";

export type CodexAppServerAccount = {
  type: "apiKey" | "chatgpt";
  email?: string;
  planType?: string;
};

export type CodexAppServerRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt?: number;
};

export type CodexAppServerRateLimits = {
  primary?: CodexAppServerRateLimitWindow | null;
  secondary?: CodexAppServerRateLimitWindow | null;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string | number;
  } | null;
};

export type CodexAppServerModel = {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
};

export type CodexAppServerApp = {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string;
  logoUrlDark?: string;
  distributionChannel?: string;
  installUrl?: string;
  isAccessible: boolean;
  isEnabled: boolean;
  appMetadata?: Record<string, unknown>;
  labels?: Record<string, string>;
};

type CodexAppServerAppConfigEntry = {
  enabled?: boolean | null;
};

type CodexAppServerAppsConfig = {
  defaultEnabled?: boolean | null;
  entries: Map<string, CodexAppServerAppConfigEntry>;
};

type ReadAccountOptions = {
  refreshToken?: boolean;
  log?: (line: string) => void;
};

type ReadRateLimitsOptions = {
  log?: (line: string) => void;
};

type LoginOptions = {
  openUrl?: UrlOpener;
  log?: (line: string) => void;
};

type ListModelsOptions = {
  log?: (line: string) => void;
};

type ListAppsOptions = {
  forceRefetch?: boolean;
  log?: (line: string) => void;
};

type SetAppEnabledOptions = {
  appId: string;
  enabled: boolean;
  log?: (line: string) => void;
};

type AppServerAuthOverrides = {
  readAccount?: (
    opts: ReadAccountOptions,
  ) => Promise<{ account: CodexAppServerAccount | null; requiresOpenaiAuth: boolean }>;
  readRateLimits?: (opts: ReadRateLimitsOptions) => Promise<CodexAppServerRateLimits | null>;
  login?: (opts: LoginOptions) => Promise<{ account: CodexAppServerAccount | null }>;
  listModels?: (opts: ListModelsOptions) => Promise<CodexAppServerModel[]>;
  listApps?: (opts: ListAppsOptions) => Promise<CodexAppServerApp[]>;
  setAppEnabled?: (opts: SetAppEnabledOptions) => Promise<void>;
};

const appServerAuthOverrides: AppServerAuthOverrides = {};

async function withClient<T>(
  fn: (client: CodexAppServerClient) => Promise<T>,
  log?: (line: string) => void,
): Promise<T> {
  return await withCodexAppServerClient(fn, { log });
}

function normalizeAccount(value: unknown): CodexAppServerAccount | null {
  const account = asRecord(value);
  const type = asString(account?.type);
  if (type === "apiKey") return { type };
  if (type === "chatgpt") {
    const email = asString(account?.email);
    const planType = asString(account?.planType);
    return {
      type,
      ...(email ? { email } : {}),
      ...(planType ? { planType } : {}),
    };
  }
  return null;
}

function normalizeModel(value: unknown): CodexAppServerModel | null {
  const model = asRecord(value);
  const id = asString(model?.id);
  const modelId = asString(model?.model);
  const canonicalId = modelId || id;
  if (!canonicalId) return null;
  const description = asString(model?.description);
  return {
    id: canonicalId,
    model: modelId || canonicalId,
    displayName: asString(model?.displayName) || canonicalId,
    ...(description ? { description } : {}),
    isDefault: model?.isDefault === true,
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const text = asString(entry);
    if (text !== undefined) normalized[key] = text;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeApp(value: unknown): CodexAppServerApp | null {
  const app = asRecord(value);
  const id = asString(app?.id);
  const name = asString(app?.name);
  if (!id || !name) return null;
  const description = asString(app?.description);
  const logoUrl = asString(app?.logoUrl);
  const logoUrlDark = asString(app?.logoUrlDark);
  const distributionChannel = asString(app?.distributionChannel);
  const installUrl = asString(app?.installUrl);
  const appMetadata = asRecord(app?.appMetadata);
  const labels = normalizeStringRecord(app?.labels);
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(logoUrlDark ? { logoUrlDark } : {}),
    ...(distributionChannel ? { distributionChannel } : {}),
    ...(installUrl ? { installUrl } : {}),
    isAccessible: app?.isAccessible === true,
    isEnabled: app?.isEnabled === true,
    ...(appMetadata ? { appMetadata } : {}),
    ...(labels ? { labels } : {}),
  };
}

function normalizeAppConfig(value: unknown): CodexAppServerAppsConfig {
  const apps = asRecord(value);
  const entries = new Map<string, CodexAppServerAppConfigEntry>();
  let defaultEnabled: boolean | null | undefined;
  if (!apps) return { entries };

  for (const [key, entryValue] of Object.entries(apps)) {
    const entry = asRecord(entryValue);
    if (key === "_default") {
      defaultEnabled = entry?.enabled === true ? true : entry?.enabled === false ? false : null;
      continue;
    }
    entries.set(key, {
      enabled: entry?.enabled === true ? true : entry?.enabled === false ? false : null,
    });
  }

  return {
    ...(defaultEnabled !== undefined ? { defaultEnabled } : {}),
    entries,
  };
}

function isUnknownMethodError(error: unknown, method: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("unknown variant") ||
    error.message.includes("Unknown method") ||
    error.message.includes(`unknown method ${method}`) ||
    error.message.includes(`method not found: ${method}`)
  );
}

async function readCodexAppServerAppsConfig(
  client: CodexAppServerClient,
): Promise<CodexAppServerAppsConfig> {
  const result = asRecord(await client.request("config/read", {}));
  const config = asRecord(result?.config);
  return normalizeAppConfig(config?.apps);
}

async function listCodexAppServerMcpStatuses(client: CodexAppServerClient): Promise<unknown[]> {
  const statuses: unknown[] = [];
  let cursor: string | undefined;
  do {
    const result = asRecord(
      await client.request("mcpServerStatus/list", {
        limit: 100,
        cursor: cursor ?? null,
      }),
    );
    const items = Array.isArray(result?.data) ? result.data : [];
    statuses.push(...items);
    cursor = asString(result?.nextCursor) ?? asString(result?.next_cursor);
  } while (cursor);
  return statuses;
}

function appsFromMcpServerStatuses(
  statuses: unknown[],
  appsConfig: CodexAppServerAppsConfig,
): CodexAppServerApp[] {
  const apps = new Map<
    string,
    CodexAppServerApp & { appMetadata: NonNullable<CodexAppServerApp["appMetadata"]> }
  >();

  for (const statusValue of statuses) {
    const status = asRecord(statusValue);
    const serverName = asString(status?.name);
    const tools = asRecord(status?.tools);
    if (!tools) continue;

    for (const toolValue of Object.values(tools)) {
      const tool = asRecord(toolValue);
      const meta = asRecord(tool?._meta);
      const connectorId = asString(meta?.connector_id);
      if (!connectorId) continue;

      const existing = apps.get(connectorId);
      const name = asString(meta?.connector_name) ?? connectorId;
      const description = asString(meta?.connector_description);
      const appConfig = appsConfig.entries.get(connectorId);
      const isEnabled = appConfig?.enabled ?? appsConfig.defaultEnabled ?? true;
      const app =
        existing ??
        ({
          id: connectorId,
          name,
          ...(description ? { description } : {}),
          isAccessible: true,
          isEnabled,
          appMetadata: {
            source: "mcpServerStatus/list",
            toolCount: 0,
            serverNames: [],
            linkIds: [],
          },
        } satisfies CodexAppServerApp & {
          appMetadata: NonNullable<CodexAppServerApp["appMetadata"]>;
        });

      app.isEnabled = isEnabled;
      if (!app.description && description) app.description = description;
      const metadata = app.appMetadata;
      metadata.toolCount = Number(metadata.toolCount ?? 0) + 1;
      const serverNames = Array.isArray(metadata.serverNames) ? metadata.serverNames : [];
      if (serverName && !serverNames.includes(serverName)) serverNames.push(serverName);
      metadata.serverNames = serverNames;
      const linkId = asString(meta?.link_id);
      const linkIds = Array.isArray(metadata.linkIds) ? metadata.linkIds : [];
      if (linkId && !linkIds.includes(linkId)) linkIds.push(linkId);
      metadata.linkIds = linkIds;
      apps.set(connectorId, app);
    }
  }

  for (const [appId, appConfig] of appsConfig.entries) {
    if (apps.has(appId)) continue;
    if (appConfig.enabled !== false) continue;
    apps.set(appId, {
      id: appId,
      name: appId,
      isAccessible: false,
      isEnabled: false,
      appMetadata: {
        source: "config/read",
        toolCount: 0,
        serverNames: [],
        linkIds: [],
      },
    });
  }

  return [...apps.values()];
}

async function listCodexAppServerAppsViaMcpStatus(
  client: CodexAppServerClient,
): Promise<CodexAppServerApp[]> {
  const [statuses, appsConfig] = await Promise.all([
    listCodexAppServerMcpStatuses(client),
    readCodexAppServerAppsConfig(client),
  ]);
  return appsFromMcpServerStatuses(statuses, appsConfig);
}

async function listCodexAppServerAppsViaLegacyAppList(
  client: CodexAppServerClient,
  opts: ListAppsOptions,
): Promise<CodexAppServerApp[]> {
  const apps: CodexAppServerApp[] = [];
  let cursor: string | undefined;
  do {
    const result = asRecord(
      await client.request("app/list", {
        limit: 100,
        cursor: cursor ?? null,
        forceRefetch: opts.forceRefetch === true,
      }),
    );
    const items = Array.isArray(result?.data) ? result.data : [];
    for (const item of items) {
      const app = normalizeApp(item);
      if (app) apps.push(app);
    }
    cursor = asString(result?.nextCursor) ?? asString(result?.next_cursor);
  } while (cursor);
  return apps;
}

export async function listCodexAppServerModels(
  opts: ListModelsOptions = {},
): Promise<CodexAppServerModel[]> {
  if (appServerAuthOverrides.listModels) return await appServerAuthOverrides.listModels(opts);
  return await withClient(async (client) => {
    const models: CodexAppServerModel[] = [];
    let cursor: string | undefined;
    do {
      const result = asRecord(
        await client.request("model/list", {
          limit: 100,
          cursor: cursor ?? null,
        }),
      );
      const items = Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result?.items)
          ? result.items
          : [];
      for (const item of items) {
        const model = normalizeModel(item);
        if (model) models.push(model);
      }
      cursor = asString(result?.nextCursor) ?? asString(result?.next_cursor);
    } while (cursor);
    return models;
  }, opts.log);
}

export async function listCodexAppServerApps(
  opts: ListAppsOptions = {},
): Promise<CodexAppServerApp[]> {
  if (appServerAuthOverrides.listApps) return await appServerAuthOverrides.listApps(opts);
  return await withClient(async (client) => {
    try {
      return await listCodexAppServerAppsViaMcpStatus(client);
    } catch (error) {
      if (!isUnknownMethodError(error, "mcpServerStatus/list")) throw error;
      return await listCodexAppServerAppsViaLegacyAppList(client, opts);
    }
  }, opts.log);
}

export async function setCodexAppServerAppEnabled(opts: SetAppEnabledOptions): Promise<void> {
  if (appServerAuthOverrides.setAppEnabled) {
    await appServerAuthOverrides.setAppEnabled(opts);
    return;
  }
  const appId = opts.appId.trim();
  if (!appId) throw new Error("App id is required.");
  await withClient(async (client) => {
    await client.request("config/value/write", {
      keyPath: `apps.${appId}.enabled`,
      value: opts.enabled,
      mergeStrategy: "upsert",
    });
  }, opts.log);
}

export async function readCodexAppServerAccount(
  opts: ReadAccountOptions,
): Promise<{ account: CodexAppServerAccount | null; requiresOpenaiAuth: boolean }> {
  if (appServerAuthOverrides.readAccount) return await appServerAuthOverrides.readAccount(opts);
  return await withClient(async (client) => {
    const result = asRecord(
      await client.request("account/read", { refreshToken: opts.refreshToken ?? false }),
    );
    return {
      account: normalizeAccount(result?.account),
      requiresOpenaiAuth: result?.requiresOpenaiAuth === true,
    };
  }, opts.log);
}

export async function readCodexAppServerRateLimits(
  opts: ReadRateLimitsOptions,
): Promise<CodexAppServerRateLimits | null> {
  if (appServerAuthOverrides.readRateLimits) {
    return await appServerAuthOverrides.readRateLimits(opts);
  }
  return await withClient(async (client) => {
    const result = asRecord(await client.request("account/rateLimits/read"));
    return (asRecord(result?.rateLimits) as CodexAppServerRateLimits | null) ?? null;
  }, opts.log);
}

export async function loginCodexAppServerChatGpt(
  opts: LoginOptions,
): Promise<{ account: CodexAppServerAccount | null }> {
  if (appServerAuthOverrides.login) return await appServerAuthOverrides.login(opts);
  return await withClient(async (client) => {
    const started = asRecord(await client.request("account/login/start", { type: "chatgpt" }));
    const authUrl = asString(started?.authUrl);
    const loginId = asString(started?.loginId);
    if (!authUrl || !loginId) {
      throw new Error("codex app-server did not return a ChatGPT login URL.");
    }
    opts.log?.("[auth] opening Codex app-server ChatGPT login URL.");
    await (opts.openUrl ?? openExternalUrl)(authUrl);
    await waitForLogin(client, loginId);
    const result = asRecord(await client.request("account/read", { refreshToken: true }));
    return {
      account: normalizeAccount(result?.account),
    };
  }, opts.log);
}

export const __internal = {
  appsFromMcpServerStatuses,
  normalizeAppConfig,
  setAuthOverridesForTests(overrides: AppServerAuthOverrides): void {
    appServerAuthOverrides.readAccount = overrides.readAccount;
    appServerAuthOverrides.readRateLimits = overrides.readRateLimits;
    appServerAuthOverrides.login = overrides.login;
    appServerAuthOverrides.listModels = overrides.listModels;
    appServerAuthOverrides.listApps = overrides.listApps;
    appServerAuthOverrides.setAppEnabled = overrides.setAppEnabled;
  },
  resetAuthOverridesForTests(): void {
    delete appServerAuthOverrides.readAccount;
    delete appServerAuthOverrides.readRateLimits;
    delete appServerAuthOverrides.login;
    delete appServerAuthOverrides.listModels;
    delete appServerAuthOverrides.listApps;
    delete appServerAuthOverrides.setAppEnabled;
  },
} as const;

async function waitForLogin(client: CodexAppServerClient, loginId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        dispose();
        reject(new Error("Timed out waiting for Codex app-server login."));
      },
      10 * 60 * 1000,
    );
    const dispose = client.onNotification((notification) => {
      if (notification.method !== "account/login/completed") return;
      const params = asRecord(notification.params);
      if (asString(params?.loginId) !== loginId) return;
      clearTimeout(timeout);
      dispose();
      if (params?.success === true) {
        resolve();
      } else {
        reject(new Error(asString(params?.error) ?? "Codex app-server login failed."));
      }
    });
  });
}
