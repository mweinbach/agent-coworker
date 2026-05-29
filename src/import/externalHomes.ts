import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ImportSource = "claude" | "codex";

export const IMPORT_SOURCES: readonly ImportSource[] = ["claude", "codex"] as const;

export interface ExternalHome {
  source: ImportSource;
  /** Resolved home directory (e.g. ~/.claude or ~/.codex). */
  homeDir: string;
  /** Whether `homeDir` exists and is a directory. */
  exists: boolean;
  /**
   * Explicit directories to scan for plugin manifests. We never walk the home
   * directory broadly — Codex in particular keeps multi-GB sqlite logs there.
   */
  pluginScanRoots: string[];
  /** Directory holding standalone skill bundles (one SKILL.md dir per skill). */
  skillsDir: string;
}

function homeDirNameForSource(source: ImportSource): string {
  return source === "claude" ? ".claude" : ".codex";
}

function homeDirForSource(
  source: ImportSource,
  opts: { homeOverride?: string; homeBaseOverride?: string },
): string {
  if (opts.homeOverride) {
    return path.resolve(opts.homeOverride);
  }
  const base = opts.homeBaseOverride ?? os.homedir();
  return path.join(base, homeDirNameForSource(source));
}

function pluginScanRootsForSource(source: ImportSource, homeDir: string): string[] {
  const pluginsDir = path.join(homeDir, "plugins");
  if (source === "claude") {
    // Claude caches installed plugins under plugins/cache and clones
    // marketplace bundles (which can ship their own plugin.json) under
    // plugins/marketplaces.
    return [path.join(pluginsDir, "cache"), path.join(pluginsDir, "marketplaces")];
  }
  return [path.join(pluginsDir, "cache")];
}

export async function resolveExternalHome(
  source: ImportSource,
  opts: { homeOverride?: string; homeBaseOverride?: string } = {},
): Promise<ExternalHome> {
  const homeDir = homeDirForSource(source, opts);
  let exists = false;
  try {
    const stat = await fs.stat(homeDir);
    exists = stat.isDirectory();
  } catch {
    exists = false;
  }
  return {
    source,
    homeDir,
    exists,
    pluginScanRoots: pluginScanRootsForSource(source, homeDir),
    skillsDir: path.join(homeDir, "skills"),
  };
}

export async function listAvailableExternalHomes(
  opts: { homeBaseOverride?: string } = {},
): Promise<ExternalHome[]> {
  return await Promise.all(
    IMPORT_SOURCES.map((source) =>
      resolveExternalHome(source, { homeBaseOverride: opts.homeBaseOverride }),
    ),
  );
}
