import { constants as fsConstants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";

import { canonicalizeSync } from "../platform/paths";
import type { FileChangeVersion } from "../shared/fileVersion";
import { fileChangeVersionsEqual } from "../shared/fileVersion";

export type CappedFilePreview = {
  path: string;
  bytes: Uint8Array;
  byteLength: number;
  truncated: boolean;
  version: FileChangeVersion;
};

export function fileChangeVersionFromStat(
  stat: Pick<Stats, "mtimeMs" | "ctimeMs" | "size"> & Partial<Pick<Stats, "dev" | "ino">>,
): FileChangeVersion {
  const modifiedAtMs = stat.mtimeMs;
  const changeTimeMs = stat.ctimeMs;
  const identity =
    typeof stat.dev === "number" && typeof stat.ino === "number" ? `${stat.dev}:${stat.ino}:` : "";
  return {
    modifiedAtMs,
    changeTimeMs,
    size: stat.size,
    fingerprint: `${identity}${modifiedAtMs}:${changeTimeMs}:${stat.size}`,
  };
}

export async function readFileChangeVersion(
  absPath: string,
  options?: { allowDirectory?: boolean },
): Promise<FileChangeVersion> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile() && !(options?.allowDirectory && stat.isDirectory())) {
    throw new Error("Path is not a file");
  }
  return fileChangeVersionFromStat(stat);
}

function assertAuthorizedFilePath(absPath: string, expectedCanonicalPath: string): void {
  if (canonicalizeSync(absPath) !== expectedCanonicalPath) {
    throw new Error("File path no longer matches the authorized file path.");
  }
}

/** Open an authorized regular file without handing callers a pathname to reopen. */
export async function openAuthorizedFile(
  absPath: string,
  options: { expectedCanonicalPath: string },
): Promise<{ handle: FileHandle; stat: Stats }> {
  const expectedCanonicalPath = options.expectedCanonicalPath;
  assertAuthorizedFilePath(absPath, expectedCanonicalPath);
  const handle = await fs.open(
    absPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    assertAuthorizedFilePath(absPath, expectedCanonicalPath);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Path is not a file");

    const pathStat = await fs.lstat(absPath);
    assertAuthorizedFilePath(absPath, expectedCanonicalPath);
    if (!pathStat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error("File changed while it was being opened.");
    }
    // Ownership transfers only after validation; callers must close the handle.
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function readCappedFilePreview(
  absPath: string,
  maxBytes: number,
  options?: {
    /** Immutable canonical path captured by the caller's authorization check. */
    expectedCanonicalPath?: string;
    beforePathVerification?: () => Promise<void>;
  },
): Promise<CappedFilePreview> {
  const expectedCanonicalPath = options?.expectedCanonicalPath ?? canonicalizeSync(absPath);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await (async () => {
      const { handle, stat: beforeStat } = await openAuthorizedFile(absPath, {
        expectedCanonicalPath,
      });
      try {
        const toRead = Math.min(maxBytes, beforeStat.size);
        const buffer = Buffer.alloc(toRead);
        const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
        return { beforeStat, afterStat: await handle.stat(), buffer, bytesRead };
      } finally {
        await handle.close();
      }
    })();

    // Close the descriptor before checking the path. Windows prevents atomic
    // replacement while our descriptor is open, which would turn a detectable
    // race into an unrelated EPERM. The descriptor stats above still identify
    // exactly which bytes were read, and the path stat below binds that snapshot
    // back to the current directory entry.
    await options?.beforePathVerification?.();
    let pathStat: Stats;
    try {
      pathStat = await fs.lstat(absPath);
    } catch (error) {
      if (attempt === 0) {
        continue;
      }
      throw error;
    }
    assertAuthorizedFilePath(absPath, expectedCanonicalPath);
    if (!pathStat.isFile()) {
      if (attempt === 0) {
        continue;
      }
      throw new Error("Preview path was replaced while it was being read.");
    }
    const beforeVersion = fileChangeVersionFromStat(snapshot.beforeStat);
    const afterVersion = fileChangeVersionFromStat(snapshot.afterStat);
    const pathVersion = fileChangeVersionFromStat(pathStat);
    if (
      !fileChangeVersionsEqual(beforeVersion, afterVersion) ||
      !fileChangeVersionsEqual(afterVersion, pathVersion)
    ) {
      if (attempt === 0) {
        continue;
      }
      throw new Error("File changed or was replaced while the preview was being read.");
    }

    const bytes = new Uint8Array(snapshot.bytesRead);
    bytes.set(snapshot.buffer.subarray(0, snapshot.bytesRead));
    return {
      path: absPath,
      bytes,
      byteLength: snapshot.bytesRead,
      truncated: snapshot.afterStat.size > snapshot.bytesRead,
      version: pathVersion,
    };
  }
  throw new Error("Unable to read a stable file preview.");
}
