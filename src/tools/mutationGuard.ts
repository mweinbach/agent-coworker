import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../platform/fs";
import { canonicalize } from "../platform/paths";
import { raceWithAbort } from "../utils/abortSignal";
import { fileLockRootForCoworkHome, withFileLock } from "../utils/fileLock";
import { assertWritePathAllowed } from "../utils/permissions";
import type { ToolContext } from "./context";

type MutationTool = "write" | "edit";

async function fileStat(filePath: string): Promise<Stats | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) throw new Error(`File mutation blocked: not a regular file: ${filePath}`);
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameFileVersion(left: Stats | null, right: Stats | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function assertCanMutate(ctx: ToolContext, toolName: MutationTool): Promise<void> {
  ctx.abortSignal?.throwIfAborted();
  const kind = ctx.sandboxPolicy?.kind;
  if (kind === "read-only" || kind === "no-project-write") {
    throw new Error(`${toolName} blocked: sandbox mode is ${kind}`);
  }
  await ctx.assertCanMutate?.(toolName);
  ctx.abortSignal?.throwIfAborted();
}

/**
 * Serialize file-tool read/modify/write cycles across sessions and processes.
 * Use the original canonical target for the whole operation so an internal
 * symlink remains a symlink. Recheck its spelling, permissions and file version
 * after asynchronous gates and just before publishing the staged replacement.
 * These path checks detect changed aliases; they are not a filesystem-wide lock
 * against an unrelated process changing a directory during the final syscall.
 */
export async function withFileMutation<T>(
  ctx: ToolContext,
  toolName: MutationTool,
  requestedPath: string,
  mutate: (file: {
    path: string;
    stat: Stats | null;
    commit: (data: string | Uint8Array, opts?: { append?: boolean }) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  await assertCanMutate(ctx, toolName);
  const checkedPath = await assertWritePathAllowed(
    requestedPath,
    ctx.config,
    toolName,
    ctx.agentTargetPaths,
  );
  const canonicalPath = await canonicalize(checkedPath);
  const assertTargetUnchanged = async () => {
    await assertWritePathAllowed(checkedPath, ctx.config, toolName, ctx.agentTargetPaths);
    if ((await canonicalize(checkedPath)) !== canonicalPath) {
      throw new Error(`${toolName} blocked: file path changed during mutation: ${checkedPath}`);
    }
  };

  const mutation = withFileLock(
    checkedPath,
    async () => {
      await assertCanMutate(ctx, toolName);
      await assertTargetUnchanged();
      const createdDirs =
        toolName === "write"
          ? await prepareMutationDirectory(ctx, toolName, path.dirname(canonicalPath))
          : [];
      try {
        await assertTargetUnchanged();
        const originalStat = await fileStat(canonicalPath);
        return await mutate({
          path: canonicalPath,
          stat: originalStat,
          commit: async (data, opts = {}) => {
            const assertUnchanged = async () => {
              await assertCanMutate(ctx, toolName);
              await assertTargetUnchanged();
              if (!sameFileVersion(originalStat, await fileStat(canonicalPath))) {
                throw new Error(
                  `${toolName} blocked: file changed during mutation; read it again before retrying: ${checkedPath}`,
                );
              }
              ctx.abortSignal?.throwIfAborted();
            };
            await assertUnchanged();
            await writeFileAtomic(canonicalPath, data, {
              ...(originalStat ? { mode: originalStat.mode & 0o777 } : {}),
              ...opts,
              beforeCommit: async (stagedPath) => {
                // Creation mode is filtered by umask. Preserve the existing
                // file's exact permissions on its staged replacement instead.
                if (originalStat) await fs.chmod(stagedPath, originalStat.mode & 0o777);
                await assertUnchanged();
              },
            });
          },
        });
      } catch (error) {
        await cleanupCreatedDirectories(createdDirs);
        throw error;
      }
    },
    { lockRoot: fileLockRootForCoworkHome(ctx.config.userCoworkDir) },
  );
  // A cancelled turn need not wait for another process to release its lock.
  // The queued callback rechecks the signal before any later mutation occurs.
  return raceWithAbort(mutation, ctx.abortSignal, `${toolName} cancelled.`);
}

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
