import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_RUNTIME_BUNDLED_DIR_ENV,
  ARTIFACT_RUNTIME_ENV_DIR,
  ARTIFACT_RUNTIME_ENV_NODE,
  ARTIFACT_RUNTIME_ENV_NODE_MODULES,
  ARTIFACT_RUNTIME_ENV_NODE_RESOLVER,
  ARTIFACT_RUNTIME_ENV_PYTHON,
} from "./constants";
import { pathExists } from "./state";
import type { ArtifactRuntimeSetupResult } from "./types";

export function artifactRuntimeCacheRoot(home: string): string {
  return path.join(home, ".cache", "cowork", "artifact-runtime");
}

export function bundledRuntimeDirFromOptions(opts: {
  bundledRuntimeDir?: string;
  env: Record<string, string | undefined>;
}): string | undefined {
  const fromOption = opts.bundledRuntimeDir?.trim();
  if (fromOption) return path.resolve(fromOption);

  const fromEnv = opts.env[ARTIFACT_RUNTIME_BUNDLED_DIR_ENV]?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  return undefined;
}

async function findOaiNamespaceInRuntimeRoot(root: string): Promise<string | null> {
  const candidates = [
    path.join(root, "node", "node_modules", "@oai"),
    path.join(root, "dependencies", "node", "node_modules", "@oai"),
    path.join(
      root,
      "python",
      "Lib",
      "site-packages",
      "artifact_tool_v2",
      "bin",
      "node_modules",
      "@oai",
    ),
    path.join(
      root,
      "dependencies",
      "python",
      "Lib",
      "site-packages",
      "artifact_tool_v2",
      "bin",
      "node_modules",
      "@oai",
    ),
  ];

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "artifact-tool", "package.json"))) return candidate;
  }

  return null;
}

export async function findArtifactToolNamespace(
  runtimeRoots: readonly string[],
): Promise<string | null> {
  for (const root of runtimeRoots) {
    const found = await findOaiNamespaceInRuntimeRoot(root);
    if (found) return found;
  }
  return null;
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

function dedupePathEntries(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

async function isRuntimeRootUsable(root: string): Promise<boolean> {
  return (
    (await pathExists(path.join(root, "runtime.json"))) ||
    (await findOaiNamespaceInRuntimeRoot(root)) !== null
  );
}

export async function collectRuntimeRoots(
  home: string,
  bundledRuntimeDir?: string,
): Promise<string[]> {
  const candidates = [
    ...(bundledRuntimeDir ? [bundledRuntimeDir] : []),
    artifactRuntimeCacheRoot(home),
  ];
  const roots: string[] = [];
  for (const candidate of dedupePaths(candidates)) {
    if (await isRuntimeRootUsable(candidate)) roots.push(candidate);
  }
  return roots;
}

async function findFirstExistingFile(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

function executableBasename(name: "node" | "python" | "python3"): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

export async function resolveRuntimeExecutablePaths(
  runtimeRoots: readonly string[],
): Promise<ArtifactRuntimeSetupResult["runtime"] & { runtimeEnv: Record<string, string> }> {
  for (const root of runtimeRoots) {
    const oaiNamespace = await findOaiNamespaceInRuntimeRoot(root);
    const nodePath = await findFirstExistingFile([
      path.join(root, "node", "bin", executableBasename("node")),
      path.join(root, "dependencies", "node", "bin", executableBasename("node")),
      path.join(root, "bin", executableBasename("node")),
    ]);
    const pythonPath = await findFirstExistingFile([
      path.join(root, "python", executableBasename("python")),
      path.join(root, "python", "bin", executableBasename("python3")),
      path.join(root, "dependencies", "python", executableBasename("python")),
      path.join(root, "dependencies", "python", "bin", executableBasename("python3")),
    ]);
    const nodeModulesPath = oaiNamespace ? path.dirname(oaiNamespace) : undefined;
    if (!nodePath && !pythonPath && !nodeModulesPath) continue;

    const runtimeEnv: Record<string, string> = {
      [ARTIFACT_RUNTIME_ENV_DIR]: root,
    };
    if (nodePath) runtimeEnv[ARTIFACT_RUNTIME_ENV_NODE] = nodePath;
    if (pythonPath) runtimeEnv[ARTIFACT_RUNTIME_ENV_PYTHON] = pythonPath;
    if (nodeModulesPath) runtimeEnv[ARTIFACT_RUNTIME_ENV_NODE_MODULES] = nodeModulesPath;

    return {
      status: "available",
      source: root,
      ...(nodePath ? { nodePath } : {}),
      ...(pythonPath ? { pythonPath } : {}),
      ...(nodeModulesPath ? { nodeModulesPath } : {}),
      runtimeEnv,
    };
  }

  return { status: "missing", runtimeEnv: {} };
}

export function prependToolPath(
  env: Record<string, string | undefined>,
  runtimeEnv: Record<string, string>,
  dirs: string[],
): Record<string, string> {
  const cleanDirs = dirs.filter(Boolean);
  if (Object.keys(runtimeEnv).length === 0 && cleanDirs.length === 0) {
    return runtimeEnv;
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const existingPath = env[pathKey] ?? "";
  const existingParts = existingPath ? existingPath.split(path.delimiter) : [];
  const nextParts = dedupePathEntries([...cleanDirs, ...existingParts]);
  if (nextParts.length === 0) return runtimeEnv;
  return { ...runtimeEnv, [pathKey]: nextParts.join(path.delimiter) };
}

export function prependNodePath(
  env: Record<string, string | undefined>,
  runtimeEnv: Record<string, string>,
  nodeModulesPath?: string,
): Record<string, string> {
  if (!nodeModulesPath) return runtimeEnv;
  const existingParts = env.NODE_PATH ? env.NODE_PATH.split(path.delimiter) : [];
  const nextParts = dedupePathEntries([nodeModulesPath, ...existingParts]);
  return { ...runtimeEnv, NODE_PATH: nextParts.join(path.delimiter) };
}

const nodeResolverRegisterSource = `import { register } from "node:module";

register(new URL("./hooks.mjs", import.meta.url));
`;

const nodeResolverHooksSource = `import path from "node:path";
import { pathToFileURL } from "node:url";

const nodeModulesPath = process.env.${ARTIFACT_RUNTIME_ENV_NODE_MODULES};
const runtimeParentURL = nodeModulesPath
  ? pathToFileURL(path.join(nodeModulesPath, ".cowork-runtime-entry.mjs")).href
  : null;

function isBareSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    specifier.length > 0 &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#") &&
    !specifier.includes(":")
  );
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!runtimeParentURL || !isBareSpecifier(specifier)) {
      throw error;
    }

    try {
      return await nextResolve(specifier, {
        ...context,
        parentURL: runtimeParentURL,
      });
    } catch {
      throw error;
    }
  }
}
`;

function getEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const actualKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  const value = actualKey ? env[actualKey] : undefined;
  return value?.trim() ? value : undefined;
}

function prependNodeOption(existing: string | undefined, option: string): string {
  const trimmed = existing?.trim();
  if (!trimmed) return option;
  if (trimmed.includes(option)) return trimmed;
  return `${option} ${trimmed}`;
}

export async function prepareNodeModuleResolverEnv(opts: {
  env: Record<string, string | undefined>;
  runtimeDir: string;
  runtimeEnv: Record<string, string>;
  nodeModulesPath?: string;
}): Promise<Record<string, string>> {
  if (!opts.nodeModulesPath) return opts.runtimeEnv;

  const resolverDir = path.join(opts.runtimeDir, "node-resolver");
  const registerPath = path.join(resolverDir, "register.mjs");
  const hooksPath = path.join(resolverDir, "hooks.mjs");
  await fs.mkdir(resolverDir, { recursive: true });
  await fs.writeFile(registerPath, nodeResolverRegisterSource, "utf-8");
  await fs.writeFile(hooksPath, nodeResolverHooksSource, "utf-8");

  const importOption = `--import=${pathToFileURL(registerPath).href}`;
  return {
    ...opts.runtimeEnv,
    [ARTIFACT_RUNTIME_ENV_NODE_RESOLVER]: registerPath,
    NODE_OPTIONS: prependNodeOption(getEnvValue(opts.env, "NODE_OPTIONS"), importOption),
  };
}

export async function resolveArtifactTool(opts: {
  runtimeRoots: readonly string[];
}): Promise<ArtifactRuntimeSetupResult["artifactTool"]> {
  const source = await findArtifactToolNamespace(opts.runtimeRoots);
  if (!source) {
    return {
      status: "missing",
      reason: "@oai/artifact-tool was not found in the Cowork artifact runtime cache.",
    };
  }
  return { status: "available", source };
}

/**
 * Build the artifact runtime environment from whatever is already present on
 * disk (cache or bundled dir). Performs no network download, so it is safe to
 * call on every turn for idempotent env injection.
 */
export async function discoverArtifactRuntimeEnv(opts: {
  home: string;
  env: Record<string, string | undefined>;
  bundledRuntimeDir?: string;
}): Promise<Record<string, string>> {
  const runtimeRoots = await collectRuntimeRoots(opts.home, opts.bundledRuntimeDir);
  const runtime = await resolveRuntimeExecutablePaths(runtimeRoots);
  if (runtime.status !== "available") return {};
  const runtimePathDirs = [
    runtime.nodePath ? path.dirname(runtime.nodePath) : "",
    runtime.pythonPath ? path.dirname(runtime.pythonPath) : "",
    runtime.pythonPath ? path.join(path.dirname(runtime.pythonPath), "Scripts") : "",
  ];
  return await prepareNodeModuleResolverEnv({
    env: opts.env,
    runtimeDir: artifactRuntimeCacheRoot(opts.home),
    runtimeEnv: prependNodePath(
      opts.env,
      prependToolPath(opts.env, runtime.runtimeEnv, runtimePathDirs),
      runtime.nodeModulesPath,
    ),
    nodeModulesPath: runtime.nodeModulesPath,
  });
}
