import fs from "node:fs/promises";
import path from "node:path";

import { MODEL_SCRATCHPAD_DIRNAME } from "../../shared/toolOutputOverflow";

export function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  if (!relative) return true;
  if (relative.startsWith("..")) return false;
  return !path.isAbsolute(relative);
}

export async function ensureSecureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dirPath, 0o700);
  } catch {
    // best effort only
  }
}

export async function ensureWorkingDirectory(workingDirectory: string): Promise<void> {
  try {
    const st = await fs.stat(workingDirectory);
    if (!st.isDirectory())
      throw new Error(`Working directory is not a directory: ${workingDirectory}`);
  } catch {
    await fs.mkdir(workingDirectory, { recursive: true });
  }
}

export async function emptyDirectory(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === MODEL_SCRATCHPAD_DIRNAME) continue;
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

export async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function copyDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.cp(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (sourcePath) => {
      const relativePath = path.relative(sourceDir, sourcePath);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return true;
      }
      const [firstSegment] = relativePath.split(path.sep);
      return firstSegment !== MODEL_SCRATCHPAD_DIRNAME;
    },
  });
}

export async function copyDirectoryContents(
  sourceDir: string,
  destinationDir: string,
): Promise<void> {
  await ensureDirectory(destinationDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === MODEL_SCRATCHPAD_DIRNAME) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    await fs.cp(sourcePath, destinationPath, { recursive: true, force: true, errorOnExist: false });
  }
}

async function directoryByteSizeFrom(rootDir: string, currentDir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (currentDir === rootDir && entry.name === MODEL_SCRATCHPAD_DIRNAME) continue;
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryByteSizeFrom(rootDir, entryPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(entryPath);
    total += stat.size;
  }
  return total;
}

export async function directoryByteSize(rootDir: string): Promise<number> {
  return directoryByteSizeFrom(rootDir, rootDir);
}
