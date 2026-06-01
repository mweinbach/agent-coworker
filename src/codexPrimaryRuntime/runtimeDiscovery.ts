import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./state";

export function codexRuntimeRoot(home: string): string {
  return path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime");
}

export function codexPluginCacheRoot(home: string): string {
  return path.join(home, ".codex", "plugins", "cache", "openai-primary-runtime");
}

export function bundledRuntimeDirFromOptions(opts: {
  bundledRuntimeDir?: string;
  builtInSkillsDir?: string;
  env: Record<string, string | undefined>;
}): string | undefined {
  const fromOption = opts.bundledRuntimeDir?.trim();
  if (fromOption) return path.resolve(fromOption);

  const fromEnv = opts.env.COWORK_BUNDLED_CODEX_PRIMARY_RUNTIME_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  if (opts.builtInSkillsDir) {
    return path.join(path.dirname(opts.builtInSkillsDir), "codex-primary-runtime");
  }

  return undefined;
}

async function sortedChildDirs(parent: string): Promise<string[]> {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

async function isRuntimeRootUsable(root: string): Promise<boolean> {
  return (
    (await pathExists(path.join(root, "runtime.json"))) ||
    (await pathExists(path.join(root, "plugins", "openai-primary-runtime")))
  );
}

export async function collectRuntimeRoots(
  home: string,
  bundledRuntimeDir?: string,
): Promise<string[]> {
  const candidates = [
    ...(bundledRuntimeDir ? [bundledRuntimeDir] : []),
    codexRuntimeRoot(home),
    ...(await sortedChildDirs(path.join(home, ".cache", "codex-runtimes"))).map((installRoot) =>
      path.join(installRoot, "payload", "codex-primary-runtime"),
    ),
  ];
  const roots: string[] = [];
  for (const candidate of dedupePaths(candidates)) {
    if (await isRuntimeRootUsable(candidate)) roots.push(candidate);
  }
  return roots;
}
