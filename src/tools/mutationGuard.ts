import fs from "node:fs/promises";
import path from "node:path";

import type { ToolContext } from "./context";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function collectMissingDirectories(dirPath: string): Promise<string[]> {
  const missing: string[] = [];
  let current = path.resolve(dirPath);
  while (!(await pathExists(current))) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

export async function cleanupCreatedDirectories(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    try {
      await fs.rmdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") continue;
      throw error;
    }
  }
}

export async function prepareMutationDirectory(
  ctx: ToolContext,
  toolName: string,
  dirPath: string,
): Promise<string[]> {
  await ctx.assertCanMutate?.(toolName);
  const createdDirs = await collectMissingDirectories(dirPath);
  if (createdDirs.length === 0) return [];

  await fs.mkdir(dirPath, { recursive: true });
  try {
    await ctx.assertCanMutate?.(toolName);
  } catch (error) {
    await cleanupCreatedDirectories(createdDirs);
    throw error;
  }
  return createdDirs;
}
