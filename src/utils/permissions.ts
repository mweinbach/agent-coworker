import path from "node:path";
import {
  resolveAdvancedMemoryReadRoots,
  resolveAdvancedMemoryWriteRoots,
} from "../advancedMemory/store";
import {
  canonicalize as platformCanonicalize,
  canonicalizeSync as platformCanonicalizeSync,
} from "../platform/paths";
import { discoverPlugins } from "../plugins/discovery";
import { readPluginManifest } from "../plugins/manifest";
import type { AgentConfig } from "../types";
import { isPathInside, PROTECTED_METADATA_DIR_NAMES, pathCrossesProtectedMetadata } from "./paths";

const WRITE_ROOT_LABEL =
  "workingDirectory/outputDirectory/uploadsDirectory/project root/active advanced-memory folder";
const READ_ROOT_LABEL =
  "workingDirectory/outputDirectory/uploadsDirectory/project root/skills directories/plugin roots/advanced-memory folders";

function writeRoots(config: AgentConfig): string[] {
  const projectRoot = path.dirname(config.projectCoworkDir);
  return [
    projectRoot,
    config.workingDirectory,
    ...(config.outputDirectory ? [config.outputDirectory] : []),
    ...(config.uploadsDirectory ? [config.uploadsDirectory] : []),
    ...resolveAdvancedMemoryWriteRoots(config),
  ];
}

function readRoots(config: AgentConfig): string[] {
  return [
    ...writeRoots(config),
    ...resolveAdvancedMemoryReadRoots(config),
    ...config.skillsDirs.filter(Boolean),
    ...(config.workspacePluginsDir ? [config.workspacePluginsDir] : []),
    ...(config.userPluginsDir ? [config.userPluginsDir] : []),
  ];
}

/**
 * Credential directories that the read/glob/grep tools must never surface even
 * though they can sit inside a read root (e.g. a project's `.cowork/auth` holds
 * MCP OAuth tokens / API keys, and the workspace itself is a read root). This
 * closes the file-tool exfiltration vector reachable via plain prompt injection.
 * The OS sandbox still grants `bash` full-disk read by design — that is a
 * separate, documented capability, not something these tools can tighten.
 */
export function credentialReadDenyDirs(config: AgentConfig): string[] {
  return [path.join(config.projectCoworkDir, "auth"), path.join(config.userCoworkDir, "auth")];
}

function isInsideCredentialDir(resolvedTarget: string, config: AgentConfig): boolean {
  return credentialReadDenyDirs(config).some((dir) =>
    isPathInside(path.resolve(dir), resolvedTarget),
  );
}

async function pluginReadRoots(config: AgentConfig): Promise<string[]> {
  try {
    const discovery = await discoverPlugins(config);
    const roots = new Set<string>();

    for (const plugin of discovery.plugins) {
      roots.add(plugin.rootDir);
      try {
        const manifest = await readPluginManifest(plugin.rootDir);
        for (const skillsPath of manifest.skillsPaths) {
          roots.add(skillsPath);
        }
      } catch {
        // Ignore malformed plugin manifests here; permission checks should fail closed.
      }
    }

    return [...roots];
  } catch {
    return [];
  }
}

function isPathInsideAnyRoot(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((root) => isPathInside(root, resolved));
}

export function resolveAgentTargetPathRoots(
  config: AgentConfig,
  targetPaths: readonly string[] | null | undefined,
): string[] {
  if (!targetPaths || targetPaths.length === 0) return [];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of targetPaths) {
    const trimmed = rawPath.trim();
    if (!trimmed) continue;
    const resolved = path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.resolve(config.workingDirectory, trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

async function assertInsideAgentTargetPaths(
  resolvedPath: string,
  config: AgentConfig,
  action: string,
  targetPaths: readonly string[] | null | undefined,
  opts: { projectPathsOnly: boolean },
): Promise<void> {
  const scopeRoots = resolveAgentTargetPathRoots(config, targetPaths);
  if (scopeRoots.length === 0) return;

  if (opts.projectPathsOnly && !isPathInsideAnyRoot(resolvedPath, writeRoots(config))) {
    return;
  }

  if (!isPathInsideAnyRoot(resolvedPath, scopeRoots)) {
    throw new Error(
      `${action} blocked: path is outside this child agent's targetPaths (${targetPaths?.join(
        ", ",
      )}): ${resolvedPath}`,
    );
  }

  const canonicalRoots = await Promise.all([
    canonicalizeExistingPrefix(resolvedPath),
    ...scopeRoots.map((root) => canonicalizeRoot(root)),
  ]);
  const [canonicalTarget, ...allowedRoots] = canonicalRoots;
  if (!allowedRoots.some((root) => isPathInside(root, canonicalTarget))) {
    throw new Error(
      `${action} blocked: canonical target resolves outside this child agent's targetPaths: ${canonicalTarget}`,
    );
  }
}

/**
 * Whether a write target lands inside protected project metadata (`.git` or
 * `.cowork`). Mirrors the shell sandbox policy's carve-out so the built-in
 * write/edit tools cannot plant git hooks or mutate project config/skills/memory
 * metadata even though the project root is a writable root. The check is made
 * relative to the project root and re-checked after symlink resolution.
 */
function writeTargetCrossesProtectedMetadata(config: AgentConfig, resolvedTarget: string): boolean {
  const projectRoot = path.dirname(config.projectCoworkDir);
  if (pathCrossesProtectedMetadata(projectRoot, resolvedTarget)) {
    return true;
  }
  try {
    return pathCrossesProtectedMetadata(
      canonicalizeRootSync(projectRoot),
      canonicalizeExistingPrefixSync(resolvedTarget),
    );
  } catch {
    // Containment/symlink checks already passed before this runs; if canonical
    // resolution fails here, defer to the logical result above.
    return false;
  }
}

export function isWritePathAllowed(filePath: string, config: AgentConfig): boolean {
  const resolved = path.resolve(filePath);
  if (!isCanonicalPathInsideRoots(resolved, writeRoots(config))) {
    return false;
  }
  return !writeTargetCrossesProtectedMetadata(config, resolved);
}

export function isReadPathAllowed(filePath: string, config: AgentConfig): boolean {
  const resolved = path.resolve(filePath);
  if (isInsideCredentialDir(resolved, config)) return false;
  try {
    const canonicalTarget = canonicalizeExistingPrefixSync(resolved);
    const canonicalDenyDirs = credentialReadDenyDirs(config).map((dir) =>
      canonicalizeExistingPrefixSync(dir),
    );
    if (
      isInsideCredentialDir(canonicalTarget, config) ||
      canonicalDenyDirs.some((dir) => isPathInside(dir, canonicalTarget))
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return isCanonicalPathInsideRoots(filePath, readRoots(config));
}

/**
 * Canonicalization for permission boundaries uses THE single engine
 * (platform/paths: NATIVE realpath + longest-existing-prefix walk). The local
 * walkers this replaces used JS realpath, which does not resolve on-disk
 * casing — on macOS/Windows a differently-cased spelling of an existing
 * credential directory (`.COWORK/AUTH`) canonicalized to the caller's casing
 * and slipped past the case-sensitive deny compare. Native realpath returns
 * the true on-disk casing for every existing prefix, so the deny checks below
 * compare canonical forms.
 */
async function canonicalizeExistingPrefix(targetPath: string): Promise<string> {
  return await platformCanonicalize(targetPath);
}

async function canonicalizeRoot(rootPath: string): Promise<string> {
  return canonicalizeExistingPrefix(rootPath);
}

function canonicalizeExistingPrefixSync(targetPath: string): string {
  return platformCanonicalizeSync(targetPath);
}

function canonicalizeRootSync(rootPath: string): string {
  return canonicalizeExistingPrefixSync(rootPath);
}

function isCanonicalPathInsideRoots(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  if (!isPathInsideAnyRoot(resolved, roots)) {
    return false;
  }

  try {
    const canonicalTarget = canonicalizeExistingPrefixSync(resolved);
    return roots
      .map((root) => canonicalizeRootSync(root))
      .some((root) => isPathInside(root, canonicalTarget));
  } catch {
    return false;
  }
}

export async function assertWritePathAllowed(
  filePath: string,
  config: AgentConfig,
  action: "write" | "edit",
  targetPaths?: readonly string[] | null,
): Promise<string> {
  const resolved = path.resolve(filePath);
  const roots = writeRoots(config);
  if (!isPathInsideAnyRoot(resolved, roots)) {
    throw new Error(`${action} blocked: path is outside ${WRITE_ROOT_LABEL}: ${resolved}`);
  }

  // Guard against symlink escapes such as:
  // <workingDirectory>/link -> /etc and target <workingDirectory>/link/passwd
  const canonicalRoots = await Promise.all([
    canonicalizeExistingPrefix(resolved),
    ...roots.map((root) => canonicalizeRoot(root)),
  ]);
  const [canonicalTarget, ...allowedRoots] = canonicalRoots;

  if (!allowedRoots.some((root) => isPathInside(root, canonicalTarget))) {
    throw new Error(
      `${action} blocked: canonical target resolves outside allowed directories: ${canonicalTarget}`,
    );
  }

  // Protected project metadata (.git/.cowork) is carved out of the writable set,
  // matching the shell sandbox policy, so a prompt-influenced write/edit cannot
  // plant a git hook or mutate project config/skills/memory metadata.
  if (writeTargetCrossesProtectedMetadata(config, resolved)) {
    throw new Error(
      `${action} blocked: ${PROTECTED_METADATA_DIR_NAMES.join("/")} project metadata is read-only: ${resolved}`,
    );
  }

  await assertInsideAgentTargetPaths(resolved, config, action, targetPaths, {
    projectPathsOnly: false,
  });

  return resolved;
}

export async function assertReadPathAllowed(
  filePath: string,
  config: AgentConfig,
  action: "read" | "glob" | "grep",
  targetPaths?: readonly string[] | null,
): Promise<string> {
  const resolved = path.resolve(filePath);
  const roots = [...readRoots(config), ...(await pluginReadRoots(config))];
  if (!isPathInsideAnyRoot(resolved, roots)) {
    throw new Error(`${action} blocked: path is outside ${READ_ROOT_LABEL}: ${resolved}`);
  }

  const canonicalRoots = await Promise.all([
    canonicalizeExistingPrefix(resolved),
    ...roots.map((root) => canonicalizeRoot(root)),
  ]);
  const [canonicalTarget, ...allowedRoots] = canonicalRoots;

  // Deny credential directories before the root check (the workspace is a read
  // root, so .cowork/auth would otherwise pass). Check the logical path and the
  // symlink-resolved canonical path so a workspace symlink into .cowork/auth is
  // also blocked. The deny dirs are canonicalized too: when the workspace path
  // itself contains a symlink (e.g. macOS /var -> /private/var), the logical deny
  // dir would not prefix-match the canonical target, so compare both forms.
  const canonicalDenyDirs = await Promise.all(
    credentialReadDenyDirs(config).map((dir) => canonicalizeExistingPrefix(dir)),
  );
  if (
    isInsideCredentialDir(resolved, config) ||
    isInsideCredentialDir(canonicalTarget, config) ||
    canonicalDenyDirs.some((dir) => isPathInside(dir, canonicalTarget))
  ) {
    throw new Error(`${action} blocked: credential directory is not readable: ${resolved}`);
  }

  if (!allowedRoots.some((root) => isPathInside(root, canonicalTarget))) {
    throw new Error(
      `${action} blocked: canonical target resolves outside allowed directories: ${canonicalTarget}`,
    );
  }

  await assertInsideAgentTargetPaths(resolved, config, action, targetPaths, {
    projectPathsOnly: true,
  });

  return resolved;
}
