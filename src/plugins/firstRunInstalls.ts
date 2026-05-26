import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../types";
import { ensureAiCoworkerHome, getAiCoworkerPaths } from "../store/connections";
import { BUILT_IN_MARKETPLACES, type RemoteMarketplaceConfig } from "./builtInMarketplaces";
import { installPluginsFromSource } from "./operations";
import {
  buildRemotePluginInstallUrl,
  fetchRemoteMarketplaces,
  type RemoteMarketplaceSnapshot,
} from "./remoteMarketplace";

const FIRST_RUN_STATE_FILE = "first-run-installs.json";
const FIRST_RUN_STATE_VERSION = 1;

export interface FirstRunInstallSpec {
  marketplaceId: string;
  pluginName: string;
}

export const FIRST_RUN_INSTALLS: readonly FirstRunInstallSpec[] = [
  { marketplaceId: "cowork-personal", pluginName: "documents" },
  { marketplaceId: "cowork-personal", pluginName: "spreadsheets" },
  { marketplaceId: "cowork-personal", pluginName: "presentations" },
] as const;

interface FirstRunInstallState {
  version: number;
  installed: string[];
  removed: string[];
}

export interface FirstRunInstallResult {
  installed: string[];
  skipped: string[];
  removedTombstoned: string[];
  errors: Array<{ key: string; error: string }>;
}

function specKey(spec: FirstRunInstallSpec): string {
  return `${spec.marketplaceId}:${spec.pluginName}`;
}

async function readState(stateFile: string): Promise<FirstRunInstallState> {
  try {
    const raw = await fs.readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FirstRunInstallState>;
    return {
      version:
        typeof parsed.version === "number" ? parsed.version : FIRST_RUN_STATE_VERSION,
      installed: Array.isArray(parsed.installed)
        ? parsed.installed.filter((value): value is string => typeof value === "string")
        : [],
      removed: Array.isArray(parsed.removed)
        ? parsed.removed.filter((value): value is string => typeof value === "string")
        : [],
    };
  } catch {
    return { version: FIRST_RUN_STATE_VERSION, installed: [], removed: [] };
  }
}

async function writeState(stateFile: string, state: FirstRunInstallState): Promise<void> {
  const payload: FirstRunInstallState = {
    version: FIRST_RUN_STATE_VERSION,
    installed: [...new Set(state.installed)].sort(),
    removed: [...new Set(state.removed)].sort(),
  };
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function shouldRun(env: Record<string, string | undefined>): boolean {
  const raw = env.COWORK_SKIP_FIRST_RUN_INSTALLS ?? env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP;
  const normalized = raw?.trim().toLowerCase();
  return !(normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on");
}

function findPluginInSnapshot(
  snapshots: RemoteMarketplaceSnapshot[],
  spec: FirstRunInstallSpec,
): { config: RemoteMarketplaceConfig; sourcePath: string } | null {
  for (const snapshot of snapshots) {
    if (snapshot.config.id !== spec.marketplaceId) continue;
    const entry = snapshot.document.plugins.find((plugin) => plugin.name === spec.pluginName);
    if (entry) {
      return { config: snapshot.config, sourcePath: entry.sourcePath };
    }
  }
  return null;
}

export function firstRunInstallStateFile(homedir?: string): string {
  const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
  return path.join(paths.configDir, FIRST_RUN_STATE_FILE);
}

const inFlightRuns = new Map<string, Promise<FirstRunInstallResult | null>>();

export async function ensureFirstRunPluginsInstalled(opts: {
  config: AgentConfig;
  homedir?: string;
  env?: Record<string, string | undefined>;
  specs?: readonly FirstRunInstallSpec[];
  marketplaces?: readonly RemoteMarketplaceConfig[];
  log?: (line: string) => void;
}): Promise<FirstRunInstallResult | null> {
  const env = opts.env ?? process.env;
  if (!shouldRun(env)) {
    return null;
  }

  const home = path.resolve(opts.homedir ?? os.homedir());
  const existing = inFlightRuns.get(home);
  if (existing) {
    return await existing;
  }

  const promise = (async () => {
    try {
      return await runFirstRunInstalls(opts);
    } catch (error) {
      opts.log?.(
        `First-run plugin install failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      inFlightRuns.delete(home);
      return null;
    }
  })();

  inFlightRuns.set(home, promise);
  return await promise;
}

async function runFirstRunInstalls(opts: {
  config: AgentConfig;
  homedir?: string;
  specs?: readonly FirstRunInstallSpec[];
  marketplaces?: readonly RemoteMarketplaceConfig[];
  log?: (line: string) => void;
}): Promise<FirstRunInstallResult> {
  const specs = opts.specs ?? FIRST_RUN_INSTALLS;
  const marketplaces = opts.marketplaces ?? BUILT_IN_MARKETPLACES;
  const paths = getAiCoworkerPaths(opts.homedir ? { homedir: opts.homedir } : {});
  await ensureAiCoworkerHome(paths);
  const stateFile = path.join(paths.configDir, FIRST_RUN_STATE_FILE);
  const state = await readState(stateFile);

  const result: FirstRunInstallResult = {
    installed: [],
    skipped: [],
    removedTombstoned: [],
    errors: [],
  };

  const userPluginsDir = opts.config.userPluginsDir;
  const userScopeAvailable = typeof userPluginsDir === "string" && userPluginsDir.length > 0;

  const pendingSpecs = specs.filter((spec) => {
    const key = specKey(spec);
    if (state.removed.includes(key)) {
      result.removedTombstoned.push(key);
      return false;
    }
    return true;
  });

  if (pendingSpecs.length === 0) {
    return result;
  }

  let snapshots: RemoteMarketplaceSnapshot[] = [];
  if (marketplaces.length > 0) {
    const fetchResult = await fetchRemoteMarketplaces(marketplaces);
    snapshots = fetchResult.snapshots;
    for (const failure of fetchResult.errors) {
      opts.log?.(
        `Marketplace ${failure.config.id} unavailable: ${failure.error}`,
      );
    }
  }

  for (const spec of pendingSpecs) {
    const key = specKey(spec);
    if (state.installed.includes(key) && (await pluginIsInstalledOnDisk(userPluginsDir, spec.pluginName))) {
      result.skipped.push(key);
      continue;
    }
    if (!userScopeAvailable) {
      result.errors.push({ key, error: "User plugin scope unavailable" });
      continue;
    }
    const remote = findPluginInSnapshot(snapshots, spec);
    if (!remote) {
      result.errors.push({
        key,
        error: `Plugin ${spec.pluginName} not found in marketplace ${spec.marketplaceId}`,
      });
      continue;
    }
    try {
      const installUrl = buildRemotePluginInstallUrl(remote.config, remote.sourcePath);
      await installPluginsFromSource({
        config: opts.config,
        input: installUrl,
        targetScope: "user",
      });
      result.installed.push(key);
      if (!state.installed.includes(key)) {
        state.installed.push(key);
      }
    } catch (error) {
      result.errors.push({
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await writeState(stateFile, state);
  return result;
}

async function pluginIsInstalledOnDisk(
  userPluginsDir: string | undefined,
  pluginName: string,
): Promise<boolean> {
  if (!userPluginsDir) return false;
  try {
    const stat = await fs.stat(path.join(userPluginsDir, pluginName));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function recordPluginUninstallTombstone(opts: {
  homedir?: string;
  marketplaceId: string;
  pluginName: string;
}): Promise<void> {
  const stateFile = firstRunInstallStateFile(opts.homedir);
  const state = await readState(stateFile);
  const key = `${opts.marketplaceId}:${opts.pluginName}`;
  if (!state.removed.includes(key)) {
    state.removed.push(key);
  }
  state.installed = state.installed.filter((value) => value !== key);
  await writeState(stateFile, state);
}

export async function clearPluginUninstallTombstone(opts: {
  homedir?: string;
  marketplaceId: string;
  pluginName: string;
}): Promise<void> {
  const stateFile = firstRunInstallStateFile(opts.homedir);
  const state = await readState(stateFile);
  const key = `${opts.marketplaceId}:${opts.pluginName}`;
  state.removed = state.removed.filter((value) => value !== key);
  await writeState(stateFile, state);
}
