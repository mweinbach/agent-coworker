import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";

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
  const modifiedAtMs = Math.round(stat.mtimeMs);
  const changeTimeMs = Math.round(stat.ctimeMs);
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

export async function readCappedFilePreview(
  absPath: string,
  maxBytes: number,
  hooks?: {
    beforePathVerification?: () => Promise<void>;
  },
): Promise<CappedFilePreview> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await fs.open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const beforeStat = await handle.stat();
      if (!beforeStat.isFile()) {
        throw new Error("Path is not a file");
      }
      const toRead = Math.min(maxBytes, beforeStat.size);
      const buffer = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
      const afterStat = await handle.stat();
      await hooks?.beforePathVerification?.();
      let pathStat: Stats;
      try {
        pathStat = await fs.lstat(absPath);
      } catch (error) {
        if (attempt === 0) {
          continue;
        }
        throw error;
      }
      if (!pathStat.isFile()) {
        if (attempt === 0) {
          continue;
        }
        throw new Error("Preview path was replaced while it was being read.");
      }
      const beforeVersion = fileChangeVersionFromStat(beforeStat);
      const afterVersion = fileChangeVersionFromStat(afterStat);
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

      const bytes = new Uint8Array(bytesRead);
      bytes.set(buffer.subarray(0, bytesRead));
      return {
        path: absPath,
        bytes,
        byteLength: bytesRead,
        truncated: afterStat.size > bytesRead,
        version: pathVersion,
      };
    } finally {
      await handle.close();
    }
  }
  throw new Error("Unable to read a stable file preview.");
}
