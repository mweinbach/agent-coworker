import fs from "node:fs/promises";
import path from "node:path";
import { findArtifactToolNamespace } from "./runtimeDiscovery";
import { pathExists } from "./state";

/**
 * Legacy location where `@oai/artifact-tool` used to be discovered: the Codex
 * primary runtime cache. We only read from it during a one-time migration into
 * the Cowork-owned artifact runtime cache; it is never part of normal
 * resolution.
 */
function legacyCodexRuntimeRoot(home: string): string {
  return path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime");
}

async function sortedChildDirs(parent: string): Promise<string[]> {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
}

async function legacyRuntimeRoots(home: string): Promise<string[]> {
  const roots = [legacyCodexRuntimeRoot(home)];
  for (const installRoot of await sortedChildDirs(path.join(home, ".cache", "codex-runtimes"))) {
    if (!path.basename(installRoot).startsWith("codex-runtime-install-")) continue;
    roots.push(path.join(installRoot, "payload", "codex-primary-runtime"));
  }
  return roots;
}

// Runtime payload only. Deliberately excludes `plugins/` so migrated artifact
// runtimes never carry skills (those are owned by the cowork-skills-plugins
// marketplace, not bundled into the runtime).
const RUNTIME_PAYLOAD_ENTRIES = ["node", "dependencies", "python", "runtime.json"] as const;

async function shouldCopyRuntimePath(src: string): Promise<boolean> {
  const stat = await fs.lstat(src);
  if (!stat.isSymbolicLink()) return true;

  try {
    await fs.stat(src);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function findLegacyArtifactRuntimeRoot(home: string): Promise<string | null> {
  for (const root of await legacyRuntimeRoots(home)) {
    if (await findArtifactToolNamespace([root])) return root;
  }
  return null;
}

/**
 * One-time migration: if a usable `@oai/artifact-tool` runtime exists only in
 * the legacy Codex primary runtime cache, copy its dependency payload into the
 * Cowork artifact runtime cache so existing installs keep working after the
 * upgrade. After this runs the Cowork cache is the source of truth.
 */
export async function migrateLegacyArtifactRuntime(opts: {
  home: string;
  cacheDir: string;
  log?: (line: string) => void;
}): Promise<{ status: "migrated" | "none" | "failed"; source?: string; reason?: string }> {
  try {
    const source = await findLegacyArtifactRuntimeRoot(opts.home);
    if (!source) return { status: "none" };

    opts.log?.(`Migrating artifact runtime from legacy Codex cache at ${source}`);
    await fs.rm(opts.cacheDir, { recursive: true, force: true });
    await fs.mkdir(opts.cacheDir, { recursive: true });
    for (const entry of RUNTIME_PAYLOAD_ENTRIES) {
      const src = path.join(source, entry);
      if (await pathExists(src)) {
        // `dereference: true` copies symlink *targets* as real files instead of
        // recreating the links. Legacy pnpm runtimes are full of symlinks and
        // junctions (e.g. `@napi-rs/canvas-*`); recreating them fails on Windows
        // with EPERM unless Developer Mode / administrator rights are enabled.
        await fs.cp(src, path.join(opts.cacheDir, entry), {
          recursive: true,
          force: true,
          dereference: true,
          filter: shouldCopyRuntimePath,
        });
      }
    }
    if (!(await pathExists(path.join(opts.cacheDir, "runtime.json")))) {
      await fs.writeFile(
        path.join(opts.cacheDir, "runtime.json"),
        `${JSON.stringify({ migratedFrom: source, migratedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf-8",
      );
    }
    opts.log?.(`Artifact runtime migrated into ${opts.cacheDir}`);
    return { status: "migrated", source };
  } catch (error) {
    // A best-effort, one-time migration must never crash server startup. Log it,
    // remove any partially-copied tree so the next launch can retry or fall back
    // to a fresh download, and let the runtime resolve as unavailable instead.
    const reason = error instanceof Error ? error.message : String(error);
    opts.log?.(`Artifact runtime migration failed; continuing without it: ${reason}`);
    await fs.rm(opts.cacheDir, { recursive: true, force: true }).catch(() => {});
    return { status: "failed", reason };
  }
}
