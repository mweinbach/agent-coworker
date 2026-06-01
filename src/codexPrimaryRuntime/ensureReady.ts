import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAiCoworkerPaths } from "../store/connections";
import { defaultExtractZipArchive, downloadCuratedPluginsArchive } from "./archive";
import { CODEX_CURATED_PLUGINS_EXPORT_URL, CODEX_RUNTIME_SKILLS } from "./constants";
import {
  bundledRuntimeDirFromOptions,
  codexRuntimeRoot,
  collectRuntimeRoots,
} from "./runtimeDiscovery";
import {
  installSkills,
  installWorkspaceToolsPlugin,
  removeLegacyRuntimeSkills,
  removeManagedRuntimeSkills,
  skillSourceFromPluginCacheForProbe,
} from "./skills";
import { runtimeStateFile, writeState } from "./state";
import type {
  CodexPrimaryRuntimeSetupResult,
  CodexRuntimeSkillName,
  EnsureCodexPrimaryRuntimeOptions,
} from "./types";

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function availableWorkspaceToolsSkillNames(
  skills: CodexPrimaryRuntimeSetupResult["skills"],
): ReadonlySet<CodexRuntimeSkillName> {
  const names = new Set<CodexRuntimeSkillName>();
  for (const skill of skills) {
    if (skill.status === "installed" || skill.status === "already_installed") {
      names.add(skill.name);
    }
  }
  return names;
}

export function shouldBootstrapCodexPrimaryRuntime(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !isTruthy(env.COWORK_SKIP_CODEX_PRIMARY_RUNTIME_BOOTSTRAP);
}

export async function ensureCodexPrimaryRuntimeReady(
  opts: EnsureCodexPrimaryRuntimeOptions = {},
): Promise<CodexPrimaryRuntimeSetupResult | null> {
  const env = opts.env ?? process.env;
  if (!shouldBootstrapCodexPrimaryRuntime(env)) return null;

  const home = path.resolve(opts.homedir ?? os.homedir());
  const paths = getAiCoworkerPaths({ homedir: home });
  await fs.mkdir(paths.configDir, { recursive: true });

  const force = opts.force || isTruthy(env.COWORK_CODEX_PRIMARY_RUNTIME_FORCE);
  const allowNetwork =
    opts.allowNetwork ??
    (opts.fetchImpl !== undefined ||
      force ||
      isTruthy(env.COWORK_CODEX_PRIMARY_RUNTIME_ALLOW_NETWORK));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const extractZipArchive = opts.extractZipArchive ?? defaultExtractZipArchive;
  const stateFile = runtimeStateFile(home);
  const tmpRoot = await fs.mkdtemp(path.join(paths.rootDir, ".codex-primary-runtime-"));
  const bundledRuntimeDir = bundledRuntimeDirFromOptions({
    bundledRuntimeDir: opts.bundledRuntimeDir,
    builtInSkillsDir: opts.builtInSkillsDir,
    env,
  });
  const runtimeRoots = await collectRuntimeRoots(home, bundledRuntimeDir);
  let archive: CodexPrimaryRuntimeSetupResult["archive"] = {
    status: "skipped",
    endpoint: CODEX_CURATED_PLUGINS_EXPORT_URL,
  };
  let curatedRepoRoot: string | undefined;

  try {
    const localSkillProbe = await skillSourceFromPluginCacheForProbe(home, CODEX_RUNTIME_SKILLS[0]);
    if ((force || !localSkillProbe) && allowNetwork) {
      try {
        curatedRepoRoot = await downloadCuratedPluginsArchive({
          fetchImpl,
          extractZipArchive,
          tmpRoot,
          log: opts.log,
        });
        archive = {
          status: "downloaded",
          endpoint: CODEX_CURATED_PLUGINS_EXPORT_URL,
          extractedDir: curatedRepoRoot,
        };
      } catch (error) {
        archive = {
          status: "failed",
          endpoint: CODEX_CURATED_PLUGINS_EXPORT_URL,
          reason: error instanceof Error ? error.message : String(error),
        };
        opts.log?.(`Codex curated plugin archive download failed: ${archive.reason}`);
      }
    } else if (!localSkillProbe && !allowNetwork) {
      archive = {
        status: "skipped",
        endpoint: CODEX_CURATED_PLUGINS_EXPORT_URL,
        reason: "Network bootstrap is disabled for this process.",
      };
    }

    await removeLegacyRuntimeSkills({
      destinationRoot: opts.builtInSkillsDir,
      global: false,
      log: opts.log,
    });
    const builtInSkillResults = await installSkills({
      home,
      runtimeRoots,
      destinationRoot: opts.builtInSkillsDir,
      global: false,
      force,
      curatedRepoRoot,
      log: opts.log,
    });
    const workspaceToolsSkillResults = await installWorkspaceToolsPlugin({
      home,
      runtimeRoots,
      force,
      pluginsDir: opts.globalPluginsDir,
      skip: opts.skipGlobalWorkspaceToolsPlugin === true,
      curatedRepoRoot,
      log: opts.log,
    });
    const availableWorkspaceToolsSkills = availableWorkspaceToolsSkillNames(
      workspaceToolsSkillResults,
    );
    if (availableWorkspaceToolsSkills.size > 0) {
      await removeLegacyRuntimeSkills({
        destinationRoot: opts.globalSkillsDir,
        global: true,
        runtimeSkillNames: availableWorkspaceToolsSkills,
        log: opts.log,
      });
      await removeManagedRuntimeSkills({
        destinationRoot: opts.globalSkillsDir,
        runtimeSkillNames: availableWorkspaceToolsSkills,
        log: opts.log,
      });
    }
    const skills = [...builtInSkillResults, ...workspaceToolsSkillResults];
    await writeState({ stateFile, skills });

    return {
      runtimeDir: codexRuntimeRoot(home),
      stateFile,
      skills,
      archive,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}
