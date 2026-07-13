import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupLegacyCoworkProductivitySkills } from "../coworkRuntime/cleanup";
import type { FetchLike } from "../extensions/source";
import { buildPluginCatalogSnapshot, installPluginsFromSource } from "../plugins";
import { readPluginInstallMetadata } from "../plugins/manifest";
import { readPluginOverrides } from "../plugins/overrides";
import {
  BUILT_IN_MARKETPLACE_REPO,
  buildMarketplaceInstallMetadataByPluginId,
  canonicalDefaultMarketplacePluginIdForTombstone,
  DEFAULT_MARKETPLACE_PLUGIN_IDS,
  fetchRemotePluginMarketplace,
} from "../plugins/remoteMarketplace";
import { ensureAiCoworkerHome, getAiCoworkerPaths } from "../store/connections";
import { type AgentConfig, isInstalledPluginCatalogEntry } from "../types";
import { writeTextFileAtomic } from "../utils/atomicFile";
import { fileLockRootForCoworkHome, withFileLock } from "../utils/fileLock";

const DEFAULT_SKILLS_STATE_FILE = "default-global-skills.json";
const DEFAULT_SKILLS_FAILURE_FILE = "default-global-skills.failure.json";
const INSTALL_STATE_VERSION = 1;
const FAILURE_STATE_VERSION = 1;
const BOOTSTRAP_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const bootstrapPromises = new Map<
  string,
  Promise<EnsureDefaultGlobalSkillsInstalledResult | null>
>();

type DefaultGlobalSkillsState = {
  version: number;
  marketplace: string;
  installedAt: string;
  plugins: string[];
};

type DefaultGlobalSkillsFailureState = {
  version: number;
  failedAt: string;
  message: string;
};

export type DefaultSkillSpec = {
  id: string;
};

export const DEFAULT_GLOBAL_SKILLS: readonly DefaultSkillSpec[] = [
  ...DEFAULT_MARKETPLACE_PLUGIN_IDS.map((id) => ({ id })),
] as const;

export function isDefaultPluginRemoved(
  pluginId: string,
  overrides: Awaited<ReturnType<typeof readPluginOverrides>>,
): boolean {
  const defaultPluginId = canonicalDefaultMarketplacePluginIdForTombstone(pluginId) ?? pluginId;
  return overrides.user.removedDefaultPlugins?.[defaultPluginId] === true;
}

export type EnsureDefaultGlobalSkillsInstalledResult = {
  status: "installed" | "already_installed";
  pluginsDir: string;
  stateFile: string;
  installed: string[];
  skippedExisting: string[];
  skippedRemoved: string[];
};

async function readState(stateFile: string): Promise<DefaultGlobalSkillsState | null> {
  try {
    const raw = await fs.readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DefaultGlobalSkillsState>;
    if (
      parsed.version !== INSTALL_STATE_VERSION ||
      typeof parsed.marketplace !== "string" ||
      typeof parsed.installedAt !== "string" ||
      !Array.isArray(parsed.plugins)
    ) {
      return null;
    }
    return {
      version: parsed.version,
      marketplace: parsed.marketplace,
      installedAt: parsed.installedAt,
      plugins: parsed.plugins.filter((value): value is string => typeof value === "string"),
    };
  } catch {
    return null;
  }
}

async function mergeAndWriteState(
  stateFile: string,
  state: DefaultGlobalSkillsState,
  requestedPluginIds: ReadonlySet<string>,
  lockRoot: string,
): Promise<void> {
  // Multiple workspace servers share the user-level bootstrap state. Distinct
  // plugin sets may install concurrently, so serialize the read-modify-write
  // cycle and preserve successful IDs recorded by a peer instead of letting
  // the last writer erase them. Atomic replacement also prevents readers from
  // observing partial JSON after a process interruption.
  await withFileLock(
    stateFile,
    async () => {
      const current = await readState(stateFile);
      const plugins = new Set(state.plugins);
      if (current?.marketplace === state.marketplace) {
        for (const pluginId of current.plugins) {
          // This invocation is authoritative for the IDs it evaluated (including
          // explicit uninstall tombstones), while preserving disjoint IDs that a
          // concurrent peer may have recorded.
          if (!requestedPluginIds.has(pluginId)) plugins.add(pluginId);
        }
      }
      await writeTextFileAtomic(
        stateFile,
        `${JSON.stringify(
          {
            ...state,
            plugins: [...plugins].sort((left, right) => left.localeCompare(right)),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    },
    { lockRoot },
  );
}

function defaultStateFileForHomedir(homedir?: string): string {
  const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
  return path.join(paths.configDir, DEFAULT_SKILLS_STATE_FILE);
}

export function defaultGlobalSkillsStateFile(homedir?: string): string {
  return defaultStateFileForHomedir(homedir);
}

function defaultFailureFileForHomedir(homedir?: string): string {
  const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
  return path.join(paths.configDir, DEFAULT_SKILLS_FAILURE_FILE);
}

export function defaultGlobalSkillsFailureFile(homedir?: string): string {
  return defaultFailureFileForHomedir(homedir);
}

async function readFailureState(
  failureFile: string,
): Promise<DefaultGlobalSkillsFailureState | null> {
  try {
    const raw = await fs.readFile(failureFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DefaultGlobalSkillsFailureState>;
    if (
      parsed.version !== FAILURE_STATE_VERSION ||
      typeof parsed.failedAt !== "string" ||
      typeof parsed.message !== "string"
    ) {
      return null;
    }
    return { version: parsed.version, failedAt: parsed.failedAt, message: parsed.message };
  } catch {
    return null;
  }
}

async function writeFailureState(failureFile: string, message: string): Promise<void> {
  const state: DefaultGlobalSkillsFailureState = {
    version: FAILURE_STATE_VERSION,
    failedAt: new Date().toISOString(),
    message,
  };
  try {
    await fs.mkdir(path.dirname(failureFile), { recursive: true });
    await fs.writeFile(failureFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort: failure-state persistence must never mask the original bootstrap error.
  }
}

async function clearFailureState(failureFile: string): Promise<void> {
  try {
    await fs.rm(failureFile, { force: true });
  } catch {
    // Best-effort: a stale failure file only delays the next retry window.
  }
}

function isWithinFailureBackoff(
  failureState: DefaultGlobalSkillsFailureState,
  now: number = Date.now(),
): boolean {
  const failedAtMs = Date.parse(failureState.failedAt);
  if (!Number.isFinite(failedAtMs)) return false;
  return now - failedAtMs < BOOTSTRAP_FAILURE_BACKOFF_MS;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function shouldBootstrapDefaultGlobalSkills(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isTruthy(env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP)) return false;
  const explicit = env.COWORK_BOOTSTRAP_DEFAULT_SKILLS;
  return explicit === undefined || isTruthy(explicit);
}

async function findLegacyRuntimeOwnedPluginIds(
  catalog: Awaited<ReturnType<typeof buildPluginCatalogSnapshot>>,
): Promise<Set<string>> {
  const legacyPluginIds = new Set<string>();
  for (const plugin of catalog.plugins) {
    if (!isInstalledPluginCatalogEntry(plugin) || plugin.scope !== "user") continue;
    const metadata = await readPluginInstallMetadata(plugin.rootDir);
    const bootstrapPluginId = metadata?.bootstrap?.pluginId ?? plugin.id;
    if (metadata?.bootstrap?.name === "codex-primary-runtime" && bootstrapPluginId === plugin.id) {
      legacyPluginIds.add(plugin.id);
    }
  }
  return legacyPluginIds;
}

async function cleanupMigratedProductivitySkills(opts: {
  homedir?: string;
  recordedPluginIds: ReadonlySet<string>;
  log?: (line: string) => void;
}): Promise<void> {
  if (!opts.recordedPluginIds.has("workspace-tools")) return;
  await cleanupLegacyCoworkProductivitySkills({
    home: path.resolve(opts.homedir ?? os.homedir()),
    log: opts.log,
  });
}

function bootstrapPromiseKey(opts: {
  homedir?: string;
  config: Pick<AgentConfig, "userPluginsDir" | "userCoworkDir">;
  plugins?: readonly DefaultSkillSpec[];
  force?: boolean;
}): string {
  const home = path.resolve(opts.homedir ?? os.homedir());
  const userPluginsDir = opts.config.userPluginsDir ? path.resolve(opts.config.userPluginsDir) : "";
  const userCoworkDir = path.resolve(opts.config.userCoworkDir);
  const pluginIds = [
    ...new Set([...(opts.plugins ?? DEFAULT_GLOBAL_SKILLS)].map((plugin) => plugin.id)),
  ].sort((left, right) => left.localeCompare(right));
  return JSON.stringify({
    home,
    userCoworkDir,
    userPluginsDir,
    pluginIds,
    force: opts.force === true,
  });
}

export async function ensureDefaultGlobalSkillsReady(opts: {
  homedir?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  config: AgentConfig;
  plugins?: readonly DefaultSkillSpec[];
  force?: boolean;
  log?: (line: string) => void;
}): Promise<EnsureDefaultGlobalSkillsInstalledResult | null> {
  const env = opts.env ?? process.env;
  if (!shouldBootstrapDefaultGlobalSkills(env)) {
    return null;
  }

  const promiseKey = bootstrapPromiseKey(opts);
  const existing = bootstrapPromises.get(promiseKey);
  if (existing) {
    return await existing;
  }

  const promise = (async () => {
    try {
      return await ensureDefaultGlobalSkillsInstalled(opts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      opts.log?.(`Default skill bootstrap failed: ${message}`);
      await writeFailureState(defaultFailureFileForHomedir(opts.homedir), message);
      return null;
    } finally {
      bootstrapPromises.delete(promiseKey);
    }
  })();

  bootstrapPromises.set(promiseKey, promise);
  return await promise;
}

export async function ensureDefaultGlobalSkillsInstalled(opts: {
  homedir?: string;
  fetchImpl?: FetchLike;
  config: AgentConfig;
  plugins?: readonly DefaultSkillSpec[];
  force?: boolean;
  log?: (line: string) => void;
}): Promise<EnsureDefaultGlobalSkillsInstalledResult> {
  const pluginSpecs = [...(opts.plugins ?? DEFAULT_GLOBAL_SKILLS)];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const paths = getAiCoworkerPaths(opts.homedir ? { homedir: opts.homedir } : {});
  const stateFile = defaultStateFileForHomedir(opts.homedir);
  const failureFile = defaultFailureFileForHomedir(opts.homedir);

  await ensureAiCoworkerHome(paths);

  const marketplaceName = BUILT_IN_MARKETPLACE_REPO;
  const overrides = await readPluginOverrides(opts.config);
  const catalog = await buildPluginCatalogSnapshot(opts.config, { fetchImpl });
  const legacyRuntimeOwnedPluginIds = await findLegacyRuntimeOwnedPluginIds(catalog);

  if (!opts.force) {
    const state = await readState(stateFile);
    const requestedPluginIds = pluginSpecs.map((plugin) => plugin.id);
    if (
      state &&
      state.marketplace === marketplaceName &&
      requestedPluginIds.every((pluginId) => state.plugins.includes(pluginId)) &&
      requestedPluginIds.every((pluginId) =>
        catalog.plugins.some(
          (plugin) =>
            plugin.id === pluginId &&
            plugin.scope === "user" &&
            !legacyRuntimeOwnedPluginIds.has(pluginId),
        ),
      ) &&
      requestedPluginIds.every((pluginId) => !isDefaultPluginRemoved(pluginId, overrides))
    ) {
      await cleanupMigratedProductivitySkills({
        homedir: opts.homedir,
        recordedPluginIds: new Set(requestedPluginIds),
        log: opts.log,
      });
      await clearFailureState(failureFile);
      return {
        status: "already_installed",
        pluginsDir: opts.config.userPluginsDir ?? "",
        stateFile,
        installed: [],
        skippedExisting: [...state.plugins],
        skippedRemoved: [],
      };
    }
  }

  const installed: string[] = [];
  const skippedExisting: string[] = [];
  const skippedRemoved: string[] = [];
  const recordedPluginIds = new Set<string>();
  const pluginIdsNeedingInstall: string[] = [];

  opts.log?.(`Ensuring default marketplace plugins in ${opts.config.userPluginsDir ?? "(none)"}`);

  for (const pluginSpec of pluginSpecs) {
    const pluginId = pluginSpec.id;
    if (!opts.force && isDefaultPluginRemoved(pluginId, overrides)) {
      skippedRemoved.push(pluginId);
      continue;
    }
    if (
      !opts.force &&
      catalog.plugins.some((plugin) => plugin.id === pluginId && plugin.scope === "user") &&
      !legacyRuntimeOwnedPluginIds.has(pluginId)
    ) {
      skippedExisting.push(pluginId);
      recordedPluginIds.add(pluginId);
      continue;
    }
    pluginIdsNeedingInstall.push(pluginId);
  }

  if (pluginIdsNeedingInstall.length === 0) {
    const state: DefaultGlobalSkillsState = {
      version: INSTALL_STATE_VERSION,
      marketplace: marketplaceName,
      installedAt: new Date().toISOString(),
      plugins: pluginSpecs
        .map((plugin) => plugin.id)
        .filter((pluginId) => recordedPluginIds.has(pluginId)),
    };
    await mergeAndWriteState(
      stateFile,
      state,
      new Set(pluginSpecs.map((plugin) => plugin.id)),
      fileLockRootForCoworkHome(paths.rootDir),
    );
    await cleanupMigratedProductivitySkills({
      homedir: opts.homedir,
      recordedPluginIds,
      log: opts.log,
    });
    await clearFailureState(failureFile);

    return {
      status: "already_installed",
      pluginsDir: opts.config.userPluginsDir ?? "",
      stateFile,
      installed,
      skippedExisting,
      skippedRemoved,
    };
  }

  if (!opts.force) {
    // Failed bootstraps back off before any network work so repeated workspace
    // server starts cannot burn the unauthenticated GitHub rate limit.
    const failureState = await readFailureState(failureFile);
    if (failureState && isWithinFailureBackoff(failureState)) {
      opts.log?.(
        `Default skill bootstrap skipped: last attempt failed ${failureState.failedAt}; retrying after 30 minutes.`,
      );
      return {
        status: "already_installed",
        pluginsDir: opts.config.userPluginsDir ?? "",
        stateFile,
        installed,
        skippedExisting,
        skippedRemoved,
      };
    }
  }

  const marketplace = await fetchRemotePluginMarketplace({ fetchImpl });
  const requestedPluginIds = new Set(pluginIdsNeedingInstall);
  const marketplaceMetadataByPluginId = buildMarketplaceInstallMetadataByPluginId(
    marketplace,
    requestedPluginIds,
  );

  for (const pluginId of pluginIdsNeedingInstall) {
    const marketplaceEntry = marketplace.plugins.find((entry) => entry.name === pluginId);
    if (!marketplaceEntry?.sourceInput) {
      opts.log?.(`Default marketplace plugin "${pluginId}" is not currently available.`);
      continue;
    }

    await installPluginsFromSource({
      config: opts.config,
      input: marketplaceEntry.sourceInput,
      targetScope: "user",
      fetchImpl,
      marketplaceMetadataByPluginId,
    });
    installed.push(pluginId);
    recordedPluginIds.add(pluginId);
  }

  const state: DefaultGlobalSkillsState = {
    version: INSTALL_STATE_VERSION,
    marketplace: marketplaceName,
    installedAt: new Date().toISOString(),
    plugins: pluginSpecs
      .map((plugin) => plugin.id)
      .filter((pluginId) => recordedPluginIds.has(pluginId)),
  };
  await mergeAndWriteState(
    stateFile,
    state,
    new Set(pluginSpecs.map((plugin) => plugin.id)),
    fileLockRootForCoworkHome(paths.rootDir),
  );
  await cleanupMigratedProductivitySkills({
    homedir: opts.homedir,
    recordedPluginIds,
    log: opts.log,
  });
  await clearFailureState(failureFile);

  return {
    status: installed.length > 0 ? "installed" : "already_installed",
    pluginsDir: opts.config.userPluginsDir ?? "",
    stateFile,
    installed,
    skippedExisting,
    skippedRemoved,
  };
}

export const __internal = {
  resetForTests() {
    bootstrapPromises.clear();
  },
};
