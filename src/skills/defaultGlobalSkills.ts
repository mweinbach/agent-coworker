import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BUILT_IN_MARKETPLACE_REPO,
  DEFAULT_MARKETPLACE_PLUGIN_IDS,
  type FetchLike,
} from "../extensions/source";
import { buildPluginCatalogSnapshot, installPluginsFromSource } from "../plugins";
import { readPluginOverrides } from "../plugins/overrides";
import { fetchRemotePluginMarketplace } from "../plugins/remoteMarketplace";
import { ensureAiCoworkerHome, getAiCoworkerPaths } from "../store/connections";
import type { AgentConfig } from "../types";

const DEFAULT_SKILLS_STATE_FILE = "default-global-skills.json";
const INSTALL_STATE_VERSION = 1;
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

export type DefaultSkillSpec = {
  id: string;
};

export const DEFAULT_GLOBAL_SKILLS: readonly DefaultSkillSpec[] = [
  ...DEFAULT_MARKETPLACE_PLUGIN_IDS.map((id) => ({ id })),
] as const;

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

function defaultStateFileForHomedir(homedir?: string): string {
  const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
  return path.join(paths.configDir, DEFAULT_SKILLS_STATE_FILE);
}

export function defaultGlobalSkillsStateFile(homedir?: string): string {
  return defaultStateFileForHomedir(homedir);
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function shouldBootstrapDefaultGlobalSkills(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !isTruthy(env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP);
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

  const home = path.resolve(opts.homedir ?? os.homedir());
  const existing = bootstrapPromises.get(home);
  if (existing) {
    return await existing;
  }

  const promise = (async () => {
    try {
      return await ensureDefaultGlobalSkillsInstalled(opts);
    } catch (error) {
      opts.log?.(
        `Default skill bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      bootstrapPromises.delete(home);
      return null;
    }
  })();

  bootstrapPromises.set(home, promise);
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

  await ensureAiCoworkerHome(paths);

  const marketplaceName = BUILT_IN_MARKETPLACE_REPO;

  if (!opts.force) {
    const state = await readState(stateFile);
    const requestedPluginIds = pluginSpecs.map((plugin) => plugin.id);
    if (
      state &&
      state.marketplace === marketplaceName &&
      requestedPluginIds.every((pluginId) => state.plugins.includes(pluginId))
    ) {
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

  const marketplace = await fetchRemotePluginMarketplace({ fetchImpl });

  const installed: string[] = [];
  const skippedExisting: string[] = [];
  const skippedRemoved: string[] = [];
  const recordedPluginIds = new Set<string>();

  opts.log?.(`Ensuring default marketplace plugins in ${opts.config.userPluginsDir ?? "(none)"}`);

  const overrides = await readPluginOverrides(opts.config);
  let catalog = await buildPluginCatalogSnapshot(opts.config, {
    fetchImpl,
    includeRemoteMarketplace: true,
  });
  for (const pluginSpec of pluginSpecs) {
    const pluginId = pluginSpec.id;
    if (!opts.force && overrides.user.plugins?.[pluginId] === false) {
      skippedRemoved.push(pluginId);
      recordedPluginIds.add(pluginId);
      continue;
    }
    if (
      !opts.force &&
      catalog.plugins.some((plugin) => plugin.id === pluginId && plugin.installed !== false)
    ) {
      skippedExisting.push(pluginId);
      recordedPluginIds.add(pluginId);
      continue;
    }

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
    });
    installed.push(pluginId);
    recordedPluginIds.add(pluginId);
    catalog = await buildPluginCatalogSnapshot(opts.config, {
      fetchImpl,
      includeRemoteMarketplace: true,
    });
  }

  const state: DefaultGlobalSkillsState = {
    version: INSTALL_STATE_VERSION,
    marketplace: marketplaceName,
    installedAt: new Date().toISOString(),
    plugins: pluginSpecs
      .map((plugin) => plugin.id)
      .filter((pluginId) => recordedPluginIds.has(pluginId)),
  };
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

  return {
    status: installed.length > 0 ? "installed" : "already_installed",
    pluginsDir: opts.config.userPluginsDir ?? "",
    stateFile,
    installed,
    skippedExisting,
    skippedRemoved,
  };
}
