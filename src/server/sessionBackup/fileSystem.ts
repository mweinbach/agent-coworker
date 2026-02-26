import fs from "node:fs/promises";
import path from "node:path";

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
    if (!st.isDirectory()) throw new Error(`Working directory is not a directory: ${workingDirectory}`);
  } catch {
    await fs.mkdir(workingDirectory, { recursive: true });
  }
}

export async function emptyDirectory(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

export async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function copyDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.cp(sourceDir, destinationDir, { recursive: true, force: true, errorOnExist: false });
}

export async function copyDirectoryContents(sourceDir: string, destinationDir: string): Promise<void> {
  await ensureDirectory(destinationDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    await fs.cp(sourcePath, destinationPath, { recursive: true, force: true, errorOnExist: false });
  }
}

export async function directoryByteSize(rootDir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryByteSize(entryPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(entryPath);
    total += stat.size;
  }
  return total;
}
