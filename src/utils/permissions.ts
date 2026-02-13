import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../types";
import { isPathInside } from "./paths";

export function isWritePathAllowed(filePath: string, config: AgentConfig): boolean {
  const resolved = path.resolve(filePath);

  // v0.1: allow writes within the current project, working directory, or output directory.
  const projectRoot = path.dirname(config.projectAgentDir);
  if (isPathInside(projectRoot, resolved)) return true;

  if (isPathInside(config.workingDirectory, resolved)) return true;
  if (isPathInside(config.outputDirectory, resolved)) return true;

  return false;
}

async function canonicalizeExistingPrefix(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const tail: string[] = [];
  let cursor = resolved;

  while (true) {
    try {
      const canonical = await fs.realpath(cursor);
      return tail.length > 0 ? path.join(canonical, ...tail.reverse()) : canonical;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function canonicalizeRoot(rootPath: string): Promise<string> {
  const resolved = path.resolve(rootPath);
  try {
    return await fs.realpath(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw err;
    return resolved;
  }
}

export async function assertWritePathAllowed(
  filePath: string,
  config: AgentConfig,
  action: "write" | "edit" | "notebookEdit"
): Promise<string> {
  const resolved = path.resolve(filePath);
  if (!isWritePathAllowed(resolved, config)) {
    throw new Error(
      `${action} blocked: path is outside workingDirectory/outputDirectory/project root: ${resolved}`
    );
  }

  // Guard against symlink escapes such as:
  // <workingDirectory>/link -> /etc and target <workingDirectory>/link/passwd
  const projectRoot = path.dirname(config.projectAgentDir);
  const [canonicalTarget, canonicalProjectRoot, canonicalWorkingDirectory, canonicalOutputDirectory] =
    await Promise.all([
      canonicalizeExistingPrefix(resolved),
      canonicalizeRoot(projectRoot),
      canonicalizeRoot(config.workingDirectory),
      canonicalizeRoot(config.outputDirectory),
    ]);

  if (
    !isPathInside(canonicalProjectRoot, canonicalTarget) &&
    !isPathInside(canonicalWorkingDirectory, canonicalTarget) &&
    !isPathInside(canonicalOutputDirectory, canonicalTarget)
  ) {
    throw new Error(
      `${action} blocked: canonical target resolves outside allowed directories: ${canonicalTarget}`
    );
  }

  return resolved;
}
