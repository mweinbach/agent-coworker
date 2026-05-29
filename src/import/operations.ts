import path from "node:path";
import { installPluginsFromSource } from "../plugins/operations";
import { installSkillsFromSource } from "../skills/operations";
import type {
  AgentConfig,
  PluginCatalogSnapshot,
  PluginInstallTargetScope,
  SkillCatalogSnapshot,
} from "../types";
import { stageClaudePluginForInstall } from "./conversion";
import {
  type ImportableItem,
  type ImportableKind,
  listImportablePlugins,
  listImportableSkills,
} from "./discovery";
import { type ImportSource, resolveExternalHome } from "./externalHomes";

export interface ListImportableResult {
  source: ImportSource;
  kind: ImportableKind;
  homeExists: boolean;
  items: ImportableItem[];
}

/**
 * The external tool homes (`~/.claude`, `~/.codex`) live alongside cowork's own
 * home. Derive the base from the config's user home so discovery honors a pinned
 * home (desktop service, tests) instead of the process-wide `os.homedir()`.
 */
function externalHomeBase(config: AgentConfig): string {
  return path.dirname(config.userCoworkDir);
}

export async function listImportable(opts: {
  config: AgentConfig;
  source: ImportSource;
  kind: ImportableKind;
  /** Full external home dir override (mainly for tests). */
  homeOverride?: string;
}): Promise<ListImportableResult> {
  const home = await resolveExternalHome(opts.source, {
    homeOverride: opts.homeOverride,
    homeBaseOverride: externalHomeBase(opts.config),
  });
  const items = home.exists
    ? opts.kind === "plugin"
      ? await listImportablePlugins({ config: opts.config, homes: [home] })
      : await listImportableSkills({ config: opts.config, homes: [home] })
    : [];
  return { source: opts.source, kind: opts.kind, homeExists: home.exists, items };
}

export async function importPlugin(opts: {
  config: AgentConfig;
  sourcePath: string;
  conversionRequired: boolean;
  targetScope: PluginInstallTargetScope;
}): Promise<{ pluginId: string; catalog: PluginCatalogSnapshot }> {
  if (opts.conversionRequired) {
    const staged = await stageClaudePluginForInstall(opts.sourcePath);
    try {
      const result = await installPluginsFromSource({
        config: opts.config,
        input: staged.stagedRoot,
        targetScope: opts.targetScope,
      });
      return { pluginId: result.pluginId, catalog: result.catalog };
    } finally {
      await staged.cleanup();
    }
  }
  const result = await installPluginsFromSource({
    config: opts.config,
    input: opts.sourcePath,
    targetScope: opts.targetScope,
  });
  return { pluginId: result.pluginId, catalog: result.catalog };
}

export async function importSkill(opts: {
  config: AgentConfig;
  sourcePath: string;
  /** UI scope; mapped to the skill scope vocabulary internally. */
  targetScope: PluginInstallTargetScope;
}): Promise<{ installationIds: string[]; catalog: SkillCatalogSnapshot }> {
  const skillScope = opts.targetScope === "user" ? "global" : "project";
  const result = await installSkillsFromSource({
    config: opts.config,
    input: opts.sourcePath,
    targetScope: skillScope,
  });
  return { installationIds: result.installationIds, catalog: result.catalog };
}
