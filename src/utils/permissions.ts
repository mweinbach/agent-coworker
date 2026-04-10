import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentConfig } from "../types";
import { discoverPlugins } from "../plugins/discovery";
import { readPluginManifest } from "../plugins/manifest";
import { isPathInside } from "./paths";

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();
const WRITE_ROOT_LABEL = "workingDirectory/outputDirectory/uploadsDirectory/project root";
const READ_ROOT_LABEL = "workingDirectory/outputDirectory/uploadsDirectory/project root/skills directories/plugin roots";

function writeRoots(config: AgentConfig): string[] {
  const projectRoot = path.dirname(config.projectAgentDir);
  return [
    projectRoot,
    config.workingDirectory,
    ...(config.outputDirectory ? [config.outputDirectory] : []),
    ...(config.uploadsDirectory ? [config.uploadsDirectory] : []),
  ];
}

function readRoots(config: AgentConfig): string[] {
  return [
    ...writeRoots(config),
    ...config.skillsDirs.filter(Boolean),
    ...(config.workspacePluginsDir ? [config.workspacePluginsDir] : []),
    ...(config.userPluginsDir ? [config.userPluginsDir] : []),
  ];
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

export function isWritePathAllowed(filePath: string, config: AgentConfig): boolean {
  return isCanonicalPathInsideRoots(filePath, writeRoots(config));
}

export function isReadPathAllowed(filePath: string, config: AgentConfig): boolean {
  return isCanonicalPathInsideRoots(filePath, readRoots(config));
}

async function canonicalizeExistingPrefix(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const tail: string[] = [];
  let cursor = resolved;

  while (true) {
    try {
      const canonical = await fsPromises.realpath(cursor);
      return tail.length > 0 ? path.join(canonical, ...tail.reverse()) : canonical;
    } catch (err) {
      const parsedCode = errorWithCodeSchema.safeParse(err);
      const code = parsedCode.success ? parsedCode.data.code : undefined;
      if (code !== "ENOENT") throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function canonicalizeRoot(rootPath: string): Promise<string> {
  return canonicalizeExistingPrefix(rootPath);
}

function canonicalizeExistingPrefixSync(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const tail: string[] = [];
  let cursor = resolved;

  while (true) {
    try {
      const canonical = fs.realpathSync(cursor);
      return tail.length > 0 ? path.join(canonical, ...tail.reverse()) : canonical;
    } catch (err) {
      const parsedCode = errorWithCodeSchema.safeParse(err);
      const code = parsedCode.success ? parsedCode.data.code : undefined;
      if (code !== "ENOENT") throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
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
  action: "write" | "edit" | "notebookEdit"
): Promise<string> {
  const resolved = path.resolve(filePath);
  const roots = writeRoots(config);
  if (!isPathInsideAnyRoot(resolved, roots)) {
    throw new Error(
      `${action} blocked: path is outside ${WRITE_ROOT_LABEL}: ${resolved}`
    );
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
      `${action} blocked: canonical target resolves outside allowed directories: ${canonicalTarget}`
    );
  }

  return resolved;
}

export async function assertReadPathAllowed(
  filePath: string,
  config: AgentConfig,
  action: "read" | "glob" | "grep"
): Promise<string> {
  const resolved = path.resolve(filePath);
  const roots = [
    ...readRoots(config),
    ...(await pluginReadRoots(config)),
  ];
  if (!isPathInsideAnyRoot(resolved, roots)) {
    throw new Error(
      `${action} blocked: path is outside ${READ_ROOT_LABEL}: ${resolved}`
    );
  }

  const canonicalRoots = await Promise.all([
    canonicalizeExistingPrefix(resolved),
    ...roots.map((root) => canonicalizeRoot(root)),
  ]);
  const [canonicalTarget, ...allowedRoots] = canonicalRoots;

  if (!allowedRoots.some((root) => isPathInside(root, canonicalTarget))) {
    throw new Error(
      `${action} blocked: canonical target resolves outside allowed directories: ${canonicalTarget}`
    );
  }

  return resolved;
}
