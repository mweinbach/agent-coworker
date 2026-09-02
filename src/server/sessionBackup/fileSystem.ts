import fs from "node:fs/promises";
import path from "node:path";

import { MODEL_SCRATCHPAD_DIRNAME } from "../../shared/toolOutputOverflow";
import {
  RECOVERY_DIRECTORY_PREFIX,
  workspaceRecoveryFailureReason,
  writeRecoveryJournal,
} from "./recovery";

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

async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function copyDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.cp(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    verbatimSymlinks: true,
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
    await fs.cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      verbatimSymlinks: true,
    });
  }
}

/** Keep the live files on the same filesystem until their replacement succeeds. */
export async function replaceDirectoryContents(
  sourceDir: string,
  destinationDir: string,
): Promise<void> {
  const recoveryFailure = await workspaceRecoveryFailureReason(destinationDir);
  if (recoveryFailure) throw new Error(recoveryFailure);
  const rollbackDir = await fs.mkdtemp(path.join(destinationDir, RECOVERY_DIRECTORY_PREFIX));
  const rollbackName = path.basename(rollbackDir);
  const rollbackFiles = path.join(rollbackDir, "files");
  const moved: string[] = [];
  let copying = false;
  let preserveRollback = false;
  const isPreserved = (name: string) => name === MODEL_SCRATCHPAD_DIRNAME || name === rollbackName;
  try {
    await fs.mkdir(rollbackFiles);
    const entries = (await fs.readdir(destinationDir)).filter((name) => !isPreserved(name));
    await writeRecoveryJournal(rollbackDir, destinationDir, entries, "moving");
    for (const name of entries) {
      await fs.rename(path.join(destinationDir, name), path.join(rollbackFiles, name));
      moved.push(name);
    }
    await writeRecoveryJournal(rollbackDir, destinationDir, entries, "restoring");
    copying = true;
    await copyDirectoryContents(sourceDir, destinationDir);
    await writeRecoveryJournal(rollbackDir, destinationDir, entries, "complete");
  } catch (error) {
    try {
      if (copying) {
        for (const name of await fs.readdir(destinationDir)) {
          if (isPreserved(name)) continue;
          await fs.rm(path.join(destinationDir, name), { recursive: true, force: true });
        }
      }
      for (const name of moved) {
        await fs.rename(path.join(rollbackFiles, name), path.join(destinationDir, name));
      }
    } catch (rollbackError) {
      preserveRollback = true;
      throw new AggregateError(
        [error, rollbackError],
        `Restore failed and rollback was incomplete. Recover previous files from ${rollbackDir}`,
      );
    }
    throw error;
  } finally {
    if (!preserveRollback) await fs.rm(rollbackDir, { recursive: true, force: true });
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
