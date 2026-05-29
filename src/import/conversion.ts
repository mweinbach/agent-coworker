import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLAUDE_PLUGIN_MANIFEST_DIR_NAME } from "../plugins/manifest";
import { isRecord } from "../utils/typeGuards";

/**
 * Top-level `plugin.json` keys that Claude Code supports but cowork's strict
 * manifest schema rejects. They are dropped during conversion so the staged
 * bundle parses. `mcpServers` is special-cased: cowork expects a string path,
 * so an object-form value is removed while a string path is preserved.
 */
const STRIP_TOP_LEVEL_KEYS = ["commands", "agents", "hooks", "$schema"] as const;

const COWORK_PLUGIN_MANIFEST_DIR_NAME = ".cowork-plugin";

export interface StagedPlugin {
  /** Path to the staged plugin root that can be fed to installPluginsFromSource. */
  stagedRoot: string;
  cleanup: () => Promise<void>;
}

function sanitizeManifest(parsed: unknown): Record<string, unknown> {
  if (!isRecord(parsed)) {
    return {};
  }
  const next: Record<string, unknown> = { ...parsed };
  for (const key of STRIP_TOP_LEVEL_KEYS) {
    delete next[key];
  }
  // cowork's manifest schema wants `mcpServers` to be a string path. Claude
  // bundles sometimes inline an object map — drop those, keep string paths.
  if ("mcpServers" in next && typeof next.mcpServers !== "string") {
    delete next.mcpServers;
  }
  return next;
}

/**
 * Stages a Claude plugin (`.claude-plugin/plugin.json`) into a temp directory
 * that cowork's install pipeline understands: the manifest dir is renamed to
 * `.cowork-plugin` and schema-incompatible top-level keys are stripped.
 */
export async function stageClaudePluginForInstall(sourceRoot: string): Promise<StagedPlugin> {
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-import-"));
  const stagedRoot = path.join(stageDir, path.basename(sourceRoot) || "plugin");
  await fs.cp(sourceRoot, stagedRoot, { recursive: true, force: true, errorOnExist: false });

  const claudeManifestDir = path.join(stagedRoot, CLAUDE_PLUGIN_MANIFEST_DIR_NAME);
  const coworkManifestDir = path.join(stagedRoot, COWORK_PLUGIN_MANIFEST_DIR_NAME);
  // Rename the whole manifest dir so sibling files (e.g. install metadata) travel with it.
  await fs.rm(coworkManifestDir, { recursive: true, force: true });
  await fs.rename(claudeManifestDir, coworkManifestDir);

  const manifestPath = path.join(coworkManifestDir, "plugin.json");
  const raw = await fs.readFile(manifestPath, "utf-8");
  const sanitized = sanitizeManifest(JSON.parse(raw));
  await fs.writeFile(manifestPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf-8");

  return {
    stagedRoot,
    cleanup: async () => {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
