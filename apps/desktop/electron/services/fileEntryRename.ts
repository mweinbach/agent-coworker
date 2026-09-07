import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { symlink } from "../../../../src/platform/fs";

function isSameEntry(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink()
  );
}

async function statEntry(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function destinationExists(): Error {
  return new Error("A file or folder with that name already exists.");
}

async function renameEntry(source: string, target: string): Promise<void> {
  const sourceStat = await fs.lstat(source);
  if (source === target) return;

  const targetStat = await statEntry(target);
  if (targetStat) {
    // On case-insensitive filesystems the requested casing can resolve to the
    // source itself. Distinct hardlinks with both names present are collisions.
    if (
      isSameEntry(sourceStat, targetStat) &&
      path.basename(source).toLowerCase() === path.basename(target).toLowerCase() &&
      !(await fs.readdir(path.dirname(source))).includes(path.basename(target))
    ) {
      await fs.rename(source, target);
      return;
    }
    throw destinationExists();
  }

  if (sourceStat.isDirectory()) {
    // Node has no portable no-replace directory rename. Serialize our own
    // requests and reject existing destinations; the OS also rejects replacing
    // a nonempty directory. Do not claim atomic exclusion of external writers.
    await fs.rename(source, target);
    return;
  }
  if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
    throw new Error("Only files, folders, and symbolic links can be renamed.");
  }

  const sourceLink = sourceStat.isSymbolicLink() ? await fs.readlink(source) : undefined;
  // Claim the destination exclusively without copying file contents. Symlinks
  // are recreated explicitly because fs.link follows them on some runtimes.
  // Unsupported filesystems fail without removing the source.
  try {
    if (sourceLink !== undefined) {
      await symlink(sourceLink, target);
    } else {
      await fs.link(source, target);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw destinationExists();
    if (["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EPERM"].includes(code ?? "")) {
      throw new Error(
        "This filesystem cannot rename this entry safely. Rename it in your file manager.",
        {
          cause: error,
        },
      );
    }
    throw error;
  }

  const linkedStat = await fs.lstat(target);
  try {
    const currentSource = await fs.lstat(source);
    const targetMatches =
      sourceLink === undefined
        ? isSameEntry(sourceStat, linkedStat)
        : linkedStat.isSymbolicLink() && (await fs.readlink(target)) === sourceLink;
    if (!targetMatches || !isSameEntry(sourceStat, currentSource)) {
      throw new Error("The file changed while it was being renamed. Try again.");
    }
    await fs.unlink(source);
  } catch (error) {
    const [currentSource, currentTarget] = await Promise.all([
      statEntry(source),
      statEntry(target),
    ]);
    // Roll back only our newly created entry, and only while the original still
    // exists. If an external writer removed it, keep the last remaining link.
    if (
      currentSource &&
      currentTarget &&
      isSameEntry(sourceStat, currentSource) &&
      isSameEntry(linkedStat, currentTarget)
    ) {
      await fs.unlink(target);
    }
    throw error;
  }
}

export function createFileEntryRenamer(): (source: string, target: string) => Promise<void> {
  let pending = Promise.resolve();
  return (source, target) => {
    const operation = pending.then(() => renameEntry(source, target));
    pending = operation.catch(() => {
      // Keep later rename requests serialized after a failed operation; the caller still receives it.
    });
    return operation;
  };
}
